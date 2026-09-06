'use client';

import Link from 'next/link';
import { Card } from '@/components/ui';
import { Icon } from '@/components/icons';
import { useI18n } from '@/lib/i18n';
import type { ReadinessReport, SourceReadiness as Row } from '@/lib/topic/readiness';

// 候选源就绪度（冷启动引导）。
//
// 冷启动实测：新用户第一天八个来源只有三个出货，差异化完全不可见。这块就是把「补什么数据能解锁什么」
// 明说出来，而不是指望用户自己悟。

const SOURCE_NAMES_EN: Record<string, string> = {
  hot: 'Trending Hotlist',
  competitor: 'Competitors',
  gap: 'Opportunity Gap',
  recycle: 'Revive Old Posts',
  crossplat: 'Cross-platform Syndicate',
  calendar: 'Content Calendar',
  evergreen: 'Evergreen Vault',
  inspiration: 'Inspiration Box',
  material: 'Material Library',
};

function getActionText(r: Row, lang: string): string {
  if (lang !== 'en') return r.action?.text ?? '';
  switch (r.key) {
    case 'hot': return 'Refresh hotlist aggregation';
    case 'competitor': return 'Track a competitor profile';
    case 'gap': return r.action?.href === '/persona' ? 'Set primary platforms in Persona' : 'Track more competitor accounts';
    case 'recycle': return 'Import past published works';
    case 'crossplat': return r.action?.href === '/persona' ? 'Add secondary platform in Persona' : 'Import or log published works';
    case 'calendar': return 'Add niche in Persona';
    case 'evergreen': return 'Add niche in Persona';
    case 'inspiration': return 'Save an inspiration item';
    case 'material': return 'Add materials to library';
    default: return r.action?.text ?? '';
  }
}

function getReasonText(r: Row, lang: string): string {
  if (lang !== 'en') return r.reason;
  switch (r.key) {
    case 'hot':
      return r.state === 'active'
        ? r.reason.replace('当前榜上', 'Currently ').replace('条词条正在参与筛选', ' entries participating in filtering')
        : 'Hotlist aggregation has not run yet';
    case 'competitor':
      return r.state === 'active'
        ? r.reason.replace('已订阅', 'Subscribed to ').replace('个同行，他们的高热作品会进候选池', ' competitors, top posts enter candidate pool')
        : 'No competitors tracked yet';
    case 'gap':
      if (r.state === 'active') return r.reason;
      if (r.reason.includes('人设里还没填主战平台')) return 'Primary platforms not filled in Persona; cannot determine spread lag';
      if (r.reason.includes('没有公开热榜可查')) return 'No public hotlist for platform; requires competitor samples';
      if (r.reason.includes('当前没有跨平台扩散中的话题')) return 'No cross-platform trending topics currently spreading';
      return r.reason;
    case 'recycle':
      return r.state === 'active'
        ? r.reason.replace('条旧作在等话题回温', ' past works waiting for topics to re-trend')
        : 'No historical works older than required days to revive';
    case 'crossplat':
      if (r.state === 'active') return r.reason.replace('已有基线，能挑出跑赢自己的那几条', ' has baseline, ready to pick outperforming posts');
      if (r.reason.includes('只经营一个平台')) return 'Only 1 platform managed; no secondary destination to syndicate';
      return 'Insufficient posts with view counts to calculate performance baseline';
    case 'calendar':
      return r.state === 'active'
        ? r.reason.replace('按「', 'Using "').replace('」代入节点选题', '" for content calendar topics')
        : 'Niche not specified in Persona; calendar topics fall back to generic';
    case 'evergreen':
      return r.state === 'active'
        ? r.reason.replace('已按「', 'Evergreen topics prepared for "').replace('」备好常青题库', '"')
        : 'Requires niche in Persona to generate evergreen topics';
    case 'inspiration':
      return r.state === 'active'
        ? r.reason.replace('收集箱里有', 'Inspiration box has ').replace('条待用', ' items ready to use')
        : 'Inspiration box is empty';
    case 'material':
      return 'Material library is empty — authentic experiences make your content unique';
    default:
      return r.reason;
  }
}

