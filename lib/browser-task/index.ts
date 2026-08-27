import { prisma } from '../db';
import { toJson, parseJson } from '../json';
import { createLogger } from '../logger';
import { notify } from '../notify';
import {
  browserTaskPayloadSchema, retriable, MAX_ATTEMPTS, TASK_TTL_HOURS, LEASE_MINUTES, KIND_LABEL,
  type BrowserTaskKind, type BrowserTaskPayload,
} from './kinds';

const log = createLogger({ module: 'browser-task' });

export * from './kinds';

// ── 派给浏览器的活 ──────────────────────────────────────────────────────────
//
// 【为什么是「排队等领」而不是「服务端推」】插件是浏览器扩展，服务端够不到它：
// 没有长连接、没有推送通道，用户的浏览器还可能整天关着。所以方向只能反过来——
// 服务端把活排进队列，插件醒来时（chrome.alarms / 用户打开页面）自己来问「有我的活吗」。
//
// 这条约束决定了三件事，别试图绕开：
//   ① **不能同步等**。AI 派完活就该继续做别的或如实告诉用户「已排队，等浏览器来领」，
//      而不是卡在那里等一个可能关着的浏览器。
//   ② **必须有过期**。排了没人领的活，等到用户三天后打开浏览器时早就没意义了。
//   ③ **必须有租约**。领了不还是常态（关标签页/关机/崩溃），没有租约那条活就永远卡在
//      claimed 上，而池子里看起来「有人在做」。

export type ClaimedTask = {
  id: string;
  kind: BrowserTaskKind;
  payload: BrowserTaskPayload;
  accountId: string | null;
  leaseUntil: string;
};

/**
 * 这个工作区有没有**能干活的浏览器**：至少一枚未吊销的采集令牌，或老式的工作区令牌。
 *
 * 【为什么派活前要问一句】没装插件的工作区，派下去的活会一直 pending 到 48 小时后过期，
 * 而 AI 那时已经跟用户说过「已排给插件」了——用户等了两天，什么都没发生，也没人告诉他为什么。
 * 与其排一个注定没人领的活，不如当场说清「你还没装插件」，并把他指到安装页。
 */
export async function hasCollector(workspaceId: string): Promise<boolean> {
  const [byDevice, legacy] = await Promise.all([
    prisma.ingestToken.count({ where: { workspaceId, revokedAt: null } }),
    prisma.workspace.count({ where: { id: workspaceId, ingestToken: { not: null } } }),
  ]);
  return byDevice > 0 || legacy > 0;
}

