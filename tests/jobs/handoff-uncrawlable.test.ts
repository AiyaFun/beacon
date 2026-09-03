import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 服务端采不到的竞对，定时任务要转手派给插件。
//
// 【这条守的是一个静默的洞】2026-08-24 生产实测：竞对作品按平台是
// douyin 622 / xiaohongshu 194 / x 63 / bilibili 37 / youtube 24，而
// **wechat 与 shipinhao 都是 0**——同时这两个平台上有 10 个竞对订阅。
// 有人订阅了竞对、一条数据都没拿到过，而系统一声不吭。
//
// 根因不是 bug 是**没有路**：公众号要商业源（生产没配 key），视频号没有官方接口。
// 但插件走得通（collect_competitor 早就实现好了），定时任务从来没把活交给它。

const { HANDLERS } = await import('@/lib/jobs/handlers');
const runCrawl = () => HANDLERS.crawl_competitors(undefined as never);

let wsId: string;
let tenantId: string;

beforeEach(async () => {
  vi.unstubAllEnvs();
  await prisma.browserTask.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.ingestToken.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();

  const t = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  tenantId = t.id;
  const ws = await prisma.workspace.create({ data: { tenantId: t.id, name: 'W' } });
  wsId = ws.id;
});

/** 订一个竞对。platform 决定服务端够不够得着。 */
async function watch(platform: string, name = platform) {
  const c = await prisma.competitorAccount.create({
    data: { platform, handle: `h-${name}-${Date.now()}${Math.floor(performance.now())}`, name },
  });
  await prisma.watchlistItem.create({ data: { workspaceId: wsId, competitorId: c.id } });
  return c;
}

/** 让这个工作区“装了插件”。 */
async function installCollector() {
  await prisma.ingestToken.create({
    data: { workspaceId: wsId, token: `bcn_${Date.now()}_${Math.random().toString(36).slice(2)}`, label: '测试设备' },
  });
}

const tasks = () => prisma.browserTask.findMany({ select: { kind: true, payload: true, origin: true, status: true } });

describe('服务端够不着的竞对要转派给插件', () => {
  it('公众号/视频号采不到 → 派活给插件', async () => {
    await watch('wechat');
    await installCollector();

    await runCrawl();

    const t = await tasks();
    expect(t.length, '公众号竞对没被转派 —— 用户订了却永远拿不到数据').toBe(1);
    expect(t[0].kind).toBe('collect_competitor');
    expect(t[0].origin, '来源要标成 schedule，跑动记录里才分得清是谁派的').toBe('schedule');
  });

  it('🔒 服务端采得到的平台不许转派（否则插件白跑一遍已有的数据）', async () => {
    // RSSHub 在链上时 bilibili 走得通（B 站没有别的服务端通道了，见 competitor-real.ts）
    vi.stubEnv('BEACON_RSSHUB_BASE_URL', 'http://rsshub.test:1200');
    vi.stubGlobal('fetch', async () => { throw new TypeError('network unreachable'); });
    await watch('bilibili');
    await installCollector();

    await runCrawl();
    expect(await tasks(), '服务端能采的也派给了插件').toHaveLength(0);
  });

  it('🔒 没装插件就不派（任务只会堆到过期，白占队列还吓人）', async () => {
    await watch('wechat');
    // 不装插件
    await runCrawl();
    expect(await tasks(), '没有采集端却排了活').toHaveLength(0);
  });

  it('🔒 每个工作区每轮封顶（采集是用户的浏览器在出力）', async () => {
    for (let i = 0; i < 6; i++) await watch('wechat', `号${i}`);
    await installCollector();

    await runCrawl();
    const n = (await tasks()).length;
    expect(n, `一轮塞了 ${n} 个活，等于占着用户的机器`).toBeLessThanOrEqual(3);
    expect(n, '一个都没派').toBeGreaterThan(0);
  });

  it('🔒 跑两轮不会越堆越多（同一个活复用 pending 那条）', async () => {
    await watch('wechat');
    await installCollector();

    await runCrawl();
    await runCrawl();
    expect(await tasks(), '每两小时排一条，插件没来领就堆成山').toHaveLength(1);
  });

  it('🔒 补上服务端的 key 之后自动停手（判据不是写死的平台名单）', async () => {
    await watch('wechat');
    await installCollector();
    // 配上公众号的商业源 key —— 服务端从此够得着，不该再麻烦用户的浏览器
    vi.stubEnv('BEACON_NEWRANK_KEY', 'test-key');

    await runCrawl();
    expect(await tasks(), '配了 key 还在派活，用户会看到插件一直采一个已经采好的号').toHaveLength(0);
  });

  it('演示工作区不派（它是只读展台，订阅是种子假数据）', async () => {
    const { DEMO_TENANT_ID, DEMO_WORKSPACE_ID } = await import('@/lib/demo/guard');
    await prisma.tenant.upsert({
      where: { id: DEMO_TENANT_ID },
      update: {},
      create: { id: DEMO_TENANT_ID, name: '演示', plan: 'personal' },
    });
    await prisma.workspace.upsert({
      where: { id: DEMO_WORKSPACE_ID },
      update: {},
      create: { id: DEMO_WORKSPACE_ID, tenantId: DEMO_TENANT_ID, name: '演示工作区' },
    });
    const c = await prisma.competitorAccount.create({
      data: { platform: 'wechat', handle: `demo-${Date.now()}`, name: '演示竞对' },
    });
    await prisma.watchlistItem.create({ data: { workspaceId: DEMO_WORKSPACE_ID, competitorId: c.id } });
    await prisma.ingestToken.create({
      data: { workspaceId: DEMO_WORKSPACE_ID, token: `bcn_demo_${Date.now()}`, label: '演示' },
    });

    await runCrawl();
    const n = await prisma.browserTask.count({ where: { workspaceId: DEMO_WORKSPACE_ID } });
    expect(n, '给演示工作区排了真实采集活 —— 那是只读展台').toBe(0);
  });
});
