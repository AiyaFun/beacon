// 打包「烽火台采集助手」浏览器插件 → 可上架商店的 zip + 下载页用的清单。
//
// 用法：npm run pack:ext
//
// 产物落在 public/downloads/（Next 静态托管，自托管兜底下载走这里）：
//   - beacon-collector-<version>.zip   ← 上架 Chrome 应用商店 / Edge Addons / 360 市场，直接传这个
//   - beacon-collector-latest.zip      ← 稳定别名，下载页兜底链接指向它（永远等于最新 zip）
//   - downloads.manifest.json          ← 版本/大小/sha256，下载页读它显示版本与校验值
//
// 为什么只出 zip 不出 crx：三大商店上传要的就是 zip；而裸 crx 双击安装在新版
// Chrome/Edge 上早已被封（只有企业策略或商店能装），所以 crx 不是分发主路径。
// 需要自托管 crx 的场景（企业内网强推），用 `chrome --pack-extension` 单独签名，
// 见 extension/store/PUBLISH.md，本脚本不手搓 CRX3 签名（易产出非法文件）。
//
// 打包白名单：只把真正要发的运行文件放进 zip——dev README、store 素材、.DS_Store
// 一律不进包，避免把内部材料/杂物带上商店。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = join(ROOT, 'extension');
const OUT_DIR = join(ROOT, 'public', 'downloads');
const STAGE_DIR = join(ROOT, '.pack-stage');

// 进包白名单：manifest 里 content_scripts 引用的目录 + 弹窗/设置/图标/后台脚本。
// 新增运行文件时要同步加进来，否则不会被打进 zip。
const INCLUDE = [
  'manifest.json',
  'sw.js',
  'popup.html',
  'popup.js',
  'options.html',
  'options.js',
  'icon16.png',
  'icon48.png',
  'icon128.png',
  'sidepanel.html', // manifest.side_panel.default_path 引用，漏了侧栏会整块打不开
  'sidepanel.js',
  'logo.png', // manifest.web_accessible_resources 引用
  'content', // 整个目录
];

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main() {
  const manifest = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8')) as {
    version: string;
    name: string;
  };
  const version = manifest.version;
  console.log(`📦 打包 ${manifest.name} v${version}`);

  // 1) 干净暂存：只拷白名单里的文件
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });
  for (const rel of INCLUDE) {
    const src = join(EXT_DIR, rel);
    if (!existsSync(src)) {
      console.error(`❌ 缺文件：extension/${rel}（白名单引用了它但目录里没有）`);
      process.exit(1);
    }
    cpSync(src, join(STAGE_DIR, rel), { recursive: true });
  }

  // 2) 打 zip（商店上传格式）。用系统 zip；-x 排除任何漏网的 .DS_Store。
  mkdirSync(OUT_DIR, { recursive: true });
  const zipName = `beacon-collector-${version}.zip`;
  const zipPath = join(OUT_DIR, zipName);
  const latestPath = join(OUT_DIR, 'beacon-collector-latest.zip');
  rmSync(zipPath, { force: true });
  rmSync(latestPath, { force: true });
  // 在暂存目录内打包，保证 zip 根就是插件根（商店要求 manifest.json 在压缩包根）。
  // 依赖系统 zip：Docker slim 镜像默认没有，已在 Dockerfile 装（apt install zip）。
  try {
    execFileSync('zip', ['-r', '-q', '-X', zipPath, '.', '-x', '*.DS_Store'], { cwd: STAGE_DIR });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') {
      console.error('❌ 找不到 `zip` 命令。本机装一个：macOS 自带 / Debian: apt-get install -y zip。');
      console.error('   （Docker 构建已在 Dockerfile 的 base 阶段装了 zip，本报错通常出现在裸机跑此脚本时。）');
    }
    throw e;
  }
  cpSync(zipPath, latestPath);

  // 3) 写下载清单：版本 + 大小 + 校验值，供下载页展示
  const size = statSync(zipPath).size;
  const hash = sha256(zipPath);
  const manifestOut = {
    name: manifest.name,
    version,
    zip: `/downloads/${zipName}`,
    latest: '/downloads/beacon-collector-latest.zip',
    bytes: size,
    sizeKB: Math.round(size / 1024),
    sha256: hash,
    builtAtNote: '构建时间见文件 mtime（脚本不写死时间戳，保证可复现构建）',
  };
  writeFileSync(join(OUT_DIR, 'downloads.manifest.json'), JSON.stringify(manifestOut, null, 2) + '\n');

  // 4) 清理暂存
  rmSync(STAGE_DIR, { recursive: true, force: true });

  console.log(`✅ 完成：public/downloads/${zipName}  (${manifestOut.sizeKB} KB)`);
  console.log(`   别名：public/downloads/beacon-collector-latest.zip`);
  console.log(`   sha256：${hash}`);
  console.log(`   上架：把这个 zip 传到 Chrome 应用商店 / Edge Addons / 360 市场（见 extension/store/PUBLISH.md）`);
}

main();
