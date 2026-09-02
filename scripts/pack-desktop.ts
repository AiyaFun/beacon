// 收集桌面壳（Tauri）的构建产物 → public/downloads/ + desktop.manifest.json。
//
// 用法：先在**对应操作系统上**构建，再跑本脚本收集：
//   Mac：  cd desktop && npm run build     → 产物 src-tauri/target/release/bundle/dmg/*.dmg
//   Win：  cd desktop && npm run build     → 产物 src-tauri\target\release\bundle\{msi,nsis}\*
//   然后： npm run pack:desktop
//
// 【为什么是「收集」不是「构建」】各平台各自构建，本脚本**合并收集**——
// 已在清单里、这次没重新构建的平台**原样保留**（跨机器接力打包的唯一可行姿势）。
//
// 【交叉编译的实测边界，2026-08-27 在 Mac(Apple 芯片) 上验过】
//   · Windows 的 .exe 主程序**能**从 Mac 交叉编译出来（cargo-xwin + llvm-rc，产物是真的
//     PE32+ x86-64），但 Tauri 会打 "Cross-platform compilation is experimental" 警告；
//   · **安装包封装出不来**：NSIS 要 makensis（Homebrew 的 3.12 bottle 在 arm64 上是坏的，
//     连 4 行空脚本都 std::bad_alloc；源码重建被 Xcode 版本挡住），MSI 要 WiX（只能 Windows/wine）；
//   · 且交叉出来的包**无法在 Mac 上真机验证**。
//   结论：Windows 包老老实实在 Windows 机器或 CI（windows-latest）上构建，拷回来再跑本脚本。
//
// 【不做签名】Mac 公证要 Apple 开发者账号、Windows 代码签名要证书，两者都是用户持有的凭据。
// 未签名包首次打开要走「右键→打开」，下载页必须如实写明——不写的话用户会以为包坏了。

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'desktop', 'src-tauri', 'target');
// 产物可能落在两处：本机构建 target/release/bundle，交叉编译 target/<triple>/release/bundle。
// 只扫前者的话，从 Windows 机器拷回来的包、或 CI 下载下来的产物全都收不到。
const BUNDLE_DIRS = [join(TARGET, 'release', 'bundle')];
for (const d of (existsSync(TARGET) ? readdirSync(TARGET) : [])) {
  const p = join(TARGET, d, 'release', 'bundle');
  if (d !== 'release' && existsSync(p)) BUNDLE_DIRS.push(p);
}
const OUT_DIR = join(ROOT, 'public', 'downloads');
const MANIFEST = join(OUT_DIR, 'desktop.manifest.json');

type Os = 'mac' | 'win';
type Build = { os: Os; arch: string; file: string; ext: string; sizeMB: number; sha256: string };

