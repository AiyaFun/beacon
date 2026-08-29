// 本机命令执行的闸门（2026-08-29）。
//
// 【为什么有这东西】用户要 OpenClaw / Hermes 那种「AI 真能在我机器上干活」的效果。
// 那两个项目跟烽火台唯一真正的能力差就是 shell + 文件——消息平台这边已经有五个，
// 浏览器驱动也有。
//
// 【为什么它只在整机版】SaaS 的服务跑在我们机房、多租户共用一台机器，
// 给模型 shell 等于给它别人的数据。整机版是用户自己的电脑，风险由他自己承担。
// 判据走 lib/edition.ts 的能力矩阵，不是 env 开关——矩阵是 TypeScript 强制写全的。
//
// ── 三道闸，每一道都对应一种「写成直觉版本就等于没防」──
//
// ① **不经 shell。** spawn 时 shell:false、命令与参数分开传。这一刀砍掉了整类问题：
//    管道、`;`、`&&`、反引号、$() 、通配符全部失效——它们只是普通字符串，不再是语法。
//    直觉写法 `exec(cmdline)` 等于把整条命令交给 /bin/sh 解释，白名单当场失效。
//
// ② **路径按真实路径判，不是按字符串前缀。** `startsWith(root)` 有两个洞：
//    `/allowed` 会匹配上 `/allowed-evil`（没有分隔符边界），而 `cd x && cat ../../etc/passwd`
//    根本不是前缀问题。所以先 realpath 解掉软链再比，且必须比到分隔符边界。
//
// ③ **参数里的路径也要过闸。** 只挡工作目录不挡参数，等于没挡——命令本来就带路径参数。
//
// ── 一句必须说破的话 ──
// 命令白名单**不可能做到滴水不漏**。允许了 git，就等于允许 `git -c core.pager=…`；
// 允许了 find，就等于允许 `find -exec`。下面的 DANGEROUS_FLAGS 挡住的是常见的几个口子，
// 它是「别踩到脚」而不是「关得住恶意」。真正的边界是**用户自己选了哪些命令**，
// 所以设置页必须把这句话原样告诉用户，而不是让他以为勾了白名单就安全了。
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

