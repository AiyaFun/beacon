import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { checkCommand, runCommand, insideRoot, readTextFile, writeTextFile, listDir, FILE_LIMITS, SHELL_DEFAULTS } from '@/lib/agent/shell';
import { before } from '../helpers/anchor';

// 本机命令执行的闸门（2026-08-29）。这是这个项目里**最危险的一段代码**：
// 它在用户机器上跑命令。所以这里几乎全是真跑，不是源码级断言——
// 「看起来挡住了」和「真的挡住了」在这一层差别是致命的。

let root = '';
let outside = '';

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'beacon-shell-'));
  root = join(base, 'work'); mkdirSync(root);
  outside = join(base, 'secret'); mkdirSync(outside);
  writeFileSync(join(root, 'ok.txt'), 'inside');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(outside, 'passwd.txt'), 'SECRET');
  // 从 root 指向外面的软链——纯字符串前缀判据会被它骗过去
  symlinkSync(outside, join(root, 'escape'));
});
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ } });

const policy = () => ({ allow: ['echo', 'ls', 'git'], mode: 'allowlist' as const, root, ...SHELL_DEFAULTS });

describe('闸②：路径按真实路径判', () => {
  it('目录内的路径放行', async () => {
    expect(await insideRoot(root, 'ok.txt')).toBe(true);
    expect(await insideRoot(root, './ok.txt')).toBe(true);
  });

  it('..  跳出去的挡住', async () => {
    expect(await insideRoot(root, '../secret/passwd.txt')).toBe(false);
    expect(await insideRoot(root, '../..')).toBe(false);
  });

  it('软链指向外面的挡住（startsWith 判据会在这里破功）', async () => {
    expect(await insideRoot(root, 'escape/passwd.txt')).toBe(false);
  });

  it('同前缀的兄弟目录挡住（/work 不该匹配上 /work-evil）', async () => {
    const sibling = `${root}-evil`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'x.txt'), 'nope');
    expect(await insideRoot(root, `${sibling}/x.txt`)).toBe(false);
    rmSync(sibling, { recursive: true, force: true });
  });

  it('还不存在的文件按父目录判（要新建的文件也得在界内）', async () => {
    expect(await insideRoot(root, 'new-file.txt')).toBe(true);
    expect(await insideRoot(root, '../secret/new-file.txt')).toBe(false);
  });
});