function sha256(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

/** 从 Tauri 产出的文件名里认架构。认不出按当前进程架构兜底（构建就在本机发生）。 */
function archOf(name: string): string {
  if (/aarch64|arm64/i.test(name)) return 'aarch64';
  if (/x64|x86_64|amd64/i.test(name)) return 'x64';
  return process.arch === 'arm64' ? 'aarch64' : 'x64';
}

/** 在所有候选 bundle 目录下找某个子目录里的文件，返回 [目录, 文件名] 对。 */
function findAll(sub: string, match: (f: string) => boolean): [string, string][] {
  const out: [string, string][] = [];
  for (const base of BUNDLE_DIRS) {
    const dir = join(base, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (match(f)) out.push([dir, f]);
  }
  return out;
}

const version = (JSON.parse(readFileSync(join(ROOT, 'desktop', 'package.json'), 'utf8')) as { version: string }).version;
mkdirSync(OUT_DIR, { recursive: true });

// 先读旧清单：这次没构建的平台要原样留着（见文件头「跨机器接力」）
let prev: Build[] = [];
let prevVersion = '';
try {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { version: string; builds: Build[] };
  prevVersion = m.version;
  prev = Array.isArray(m.builds) ? m.builds : [];
} catch { /* 首次打包 */ }

// ── 同发闸（2026-09-01）────────────────────────────────────────────────
// 「两个一起发，版本号都要保持一致」是用户拍板的发布规则。而 deploy-prepare 每次都会跑本脚本：
// 只要 bundle 目录里躺着新版本的**某一个**平台（比如 mac 刚构建完、Windows 还没跑 CI），
// 清单就会被写成「新版本、缺平台」——下载页立刻少一个平台，老平台用户还会被提示去装一个
// 不存在的新版。2026-09-01 真发生：1.3.4 预备把清单写成了 1.2.5 只有 mac。
// 判据：**换版本**且收集到的平台集合是上一份清单平台集合的真子集 → 什么都不动，如实说明。
// 同版本的接力收集（跨机器分两次打进同一份清单）不受影响——那正是 keep 逻辑服务的场景。
const found: Build[] = [];

function take(srcDir: string, name: string, os: Os) {
  const src = join(srcDir, name);
  if (!statSync(src).isFile()) return;
  const ext = extname(name).slice(1).toLowerCase();
  const arch = archOf(name);
  const outName = `beacon-desktop-${version}-${os}-${arch}.${ext}`;
  copyFileSync(src, join(OUT_DIR, outName));
  const size = statSync(join(OUT_DIR, outName)).size;
  found.push({
    os, arch, ext,
    file: `/downloads/${outName}`,
    sizeMB: mb(size),
    sha256: sha256(join(OUT_DIR, outName)),
  });
  console.log(`收集 ${os}/${arch}: ${name} → ${outName}（${mb(size)} MB）`);
}

// 【只收当前版本的产物】Tauri 不清理上一版，bundle 目录里堆着历史包是常态。
// 2026-08-29 真出过事：nsis 目录里同时躺着 1.2.0 和 1.2.1 两个 exe，两个都被收进来、
// 写成同一个输出文件名，清单里就出现**两条 win/x64 且 sha256 不同**——第一条挂的是旧文件
// 的哈希，磁盘上却是后写的那个。用户照校验值一验，会以为下载的文件被人动过手脚。
// 版本对不上的一律不收：宁可某个平台缺席（页面会如实说「还没有」），也不能贴错标签。
const ofVersion = (f: string) => f.includes(version);

// Mac：dmg 优先（拖进 Applications 的标准装法）
for (const [d, f] of findAll('dmg', (f) => ofVersion(f) && f.toLowerCase().endsWith('.dmg'))) take(d, f, 'mac');
// Windows：msi 与 nsis(.exe) 都收，用户按习惯选
for (const [d, f] of findAll('msi', (f) => ofVersion(f) && f.toLowerCase().endsWith('.msi'))) take(d, f, 'win');
for (const [d, f] of findAll('nsis', (f) => ofVersion(f) && f.toLowerCase().endsWith('.exe'))) take(d, f, 'win');

// 合并：这次收到的覆盖同 os+arch+ext 的旧条目；旧版本号的其它平台条目
// **只在版本号没变时保留**——版本变了还留着上一版的 Windows 包，
// 下载页会把「1.2.0」的标题挂在 1.1.0 的文件上，那是骗人。
// 【兜底去重】同 os+arch+ext 只留一条。上面的版本过滤是第一道，这里防的是
// 「同一版本在两个 bundle 目录各有一份」这类情况——清单里出现两条同名不同哈希的记录，
// 比缺一个平台危险得多。
const dedup: Build[] = [];
for (const b of found) {
  const i = dedup.findIndex((x) => x.os === b.os && x.arch === b.arch && x.ext === b.ext);
  if (i >= 0) { console.warn(`⚠️ ${b.os}/${b.arch}.${b.ext} 收到多份，保留最后一份：${b.file}`); dedup[i] = b; }
  else dedup.push(b);
}
found.length = 0; found.push(...dedup);

if (version !== prevVersion && prev.length > 0) {
  const prevOses = new Set(prev.map((b) => b.os));
  const newOses = new Set(found.map((b) => b.os));
  const missing = [...prevOses].filter((o) => !newOses.has(o));
  if (missing.length > 0) {
    console.error(`⏸ 同发闸：v${version} 只收到 ${[...newOses].join('、') || '（无）'}，比线上 v${prevVersion} 少了 ${missing.join('、')}。`);
    console.error('  清单保持原样不动。等缺的平台构建好、产物放回 bundle 目录后，再跑一次本脚本即可两平台同发。');
    console.error('  确要单平台发布（明知故犯），设 BEACON_DESKTOP_ALLOW_PLATFORM_DROP=1 再跑。');
    if (process.env.BEACON_DESKTOP_ALLOW_PLATFORM_DROP !== '1') {
      // 已拷进 OUT_DIR 的新版文件顺手清掉——留着会被 rsync 传上去当孤儿
      for (const b of found) {
        try { rmSync(join(OUT_DIR, b.file.replace('/downloads/', ''))); } catch { /* 尽力 */ }
      }
      process.exit(0);
    }
  }
}

const keep = version === prevVersion
  ? prev.filter((p) => !found.some((f) => f.os === p.os && f.arch === p.arch && f.ext === p.ext))
  : [];
const builds = [...found, ...keep].sort((a, b) => (a.os === b.os ? a.arch.localeCompare(b.arch) : a.os < b.os ? -1 : 1));

if (builds.length === 0) {
  console.error(
    `没找到任何桌面产物（看过：${BUNDLE_DIRS.join('、')}）。\n` +
    `先在本机构建：cd desktop && npm run build\n` +
    `Mac 的 dmg 一步若失败，按 desktop/README.md 用 hdiutil 手动补一个再跑本脚本。`,
  );
  process.exit(1);
}

// ── 一键更新工件（2026-09-01）────────────────────────────────────────────
//
// 更新通道与下载页是两套载荷：下载页给人手装（mac=dmg / win=exe），
// 更新器吃的是 mac=.app.tar.gz、win=同一个 nsis exe，都要配一个 minisign 签名（.sig）。
//
// 【签名一律在这台打包机上重做，不信任何随包而来的 .sig】CI 里配的是仓库里的
// 一次性钥匙（desktop/ci-throwaway-updater.key，只为让打包器走完流程），它签出的 .sig
// 对客户端里钉死的真公钥毫无意义。收集时统一用真钥匙（deploy/private/signing/，
// 永不进 CI、永不进 rsync）重签——这样「假签名混进生产」在结构上就不可能，
// 而不是靠人记得别拷错文件。
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
// 真钥匙住 ~/.beacon-signing/（明文 minisign，不许进任何仓库树——树里签名目录只收加密凭据）
const UPDATER_KEY = join(homedir(), '.beacon-signing', 'tauri-updater.key');
const SITE = 'https://beacon.iyunci.cn';
const UPDATE_JSON = join(OUT_DIR, 'desktop-update.json');

type UpdatePlatform = { url: string; signature: string };
type UpdateManifest = { version: string; pub_date: string; platforms: Record<string, UpdatePlatform> };

function signWithRealKey(file: string): string {
  if (!existsSync(UPDATER_KEY)) {
    console.error(`⛔ 更新签名钥匙不在（${UPDATER_KEY}）。没有它就出不了可信的更新包——`);
    console.error('   这台机器若不是打包机，把产物拷回打包机再跑；钥匙本身绝不复制到别处。');
    process.exit(1);
  }
  // -f 是「钥匙文件路径」；-k 是「钥匙内容」——传错参数名会把路径当内容去解析，报错不知所云
  execFileSync('npx', ['tauri', 'signer', 'sign', '-f', UPDATER_KEY, '--password', '', file], {
    cwd: join(ROOT, 'desktop'), stdio: 'pipe',
  });
  return readFileSync(`${file}.sig`, 'utf8').trim();
}

const updatePlatforms: Record<string, UpdatePlatform> = {};

// mac：createUpdaterArtifacts 产出的 .app.tar.gz（与 dmg 同目录树的 macos/ 下）
for (const [d, f] of findAll('macos', (f) => f.endsWith('.app.tar.gz'))) {
  const arch = archOf(f) === 'x64' ? 'x86_64' : 'aarch64';
  const outName = `beacon-desktop-${version}-mac-${arch}.update.tar.gz`;
  copyFileSync(join(d, f), join(OUT_DIR, outName));
  updatePlatforms[`darwin-${arch}`] = {
    url: `${SITE}/downloads/${outName}`,
    signature: signWithRealKey(join(OUT_DIR, outName)),
  };
  console.log(`更新工件 mac/${arch}: ${f} → ${outName}（已用真钥匙重签）`);
}
// win：更新载荷就是 nsis exe 本身——签已收集进 OUT_DIR 的那一份（sig 跟着字节走，改名无碍）
for (const b of found.filter((x) => x.os === 'win' && x.ext === 'exe')) {
  const arch = b.arch === 'x64' ? 'x86_64' : b.arch;
  const local = join(OUT_DIR, b.file.replace('/downloads/', ''));
  updatePlatforms[`windows-${arch}`] = {
    url: `${SITE}${b.file}`,
    signature: signWithRealKey(local),
  };
  console.log(`更新工件 win/${arch}: 复用安装包（已用真钥匙重签）`);
}

// 与下载清单同样的接力语义：这次没构建的平台，同版本时从旧 update.json 原样保留
let prevUpdate: UpdateManifest | null = null;
try { prevUpdate = JSON.parse(readFileSync(UPDATE_JSON, 'utf8')) as UpdateManifest; } catch { /* 首次 */ }
if (prevUpdate && prevUpdate.version === version) {
  for (const [k, v] of Object.entries(prevUpdate.platforms)) {
    if (!updatePlatforms[k]) updatePlatforms[k] = v;
  }
}
if (Object.keys(updatePlatforms).length > 0) {
  const um: UpdateManifest = { version, pub_date: new Date().toISOString(), platforms: updatePlatforms };
  writeFileSync(UPDATE_JSON, JSON.stringify(um, null, 2) + '\n');
  console.log(`写入 ${UPDATE_JSON}（${Object.keys(updatePlatforms).join('、')}）`);
} else {
  console.log('⚠️ 这次没收到任何更新工件（.app.tar.gz / nsis exe）——一键更新清单未刷新。');
}

writeFileSync(MANIFEST, JSON.stringify({ name: '烽火台桌面客户端', version, builds }, null, 2) + '\n');
console.log(`\n写入 ${MANIFEST}`);
console.log(`版本 ${version}，共 ${builds.length} 个包：${builds.map((b) => `${b.os}/${b.arch}`).join('、')}`);
if (!builds.some((b) => b.os === 'win')) console.log('⚠️ 还没有 Windows 包——要在 Windows 机器上构建后再跑一次本脚本。');
if (!builds.some((b) => b.os === 'mac')) console.log('⚠️ 还没有 macOS 包——要在 Mac 上构建后再跑一次本脚本。');