export type ShellPolicy = {
  /** 允许直接执行的命令名（argv[0]）。空 = 一条都不许跑 */
  allow: readonly string[];
  /**
   * 'allowlist'=只跑清单里的（默认）｜'full'=不限命令。
   *
   * 【为什么要有 full 这一档】用户要「能开终端」。而一旦能开终端，命令白名单在语义上
   * 就不存在了——他敲一句 bash 就什么都能跑。与其假装白名单还管用（那是安全剧场），
   * 不如给一个明确的、他自己知道选了什么的档：**full 档下目录边界、超时、输出上限
   * 与「不经 shell」全部照旧**，只有「哪些命令」这一条不再限制。
   */
  mode: 'allowlist' | 'full';
  /** 只许在这个目录（含子目录）里动 */
  root: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export const SHELL_DEFAULTS = { timeoutMs: 20_000, maxOutputBytes: 64 * 1024 };

/**
 * 已知能把「跑一条命令」变成「跑任意命令」的参数。
 * **这不是完整清单，也不可能完整**——见文件头那段。它只挡最常见的几个。
 */
const DANGEROUS_FLAGS: RegExp[] = [
  /^-c$/,                       // git -c core.pager=… / sh -c
  /^--exec/,                    // find --exec / tar --exec
  /^-exec$/,                    // find -exec
  /^--to-command/,              // tar --to-command
  /^--upload-file$/,            // curl 外传
  /^-o$|^--output$/,            // 写到任意位置（路径闸也会拦，这里早一步给出人话）
  /^--config$/,                 // 改配置=改行为
  /^-e$|^--eval$/,              // node -e / perl -e
];

export type CheckResult = { ok: true; argv: string[]; cwd: string } | { ok: false; error: string };

/** 命令名是否带路径（允许 git ≠ 允许 /tmp/git）。 */
function hasPathSeparator(a: string): boolean {
  return a.includes('/') || a.includes('\\') || isAbsolute(a);
}

/**
 * 这个参数需要过路径闸吗。
 *
 * 【别用「长得像路径」当判据】第一版写的是「含 / 或以 . 开头才算路径」，
 * 于是 `ls escape`（escape 是 root 里一条指向外面的软链）被判定成「不是路径」，
 * 整个路径闸直接绕过——测试当场抓到。**裸文件名也是路径。**
 *
 * 现在的判据是三选一，既不漏也不误伤 `--short` 这种旗标：
 *   绝对路径 / 含 .. / **在工作目录里真实存在这个名字**（软链就是靠第三条抓住的）
 */
async function needsPathCheck(root: string, a: string): Promise<boolean> {
  if (isAbsolute(a)) return true;
  if (a.split(/[\\/]/).includes('..')) return true;
  try { await lstat(resolve(root, a)); return true; } catch { return false; }
}

/** 真实路径是否在 root 之内。root 与 p 都必须先解软链，且比到分隔符边界。 */
export async function insideRoot(root: string, p: string): Promise<boolean> {
  try {
    // 目标可能还不存在（比如要新建的文件），那就退一步解它的父目录
    const realRoot = await realpath(root);
    // resolve 已经把 .. 规范化掉了，剩下的风险只有软链
    const abs = resolve(root, p);

    // 往上找到**第一个真实存在的祖先**再解软链。
    // 【为什么不能只往上找一层】第一版只退一级父目录，于是写 `sub/new.txt`（sub 还不存在）
    // 直接被判出界——而「新建嵌套目录」是再正常不过的需求。测试当场抓到。
    let anc = abs;
    let rest = '';
    for (;;) {
      try { anc = await realpath(anc); break; } catch { /* 不存在，继续往上 */ }
      const cut = anc.lastIndexOf(sep);
      if (cut <= 0) return false; // 一路到根都不存在，不放行
      rest = anc.slice(cut) + rest;
      anc = anc.slice(0, cut);
    }
    const target = rest ? anc + rest : anc;
    return target === realRoot || target.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  } catch {
    return false; // root 本身解不出来（不存在/没权限）= 一律不放行
  }
}

/** 命令 + 参数是否放行。放行时返回规范化后的 argv 与 cwd。 */
export async function checkCommand(policy: ShellPolicy, argv: readonly string[]): Promise<CheckResult> {
  const list = argv.map((a) => String(a ?? ''));
  const cmd = list[0]?.trim();
  if (!cmd) return { ok: false, error: '没给命令' };
  // 命令名本身不许带路径：允许 `git` 不等于允许 `/tmp/git`
  if (hasPathSeparator(cmd)) return { ok: false, error: '命令名不能带路径，只能写命令本身（如 git）' };
  if (policy.mode !== 'full' && !policy.allow.includes(cmd)) {
    return { ok: false, error: `「${cmd}」不在这台机器的允许清单里。可在设置里加，但请只加你自己会用的` };
  }
  for (const a of list.slice(1)) {
    // full 档下拦危险旗标是自欺欺人：既然任何命令都能跑，挡 `git -c` 毫无意义。
    // 但**路径闸在两档下都生效**——目录边界是这个功能唯一始终成立的护栏。
    if (policy.mode !== 'full' && DANGEROUS_FLAGS.some((re) => re.test(a))) {
      return { ok: false, error: `参数「${a}」能让命令去执行别的东西，不放行` };
    }
    if ((await needsPathCheck(policy.root, a)) && !(await insideRoot(policy.root, a))) {
      return { ok: false, error: `路径「${a}」在允许的工作目录之外` };
    }
  }
  return { ok: true, argv: list, cwd: policy.root };
}

export type RunResult = { code: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean };

/** 真跑。**永远 shell:false**——见文件头闸①。 */
export async function runCommand(policy: ShellPolicy, argv: readonly string[], cwd?: string): Promise<RunResult> {
  return new Promise((res) => {
    const child = spawn(argv[0], argv.slice(1), {
      // cwd 由调用方过完路径闸再传进来（见 tools.ts 的 run_shell），这里不再自己判
      cwd: cwd ?? policy.root,
      shell: false, // ← 这一行是闸①本身，改成 true 等于白名单全废
      // 环境变量只给最小集：不把服务端的密钥（DATABASE_URL、各家 API Key）带进子进程。
      // HOME 指到工作目录，免得命令去读用户真正的 ~/.ssh、~/.aws 之类。
      // 项目给 ProcessEnv 加过必填字段，所以显式转一次；给的仍然只有这四个。
      env: { PATH: process.env.PATH ?? '', HOME: policy.root, LANG: process.env.LANG ?? 'C',
             NODE_ENV: process.env.NODE_ENV } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = ''; let truncated = false; let timedOut = false;
    // 【标记要在拼接后判】第一版写成「拼之前先看已有长度」，于是第一块就超限时
    // truncated 恒为 false——输出被砍了却告诉用户是完整的。测试当场抓到。
    const cap = (s: string, add: string) => {
      const merged = s + add;
      if (merged.length > policy.maxOutputBytes) { truncated = true; return merged.slice(0, policy.maxOutputBytes); }
      return merged;
    };
    child.stdout.on('data', (d) => { out = cap(out, String(d)); });
    child.stderr.on('data', (d) => { err = cap(err, String(d)); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, policy.timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); res({ code: null, stdout: out, stderr: String(e), truncated, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); res({ code, stdout: out, stderr: err, truncated, timedOut }); });
  });
}

// ── 文件读写（2026-08-29）───────────────────────────────────────────────
//
// 【为什么单独做，而不是让模型用 cat / echo】
//   ① 安全：读写文件不需要执行任何东西。走命令等于为了读一个文件而放行一个可执行程序。
//   ② 可靠：`echo "..." > f` 需要 shell 重定向，而这里 shell:false，写不了。
//      不给专用工具，模型就会反复尝试重定向然后失败——用户看到的是「它一直在瞎试」。
//   ③ 边界一致：复用同一个 insideRoot，不另开一套判据。
//
// 三个上限都是硬的：读的大小、写的大小、列目录的条数。没有上限的读会把整个上下文烧光，
// 而上下文烧光的表现是「它突然忘了前面在干什么」，排查起来毫无线索。

export const FILE_LIMITS = {
  readBytes: 128 * 1024,   // 单次读上限；再大就该让它先 grep 而不是整篇读
  writeBytes: 512 * 1024,
  listEntries: 200,
};

export type FileResult = { ok: true; text: string; truncated?: boolean } | { ok: false; error: string };

/** 读一个文件。路径必须在 root 内。 */
export async function readTextFile(root: string, p: string): Promise<FileResult> {
  if (!(await insideRoot(root, p))) return { ok: false, error: `路径「${p}」在允许的工作目录之外` };
  try {
    const full = resolve(root, p);
    const st = await stat(full);
    if (st.isDirectory()) return { ok: false, error: `「${p}」是目录，不是文件` };
    const buf = await readFile(full);
    const truncated = buf.length > FILE_LIMITS.readBytes;
    return { ok: true, text: buf.subarray(0, FILE_LIMITS.readBytes).toString('utf8'), truncated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '读不了' };
  }
}

/** 写一个文件。路径必须在 root 内；父目录不存在时自动建（仍在 root 内）。 */
export async function writeTextFile(root: string, p: string, text: string): Promise<FileResult> {
  if (!(await insideRoot(root, p))) return { ok: false, error: `路径「${p}」在允许的工作目录之外` };
  if (Buffer.byteLength(text, 'utf8') > FILE_LIMITS.writeBytes) {
    return { ok: false, error: `内容超过 ${Math.round(FILE_LIMITS.writeBytes / 1024)}KB 上限` };
  }
  try {
    const full = resolve(root, p);
    await mkdir(full.slice(0, full.lastIndexOf(sep)) || sep, { recursive: true });
    await writeFile(full, text, 'utf8');
    return { ok: true, text: `已写入 ${p}（${Buffer.byteLength(text, 'utf8')} 字节）` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '写不了' };
  }
}

/** 列目录。只列一层，不递归——递归列一个大仓库能刷爆上下文。 */
export async function listDir(root: string, p: string): Promise<FileResult> {
  const rel = p || '.';
  if (!(await insideRoot(root, rel))) return { ok: false, error: `路径「${rel}」在允许的工作目录之外` };
  try {
    const full = resolve(root, rel);
    const items = await readdir(full, { withFileTypes: true });
    const shown = items.slice(0, FILE_LIMITS.listEntries);
    const lines = shown.map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
    return {
      ok: true,
      text: lines.join('\n') || '（空目录）',
      truncated: items.length > shown.length,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '列不了' };
  }
}
