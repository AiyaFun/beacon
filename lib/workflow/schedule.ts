import { prisma } from '../db';
import { parseJson } from '../json';
import { beijingParts, beijingDayKey, beijingMinuteOfDay } from '../beijing';
import { runWorkflow } from './run';
import { notify } from '../notify';
import { pushEvent, beaconUrl } from '../bot';
import { createLogger } from '../logger';

const log = createLogger({ module: 'agent-schedule' });

// ── 定时智能体：让工作流模板按时自己跑 ──────────────────────────────────────
//
// 【为什么这件事必须先说风险】定时跑的是**会花钱的东西**：一条模板 3-4 步，
// 每步可能调模型或生图。手动点的时候用户看得见账单在涨；定时是他睡着的时候在跑。
// 所以三道闸是这个功能的**前提**，不是可选的加分项：
//
//   ① 每天每个工作区最多跑 MAX_RUNS_PER_DAY 次。防的是「配了 8 条计划全在早上 9 点」。
//   ② 连续失败 AUTO_PAUSE_FAILS 次自动停用并写明原因。防的是「一个坏模板每天准点烧一次配额」
//      ——它每次都失败，但失败之前该调的模型已经调了。
//      **停用必须同时告警**：定时是用户睡着时在跑，光把 enabled 改成 false 而不通知，
//      他要等到某天发现「昨天的稿子怎么没出」才知道，中间白停好几天。
//      同理「今天跑满了」也要说一次——那条计划今天没执行，不说等于静默吞掉。
//   ③ 同一逻辑日只跑一次（lastRunDay）。扫描是每 10 分钟一轮，只比时刻的话
//      一个 10 分钟窗口内会连开好几次。
//
// 【为什么不给用户写 cron】会写 cron 的是少数，而写错一个字段（把 `0 9 * * *` 写成 `* 9 * * *`）
// 就是一小时内跑 60 次。只给「几点几分 + 周几」，能表达的计划少了，能犯的错也少了。
//
// 【时区】一律北京时间（lib/beijing.ts）。容器跑 UTC，用运行环境本地时区算的话
// 「每天 9 点」在生产上是下午 5 点——这个坑项目里已经踩过两次。

/** 一个工作区一天最多跑几次定时智能体。 */
export const MAX_RUNS_PER_DAY = 5;

/** 连续失败多少次自动停用。 */
export const AUTO_PAUSE_FAILS = 3;

export type ScheduleRow = {
  id: string;
  workspaceId: string;
  accountId: string;
  /** 到点了派什么：workflow=流水线模板 | task=一条预设任务 */
  targetKind: string;
  /** targetKind='task' 时指向哪条预设任务 */
  taskPresetId: string | null;
  /** targetKind='task' 时为 null */
  templateId: string | null;
  atHour: number;
  atMinute: number;
  weekdays: number[];
  enabled: boolean;
  failStreak: number;
  lastRunDay: string | null;
};

/** 周几列表：空数组 = 每天。非法值一律丢掉，不让脏数据变成「永远不跑」或「天天跑」。 */
export function parseWeekdays(raw: string | null | undefined): number[] {
  const arr = parseJson<unknown>(raw, []);
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6))];
}

/**
 * 这条计划在 `now` 这一刻该不该跑。
 *
 * 纯函数，用例直接测——判错的两个方向都很贵：早跑一轮是白烧配额，
 * 漏跑一天用户第二天才发现「昨天的稿子没出」。
 */
export function shouldRun(row: ScheduleRow, now: Date, tickMinutes: number): boolean {
  if (!row.enabled) return false;

  const { day, month, year } = beijingParts(now);
  const today = beijingDayKey(now);
  if (row.lastRunDay === today) return false; // 今天跑过了

  // 周几：用北京时间的星期，不是 UTC 的。跨零点那几小时两者会差一天
  if (row.weekdays.length > 0) {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (!row.weekdays.includes(dow)) return false;
  }

  // 到点判定用「窗口」而不是「相等」：扫描每 tickMinutes 分钟一轮，
  // 要求分钟数正好相等的话，任何一次抖动/堆积都会让这一天整个跳过。
  const target = row.atHour * 60 + row.atMinute;
  const nowMin = beijingMinuteOfDay(now);
  return nowMin >= target && nowMin < target + tickMinutes;
}

