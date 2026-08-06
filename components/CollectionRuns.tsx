import { platformName, platformColor } from '@/lib/constants';
import { relTime, fmtDate } from '@/lib/format';
import { Empty } from '@/components/ui';
import { CHANNEL_LABEL, type CollectionRunRow, type CollectionChannel } from '@/lib/ingest/collection-run';

// 采集台账的展示：一行一次抓取，重点是那句**「覆盖 X 到 Y」**。
// 自有数据与竞对数据共用这一张表，两边页面各自传自己的 rows。

/**
 * 覆盖区间的人话。三种情形分开说，别硬套同一句：
 *   · 一条都没采到 → 说「这次没采到内容」，硬说「覆盖 …」是骗人
 *   · 采到了但没有发布时间 → 如实说，绝不拿采集时间冒充发布时间
 *   · 正常 → 首尾 + 跨度天数（「采到没有」和「采了多久的」是两个问题）
 */
function coverText(r: CollectionRunRow): { text: string; muted: boolean } {
  if (r.items === 0) return { text: '这次没采到内容', muted: true };
  if (!r.coveredFrom || !r.coveredTo) return { text: '本批未带发布时间', muted: true };
  const a = fmtDate(r.coveredFrom);
  const b = fmtDate(r.coveredTo);
  if (a === b) return { text: `覆盖 ${a} 当天`, muted: false };
  const days = Math.max(1, Math.round((r.coveredTo.getTime() - r.coveredFrom.getTime()) / 86400000) + 1);
  return { text: `覆盖 ${a} – ${b}（${days} 天）`, muted: false };
}

export function CollectionRuns({
  rows,
  emptyText,
  showTarget = true,
}: {
  rows: CollectionRunRow[];
  emptyText: string;
  /** 单账号视图里账号名是废话，可以关掉 */
  showTarget?: boolean;
}) {
  if (rows.length === 0) return <Empty icon="🗂️" text={emptyText} />;

  return (
    <div className="stack" style={{ gap: 0 }}>
      {rows.map((r) => {
        const cover = coverText(r);
        return (
          <div key={r.id} className="list-row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="badge" style={{ background: 'var(--surface-2)', color: platformColor(r.platform) }}>
                  {platformName(r.platform)}
                </span>
                {showTarget && <b className="small">{r.targetName}</b>}
                <span className="small" style={{ color: cover.muted ? 'var(--text-3)' : 'var(--text)' }}>
                  {cover.text}
                </span>
              </div>
              <div className="small muted" style={{ marginTop: 2 }}>
                {r.items} 条
                {r.items > 0 ? `（新增 ${r.created} · 更新 ${r.updated}）` : ''} ·{' '}
                {CHANNEL_LABEL[r.channel as CollectionChannel] ?? r.channel} · {relTime(r.ranAt)}采集
                {r.note ? ` · ${r.note}` : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
