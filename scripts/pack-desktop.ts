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
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync, readdirSync } from 'node:fs';
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

// Mac：dmg 优先（拖进 Applications 的标准装法）
for (const [d, f] of findAll('dmg', (f) => f.toLowerCase().endsWith('.dmg'))) take(d, f, 'mac');
// Windows：msi 与 nsis(.exe) 都收，用户按习惯选
for (const [d, f] of findAll('msi', (f) => f.toLowerCase().endsWith('.msi'))) take(d, f, 'win');
for (const [d, f] of findAll('nsis', (f) => f.toLowerCase().endsWith('.exe'))) take(d, f, 'win');

// 合并：这次收到的覆盖同 os+arch+ext 的旧条目；旧版本号的其它平台条目
// **只在版本号没变时保留**——版本变了还留着上一版的 Windows 包，
// 下载页会把「1.2.0」的标题挂在 1.1.0 的文件上，那是骗人。
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

writeFileSync(MANIFEST, JSON.stringify({ name: '烽火台桌面客户端', version, builds }, null, 2) + '\n');
console.log(`\n写入 ${MANIFEST}`);
console.log(`版本 ${version}，共 ${builds.length} 个包：${builds.map((b) => `${b.os}/${b.arch}`).join('、')}`);
if (!builds.some((b) => b.os === 'win')) console.log('⚠️ 还没有 Windows 包——要在 Windows 机器上构建后再跑一次本脚本。');
if (!builds.some((b) => b.os === 'mac')) console.log('⚠️ 还没有 macOS 包——要在 Mac 上构建后再跑一次本脚本。');
