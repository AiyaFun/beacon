// 整机版更新包的排除清单——**单一事实来源**。
//
// 为什么单独一个模块：它同时被两个地方引用（scripts/pack-appliance.ts 打包时用、
// 守卫测试逐条核对），而打包脚本是「顶层就执行」的脚本文件——测试 import 它会把包
// 重新打一遍（真发生过：测试跑一次产物就变一次）。常量放这里，脚本与测试各取所需。
//
// 【这份名单漏一条的后果是不可逆的】它决定了「哪些文件会被覆盖到客户机器上」：
//   .env* 漏了 → 客户的主密钥被冲掉，库里所有加密的 Key 再也解不开；
//   prisma/*.db 漏了 → 客户的全部业务数据被一个空库覆盖。
// deploy/appliance/update.sh 的 rsync --exclude 是同一份名单的第二层，两层都要有。
export const APPLIANCE_EXCLUDE: readonly string[] = [
  // ① 密钥与数据
  '.env', '.env.*', 'prisma/*.db', 'prisma/*.db-journal', 'prisma/*.db.bak-*',
  'deploy/certs', 'deploy/acme-webroot',
  // ② 构建产物与依赖（客户端自己 npm ci + build；原生模块跨平台不通用）
  'node_modules', '.next', '.next-verify', 'desktop/node_modules', 'desktop/src-tauri/target',
  'public/downloads', '.pack-stage',
  // ③ 内部材料（交付物里不该有内部方案）
  '.git', 'deploy/private', 'docs', 'heige-geo-seo',
  // 杂物
  '.DS_Store', '*.log', 'test-results', 'playwright-report',
];