function StateRow({ r }: { r: Row }) {
  const { lang } = useI18n();
  const dormant = r.state === 'dormant';
  const name = lang === 'en' ? (SOURCE_NAMES_EN[r.key] ?? r.name) : r.name;
  const actionText = r.action ? getActionText(r, lang) : '';
  const reasonText = getReasonText(r, lang);

  return (
    <div className="row" style={{ gap: 10, alignItems: 'flex-start', padding: '8px 0' }}>
      <span style={{ flexShrink: 0, marginTop: 1 }}>
        {dormant ? <span className="small muted">⬜</span> : <Icon.check size={14} />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 8, alignItems: 'baseline' }}>
          <b className="small">{name}</b>
          <span className="small muted">{reasonText}</span>
        </div>
        {r.action && (
          <Link href={r.action.href} className="small" style={{ display: 'inline-block', marginTop: 2 }}>
            {actionText} →
          </Link>
        )}
      </div>
    </div>
  );
}

export function SourceReadinessCard({
  report,
}: {
  report: ReadinessReport & { material: Row | null };
}) {
  const { lang } = useI18n();
  const dormant = report.sources.filter((s) => s.state === 'dormant');
  const active = report.sources.filter((s) => s.state === 'active');
  const allDone = dormant.length === 0 && !report.material;

  return (
    <Card
      title={lang === 'en' ? 'Where Recommendations Come From' : '推荐从哪儿来'}
      sub={
        allDone
          ? (lang === 'en'
              ? `All ${report.active}/${report.total} sources are actively working for you`
              : `${report.active}/${report.total} 个来源都在为你工作`)
          : (lang === 'en'
              ? `${report.active}/${report.total} sources active — fulfill the items below to unlock the rest`
              : `${report.active}/${report.total} 个来源在工作 —— 补齐下面这些，剩下的才会开口`)
      }
      style={{ marginBottom: 16 }}
    >
      {allDone ? (
        <p className="small muted" style={{ margin: 0 }}>
          {lang === 'en'
            ? 'All 8 sources activated. Daily recommendations draw simultaneously from trending topics, competitors, historical works, content calendar, and inspiration inbox.'
            : '八个来源全部激活。每天的推荐会同时从热点、同行、你的历史作品、节点日历和收集箱里找机会。'}
        </p>
      ) : (
        <>
          {/* JSX 不解析 markdown，强调必须用 <b>——写 ** 会原样显示成星号（本文件踩过） */}
          <p className="small muted" style={{ marginTop: 0, marginBottom: 6, lineHeight: 1.7 }}>
            {lang === 'en' ? (
              <>
                Differentiated recommendations (&quot;Why You&quot;, &quot;Past Topic Revamp&quot;, &quot;Competitor Untouched&quot;)
                <b> require your own profile and performance data</b> to compute. Before data is populated, recommendations resemble a standard hotlist. Follow each item below to unlock tailored recommendations.
              </>
            ) : (
              <>
                推荐的差异化（「为什么是你」「你做过这个题」「同行还没做」）
                <b>全都要靠你自己的数据</b>才算得出来。数据没进来之前，你看到的会接近一个普通热榜。
                下面每一条都写清了缺什么、去哪补。
              </>
            )}
          </p>
          <div className="stack" style={{ gap: 0 }}>
            {dormant.map((r) => (
              <StateRow key={r.key} r={r} />
            ))}
            {report.material && <StateRow r={report.material} />}
          </div>

          {active.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="small" style={{ cursor: 'pointer', color: 'var(--brand)' }}>
                {lang === 'en'
                  ? `${active.length} active sources already running`
                  : `已经在工作的 ${active.length} 个来源`}
              </summary>
              <div className="stack" style={{ gap: 0, marginTop: 4 }}>
                {active.map((r) => (
                  <StateRow key={r.key} r={r} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </Card>
  );
}