/** 今天这个工作区已经跑了几次（闸①的判据）。 */
export async function runsToday(workspaceId: string, now = new Date()): Promise<number> {
  const today = beijingDayKey(now);
  return prisma.scheduledAgent.count({ where: { workspaceId, lastRunDay: today } });
}

export type TickResult = { scanned: number; ran: number; skipped: number; failed: number; paused: number };

/**
 * 扫一轮，把到点的计划跑掉。由 run_scheduled_agents 定时任务调用。
 *
 * **失败不抛**：一条计划炸了不能把整轮带走，否则排在它后面的工作区全被拖累。
 */
export async function tickScheduledAgents(now = new Date(), tickMinutes = 10): Promise<TickResult> {
  const out: TickResult = { scanned: 0, ran: 0, skipped: 0, failed: 0, paused: 0 };
  const { hour } = beijingParts(now);

  // 只捞这个小时和上一个小时的（窗口可能跨小时），别把全表拉出来
  const rows = await prisma.scheduledAgent.findMany({
    where: { enabled: true, atHour: { in: [hour, (hour + 23) % 24] } },
    take: 500,
  });
  out.scanned = rows.length;

  // runWorkflow 用 tenantId 校验模板归属（`OR: [{isBuiltin}, {tenantId}]`）。
  // 传空串的话**自建模板会被判成「模板不存在」**，只有内置的跑得起来——
  // 而定时最常配的恰恰是团队自己攒的那条。一次查完，别在循环里逐条查。
  const wsIds = [...new Set(rows.map((r) => r.workspaceId))];
  // templateId 现在可空（targetKind='task' 那种指的是预设任务）
  const tplIds = [...new Set(rows.map((r) => r.templateId).filter((v): v is string => !!v))];
  const [workspaces, templates] = await Promise.all([
    prisma.workspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, tenantId: true } }),
    prisma.workflowTemplate.findMany({ where: { id: { in: tplIds } }, select: { id: true, name: true, emoji: true } }),
  ]);
  const tenantOf = new Map(workspaces.map((w) => [w.id, w.tenantId]));
  // 推送与通知里要说清「是哪条计划」，只报 id 用户看不懂
  const tplName = new Map(templates.map((t) => [t.id, `${t.emoji} ${t.name}`]));
  // 预设任务那种要另查一遍名字（通知与推送里要说清「是哪条计划」，只报 id 用户看不懂）
  const presetIds = [...new Set(rows.map((r) => r.taskPresetId).filter((v): v is string => !!v))];
  const presets = presetIds.length
    ? await prisma.taskPreset.findMany({ where: { id: { in: presetIds } }, select: { id: true, title: true } })
    : [];
  const presetName = new Map(presets.map((p) => [p.id, `⚡ ${p.title}`]));
  /** 这条计划到点了派什么，给人看的一句话 */
  const nameOf = (r: { targetKind: string; templateId: string | null; taskPresetId: string | null }) =>
    (r.targetKind === 'task' ? presetName.get(r.taskPresetId ?? '') : tplName.get(r.templateId ?? ''))
    ?? '这条计划';

  for (const r of rows) {
    const row: ScheduleRow = { ...r, weekdays: parseWeekdays(r.weekdays) };
    if (!shouldRun(row, now, tickMinutes)) continue;

    // 闸①：每日次数上限。**先记 lastRunDay 再判**是错的——那样超限也会占掉名额；
    // 这里先判再跑，超限的计划留到明天，且如实记原因
    if ((await runsToday(r.workspaceId, now)) >= MAX_RUNS_PER_DAY) {
      out.skipped += 1;
      const why = `今天这个工作区的定时智能体已跑满 ${MAX_RUNS_PER_DAY} 次`;
      await prisma.scheduledAgent.update({
        where: { id: r.id },
        data: { lastStatus: 'skipped', lastError: why },
      });
      // 每条计划每天最多提醒一次（lastRunDay 之外它今天不会再进到这里，天然只发一次）
      await notify({
        workspaceId: r.workspaceId,
        accountId: r.accountId,
        kind: 'system',
        refId: r.id,
        title: '定时智能体今天没跑',
        body: `${nameOf(r)}：${why}。要么减少计划条数，要么把这条挪到别的时间。`,
        link: '/workflows',
      });
      continue;
    }

    // 抢占：先把 lastRunDay 写上再跑。跑到一半进程挂了也不会明天补跑两次，
    // 更不会同一轮里被另一个 worker 重复捡起
    await prisma.scheduledAgent.update({
      where: { id: r.id },
      data: { lastRunDay: beijingDayKey(now), lastRunAt: now, lastStatus: 'running', lastError: null },
    });

    // 【两种定时，两条路】
    //   task     —— 派一条预设任务（可能跑的是自主智能体）。**异步**：派完就返回，
    //               成败由 AgentRun 到终态时回写（lib/agent/preset.ts 的 reportScheduleOutcome）。
    //               不这么做的话连败自停闸永远不累加——派发那一刻它还没跑，拿不到结局。
    //   workflow —— 一条流水线模板（旧行为）。同步跑完，当场记账。
    if (r.targetKind === 'task') {
      const presetId = r.taskPresetId;
      if (!presetId) {
        await markBroken(r, '这条定时没指到任何一键任务', nameOf(r));
        out.failed += 1;
        continue;
      }
      try {
        const { dispatchPreset } = await import('../agent/preset');
        const d = await dispatchPreset(
          {
            tenantId: tenantOf.get(r.workspaceId) ?? '',
            workspaceId: r.workspaceId,
            accountId: r.accountId,
            memberId: r.createdBy,
            role: 'owner', // 定时按建它的人跑；真正的权限在 contextForRun 里按库现查
          },
          { presetId, origin: 'schedule', scheduledAgentId: r.id },
        );
        if (!d.ok) {
          await markBroken(r, d.error, nameOf(r));
          out.failed += 1;
          continue;
        }
        // 【刻意不在这里记成功】它才刚开始跑。记成 done 的话，
        // 一条每次都跑失败的定时会永远显示「上次跑成功了」
        out.ran += 1;
      } catch (err) {
        await markBroken(r, (err as Error).message.slice(0, 300), nameOf(r));
        out.failed += 1;
      }
      continue;
    }

    if (!r.templateId) {
      await markBroken(r, '这条定时没指到任何智能体', nameOf(r));
      out.failed += 1;
      continue;
    }

    try {
      const view = await runWorkflow(
        {
          tenantId: tenantOf.get(r.workspaceId) ?? '',
          workspaceId: r.workspaceId,
          accountId: r.accountId,
          memberId: r.createdBy,
          trigger: 'schedule',
        },
        r.templateId,
      );
      const ok = view.status === 'done';
      const bad = view.logs.find((l) => !l.ok);
      // 定时是**用户不在场时**跑的：跑完推一条，他早上打开手机就知道稿子备好了。
      // 不推的话这个功能只剩「省了点手点」，而它本该是「醒来就有产出」。
      // 推送失败不影响运行结果（pushEvent 自己吞异常），也不阻塞下一条计划。
      await pushEvent(r.workspaceId, 'agent_done', {
        kind: 'card',
        title: ok ? '定时智能体跑完了' : '定时智能体没跑完',
        lines: [
          `计划：${nameOf(r)}`,
          ok ? `${view.logs.length} 步全部完成` : `停在第 ${view.logs.length} 步：${(bad?.message ?? '未知原因').slice(0, 80)}`,
        ],
        // 机器人卡片里必须是**绝对地址**：飞书/钉钉客户端里点相对路径打不开
        link: { text: '去看运行记录', url: beaconUrl('/runs') },
      }).catch(() => {});
      // 【配额用完不算「坏模板」】闸②是为了停掉一条**永远跑不通**的计划。
      // 而「这个月额度用超了」是暂时的：下个月自己就好，把用户所有计划停掉反而要他一条条重开。
      // 靠 code 判断而不是匹配 message——文案一改字符串匹配就失效，而且失效得静悄悄。
      const quota = bad?.code === 'QUOTA_EXCEEDED';
      out[ok ? 'ran' : quota ? 'skipped' : 'failed'] += 1;
      await prisma.scheduledAgent.update({
        where: { id: r.id },
        data: {
          lastStatus: ok ? 'done' : quota ? 'skipped' : 'failed',
          lastError: ok ? null : (bad?.message ?? '未知原因').slice(0, 300),
          // 配额那次不累加：累加的话连续三天用超就把计划自动停了
          failStreak: ok || quota ? 0 : r.failStreak + 1,
        },
      });
      if (quota) {
        await notify({
          workspaceId: r.workspaceId,
          accountId: r.accountId,
          kind: 'system',
          refId: r.id,
          title: '定时智能体因额度不足没跑完',
          body: `${tplName.get(r.templateId) ?? '计划'}：${(bad?.message ?? '额度不足').slice(0, 160)} 计划仍然有效，额度恢复后会照常跑。`,
          link: '/workflows',
        });
      } else if (!ok && (await autoPauseIfBroken(r, r.failStreak + 1, nameOf(r)))) {
        out.paused += 1;
      }
    } catch (err) {
      out.failed += 1;
      const msg = (err as Error).message.slice(0, 300);
      log.warn('定时智能体跑失败', { id: r.id, error: msg });
      await prisma.scheduledAgent.update({
        where: { id: r.id },
        data: { lastStatus: 'failed', lastError: msg, failStreak: r.failStreak + 1 },
      });
      if (await autoPauseIfBroken(r, r.failStreak + 1, nameOf(r))) out.paused += 1;
    }
  }

  return out;
}

