import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import {
  enqueueBrowserTask, claimNextTask, completeTask, releaseExpiredLeases, retryBrowserTaskNow, browserTaskWaitView,
  listBrowserTasksForUi, parseAttemptLog, backoffMinutesAfterFailure, needsUserAction,
  RETRY_BACKOFF_MINUTES, FIRST_FAILURE_GUARDED_BACKOFF_MINUTES, USER_ACTION_ERROR_HINTS, MAX_ATTEMPTS,
} from '@/lib/browser-task';

// 2026-09-15 真机：「帮我去采集 x 上的 aiyafun」跑了 11 分 21 秒——采集浏览器冷启动的第一次尝试 32 秒失败，
// 服务端按「失败退避 10 分钟」不许再领，第二次 20 秒采完。三处一起修：
//   ① 第一次失败不退避（要用户动手的除外；客户端已当场重试过的除外）；
//   ② 每次失败的原因留档（attemptLog，成功也不清），服务端同步落日志；
//   ③ 等待期间界面说清「第几次没成、几点自动重试」并给「现在重试」。
// 客户端那半（冷启动第一次失败原地重跑、第一次原因随结果交回）在 executor.rs，这里用源码守卫钉着。

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let wsId = '';
async function enq(): Promise<string> {
  const r = await enqueueBrowserTask({ workspaceId: wsId, payload: { kind: 'collect_competitor', competitorId: 'c1', limit: 5 }, createdBy: 'm1' });
  if (!r.ok) throw new Error(r.error);
  return r.id;
}
const rowOf = (id: string) => prisma.browserTask.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await prisma.tenant.deleteMany();
  await prisma.workspace.deleteMany();
  const t = await prisma.tenant.create({ data: { name: 't' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w' } });
  wsId = w.id;
});

describe('① 第一次失败不退避', () => {
  it('退避表：第一次 0、第二次 10；要用户动手的与客户端已当场重试过的第一次也退避', () => {
    expect(RETRY_BACKOFF_MINUTES[0]).toBe(0);
    expect(backoffMinutesAfterFailure(1, '页面一直没准备好（20 秒内拿不到执行上下文）')).toBe(0);
    expect(backoffMinutesAfterFailure(2, '页面一直没准备好')).toBe(RETRY_BACKOFF_MINUTES[1]);
    expect(backoffMinutesAfterFailure(1, '等你在采集浏览器里登录这个平台（登录墙），等了几分钟还没登上，这次先停了')).toBe(FIRST_FAILURE_GUARDED_BACKOFF_MINUTES);
    expect(backoffMinutesAfterFailure(1, '没登录')).toBe(FIRST_FAILURE_GUARDED_BACKOFF_MINUTES);
    expect(backoffMinutesAfterFailure(1, 'boom', true)).toBe(FIRST_FAILURE_GUARDED_BACKOFF_MINUTES);
    for (const hint of USER_ACTION_ERROR_HINTS) expect(needsUserAction(`x ${hint} y`), hint).toBe(true);
  });

  it('「解析器取不到内容」那句人话虽提到「还没登录」，只是提示，不算要用户动手（冷启动第一次失败的典型样子）', () => {
    expect(needsUserAction('解析器取不到内容：页面上能看到作品，但读不出正文与数据。最常见的原因是**采集浏览器还没登录这个平台**')).toBe(false);
    expect(needsUserAction('parser_stale')).toBe(false);
    expect(backoffMinutesAfterFailure(1, 'parser_stale')).toBe(0);
  });

  it('偶发失败：交回后立刻可再领；第二次失败才退避；第三次判死', async () => {
    const id = await enq();
    expect((await claimNextTask(wsId, 'A'))?.id).toBe(id);
    expect((await completeTask(wsId, id, { ok: false, error: '页面一直没准备好' }, 'A')).status).toBe('pending');
    expect((await rowOf(id)).leaseUntil, '第一次偶发失败不该有退避时间').toBeNull();
    expect((await claimNextTask(wsId, 'A'))?.id, '第一次偶发失败后应立刻能再领').toBe(id);

    expect((await completeTask(wsId, id, { ok: false, error: '页面一直没准备好' }, 'A')).status).toBe('pending');
    expect(await claimNextTask(wsId, 'A'), '第二次失败后应退避').toBeNull();
    const row = await rowOf(id);
    expect(row.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);

    await prisma.browserTask.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    expect((await claimNextTask(wsId, 'A'))?.id).toBe(id);
    expect((await completeTask(wsId, id, { ok: false, error: '页面一直没准备好' }, 'A')).status).toBe('failed');
    expect(parseAttemptLog((await rowOf(id)).attemptLog)).toHaveLength(MAX_ATTEMPTS);
  });

  it('登录墙：第一次失败也退避（立刻重试只会把登录页再弹到他面前）', async () => {
    const id = await enq();
    await claimNextTask(wsId, 'A');
    await completeTask(wsId, id, { ok: false, error: '等你在采集浏览器里登录这个平台（登录墙），等了几分钟还没登上' }, 'A');
    expect(await claimNextTask(wsId, 'A')).toBeNull();
  });

  it('客户端已当场重试过（retriedAfter）再失败：不再免退避，且两次都留档', async () => {
    const id = await enq();
    await claimNextTask(wsId, 'A');
    const r = await completeTask(wsId, id, { ok: false, error: 'no_handle', retriedAfter: '页面一直没准备好' }, 'A');
    expect(r.status).toBe('pending');
    expect(await claimNextTask(wsId, 'A'), '客户端已经原地试过一次，服务端不该再给一次免退避').toBeNull();
    const log = parseAttemptLog((await rowOf(id)).attemptLog);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ n: 1, inPlace: true, error: '页面一直没准备好', by: 'A' });
    // 内部错误码翻成人话后才落档
    expect(log[1].error).toContain('解析器没在这一页认出');
    expect(log[1].backoffMin).toBe(FIRST_FAILURE_GUARDED_BACKOFF_MINUTES);
  });
});

