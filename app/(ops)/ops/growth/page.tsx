import { PageHead, Card, Stat } from '@/components/ui';
import { funnelSummary, FUNNEL_LABEL_EN, type FunnelEventName } from '@/lib/growth/funnel';
import { prisma } from '@/lib/db';
import { fmtNum } from '@/lib/format';
import { getServerLang } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

// 增长漏斗（2026-09-05）：陌生人从「看到首页」到「首次数据回流」走到哪一步、在哪一步走掉。
// 数字来自 FunnelEvent 表（lib/growth/funnel.ts），不接任何第三方统计。
export default async function OpsGrowthPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const lang = await getServerLang();
  const isEn = lang === 'en';
  const sp = await searchParams;
  const days = sp.days === '30' ? 30 : sp.days === '1' ? 1 : 7;
  const [f, referrals] = await Promise.all([
    funnelSummary(days),
    prisma.referralGrant.count({ where: { createdAt: { gte: new Date(Date.now() - days * 86_400_000) } } }),
  ]);
  const landing = f.steps[0]?.visitors ?? 0;
  const registered = f.steps.find((s) => s.name === 'register_ok')?.visitors ?? 0;
  const downloads = f.steps.find((s) => s.name === 'download_click')?.count ?? 0;

  return (
    <>
      <PageHead
        title={isEn ? 'Growth Funnel' : '增长漏斗'}
        desc={isEn ? `Last ${days} days · Unique visitors deduped by anon string, server events deduped by tenant · No IP / UA` : `最近 ${days} 天 · 独立访客按浏览器匿名串去重，服务端事件按租户去重 · 不记 IP / UA`}
        action={
          <span className="row" style={{ gap: 4 }}>
            {[1, 7, 30].map((d) => (
              <a key={d} href={`/ops/growth?days=${d}`} className={`btn btn-sm ${d === days ? 'btn-primary' : 'btn-ghost'}`}>{d} {isEn ? (d === 1 ? 'day' : 'days') : '天'}</a>
            ))}
          </span>
        }
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label={isEn ? 'Landing Visitors' : '看到首页的人'} value={fmtNum(landing)} foot={isEn ? 'Unique visitors (anon cookie)' : '独立访客（匿名串）'} />
        <Stat
          label={isEn ? 'Registered' : '注册成功'}
          value={fmtNum(registered)}
          foot={landing > 0 ? (isEn ? `${Math.round((registered / landing) * 1000) / 10}% of landing visitors` : `占首页访客 ${Math.round((registered / landing) * 1000) / 10}%`) : (isEn ? 'No visitors yet' : '首页还没有访客记录')}
        />
        <Stat
          label={isEn ? 'Download Clicks' : '下载点击'}
          value={fmtNum(downloads)}
          foot={f.downloads.map((d) => `${d.meta} ${d.count}`).join(' · ') || (isEn ? 'No downloads clicked yet' : '还没有人点下载')}
        />
        <Stat label={isEn ? 'Referral Signups' : '凭邀请码注册'} value={fmtNum(referrals)} foot={isEn ? 'ReferralGrant records' : 'ReferralGrant 记录数'} />
      </div>

      <Card title={isEn ? '8-Step Funnel' : '八步漏斗'} sub={isEn ? 'Conversion relative to previous step; denominator 0 shown as "—"' : '每一步相对上一步的转化率；分母为 0 显示「—」，不显示 0%'} style={{ marginBottom: 16 }}>
        <div className="tbl-wrap" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '8px 10px' }}>{isEn ? 'Step' : '步骤'}</th>
                <th style={{ textAlign: 'right', padding: '8px 10px' }}>{isEn ? 'Unique' : '独立数'}</th>
                <th style={{ textAlign: 'right', padding: '8px 10px' }}>{isEn ? 'Count' : '次数'}</th>
                <th style={{ textAlign: 'right', padding: '8px 10px' }}>{isEn ? 'vs Previous' : '相对上一步'}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 200 }}>{isEn ? 'vs Landing' : '相对首页'}</th>
              </tr>
            </thead>
            <tbody>
              {f.steps.map((s) => {
                const ofLanding = landing > 0 ? Math.min(100, (s.visitors / landing) * 100) : 0;
                const label = isEn ? (FUNNEL_LABEL_EN[s.name as FunnelEventName] ?? s.label) : s.label;
                return (
                  <tr key={s.name} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 10px' }}><b>{label}</b> <span className="small muted mono">{s.name}</span></td>
                    <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(s.visitors)}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right' }} className="muted">{fmtNum(s.count)}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right' }}>{s.fromPrevPct === null ? '—' : `${s.fromPrevPct}%`}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ width: `${ofLanding}%`, height: '100%', background: 'var(--brand)' }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 10, lineHeight: 1.7 }}>
          {isEn
            ? 'Between "Download Click" and "First Ingest" lies client setup and registration without callback, so conversion is lower. "SMS Code Sent" is recorded server-side without anon cookie, so it is a trend indicator rather than strict subset.'
            : '「点下载」与「首次数据回流」之间隔着安装与登记两步，客户端那侧没有回执，转化率会偏低；「发验证码」在服务端记、没有匿名串，与前两步不是同一批人的严格子集——看趋势，别当精确比例。'}
        </p>
      </Card>

      <div className="grid grid-2">
        <Card title={isEn ? 'Downloads Breakdown' : '下载去向'} sub={isEn ? 'download_click metadata' : 'download_click 的 meta'}>
          {f.downloads.length === 0 ? <div className="small muted">{isEn ? 'No downloads clicked yet.' : '还没有人点过下载。'}</div> : (
            <div className="stack" style={{ gap: 6 }}>
              {f.downloads.map((d) => (
                <div key={d.meta} className="row-between"><span className="mono small">{d.meta}</span><b>{fmtNum(d.count)}</b></div>
              ))}
            </div>
          )}
        </Card>
        <Card title={isEn ? 'Additional Events' : '补充事件'} sub={isEn ? 'Secondary indicators' : '不在主干里，但能说明问题'}>
          <div className="stack" style={{ gap: 6 }}>
            {f.extras.map((e) => {
              const label = isEn ? (FUNNEL_LABEL_EN[e.name as FunnelEventName] ?? e.label) : e.label;
              return (
                <div key={e.name} className="row-between"><span>{label} <span className="small muted mono">{e.name}</span></span><b>{fmtNum(e.count)}</b></div>
              );
            })}
          </div>
        </Card>
      </div>
    </>
  );
}
