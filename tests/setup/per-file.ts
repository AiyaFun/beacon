import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach } from 'vitest';

// 每个测试文件跑一次，且**在被测模块被 import 之前**——这点是关键：
// lib/db.ts 在模块加载时就 new PrismaClient()，DATABASE_URL 必须此刻已经就位。
//
// 目录由 globalSetup 定、经环境变量传进来：**每次运行一个独立目录**。
// 写死成公共路径的话，机器上第二个 vitest 进程一启动就会把这一个正在用的库删掉
// （见 tests/setup/global-setup.ts 的长注释）。兜底值只在有人单独跑 per-file 时才会用到。
const dir = process.env.BEACON_TEST_DB_DIR || path.join(os.tmpdir(), 'beacon-vitest-db');
const dbFile = path.join(dir, `t-${process.pid}-${crypto.randomUUID()}.db`);

fs.copyFileSync(path.join(dir, 'template.db'), dbFile);
process.env.DATABASE_URL = `file:${dbFile}`;

// 兜底：测试进程一律按 dev 语义跑。需要生产态的用例自己 vi.stubEnv('NODE_ENV','production')。
// 否则 CI 上如果外部注入了 NODE_ENV=production，crypto 的 fail-fast 会把无关用例全打挂。
// @types/node 把 NODE_ENV 声明成只读，故绕一层写（vitest 默认也会设成 test，这里是防外部注入）。
(process.env as Record<string, string>).NODE_ENV = 'test';
delete process.env.BEACON_ENV;
delete process.env.BEACON_MASTER_KEY;
delete process.env.REDIS_URL;
delete process.env.BEACON_SMS_VENDOR;
delete process.env.BEACON_QUOTA_ENABLED;

// 热榜 60s 通道：非生产态本就默认离线走 Mock（见 lib/adapters/registry.ts），测试进程按 dev
// 语义跑（上面已置 NODE_ENV=test、删 BEACON_ENV），故默认零网络。这里再显式钉死 '0' 是护栏：
// 覆盖「某用例 stubEnv('NODE_ENV','production') 又忘了钉 60s 开关」这类漏网情形。
// 需要验证 60s 联网路径的用例自己 vi.stubEnv('BEACON_HOT60S','1') 并 stub 全局 fetch。
process.env.BEACON_HOT60S = '0';
delete process.env.BEACON_DAILYHOT_BASE_URL;

// ── 付费外部通道：本地 .env 配了真 key 时，绝不让 npm test 去打真实 API ──────────
//
// 为什么：大量用例断言的是 Mock 的确定性产物（mocked=true / 固定文案 / spy 打到 mock.complete），
// 真模型一接上就全红；而且慢（实测全量 29s → 251s）、花钱。
//
// ⚠️ 只在这里删**不够**：测试文件一旦 import 到 app/ 下的 server action，
// Next 的 @next/env 会在**导入时**把 .env 重新灌回 process.env——那已经在 setupFiles 之后了。
// 所以必须再挂一个 beforeEach 在每个用例前重擦一遍。provider 是调用时读 env（gateway.fromEnv），
// 故 beforeEach 这个时机足够。
// 要验真实通道请用一次性脚本，别让测试去烧额度；个别用例需要真实网关时自己 vi.stubEnv 注入。
// ⚠️ 只擦「来自 .env 文件的那个值」，不是无差别删除：不少用例会自己注入假 key 来验真实分支
// （如 export-chain 在 beforeAll 里设 BEACON_ANTHROPIC_API_KEY='sk-ant-stub' 再 stub fetch）。
// setupFiles 的 beforeEach 跑在用例 beforeAll 之后，无差别删会把这些故意注入的值一起擦掉。
// 按值比对就能区分：值 == .env 里的 → 是被 @next/env 灌回来的，删；值不同 → 是用例故意设的，留。
const PAID_ENV = [
  'BEACON_DEFAULT_LLM_API_KEY',
  'BEACON_DEFAULT_LLM_BASE_URL',
  'BEACON_EMBED_API_KEY',
  'BEACON_EMBED_BASE_URL',
  'BEACON_TIKHUB_KEY',
  'BEACON_NEWRANK_KEY',
  'BEACON_YOUTUBE_API_KEY',
  'BEACON_TWITTERAPI_KEY',
  'BEACON_ANTHROPIC_API_KEY',
  // ⚠️ 2026-08-13 补：这两条通道**此前不在擦除范围内**。
  // 它们各自有独立 key（取不到才回落 BEACON_DEFAULT_LLM_API_KEY），所以只擦 DEFAULT 挡不住。
  // 现在恰好没人配它们，一旦按 xhs-ai-cover 那套给即梦/豆包单独配上，
  // tests/llm/image.test.ts、tests/cover/prompt.test.ts、tests/video/analyze.test.ts
  // 就会开始打真实付费接口——烧钱 + 断言 mock 产物全红 + 全量耗时从秒级跳到分钟级。
  'BEACON_IMAGE_LLM_API_KEY',   // lib/llm/image.ts:91（即梦生图，按次计费）
  'BEACON_IMAGE_LLM_BASE_URL',
  'BEACON_VISION_LLM_API_KEY',  // lib/llm/gateway.ts:38（视频/封面分析）
  'BEACON_VISION_LLM_BASE_URL',
  // ⚠️ 短信比上面几条更要紧：打到真接口不只是烧钱，是**真的给真实手机号发出去**，
  //    而且撤不回来。之前一直不在这份清单里。
  'BEACON_VOLC_SMS_AK',
  'BEACON_VOLC_SMS_SK',
] as const;

// 直接读 .env 文件拿到「会被灌回来的那些值」。文件不存在（CI）时就没什么可擦的。
const envFileValues: Partial<Record<(typeof PAID_ENV)[number], string>> = {};
try {
  const raw = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  for (const k of PAID_ENV) {
    const m = new RegExp(`^${k}\\s*=\\s*"?([^"\\n]*)"?\\s*$`, 'm').exec(raw);
    if (m && m[1]) envFileValues[k] = m[1];
  }
} catch {
  /* 没有 .env 就没有可灌回的值 */
}

const scrubPaidEnv = () => {
  for (const k of PAID_ENV) {
    const fromFile = envFileValues[k];
    if (fromFile !== undefined && process.env[k] === fromFile) delete process.env[k];
  }
};
scrubPaidEnv();
beforeEach(scrubPaidEnv);

// 合规 DFA 缓存跨用例隔离：用例直接用 prisma 增删敏感词（绕过 app 层的 invalidateDfaCache），
// 若不在每例前清缓存，上一例 seed 的词库会串到下一例（同 cacheKey 命中旧树 → 漏检/误判）。
// 生产侧的失效由 app/(app)/compliance/actions.ts 各写入点显式调用保证，这里只覆盖测试的直写路径。
beforeEach(async () => {
  const { invalidateDfaCache } = await import('../../lib/compliance/engine');
  invalidateDfaCache();
});

afterAll(() => {
  for (const f of [dbFile, `${dbFile}-journal`]) fs.rmSync(f, { force: true });
});