describe('② 每次失败的原因留档，成功也不清', () => {
  it('失败一次、成功一次：error 清空、status done，attemptLog 仍有第一次的原因', async () => {
    const id = await enq();
    await claimNextTask(wsId, 'A');
    await completeTask(wsId, id, { ok: false, error: '页面一直没准备好' }, 'A');
    await claimNextTask(wsId, 'A');
    expect((await completeTask(wsId, id, { ok: true, result: '新增 11 条' }, 'A')).status).toBe('done');
    const row = await rowOf(id);
    expect(row.status).toBe('done');
    expect(row.error).toBeNull();
    const log = parseAttemptLog(row.attemptLog);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ n: 1, error: '页面一直没准备好', by: 'A', backoffMin: 0 });
    expect(Date.parse(log[0].at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('成功但带 retriedAfter（客户端当场重试后成功）：那一次也留档并标 inPlace', async () => {
    const id = await enq();
    await claimNextTask(wsId, 'A');
    await completeTask(wsId, id, { ok: true, result: '新增 11 条', retriedAfter: 'no_handle' }, 'A');
    const row = await rowOf(id);
    expect(row.status).toBe('done');
    const log = parseAttemptLog(row.attemptLog);
    expect(log).toHaveLength(1);
    expect(log[0].inPlace).toBe(true);
    expect(log[0].error).toContain('解析器没在这一页认出');
  });

  it('租约静默过期也记一笔（否则用户只看到 attempts 在涨、原因是空的）', async () => {
    const id = await enq();
    await claimNextTask(wsId, 'A');
    await prisma.browserTask.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    expect(await releaseExpiredLeases()).toBe(1);
    const row = await rowOf(id);
    expect(row.status).toBe('pending');
    const log = parseAttemptLog(row.attemptLog);
    expect(log).toHaveLength(1);
    expect(log[0].error).toContain('租约到期');
    expect(log[0].by).toBe('A');
  });

  it('留档有上限，超了丢最旧的；每条错误截断', async () => {
    const id = await enq();
    const long = 'x'.repeat(1000);
    await prisma.browserTask.update({ where: { id }, data: { attemptLog: JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ n: i, at: 'a', error: `old${i}` }))) } });
    await claimNextTask(wsId, 'A');
    await completeTask(wsId, id, { ok: false, error: long }, 'A');
    const log = parseAttemptLog((await rowOf(id)).attemptLog);
    expect(log.length).toBeLessThanOrEqual(10);
    expect(log[log.length - 1].error.length).toBeLessThanOrEqual(300);
    expect(log[0].error).not.toBe('old0');
  });

  it('列表给界面带 leaseUntil 与 attemptLog', async () => {
    await enq();
    const rows = await listBrowserTasksForUi(wsId);
    expect(rows).toHaveLength(1);
    expect('leaseUntil' in rows[0]).toBe(true);
    expect('attemptLog' in rows[0]).toBe(true);
  });
});

describe('③ 等待视图 + 现在重试', () => {
  it('退避中：视图给 retryAt / lastError / log；点「现在重试」后立刻可领，视图随之变', async () => {
    const id = await enq();
    await claimNextTask(wsId, 'A');
    await completeTask(wsId, id, { ok: false, error: '没登录' }, 'A');
    const v = await browserTaskWaitView(wsId, id);
    expect(v?.status).toBe('pending');
    expect(v?.attempts).toBe(1);
    expect(v?.retryAt).toBeTruthy();
    expect(v?.lastError).toContain('没登录');
    expect(v?.log).toHaveLength(1);
    expect(await claimNextTask(wsId, 'B')).toBeNull();

    expect((await retryBrowserTaskNow(wsId, id)).ok).toBe(true);
    expect((await claimNextTask(wsId, 'B'))?.id).toBe(id);
    const v2 = await browserTaskWaitView(wsId, id);
    expect(v2?.status).toBe('claimed');
    expect(v2?.retryAt).toBeUndefined();
    expect(v2?.lastError).toBeUndefined();
  });

  it('正在跑的催不动、有结局的不改、别的工作区改不了、本来就可领的直接 ok', async () => {
    const id = await enq();
    expect((await retryBrowserTaskNow(wsId, id)).ok).toBe(true);
    await claimNextTask(wsId, 'A');
    const busy = await retryBrowserTaskNow(wsId, id);
    expect(busy.ok).toBe(false);
    expect(busy.error).toContain('正在跑');
    await completeTask(wsId, id, { ok: true, result: 'ok' }, 'A');
    expect((await retryBrowserTaskNow(wsId, id)).ok).toBe(false);
    const other = await prisma.workspace.create({ data: { tenantId: (await prisma.tenant.findFirstOrThrow()).id, name: 'o' } });
    expect((await retryBrowserTaskNow(other.id, id)).ok).toBe(false);
    expect(await browserTaskWaitView(other.id, id)).toBeNull();
  });
});

