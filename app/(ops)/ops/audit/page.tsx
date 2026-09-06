import { prisma } from '@/lib/db';
import { PageHead, Card, Empty } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { parseJson } from '@/lib/json';
import { ADMIN_ACTION_LABEL, ADMIN_ACTION_LABEL_EN, type AdminAction } from '@/lib/ops/admin';
import { getServerLang } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 200;

// 审计日志：平台侧每个写动作的留痕。只读，没有任何删除入口——
// 能删的审计等于没有审计，这一条不留后门（要清理走 DB 保留期策略，不走界面）。
export default async function OpsAuditPage(props: { searchParams: Promise<{ action?: string }> }) {
  const lang = await getServerLang();
  const isEn = lang === 'en';
  const { action } = await props.searchParams;
  const where = action ? { action } : {};
  const logs = await prisma.adminAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: PAGE_SIZE });
  const actionLabels = isEn ? ADMIN_ACTION_LABEL_EN : ADMIN_ACTION_LABEL;

  return (
    <>
      <PageHead
        title={isEn ? 'Audit Log' : '审计日志'}
        desc={isEn ? `Last ${PAGE_SIZE} platform-side actions · Read-only & permanent` : `最近 ${PAGE_SIZE} 条平台侧动作 · 只读不可删`}
      />

      <form method="get" className="row" style={{ gap: 8, marginBottom: 16 }}>
        <select className="select" name="action" defaultValue={action ?? ''} style={{ maxWidth: 220 }}>
          <option value="">{isEn ? 'All Actions' : '全部动作'}</option>
          {Object.entries(actionLabels).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
        <button className="btn btn-sm" type="submit">{isEn ? 'Filter' : '筛选'}</button>
      </form>

      <Card>
        {logs.length === 0 ? (
          <Empty icon="🗂" text={isEn ? 'No records yet.' : '还没有记录。'} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>{isEn ? 'Time' : '时间'}</th>
                  <th style={{ width: 120 }}>{isEn ? 'Actor' : '操作人'}</th>
                  <th style={{ width: 150 }}>{isEn ? 'Action' : '动作'}</th>
                  <th style={{ width: 200 }}>{isEn ? 'Target' : '对象'}</th>
                  <th>{isEn ? 'Details' : '详情'}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="muted">{fmtDateTime(l.createdAt)}</td>
                    <td>{l.actorName}</td>
                    <td>{actionLabels[l.action as AdminAction] ?? l.action}</td>
                    <td>
                      <div>{l.targetLabel || '—'}</div>
                      <div className="small muted">{l.targetType} · {l.targetId}</div>
                    </td>
                    <td className="small muted" style={{ maxWidth: 420, wordBreak: 'break-all' }}>
                      {JSON.stringify(parseJson<Record<string, unknown>>(l.detail, {}))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
