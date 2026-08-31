import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, between } from '../helpers/anchor';
import { SCHEDULES } from '@/lib/jobs/schedule-config';
import { JOB_TRACK } from '@/lib/jobs/types';

// 待支付订单对账（2026-08-30）。
//
// ── 缺陷 ──
// `syncOrderFromWechat` 的注释写着「回调丢了也能正常发货」，而它**唯一的生产调用点
// 是 actPollOrder**——也就是「用户正盯着二维码那个页面」。付完就关页面是最正常的操作，
// 回调再一丢（反代过滤 Wechatpay-* 头、5s 没应答完、公网抖动——它自己的注释就列着这几种），
// 那一单就永远停在 created：**钱收了，套餐永远不发**，而且没有任何地方会报错。
//
// 这与退款那侧是同一个形状（2026-08-29 查出 syncRefundFromWechat 零调用点）。
// 当时留下的注释还说「支付那侧是对称的，由 actPollOrder 轮询」——
// 那句话只在用户不关页面时成立。
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('待支付订单要有服务端对账', () => {
  const order = code('lib/pay/order.ts');

  it('🔒 reconcilePendingOrders 存在且真的去查微信', () => {
    expect(order).toContain('export async function reconcilePendingOrders');
    const body = between(order, 'export async function reconcilePendingOrders', '\n}');
    expect(body, '没有真的逐单查单，那就只是个空壳').toContain('syncOrderFromWechat(');
    expect(body, '只捞待支付的').toContain("status: 'created'");
    expect(body, '一轮要有上限，否则积压时会把这一轮拖垮').toContain('take: 200');
  });

  it('🔒 单条失败不连累这一轮其余的单', () => {
    const body = between(order, 'export async function reconcilePendingOrders', '\n}');
    expect(body).toMatch(/\.catch\(\(\) => null\)/);
  });

  it('🔒 真的挂上了定时（写了没接等于没做）', () => {
    const h = code('lib/jobs/handlers.ts');
    expect(h, 'handlers 里没有这个 job').toContain('reconcile_orders: async () =>');
    expect(h, 'handler 没调对账函数').toContain('reconcilePendingOrders()');
    const s = SCHEDULES.find((x) => x.name === 'reconcile_orders');
    expect(s, 'SCHEDULES 里没有它，worker 不会注册').toBeTruthy();
    expect(JOB_TRACK.reconcile_orders, '没进三轨归属表').toBe('broadcast');
  });

  it('🔒 比每日跑得勤（每天一次意味着让付过钱的人等 24 小时）', () => {
    const s = SCHEDULES.find((x) => x.name === 'reconcile_orders')!;
    const m = /^\*\/(\d+) \* \* \* \*$/.exec(s.cron);
    expect(m, `cron 是「${s.cron}」，不是分钟级的 */N —— 付了钱的人要等太久`).toBeTruthy();
    expect(Number(m![1])).toBeLessThanOrEqual(15);
  });

  it('🔒 cron 用 */N 而不是 range-step（整机版调度器不认后者，且不会报错）', () => {
    // 与 tick_agent_runs 那条同一个教训：`5-59/10` 在整机版上永远不跑
    for (const s of SCHEDULES) expect(s.cron, `${s.name} 用了 range-step`).not.toMatch(/\d+-\d+\//);
  });

  it('没有计费面的形态直接跳过（企业私有化版没有支付通道）', () => {
    const h = code('lib/jobs/handlers.ts');
    const body = between(h, 'reconcile_orders: async () =>', 'reconcilePendingOrders()');
    expect(body).toContain("editionCan('payment')");
  });
});

describe('二维码过期又没付的单要关掉', () => {
  const order = code('lib/pay/order.ts');

  it('🔒 关单要两个正向条件同时成立（只凭 null 关会误关还能付的单）', () => {
    const seg = between(order, "if (q.tradeState === 'NOTPAY'", 'return null;');
    expect(seg, '没要求查单确实返回了 NOTPAY').toContain("q.tradeState === 'NOTPAY'");
    expect(seg, '没要求二维码确实已经过期').toContain('codeExpiresAt');
    expect(seg).toContain("status: 'closed'");
  });

  it('🔒 关单仍带乐观锁（并发时不许把已兑现的单改成 closed）', () => {
    const seg = between(order, "if (q.tradeState === 'NOTPAY'", 'return null;');
    expect(seg, "少了 status:'created' 的条件，可能覆盖掉刚兑现的单").toContain("status: 'created'");
  });
});

describe('🔒 退款对账失败不许静默（这一版之前就是静默的）', () => {
  const h = read('lib/jobs/handlers.ts');

  it('catch 里要留声', () => {
    const seg = between(h, 'reconcilePendingRefunds().catch(', 'const now = new Date()');
    expect(seg, '又变回什么都不做的 catch 了').toContain('console.warn');
  });

  it('detail 要分得开「没跑成」与「没东西对」', () => {
    // 只写 `scanned > 0` 的话两者都印成空白 —— 那正是这次修的那个静默
    expect(h).toContain('refunds.scanned < 0');
    expect(before(h, '退款对账**没跑成**', 200)).toContain('scanned < 0');
  });
});

// ── 上一次失败的退款要能重试（2026-08-30 修）─────────────────────────────────
//
// createRefund 里两套机制打架：
//   · `existing` 检查**刻意**只拦 REFUND_RECONCILABLE ∪ {success}——failed / closed 是
//     允许重试的，函数头注释也写着「发起失败置 failed，不留孤儿」；
//   · 而单号由订单 id **确定性**派生、outRefundNo 又是唯一索引 → 重试必撞 P2002，
//     被一句「该订单已存在退款单，请勿并发/重复发起」挡回来——用户根本没有并发。
//
// 后果：一次网络抖动导致的 failed，就让这一单的自助退款**永久发不出去**，只能转人工。
// 而复用同号本来就是这份设计自己写的：「重试复用同号，天然满足微信按 out_refund_no 的幂等」。
describe('退款重试：失败的那一单不许被自己的唯一索引锁死', () => {
  const order = code('lib/pay/order.ts');
  const fn = between(order, 'export async function createRefund', '\nexport ');

  it('🔒 撞到已有单号时先看它是什么状态，而不是一律拒绝', () => {
    expect(fn, '没有先查已有的那一行').toContain('prisma.wxPayRefund.findUnique');
    expect(fn, '没有复用它').toContain('wxPayRefund.updateMany');
  });

  it('🔒 只复活 failed / closed（活跃态与已成功的绝不许被踩回 created）', () => {
    const seg = between(fn, 'wxPayRefund.updateMany', 'revived.count');
    expect(seg, '复活的条件里没限定状态——会把进行中甚至已成功的单踩回 created').toContain("status: { in: ['failed', 'closed'] }");
    expect(seg).toContain("status: 'created'");
  });

  it('🔒 复活也带状态条件（两行之间它可能被别的路径推走）', () => {
    const seg = between(fn, 'wxPayRefund.updateMany', 'revived.count');
    expect(seg, '少了 id + status 的双条件，就成了 check-then-act').toContain('id: stale.id');
  });

  it('🔒 复活落空时如实说它现在是什么状态，不说「请勿并发」', () => {
    const seg = between(fn, 'if (revived.count === 0)', 'findUniqueOrThrow');
    expect(seg).toContain('stale.status');
  });

  it('existing 快路径仍然只拦活跃态与已成功（failed/closed 要能走到重试）', () => {
    const seg = between(fn, 'const existing = await prisma.wxPayRefund.findFirst', 'if (existing)');
    expect(seg).toContain("[...REFUND_RECONCILABLE, 'success']");
    expect(seg, "把 failed 也拦进去就等于取消了重试").not.toContain("'failed'");
  });

  it('🔒 P2002 那条兜底还在（真并发时仍靠 DB 强制一单一退款）', () => {
    expect(fn).toContain("P2002");
  });
});

// ── 定时任务替用户跑的调用不算他消耗（2026-08-30 修）───────────────────────
//
// consumedCountForOrder 原来数的是租户名下**所有**非 Mock 调用，
// 而这些是系统替他跑的、他碰都没碰：daily_recommend(05:00)、optimize_memory(05:30)、
// generate_reviews(09:00)、weekly_review(周一 08:00)、run_scheduled_agents(每 10 分钟)。
//
// 于是：用户 23:00 买了 ¥2999 永久买断去睡觉，05:00 系统替他跑了一轮推荐，
// 早上他想退款 → consumedCount > 0 → 买断已用要转人工。
// 他什么都没做，睡了一觉，自助全额退款的权利就没了——而这是我们自己替他花掉的。
describe('退款「是否消耗」：只数用户自己用掉的', () => {
  const order = code('lib/pay/order.ts');

  it('🔒 判据里排除了定时任务发起的调用', () => {
    const fn = between(order, 'async function consumedCountForOrder', '\n}');
    expect(fn, '又把系统替他跑的算成他消耗了').toContain('byJob: null');
    expect(fn).toContain('mocked: false');
  });

  it('🔒 归因真的记进了账本（写了没接等于没做）', () => {
    const gw = code('lib/llm/gateway.ts');
    expect(gw, 'recordUsage 没记 byJob').toContain('byJob: currentJob()');
    const h = code('lib/jobs/handlers.ts');
    expect(h, 'withRun 没把任务名挂进上下文').toContain('runInJob(name, fn)');
  });

  it('🔒 用 AsyncLocalStorage 而不是模块级变量（否则会串味）', async () => {
    // worker 里定时任务与别的异步工作交错跑；整机版更是 worker 与 web 同进程。
    // 模块级的「当前任务名」会把用户当场发起的调用也标成定时任务的——
    // 那就从「少算消耗」变成了「多算」，方向正好反过来，而多退钱更难收场。
    const cur = code('lib/jobs/current.ts');
    expect(cur).toContain('AsyncLocalStorage');
    expect(cur, '出现了模块级的可变状态').not.toMatch(/^let\s+\w+/m);
  });

  it('归因在并发的异步上下文里不串（真跑一遍，不是只看代码）', async () => {
    const { runInJob, currentJob } = await import('@/lib/jobs/current');
    const seen: (string | null)[] = [];
    await Promise.all([
      runInJob('daily_recommend', async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(currentJob());
      }),
      runInJob('optimize_memory', async () => {
        seen.push(currentJob());
      }),
      // 用户当场发起的那条：不在任何 job 上下文里
      (async () => { await new Promise((r) => setTimeout(r, 2)); seen.push(currentJob()); })(),
    ]);
    // 【按集合比，不按顺序】三条是并发跑的，先后本来就不确定；
    // 而且 JS 的 sort 把 null 当字符串 "null" 排，会落在两个任务名中间。
    // 这条要验的是「各自看到自己的上下文、没有串味」，不是谁先谁后。
    expect(new Set(seen)).toEqual(new Set([null, 'daily_recommend', 'optimize_memory']));
    expect(seen, '有上下文串味或漏了一条').toHaveLength(3);
  });

  it('🔒 迁移与两份 schema 都在（漏一处生产就 P2022）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sql = readFileSync(join(process.cwd(), 'prisma/postgres/44-llm-by-job.sql'), 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "byJob"');
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      expect(readFileSync(join(process.cwd(), f), 'utf8'), `${f} 里没有 byJob`).toContain('byJob');
    }
  });
});
