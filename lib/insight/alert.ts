import { prisma } from '../db';
import { parseJson, type Metrics } from '../json';
import { platformName } from '../constants';
import { automationAllows } from '../jobs/automation';
import { notify } from '../notify';
import { pushEvent, beaconUrl } from '../bot';
import { sendAlertSms } from '../sms/alert';
import { toDailySeries, type DaySeriesPoint } from './timeseries';
import { sameWindowBaseline } from './review';

// 爆款/异常预警。在快照落地处（backfill / 插件回传）触发：把本篇发布后第 N 天的累计播放
// 与账号同窗基线比，显著偏离就提醒。默认关（automationConfig.alerts，opt-in），每篇每级别只提醒一次。

const OVER_RATIO = 2; // ≥ 基线 2 倍 → 爆款加速
const UNDER_RATIO = 0.3; // ≤ 基线 0.3 倍 → 明显低于预期
const MIN_PEERS = 3;

function toSeries(snaps: { takenAt: Date; metrics: string; source: string | null; milestone: string | null }[], pub: Date): DaySeriesPoint[] {
  return toDailySeries(snaps.map((s) => ({ takenAt: s.takenAt, metrics: parseJson<Metrics>(s.metrics, {}), source: s.source, milestone: s.milestone })), pub);
}

// 返回触发的级别（'over'|'under'）或 null。旁路增强，任何异常静默吞掉不打断主流程。
export async function evaluateAndAlert(accountId: string, workspaceId: string, publishId: string): Promise<'over' | 'under' | null> {
  try {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { automationConfig: true } });
    if (!automationAllows(ws?.automationConfig, 'alerts')) return null; // 预警默认关

    // 每篇**每级别**只提醒一次。dedup key 必须带级别——只按 publishId 去重的话，
    // D+1 的「低于预期」会把 D+7 真正爆了时的「🚀 爆款加速」永久压掉，
    // 而后者恰恰是这个功能最值钱的一条提醒。
    // refId 在通知里本就充当 dedup key（weekly_review 存的是 period 而非对象 id），沿用该口径。
    const alerted = await prisma.notification.findMany({
      where: {
        workspaceId,
        kind: 'performance_alert',
        refId: { in: [`${publishId}:over`, `${publishId}:under`] },
      },
      select: { refId: true },
    });
    if (alerted.length >= 2) return null; // 两级都提醒过，后面的基线计算可以整个省掉
    const alertedLevels = new Set(alerted.map((a) => a.refId));

    const rec = await prisma.publishRecord.findFirst({
      where: { id: publishId, accountId },
      include: { snapshots: { orderBy: { takenAt: 'asc' }, select: { takenAt: true, metrics: true, source: true, milestone: true } } },
    });
    if (!rec) return null;
    const series = toSeries(rec.snapshots, rec.publishedAt);
    if (series.length < 1) return null;
    const dayN = series[series.length - 1].day;
    const myViews = series[series.length - 1].metrics.views ?? 0;
    if (myViews <= 0) return null;

    const peers = await prisma.publishRecord.findMany({
      where: { accountId, platform: rec.platform, id: { not: publishId } },
      include: { snapshots: { orderBy: { takenAt: 'asc' }, select: { takenAt: true, metrics: true, source: true, milestone: true } } },
      orderBy: { publishedAt: 'desc' },
      take: 30,
    });
    const bl = sameWindowBaseline(peers.map((p) => toSeries(p.snapshots, p.publishedAt)), dayN);
    if (bl.sample < MIN_PEERS || bl.avgAtDay <= 0) return null;

    const ratio = myViews / bl.avgAtDay;
    const level: 'over' | 'under' | null = ratio >= OVER_RATIO ? 'over' : ratio <= UNDER_RATIO ? 'under' : null;
    if (!level) return null;
    if (alertedLevels.has(`${publishId}:${level}`)) return null; // 这个级别已经提醒过

    const pName = platformName(rec.platform);
    const title = level === 'over' ? `🚀 爆款加速：《${rec.title ?? '未命名'}》` : `⚠ 低于预期：《${rec.title ?? '未命名'}》`;
    const body =
      level === 'over'
        ? `在${pName}发布后 D+${dayN} 累计播放 ${myViews}，是你同窗基线（${bl.avgAtDay}）的 ${Math.round(ratio * 10) / 10} 倍——趁热在黄金窗口加热/回评/追同款选题。`
        : `在${pName}发布后 D+${dayN} 累计播放 ${myViews}，仅为同窗基线（${bl.avgAtDay}）的 ${Math.round(ratio * 100)}%，建议复盘钩子与选题匹配度。`;

    await notify({ workspaceId, accountId, kind: 'performance_alert', refId: `${publishId}:${level}`, title, body, link: '/data' });
    await pushEvent(workspaceId, 'performance_alert', {
      kind: 'card',
      title,
      lines: [body],
      link: { text: '看数据看板', url: beaconUrl('/data') },
    });
    await sendAlertSms(`perf-${publishId}-${level}`, `${title} ${body}`.slice(0, 70));
    return level;
  } catch {
    return null;
  }
}
