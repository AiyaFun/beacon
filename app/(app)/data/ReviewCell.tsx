'use client';

import { useState, useTransition } from 'react';
import { actGenerateReview } from './actions';
import { platformName } from '@/lib/constants';
import type { ArticleReview } from '@/lib/insight/review';
import { useI18n } from '@/lib/i18n';

const VERDICT: Record<string, { labelZh: string; labelEn: string; cls: string }> = {
  over: { labelZh: '跑赢基线', labelEn: 'Beat Baseline', cls: 'badge-green' },
  meet: { labelZh: '达标', labelEn: 'Met Target', cls: 'badge-gray' },
  under: { labelZh: '低于基线', labelEn: 'Below Baseline', cls: 'badge-amber' },
};

// AI 单篇复盘触发 + 展示。确定性数据判定在服务端算好，这里只渲染。
export function ReviewCell({ publishId, stored = null }: { publishId: string; stored?: ArticleReview | null }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();
  const [review, setReview] = useState<ArticleReview | null>(stored);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  // 区分「这份是刚生成的」还是「从库里读出来的存量」——存量给个重新生成的入口
  const [fresh, setFresh] = useState(false);

  function run() {
    setErr('');
    start(async () => {
      const r = await actGenerateReview(publishId);
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      setReview(r.review);
      setFresh(true);
      setOpen(true);
    });
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <button className="btn btn-sm btn-ghost" disabled={pending} onClick={review ? () => setOpen((v) => !v) : run}>
          {pending
            ? (isEn ? 'AI Reviewing…' : 'AI 复盘中…')
            : review
              ? (open ? (isEn ? 'Hide Review' : '收起复盘') : (isEn ? 'View Review' : '看复盘'))
              : (isEn ? '🔮 AI Review' : '🔮 AI 复盘')}
        </button>
        {/* 存量复盘可能是几天前的数据算的，给一个显式的重算入口（重算才花额度） */}
        {review && !fresh && (
          <button
            className="btn btn-sm btn-ghost"
            disabled={pending}
            onClick={run}
            title={isEn ? 'Regenerate with latest metrics (consumes 1 AI quota)' : '按最新数据重新生成（会消耗一次 AI 额度）'}
            style={{ fontSize: 11, opacity: 0.75 }}
          >
            {isEn ? 'Regenerate' : '重新生成'}
          </button>
        )}
      </div>
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
      {review && open && <ReviewReport review={review} isEn={isEn} />}
    </div>
  );
}

function ReviewReport({ review, isEn }: { review: ArticleReview; isEn?: boolean }) {
  const v = VERDICT[review.verdict] ?? VERDICT.meet;
  return (
    <div className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)', minWidth: 320, maxWidth: 420 }}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 6, alignItems: 'center' }}>
        <span className={`badge ${v.cls}`}>{isEn ? v.labelEn : v.labelZh}</span>
        <span className="badge badge-gray">{review.shapeLabel}</span>
        {review.mocked && (
          <span className="badge badge-amber" title={isEn ? 'AI not connected, demo content' : 'AI 未接入，为演示内容'}>
            {isEn ? 'Demo' : '示例'}
          </span>
        )}
      </div>
      <div className="small" style={{ fontWeight: 600, marginBottom: 6, lineHeight: 1.5 }}>{review.headline}</div>

      {review.baselineCompare && (
        <div className="small muted" style={{ marginBottom: 6 }}>
          {isEn ? `D+${review.baselineCompare.dayN} total ` : `D+${review.baselineCompare.dayN} 累计 `}
          <b className="mono" style={{ color: 'var(--text)' }}>{review.baselineCompare.value.toLocaleString()}</b>
          {' '}{isEn ? 'vs baseline ' : 'vs 同窗基线 '}
          <b className="mono">{review.baselineCompare.baselineAvg.toLocaleString()}</b>
          {' '}({review.baselineCompare.sample} {isEn ? 'posts' : '篇'}, {review.baselineCompare.ratioPct >= 0 ? '+' : ''}{review.baselineCompare.ratioPct}%)
        </div>
      )}
      {!review.dataComplete && (
        <div className="small" style={{ color: 'var(--amber)', marginBottom: 6 }}>
          {isEn
            ? `Data covers ${review.coverage.have}/7 days. Add daily metrics for complete review.`
            : `数据点覆盖 ${review.coverage.have}/7 天，先补足逐日数据可出完整复盘`}
        </div>
      )}
      {review.shapeReason && <div className="small muted" style={{ marginBottom: 8 }}>{review.shapeReason}</div>}

      {review.causes.length > 0 && (
        <div className="stack" style={{ gap: 4, marginBottom: 8 }}>
          <div className="small muted">{isEn ? 'Causal Analysis' : '成因分析'}</div>
          {review.causes.map((c, i) => (
            <div key={i} className="small" style={{ lineHeight: 1.5 }}>
              <span className={`badge ${c.evidence === 'data' ? 'badge-green' : 'badge-gray'}`} style={{ fontSize: 11, marginRight: 6 }}>
                {c.evidence === 'data' ? (isEn ? 'Data' : '数据') : (isEn ? 'Inferred' : '推测')}
              </span>
              {c.factor}
            </div>
          ))}
        </div>
      )}

      {review.suggestions.length > 0 && (
        <div className="stack" style={{ gap: 4, marginBottom: 8 }}>
          <div className="small muted">{isEn ? 'Action Items Next Time' : '下次可做'}</div>
          {review.suggestions.map((sg, i) => (
            <div key={i} className="small" style={{ lineHeight: 1.5 }}>· {sg}</div>
          ))}
        </div>
      )}

      {review.decisionChain && <DecisionTrace chain={review.decisionChain} platform={review.platform} isEn={isEn} />}
    </div>
  );
}

// 决策回溯：这条内容从「为什么做」到「结果如何」的链路
function DecisionTrace({ chain, platform, isEn }: { chain: NonNullable<ArticleReview['decisionChain']>; platform: string; isEn?: boolean }) {
  const srcLabel =
    chain.sourceType === 'advisor'
      ? (isEn ? 'Council Proposal' : '智囊团提案')
      : chain.sourceType === 'hot'
        ? (isEn ? 'Hot Trend' : '热点选题')
        : chain.sourceType === 'competitor'
          ? (isEn ? 'Competitor Benchmark' : '竞品对标')
          : (isEn ? 'Manual' : '自选');
  return (
    <div style={{ borderTop: '1px dashed var(--border)', paddingTop: 8 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>{isEn ? '🧭 Decision Trace' : '🧭 决策回溯'}</div>
      <div className="small" style={{ lineHeight: 1.7 }}>
        <div>{isEn ? 'Source: ' : '来源：'}<span className="badge badge-gray">{srcLabel}</span> · {platformName(platform)}</div>
        {chain.hotFrom && <div className="muted">{isEn ? `Trend source: ${chain.hotFrom}` : `蹭的是：${chain.hotFrom}`}</div>}
        {chain.advisorOpinion && (
          <div className="muted">
            {chain.advisorOpinion.personaName} {isEn ? 'advised: ' : '当时建议：'}{chain.advisorOpinion.suggestion}
          </div>
        )}
        {chain.angle && <div>{isEn ? 'Angle: ' : '切入角：'}{chain.angle}</div>}
        {chain.totalScore > 0 && (
          <div className="muted">{isEn ? `Initial six-dimension score: ${Math.round(chain.totalScore)}` : `当时六维总分：${Math.round(chain.totalScore)}`}</div>
        )}
      </div>
    </div>
  );
}