describe('闸④：白名单', () => {
  it('不在清单里的命令拒绝', async () => {
    const r = await checkCommand(policy(), ['curl', 'http://x']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不在这台机器的允许清单里');
  });

  it('命令名不许带路径（允许 git ≠ 允许 /tmp/git）', async () => {
    const r = await checkCommand(policy(), ['/tmp/git', 'status']);
    expect(r.ok).toBe(false);
  });

  it('清单里的放行', async () => {
    expect((await checkCommand(policy(), ['git', 'status'])).ok).toBe(true);
  });
});

describe('闸③：参数里的路径也要过闸', () => {
  it('参数指向界外时拒绝', async () => {
    const r = await checkCommand(policy(), ['ls', '../secret']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('工作目录之外');
  });

  it('参数走软链出界时拒绝', async () => {
    expect((await checkCommand(policy(), ['ls', 'escape'])).ok).toBe(false);
  });
});

describe('能把「跑一条命令」变成「跑任意命令」的参数', () => {
  it.each([['git', '-c'], ['ls', '--exec'], ['git', '--config']])('%s %s 拒绝', async (c, a) => {
    expect((await checkCommand(policy(), [c, a, 'x'])).ok).toBe(false);
  });
});

describe('闸①：不经 shell（这一刀砍掉一整类问题）', () => {
  it('分号只是普通字符，不会变成第二条命令', async () => {
    const r = await runCommand(policy(), ['echo', 'a; touch pwned.txt']);
    expect(r.stdout).toContain('a; touch pwned.txt'); // 原样输出 = 没被解释
    expect(r.code).toBe(0);
  });

  it('管道符也只是字符', async () => {
    const r = await runCommand(policy(), ['echo', 'x | tee out.txt']);
    expect(r.stdout).toContain('x | tee out.txt');
  });

  it('通配符不展开', async () => {
    const r = await runCommand(policy(), ['echo', '*']);
    expect(r.stdout.trim()).toBe('*');
  });
});

describe('超时与输出上限', () => {
  it('超时会被杀掉并如实标记', async () => {
    const p = { ...policy(), allow: ['sleep'], timeoutMs: 300 };
    const r = await runCommand(p, ['sleep', '5']);
    expect(r.timedOut).toBe(true);
  }, 10_000);

  it('输出超上限截断并标记', async () => {
    const p = { ...policy(), maxOutputBytes: 20 };
    const r = await runCommand(p, ['echo', 'x'.repeat(500)]);
    expect(r.stdout.length).toBeLessThanOrEqual(20);
    expect(r.truncated).toBe(true);
  });
});

describe('源码级：几条改了就等于没防的', () => {
  const src = readFileSync(join(process.cwd(), 'lib/agent/shell.ts'), 'utf8');
  const ed = readFileSync(join(process.cwd(), 'lib/edition.ts'), 'utf8');

  it('spawn 永远 shell:false', () => {
    expect(src).toContain('shell: false,');
    expect(src).not.toMatch(/shell:\s*true/);
  });

  it('SaaS 恒关本机命令执行', () => {
    const saas = ed.slice(ed.indexOf('saas: {'), ed.indexOf('appliance: {'));
    expect(saas).toContain('localShell: false');
  });

  it('子进程不继承服务端环境变量（别把密钥递给命令）', () => {
    expect(src).toContain("env: { PATH: process.env.PATH ?? '', HOME: policy.root");
    expect(src).not.toMatch(/env:\s*process\.env/);
  });

  // 【这条曾经是假绿，2026-08-30 拆 tools.ts 时当场撞出来】
  // 原来写的是 `tools.slice(Math.max(0, i - 300), i)`。run_shell 搬到 tools-local.ts 之后
  // indexOf 返回 -1 → Math.max(0, -301) = 0 → slice(0, -1) = **整个文件**，
  // 里面当然找得到 `write: true`。**工具从这个文件里消失了，守卫却是绿的。**
  // 现在走 before()，锚点找不到就抛（见 tests/helpers/anchor.ts）。
  it('工具标了 write:true（否则「确认每一步」档形同虚设）', () => {
    const tools = readFileSync(join(process.cwd(), 'lib/agent/tools-local.ts'), 'utf8');
    expect(before(tools, "name: 'run_shell',", 300)).toContain('write: true');
  });
});

// ── full 档与文件读写（2026-08-29 补）──────────────────────────────────
// full 档是给「开终端」用的：一旦能开终端，命令白名单在语义上就不存在了。
// 关键是**目录边界在两档下都必须成立**——那是这个功能唯一始终有效的护栏。
describe('full 档：不限命令，但边界照旧', () => {
  const full = () => ({ allow: [] as string[], mode: 'full' as const, root, ...SHELL_DEFAULTS });

  it('清单外的命令也能跑（这就是 full 的含义）', async () => {
    expect((await checkCommand(full(), ['cat', 'ok.txt'])).ok).toBe(true);
  });

  it('**但目录边界仍然生效**（这一条破了，full 档就等于把整台机器交出去）', async () => {
    expect((await checkCommand(full(), ['cat', '../secret/passwd.txt'])).ok).toBe(false);
    expect((await checkCommand(full(), ['cat', 'escape/passwd.txt'])).ok).toBe(false);
  });

  it('仍然不经 shell', async () => {
    const r = await runCommand(full(), ['echo', 'a && rm -rf /']);
    expect(r.stdout).toContain('a && rm -rf /');
  });
});

describe('文件读写', () => {
  it('读得到界内的文件', async () => {
    const r = await readTextFile(root, 'ok.txt');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('inside');
  });

  it('读不到界外的（含软链绕行）', async () => {
    expect((await readTextFile(root, '../secret/passwd.txt')).ok).toBe(false);
    expect((await readTextFile(root, 'escape/passwd.txt')).ok).toBe(false);
  });

  it('写得进界内，写不进界外', async () => {
    expect((await writeTextFile(root, 'sub/new.txt', 'hi')).ok).toBe(true);
    expect((await readTextFile(root, 'sub/new.txt')).ok).toBe(true);
    expect((await writeTextFile(root, '../secret/evil.txt', 'x')).ok).toBe(false);
    expect((await writeTextFile(root, 'escape/evil.txt', 'x')).ok).toBe(false);
  });

  it('超大内容拒绝写（不给上限会被一次调用塞爆磁盘）', async () => {
    const r = await writeTextFile(root, 'big.txt', 'x'.repeat(FILE_LIMITS.writeBytes + 1));
    expect(r.ok).toBe(false);
  });

  it('列目录只列一层，界外拒绝', async () => {
    const r = await listDir(root, '.');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain('ok.txt');
    expect((await listDir(root, '../secret')).ok).toBe(false);
  });

  it('目录当文件读时说清楚，而不是报个看不懂的错', async () => {
    const r = await readTextFile(root, 'sub');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('是目录');
  });
});