describe('🔒 接线守卫：三处都接上了（写了没接是这个仓库最常见的假绿）', () => {
  it('交活路由把 retriedAfter 传给 completeTask', () => {
    const src = strip(read('app/api/ingest/tasks/route.ts'));
    expect(src).toMatch(/body\.retriedAfter/);
    expect(src).toMatch(/completeTask\([^;]*retriedAfter/);
  });

  it('桌面执行器：只在冷启动那次原地重跑一次，且把第一次原因随结果交回', () => {
    const ex = strip(read('desktop/src-tauri/src/executor.rs'));
    const seg = ex.slice(ex.indexOf('async fn poll_and_run'), ex.indexOf('fn ensure_cdp'));
    expect(seg, '重跑必须只在冷启动且值得重跑时发生').toMatch(/cold && worth_inplace_retry/);
    expect(seg, '第一次的原因要随结果交回').toMatch(/"retriedAfter"/);
    expect(ex).toMatch(/fn worth_inplace_retry/);
    expect(strip(read('desktop/src-tauri/src/collect_browser.rs'))).toMatch(/pub fn ensure_reporting/);
    // 要用户动手的错误不原地重跑，措辞与服务端 USER_ACTION_ERROR_HINTS 对齐
    for (const s of ['等你在采集浏览器里登录', '所以读不到你的内容', '人机验证']) expect(ex, s).toContain(`"${s}"`);
    // 第二次也带硬超时（不是裸 execute）
    expect((seg.match(/execute_with_timeout\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('执行面板：等采集执行器时渲染等待卡与「现在重试」，点了之后叫桌面执行器来领并重读运行', () => {
    const p = strip(read('app/(app)/assistant/AgentPanel.tsx'));
    expect(p).toMatch(/turn\.waitingTask/);
    expect(p).toContain('现在重试');
    const i = p.indexOf('await actRetryBrowserTaskNow(');
    expect(i).toBeGreaterThan(-1);
    const after = p.slice(i, i + 900);
    expect(after).toMatch(/executor_kick/);
    expect(after).toMatch(/actGetAgentRun\(/);
  });

  it('执行记录：退避中的采集任务写清「第几次没成、几点自动重试」并带「现在重试」', () => {
    const v = strip(read('app/(app)/runs/RunsClientView.tsx'));
    expect(v).toMatch(/actRetryBrowserTaskNow\.bind/);
    expect(v).toMatch(/r\.retryAt/);
    const r = strip(read('lib/runs/index.ts'));
    expect(r).toMatch(/retryAt:/);
    expect(r).toMatch(/自动重试/);
    expect(r).toMatch(/leaseUntil: true/);
    const a = strip(read('app/(app)/runs/actions.ts'));
    expect(a).toMatch(/export async function actRetryBrowserTaskNow/);
    expect(a).toMatch(/retryBrowserTaskNow\(s\.workspaceId/);
  });

  it('两份 schema 都有 attemptLog，且有对应的生产 SQL', () => {
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      const s = read(f);
      const i = s.indexOf('model BrowserTask ');
      expect(s.slice(i, s.indexOf('\n}', i)), f).toMatch(/attemptLog\s+String\s+@default\("\[\]"\)/);
    }
    expect(read('prisma/postgres/60-browser-task-attempt-log.sql')).toMatch(/"BrowserTask" ADD COLUMN IF NOT EXISTS "attemptLog"/);
  });

  it('AgentTurn 带 waitingTask，viewOf 真去查了那条活', () => {
    const s = strip(read('lib/agent/run.ts'));
    expect(s).toMatch(/waitingTask\?:/);
    expect(s).toMatch(/browserTaskWaitView\(/);
  });

  it('每次失败服务端落一行日志（可重试的失败刻意不通知，排查只能靠它）', () => {
    const s = strip(read('lib/browser-task/index.ts'));
    const i = s.indexOf('export async function completeTask(');
    const body = s.slice(i, s.indexOf('\nexport ', i + 10));
    expect(body).toMatch(/log\.warn\('浏览器任务这次没跑成'/);
  });
});