/**
 * 闸②：连续失败到阈值就停用**并告警**。返回是否真的停了。
 *
 * 告警不是可选项：这条计划从此不再跑，而用户完全不在场。不通知的话
 * 他下一次知道是「某天发现稿子没出」，中间已经白停了好几天。
 */
/** 这条定时这次没派出去：记下原因、累加连败、够数就停用。 */
async function markBroken(
  r: { id: string; workspaceId: string; accountId: string; failStreak: number },
  why: string,
  label: string,
): Promise<void> {
  await prisma.scheduledAgent.update({
    where: { id: r.id },
    data: { lastStatus: 'failed', lastError: why.slice(0, 300), failStreak: r.failStreak + 1 },
  });
  await autoPauseIfBroken(r, r.failStreak + 1, label);
}

export async function autoPauseIfBroken(
  row: { id: string; workspaceId: string; accountId: string },
  streak: number,
  name?: string,
): Promise<boolean> {
  if (streak < AUTO_PAUSE_FAILS) return false;
  // 名字必须带上：一个工作区最多 5 条计划，只说「定时智能体已自动停用」
  // 用户还得自己去页面一条条对，才知道是哪条坏了
  const why = `${name ?? '有一条定时计划'}：连续失败 ${streak} 次，已自动停用。修好之后在「智能体」页的定时任务里重新开启。`;
  await prisma.scheduledAgent.update({
    where: { id: row.id },
    data: { enabled: false, lastError: why },
  });
  await notify({
    workspaceId: row.workspaceId,
    accountId: row.accountId,
    kind: 'system',
    refId: row.id,
    title: '定时智能体已自动停用',
    body: why,
    link: '/workflows',
  });
  log.warn('定时智能体连续失败已自动停用', { id: row.id, streak });
  return true;
}
