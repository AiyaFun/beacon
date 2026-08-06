import { parseJson, type Metrics } from '../json';

// 数据体检（纯函数）。检测发布记录里可能污染分析/复盘的脏数据，产出「问题 + 建议」，
// 交给用户一键确认处理——绝不静默改数据。可复盘的前提是数据可信、动过的地方有痕。

const DAY_MS = 86_400_000;
const STALE_DAYS = 30;
const DUP_TITLE_MIN = 4; // 太短的标题（如"更新"）不参与重复判定，避免误报

export type HealthRecord = {
  id: string;
  platform: string;
  title: string | null;
  publishedAt: Date;
  needsBackfill: boolean;
  metrics: string;
  snapshots: { takenAt: Date; metrics: string }[];
};

export type HealthIssueKind = 'missing_link' | 'duplicate' | 'anomaly' | 'stale';

export type HealthIssue = {
  kind: HealthIssueKind;
  severity: 'warn' | 'info';
  title: string;
  detail: string;
  refIds: string[]; // 涉及的发布记录 id（供 UI 定位/一键处理）
};

function viewsOf(raw: string): number {
  return parseJson<Metrics>(raw, {}).views ?? 0;
}

// 单篇快照里是否出现累计播放「倒退」（平台回收流量或数据源打架）——按 takenAt 升序检查
function hasNegativeGrowth(snapshots: { takenAt: Date; metrics: string }[]): boolean {
  const sorted = [...snapshots].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  let prev = -1;
  for (const s of sorted) {
    const v = viewsOf(s.metrics);
    if (prev >= 0 && v < prev * 0.9) return true; // 跌超 10% 视为存疑
    prev = Math.max(prev, v);
  }
  return false;
}

function normTitle(t: string | null): string {
  return (t ?? '').replace(/\s+/g, '').toLowerCase();
}

export function checkDataHealth(records: HealthRecord[], now: number): HealthIssue[] {
  const issues: HealthIssue[] = [];

  // 1) 缺发布链接：自动回流永不触发
  const missing = records.filter((r) => r.needsBackfill);
  if (missing.length > 0) {
    issues.push({
      kind: 'missing_link',
      severity: 'warn',
      title: `${missing.length} 篇缺发布链接`,
      detail: '没有作品链接就解析不出 ID，自动回流会跳过这些内容，数据一直为空。给它们补链接即可开始自动追踪。',
      refIds: missing.map((r) => r.id),
    });
  }

  // 2) 疑似重复：同平台 + 标题相同 + 发布日 ±1 天
  const dupIds = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i];
      const b = records[j];
      if (a.platform !== b.platform) continue;
      const ta = normTitle(a.title);
      if (ta.length < DUP_TITLE_MIN || ta !== normTitle(b.title)) continue;
      if (Math.abs(a.publishedAt.getTime() - b.publishedAt.getTime()) <= DAY_MS) {
        dupIds.add(a.id);
        dupIds.add(b.id);
      }
    }
  }
  if (dupIds.size > 0) {
    issues.push({
      kind: 'duplicate',
      severity: 'warn',
      title: `${dupIds.size} 条疑似重复记录`,
      detail: '同平台、同标题、发布时间相近——可能是同一篇被登记两次，会让基线与统计把它算两遍。建议核对后合并。',
      refIds: [...dupIds],
    });
  }

  // 3) 异常快照：累计播放倒退（数据存疑，图表应淡化）
  const anomalies = records.filter((r) => r.snapshots.length >= 2 && hasNegativeGrowth(r.snapshots));
  if (anomalies.length > 0) {
    issues.push({
      kind: 'anomaly',
      severity: 'info',
      title: `${anomalies.length} 篇存在数据回退`,
      detail: '累计播放出现明显下降（平台回收流量或多来源数据打架）。这些点在趋势图里会标为存疑，不影响原始留存。',
      refIds: anomalies.map((r) => r.id),
    });
  }

  // 4) 僵尸记录：发布超 30 天仍零数据
  const stale = records.filter(
    (r) => !r.needsBackfill && viewsOf(r.metrics) === 0 && now - r.publishedAt.getTime() > STALE_DAYS * DAY_MS,
  );
  if (stale.length > 0) {
    issues.push({
      kind: 'stale',
      severity: 'info',
      title: `${stale.length} 篇发布超 30 天仍无数据`,
      detail: '这些内容登记后一直没有回填任何指标，对分析已无价值。建议补一次数据或归档。',
      refIds: stale.map((r) => r.id),
    });
  }

  return issues;
}
