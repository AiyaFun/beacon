'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Empty, Stat } from '@/components/ui';
import { Icon } from '@/components/icons';
import { fmtNum } from '@/lib/format';
import { actRunJobNow } from '../settings/automation-actions';
import type { WeeklyReview } from '@/lib/insight/review';

import { useI18n } from '@/lib/i18n';

// 周度运营复盘卡。此前周报只走站内通知 + 机器人推送，在 app 里**没有任何入口**——
// 用户点开通知落到 /data 却找不到周报本体。这里把它显出来，顺带承载 R7「记住了你的 N 件事」。
export function WeeklyReviewCard({ review }: { review: WeeklyReview | null }) {
  const { lang } = useI18n();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');
  const router = useRouter();

  function generate() {
    start(async () => {
      setMsg('');
      const r = await actRunJobNow('weekly_review');
      if (r.ok) {
        setMsg(r.detail || (lang === 'en' ? 'Weekly review generated' : '周报已生成'));
        router.refresh();
      } else {
        setMsg(r.error || (lang === 'en' ? 'Failed to generate' : '生成失败'));
      }
    });
  }

  if (!review) {
    return (
      <Card
        title={lang === 'en' ? '📅 Weekly Performance Review' : '📅 周度运营复盘'}
        sub={lang === 'en' ? 'Auto-generated on Mondays · Requires at least 1 published post' : '每周一自动生成 · 本周发布满 1 篇即可产出'}
        style={{ marginBottom: 16 }}
      >
        <Empty icon="🗓" text={lang === 'en' ? 'No weekly review yet. Publish posts and sync metrics to auto-generate.' : '还没有周报——本周发布并回填数据后，下次周任务会自动生成'} />
        <div style={{ textAlign: 'center', marginTop: 10 }}>
          <button className="btn btn-sm btn-primary" onClick={generate} disabled={pending}>
            {pending ? (lang === 'en' ? 'Generating…' : '生成中…') : (lang === 'en' ? 'Generate Weekly Review Now' : '立即生成本周周报')}
          </button>
          {msg && (
            <span className="small" style={{ marginLeft: 8, color: msg.includes('失败') || msg.includes('Failed') ? 'var(--red)' : 'var(--green)' }}>
              {msg}
            </span>
          )}
        </div>
      </Card>
    );
  }

  const { deltaPct, recVsSelf: rv } = review;
  return (
    <Card
      title={lang === 'en' ? '📅 Weekly Performance Review' : '📅 周度运营复盘'}
      sub={lang === 'en' ? `${review.period} · Code computes stats, AI writes insights only` : `${review.period} · 代码算数据，AI 只写结论`}
      style={{ marginBottom: 16 }}
      action={
        review.mocked ? (
          <span className="badge badge-gray" title={lang === 'en' ? 'Mock conclusions; upper stats are real data' : '未接入真实模型，结论部分为示例文案；上方数字仍是你的真实数据'}>
            {lang === 'en' ? 'Mock Insights' : 'Mock 结论'}
          </span>
        ) : undefined
      }
    >
      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat label={lang === 'en' ? 'Published' : '本周发布'} value={review.published} foot={lang === 'en' ? 'posts' : '篇'} />
        <Stat
          label={lang === 'en' ? 'Avg Views' : '均播'}
          value={fmtNum(review.avgViews)}
          foot={
            deltaPct === null ? (
              (lang === 'en' ? 'No prior week data' : '上周无数据，无法环比')
            ) : (
              <span style={{ color: deltaPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {lang === 'en' ? 'WoW ' : '环比'}{deltaPct >= 0 ? '↑' : '↓'}
                {Math.abs(deltaPct)}%
              </span>
            )
          }
        />
        <Stat label={lang === 'en' ? 'Total Views' : '总播放'} value={fmtNum(review.totalViews)} foot={lang === 'en' ? 'This week' : '本周累计'} />
        <Stat
          label={lang === 'en' ? 'Recommended vs Self' : '推荐 vs 自选'}
          value={rv.liftPct === null ? '—' : `${rv.liftPct >= 0 ? '+' : ''}${rv.liftPct}%`}
          foot={rv.liftPct === null ? (lang === 'en' ? 'Insufficient samples' : '两边样本不足，不下结论') : (lang === 'en' ? `Rec ${rv.recCount} / Self ${rv.selfCount}` : `推荐 ${rv.recCount} 篇 / 自选 ${rv.selfCount} 篇`)}
        />
      </div>

      {(review.best || review.worst) && (
        <div className="stack small" style={{ gap: 4, marginBottom: 12 }}>
          {review.best && (
            <div>
              <span className="muted">{lang === 'en' ? 'Top: ' : '最佳：'}</span>《{review.best.title}》
              <span className="mono"> {fmtNum(review.best.views)}</span>
            </div>
          )}
          {review.worst && (
            <div>
              <span className="muted">{lang === 'en' ? 'Bottom: ' : '最弱：'}</span>《{review.worst.title}》
              <span className="mono"> {fmtNum(review.worst.views)}</span>
            </div>
          )}
        </div>
      )}

      {review.conclusions.length > 0 && (
        <div className="stack" style={{ gap: 4, marginBottom: 10 }}>
          <div className="small muted">{lang === 'en' ? 'Key Conclusions' : '本周结论'}</div>
          {review.conclusions.map((c, i) => (
            <div key={i} className="small">· {c}</div>
          ))}
        </div>
      )}

      {review.suggestions.length > 0 && (
        <div className="stack" style={{ gap: 4, marginBottom: 10 }}>
          <div className="small muted">{lang === 'en' ? 'Next Week Suggestions' : '下周建议'}</div>
          {review.suggestions.map((s, i) => (
            <div key={i} className="small">→ {s}</div>
          ))}
        </div>
      )}

      {/* R7 记忆可见化：让「系统到底记住了什么」每周露一次面，而不是只在 prompt 里悄悄用。
          逐字来自记忆库，不经 LLM 改写——复述一遍只会引入幻觉，那就不叫可见化了。 */}
      <div className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
        <div className="row" style={{ gap: 6, alignItems: 'center', marginBottom: 8 }}>
          <Icon.sparkles size={14} />
          <b className="small">{lang === 'en' ? `Beacon learned ${review.learned.length} things about you this week` : `烽火台这周记住了你的 ${review.learned.length} 件事`}</b>
        </div>
        {review.learned.length === 0 ? (
          <div className="small muted">
            {lang === 'en' ? 'No new or re-verified conclusions this week — memory grows only when backed by data.' : '本周没有新增或被再次验证的结论——记忆只在数据给出证据时才增长，宁可不记也不瞎记。'}
          </div>
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {review.learned.map((l, i) => (
              <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <span className="badge badge-gray" style={{ flexShrink: 0, fontSize: 11 }}>{l.typeName}</span>
                <span className="small" style={{ lineHeight: 1.6 }}>
                  {l.content}
                  {l.isNew ? (
                    <span className="muted"> · {lang === 'en' ? 'Learned this week' : '本周新学到'}</span>
                  ) : (
                    <span style={{ color: 'var(--green)' }}> · {lang === 'en' ? `Verified ${l.hitCount} times` : `第 ${l.hitCount} 次被验证`}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="small muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
          {lang === 'en'
            ? 'These conclusions are injected into topic selection, rewrites, and consultations — when advice says "Because you...", it refers to these. Manage or delete anytime in '
            : '这些结论会注入 AI 的选题、改稿与会诊——建议里出现「因为你…」时，指的就是它们。不认可的可以到 '}
          <a href="/persona" style={{ color: 'var(--brand)' }}>{lang === 'en' ? 'Persona & Memory' : '人设与记忆'}</a>
          {lang === 'en' ? '.' : ' 里改或删。'}
        </div>
      </div>
    </Card>
  );
}
