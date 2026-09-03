import { defineConfig, configDefaults } from 'vitest/config';
import path from 'node:path';

// 单测配置。要点：
// 1. alias 必须与 tsconfig.json 的 paths 对齐（@/* → ./*），否则被测模块里的 @/ import 全挂。
// 2. setupFiles 里给每个测试文件独立的临时 SQLite 库 —— 绝不碰 prisma/dev.db（那是开发种子数据）。
// 3. 测试进程强制 dev 语义：生产态断言由用例自己用 vi.stubEnv 局部开启。
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './') },
  },
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./tests/setup/global-setup.ts'],
    setupFiles: ['./tests/setup/per-file.ts'],
    // 每个测试文件独立模块注册表：crypto.ts / provider.ts 都有模块级缓存，
    // 共享会让「先跑的用例污染后跑的」，隔离后才敢测 fail-fast。
    isolate: true,
    // e2e/ 是 Playwright 冒烟（.spec.ts + @playwright/test），不是 vitest 单测——排除，
    // 否则 npm test 会误抓它、import 一个没装的 @playwright/test 而崩。
    exclude: [...configDefaults.exclude, 'e2e/**', 'public/downloads/**'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.d.ts'],
    },
  },
});
