import { seedDemo } from '../lib/demo/seed';
import { prisma } from '../lib/db';

// 独立灌注演示（游客）租户数据。**不 wipe 任何真实数据**（幂等 upsert + 只清演示自身子数据）。
// 生产刷新演示数据用它，而不是跑会清库的 prisma/seed.ts。
async function main() {
  await seedDemo();
  console.log('✓ 演示（游客）租户数据已就绪：登录页「游客访问」可免注册体验示例数据（只读）。');
}

main()
  .catch((e) => {
    console.error('演示数据灌注失败：', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
