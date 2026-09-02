// 打整机版「服务代码包」→ public/downloads/ + appliance.manifest.json。
//
// 用法：npm run pack:appliance
//
// 这是**一键增量更新**的弹药：整机版客户点「检查更新」时读 appliance.manifest.json，
// 有新版就下这个 tar.gz、校验 sha256、原地覆盖代码，再跑 npm ci → db push → build → 重启。
// 「增量」指的是**只换代码、数据库与配置一动不动**，不是二进制差分——话要说准，
// 免得用户以为下的是几百 KB 的补丁包（见 lib/downloads.ts 的同名说明）。
//
// 【绝不进包的三类】
//   ① 密钥与数据：.env*、prisma/*.db、deploy/certs —— 覆盖到客户机器上等于把他的
//      主密钥和业务数据冲掉，这是不可逆事故；
//   ② 构建产物与依赖：node_modules、.next、desktop/target —— 客户端自己 npm ci + build，
//      带上它们包会大几百兆且平台相关（原生模块跨平台不通用）；
//   ③ 内部材料：deploy/private、docs/上线清单-*、.git —— 交付物里不该有内部方案。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { APPLIANCE_EXCLUDE } from '../lib/appliance/package-exclude';
import { notesForVersion } from '../lib/appliance/changelog';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'downloads');
const MANIFEST = join(OUT_DIR, 'appliance.manifest.json');


const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
mkdirSync(OUT_DIR, { recursive: true });

const outName = `beacon-appliance-${version}.tar.gz`;
const outPath = join(OUT_DIR, outName);
rmSync(outPath, { force: true });

// --exclude 必须在 -c 之前对 BSD tar 也成立；用 execFileSync 传数组，避免 shell 转义坑
const args = [
  '--no-xattrs',
  ...APPLIANCE_EXCLUDE.flatMap((p) => ['--exclude', p]),
  '-czf', outPath,
  '-C', ROOT, '.',
];
console.log('打包中（排除 %d 类路径）…', APPLIANCE_EXCLUDE.length);
execFileSync('tar', args, { stdio: ['ignore', 'inherit', 'inherit'] });

const size = statSync(outPath).size;
const sha256 = createHash('sha256').update(readFileSync(outPath)).digest('hex');

// 自查：包里绝不能出现 .env / 数据库文件。排除清单写错一条的后果是覆盖客户密钥，
// 光靠「我写了 --exclude」不够——**打完真的翻一遍包**。
const listed = execFileSync('tar', ['-tzf', outPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .filter(Boolean);
const leaked = listed.filter((f) =>
  /(^|\/)\.env($|\.)/.test(f) || /\.db($|-journal)/.test(f) || /deploy\/certs\//.test(f) || /(^|\/)\.git\//.test(f));
if (leaked.length > 0) {
  rmSync(outPath, { force: true });
  console.error('⛔ 包里混进了不该发的文件，已删除产物：\n' + leaked.slice(0, 20).join('\n'));
  process.exit(1);
}

// 更新说明：先是 CHANGELOG.md 里这一版的条目（客户点「检查更新」看到的正文），
// 再是自动列出的 SQL 迁移计数。
//
// 【没写说明就不许打包】版本号升了、CHANGELOG 没跟上 = 客户看到一个光秃秃的版本号，
// 不知道要不要更。这跟「版本没升更新送不出去」是同一类静默错——deploy-prepare 用硬闸
// 拦那一种，这里拦这一种。
const changelogPath = join(ROOT, 'CHANGELOG.md');
const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
const versionNotes = notesForVersion(changelog, version);
if (!versionNotes || versionNotes.length === 0) {
  rmSync(outPath, { force: true });
  console.error(`⛔ CHANGELOG.md 里没有 v${version} 的说明（要一个 \`## ${version}\` 段落和至少一条 \`- \` 条目）。已删除产物。`);
  process.exit(1);
}
const notes: string[] = [...versionNotes];

// 这一版要人工留意的事：新增的 SQL 迁移脚本自动列出来（整机版是 SQLite 走 db push，
// 这些 pg 脚本只对私有化 Postgres 有意义，但列出来让运维知道有结构变更）
const sqlDir = join(ROOT, 'prisma', 'postgres');
if (existsSync(sqlDir)) {
  const sqls = readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort();
  if (sqls.length > 0) notes.push(`结构变更脚本共 ${sqls.length} 份（私有化 Postgres 用；整机版 SQLite 由 db push 自动同步）`);
}

writeFileSync(
  MANIFEST,
  JSON.stringify({ version, file: `/downloads/${outName}`, sizeMB: Math.round((size / 1024 / 1024) * 10) / 10, sha256, notes }, null, 2) + '\n',
);

console.log(`\n产物 ${outName}（${Math.round(size / 1024 / 1024 * 10) / 10} MB，${listed.length} 个文件）`);
console.log(`sha256 ${sha256}`);
console.log(`写入 ${MANIFEST}`);