/** 排一个活。payload 先过 zod——白名单之外的 kind 与形状一律拒收。 */
export async function enqueueBrowserTask(input: {
  workspaceId: string;
  accountId?: string | null;
  payload: unknown;
  origin?: 'agent' | 'user' | 'schedule' | 'api';
  createdBy: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const parsed = browserTaskPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `任务参数不对（${first?.path.join('.') || 'kind'}：${first?.message ?? '格式错误'}）` };
  }

  // 同一个活别排两遍：pending 里已经有一模一样的就复用。
  // 不去重的话，AI 一轮里问两次「采一下这个竞对」就会排两个，插件跑两遍、数据也算两次
  const same = await prisma.browserTask.findFirst({
    where: {
      workspaceId: input.workspaceId,
      status: 'pending',
      kind: parsed.data.kind,
      payload: toJson(parsed.data),
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (same) return { ok: true, id: same.id };

  const t = await prisma.browserTask.create({
    data: {
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      kind: parsed.data.kind,
      payload: toJson(parsed.data),
      origin: input.origin ?? 'agent',
      expiresAt: new Date(Date.now() + TASK_TTL_HOURS * 3_600_000),
      createdBy: input.createdBy,
    },
  });
  return { ok: true, id: t.id };
}

/**
 * 插件来领活。一次只给一个——插件那边是串行跑的（开标签页、等加载、解析），
 * 一次给一批它也只能一个个做，反而让别的浏览器领不到。
 *
 * **防重复领**靠条件更新：`updateMany` 带上 `status: 'pending'`，
 * 两个浏览器同时来时只有一个的 count 会是 1。先 findFirst 再 update 是不行的
 *（那中间有窗口），这也是为什么这里不用 findFirst + update 的写法。
 */
export async function claimNextTask(workspaceId: string, claimerId: string): Promise<ClaimedTask | null> {
  const now = new Date();
  // 先把租约到期的放回池子：领了不还是常态，不放回就永远卡在 claimed
  await releaseExpiredLeases(now);

  const candidates = await prisma.browserTask.findMany({
    where: { workspaceId, status: 'pending', expiresAt: { gt: now } },
    orderBy: { createdAt: 'asc' }, // 先排的先做
    take: 5, // 抢失败就试下一个，不用把整池子拉出来
    select: { id: true, kind: true, payload: true, accountId: true },
  });

  for (const c of candidates) {
    const leaseUntil = new Date(Date.now() + LEASE_MINUTES * 60_000);
    const r = await prisma.browserTask.updateMany({
      // status 条件是**乐观锁**：另一个浏览器抢先一步的话这里 count=0，换下一个
      where: { id: c.id, status: 'pending' },
      data: { status: 'claimed', claimedBy: claimerId, claimedAt: now, leaseUntil, attempts: { increment: 1 } },
    });
    if (r.count === 1) {
      const payload = browserTaskPayloadSchema.safeParse(parseJson<unknown>(c.payload, {}));
      if (!payload.success) {
        // 库里躺着一条形状不合法的任务（多半是降级部署留下的）：直接判失败，
        // 别让插件领到一个它看不懂的活然后反复失败
        await prisma.browserTask.update({
          where: { id: c.id },
          data: { status: 'failed', error: '任务参数已不被当前版本识别' },
        });
        continue;
      }
      return {
        id: c.id,
        kind: c.kind as BrowserTaskKind,
        payload: payload.data,
        accountId: c.accountId,
        leaseUntil: leaseUntil.toISOString(),
      };
    }
  }
  return null;
}

/** 插件交活。ok=false 时按可重试性决定是放回池子还是判死。 */
export async function completeTask(
  workspaceId: string,
  taskId: string,
  outcome: { ok: boolean; result?: string; error?: string },
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const t = await prisma.browserTask.findFirst({
    where: { id: taskId, workspaceId },
    select: { id: true, kind: true, attempts: true, status: true },
  });
  // 带 workspaceId 查：不带的话拿到别人的任务 id 就能改别人的状态
  if (!t) return { ok: false, error: '任务不存在' };
  if (t.status !== 'claimed') {
    // 租约过期被放回、或用户中途取消了。如实回，别假装成功
    return { ok: false, error: `任务当前状态是 ${t.status}，不能交付` };
  }

  if (outcome.ok) {
    const row = await prisma.browserTask.update({
      where: { id: t.id },
      data: { status: 'done', result: (outcome.result ?? '').slice(0, 500), error: null, leaseUntil: null },
    });
    // 派活到干完中间可能隔了几小时（要等用户打开浏览器）。不通知的话，
    // 发起的人得自己想起来回去看——而他多半已经在做别的事了。
    // 同定时智能体那条：**用户不在场时完成的事，必须主动说一声**。
    await notify({
      workspaceId,
      accountId: row.accountId,
      kind: 'system',
      refId: row.id,
      title: `插件跑完了：${KIND_LABEL[row.kind as BrowserTaskKind] ?? row.kind}`,
      body: outcome.result?.slice(0, 200) || '已完成',
      link: '/runs',
    });
    // 有 AI 执行正停在这条活上等结果的话，把它叫醒接着推理（lib/agent/wake.ts）。
    // 动态 import：browser-task 是底层模块，静态引 agent 会绕成环。
    await wake(t.id, { ok: true, summary: outcome.result?.slice(0, 500) || '插件已经跑完了' });
    return { ok: true, status: 'done' };
  }

  const canRetry = retriable(t.kind as BrowserTaskKind) && t.attempts < MAX_ATTEMPTS;
  const failed = await prisma.browserTask.update({
    where: { id: t.id },
    data: {
      // 还能重试就放回池子等下一个浏览器（或同一个下一轮）
      status: canRetry ? 'pending' : 'failed',
      error: (outcome.error ?? '未说明原因').slice(0, 300),
      claimedBy: null,
      claimedAt: null,
      leaseUntil: null,
    },
  });
  // 还能重试就先不吵：下一轮多半就成了，每次失败都推一条只会让人把通知关掉。
  // 判死了才说——那时候用户是真的要去处理（多半是某个平台没登录）。
  if (!canRetry) {
    await notify({
      workspaceId,
      accountId: failed.accountId,
      kind: 'system',
      refId: failed.id,
      title: `插件没跑成：${KIND_LABEL[failed.kind as BrowserTaskKind] ?? failed.kind}`,
      body: `${(outcome.error ?? '未说明原因').slice(0, 160)}（已试 ${failed.attempts} 次）常见原因是目标平台没登录。`,
      link: '/runs',
    });
  }
  // 还能重试就别叫醒：下一轮多半就成了，这次叫醒等于让 AI 拿着「失败」去回答用户，
  // 而十分钟后数据其实就到了。判死了才叫——那时候才是真的没有结果。
  if (!canRetry) {
    await wake(t.id, { ok: false, summary: `插件没跑成：${(outcome.error ?? '未说明原因').slice(0, 200)}` });
  }
  return { ok: true, status: canRetry ? 'pending' : 'failed' };
}

/**
 * 叫醒等这条活的 AI 执行（如果有）。
 *
 * 【为什么用动态 import 且吞掉错误】① browser-task 是底层模块，静态 import lib/agent
 * 会绕成依赖环；② 叫醒失败不该把「交活」这件事带走——插件那边已经把数据传上来了，
 * 因为一次叫醒出错就回它一个失败，它会重试并再传一遍。
 */
async function wake(taskId: string, outcome: { ok: boolean; summary: string }): Promise<void> {
  try {
    const { wakeRunsWaitingOn, browserWaitToken } = await import('../agent/wake');
    await wakeRunsWaitingOn(browserWaitToken(taskId), outcome);
  } catch (err) {
    log.warn('叫醒等待中的 AI 执行失败', { taskId, error: (err as Error).message });
  }
}

/**
 * 用户取消一个还没做的活。
 *
 * 只允许取消 pending：claimed 的那条插件正在跑（标签页已经开了），
 * 从库里改成 cancelled 也停不下浏览器那边，只会让交活时撞上「状态不对」而白白重试。
 * 已结束的（done/failed/expired）取消它没有意义。
 */
export async function cancelBrowserTask(workspaceId: string, taskId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await prisma.browserTask.updateMany({
    // status 条件是必须的：不带它就能把插件正在做的那条改掉
    where: { id: taskId, workspaceId, status: 'pending' },
    data: { status: 'cancelled', error: '你取消了这个任务' },
  });
  if (r.count === 0) return { ok: false, error: '这个任务已经在跑或已结束，取消不了' };
  await wake(taskId, { ok: false, summary: '这个采集任务被取消了' });
  return { ok: true };
}

/**
 * 按**紧急度**排的顺序。
 *
 * 数据库的 `orderBy: status` 是字母序（cancelled < claimed < done < expired < failed < pending），
 * 正好把最该看的 pending 排到最后、把已经过期的排到前面——用户打开页面第一眼看到的
 * 是「三天前那条没跑成」，而不是「现在有一条等你打开浏览器」。排序要按人的紧急度来。
 */
const STATUS_RANK: Record<string, number> = {
  pending: 0, // 等你动手
  claimed: 1, // 正在跑
  failed: 2, // 要你看一眼为什么
  expired: 3, // 已经错过了，留着当记录
  done: 4,
  cancelled: 5,
};

/** 给「采集助手」页用：当前工作区的浏览器任务，按紧急度排。 */
export async function listBrowserTasksForUi(workspaceId: string, take = 12) {
  // 顺手把过期租约放回池子：用户打开这一页时看到的状态才是真的
  await releaseExpiredLeases();
  const rows = await prisma.browserTask.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true, kind: true, status: true, origin: true, attempts: true,
      result: true, error: true, expiresAt: true, createdAt: true,
    },
  });
  return rows.sort(
    (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || b.createdAt.getTime() - a.createdAt.getTime(),
  );
}

