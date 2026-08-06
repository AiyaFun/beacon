import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// 端到端冒烟：登录 → 概览 → 技能中心 → 安装技能 → 选题生成，真实浏览器跑一遍。
// 这条路径此前只有人工点过（无自动化），是 VERIFICATION.md「没测到的·端到端」里的缺口。
//
// 首次运行前（依赖未装 + 浏览器未下）：
//   npm install                       # 装 @playwright/test
//   npx playwright install chromium   # 下浏览器（需要网络）
//   npm run setup                     # 准备种子库（敏感词/算法规则/内置技能）
//   npm run test:e2e
//
// webServer 用独立端口 3100，避免和你手动开的 dev(3000/3311) 打架；已在跑就复用。
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // 冒烟共用一个 dev 库，串行跑避免相互写脏
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: true,
    timeout: 120_000,
    // ⚠️ 必须是**绝对**路径。Prisma 把 `file:` 的相对路径解析成**相对 schema 目录**（prisma/），
    // 所以原来写的 `file:./prisma/dev.db` 实际指向 `prisma/prisma/dev.db`——那个文件不存在，
    // 整套 e2e 会在登录第一步就挂在「Unable to open the database file」。
    // tests/setup/global-setup.ts 里对同一个坑早有注释，e2e 这边此前漏了。
    env: { DATABASE_URL: process.env.DATABASE_URL ?? `file:${path.join(__dirname, 'prisma', 'dev.db')}` },
  },
});
