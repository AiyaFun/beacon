import { Card, Empty } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { platformName } from '@/lib/constants';
import { AI_ANSWER_SITES } from '@/lib/geo/citation';

export type CitationRow = {
  id: string;
  engine: string;
  question: string;
  sourceTitle: string;
  sourceUrl: string;
  platform: string;
  isMine: boolean;
  capturedAt: Date;
};

/**
 * AI 引用回执。**刻意紧挨着上面那张「会不会被 AI 引擎抠走当答案」**——
 * 那张是第三方统计（别人替你算的），这张是你自己实测到的（第一方）。
 * 两张并排，「评分与真实被引用率零校准」这个病灶才第一次有了对照物。
 *
 * 【这张卡上不许出现任何百分比】它永远是样本不是统计：一次问一句、看一次结果。
 * 「引用率 33%」听起来像指标，其实是「问了 3 次中了 1 次」——
 * 这是这条路上最容易犯、也最难被发现的错。
 */
export function CitationCard({ rows, total, mine }: { rows: CitationRow[]; total: number; mine: number }) {
  const blocked = AI_ANSWER_SITES.filter((s) => s.expectBlocked);

  return (
    <Card
      title="AI 引用回执 · 你自己实测的"
      sub="上面那张是第三方统计口径；这张是你自己问出来、当场读回来的"
    >
      {total === 0 ? (
        <Empty text="还没有记录。在装了采集浏览器的那台电脑上，自己去问 AI 一句，然后让 AI 助手读那一页（record_ai_citation）。" />
      ) : (
        <>
          {/* 只报条目与计数，不报比率 */}
          <p className="small" style={{ margin: '0 0 10px', lineHeight: 1.9 }}>
            一共记下 <b>{total}</b> 条引用，其中 <b>{mine}</b> 条是你自己发过的。
            {mine === 0 && (
              <span className="muted">
                （这不能推出「你从不被引用」——记录还太少，它只是这几次这几问的结果。）
              </span>
            )}
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr><th>引擎</th><th>问的什么</th><th>引了什么</th><th>平台</th><th>时间</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{r.engine}</td>
                    <td className="small muted" style={{ maxWidth: 200 }}>{r.question || '—'}</td>
                    <td className="small" style={{ maxWidth: 260 }}>
                      {r.isMine && <span className="badge badge-brand" style={{ marginRight: 6 }}>你的</span>}
                      <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener">
                        {r.sourceTitle || r.sourceUrl}
                      </a>
                    </td>
                    <td className="small muted">{platformName(r.platform as never) || r.platform || '—'}</td>
                    <td className="small muted">{fmtDateTime(r.capturedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* 【必须说破哪条路走不通，否则它表现成「点了没反应」】 */}
      {blocked.length > 0 && (
        <p className="small muted" style={{ margin: '10px 0 0', lineHeight: 1.9 }}>
          <b>读不了的：</b>
          {blocked.map((s) => s.engine).join('、')}
          ——它们的 robots.txt <b>自己禁止抓取对话页</b>。我们不绕 robots，
          所以这条路是它关上的，不是这里坏了。
        </p>
      )}
      <p className="small muted" style={{ margin: '6px 0 0', lineHeight: 1.9 }}>
        <b>只读你自己问出来的那一页</b>——不会替你向任何 AI 提问。
      </p>
    </Card>
  );
}