/** 租约到期的放回池子。每次领活前顺手做，不用单开定时任务。 */
export async function releaseExpiredLeases(now = new Date()): Promise<number> {
  const r = await prisma.browserTask.updateMany({
    where: { status: 'claimed', leaseUntil: { lt: now } },
    data: { status: 'pending', claimedBy: null, claimedAt: null, leaseUntil: null },
  });
  if (r.count > 0) log.info('浏览器任务租约到期已放回', { count: r.count });
  return r.count;
}

/**
 * 过期任务标记。由每日清理任务调用。
 *
 * 标 expired 而不是 failed：**没做**和**做失败**对用户是两件事——
 * 前者是「你的浏览器这两天没开」，后者是「采的时候出错了」，处置方式完全不同。
 */
export async function expireStaleTasks(now = new Date()): Promise<number> {
  // 先把要判过期的挑出来：updateMany 只回条数，不回是哪几条，而叫醒需要 id。
  const stale = await prisma.browserTask.findMany({
    where: { status: { in: ['pending', 'claimed'] }, expiresAt: { lt: now } },
    select: { id: true },
  });
  if (stale.length === 0) return 0;

  const r = await prisma.browserTask.updateMany({
    where: { id: { in: stale.map((t) => t.id) }, status: { in: ['pending', 'claimed'] } },
    data: { status: 'expired', error: '超过有效期仍未被浏览器执行（插件没打开过，或一直没登录目标平台）' },
  });
  // 等这些活的 AI 执行必须被告知「没等到」——否则它们会一直停在 waiting_browser 上，
  // 而用户看到的是一次永远「进行中」的任务
  for (const t of stale) {
    await wake(t.id, { ok: false, summary: '插件一直没来领这个活，已经超过有效期了（多半是那台浏览器这两天没打开）' });
  }
  return r.count;
}
