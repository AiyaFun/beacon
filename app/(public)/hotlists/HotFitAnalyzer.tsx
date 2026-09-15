'use client';

import { useState, useTransition, useEffect, useRef } from 'react';
import { actAnalyzeHotFit, actAdoptHotAngleAsTopic } from '@/app/(app)/actions';
import type { HotFitAnalysis } from '@/lib/topic/combine';
import { useI18n } from '@/lib/i18n';

export interface HotFitAnalyzerProps {
  options: string[];
  quickPills?: { title: string; heat?: number; tag?: string }[];
  personaSummary?: {
    name: string;
    niche?: string;
    identity?: string;
    tone?: string;
  } | null;
}

export function HotFitAnalyzer({ options, quickPills = [], personaSummary }: HotFitAnalyzerProps) {
  const [selected, setSelected] = useState('');
  const [custom, setCustom] = useState('');
  const [result, setResult] = useState<HotFitAnalysis | null>(null);
  // 采纳凭证：与 result 同生同灭；采纳时只回传它和切入角序号（内容由服务端从凭证里取）
  const [adoptToken, setAdoptToken] = useState('');
  const [err, setErr] = useState('');
  const [step, setStep] = useState(1);
  const [adoptedAngles, setAdoptedAngles] = useState<Record<number, boolean>>({});
  // 采纳请求在途：按钮此时就要禁用，否则双击会并发发两次（服务端另有 5 分钟幂等键兜底）
  const [adoptingAngles, setAdoptingAngles] = useState<Record<number, boolean>>({});
  const [copiedAngles, setCopiedAngles] = useState<Record<number, boolean>>({});
  const [pending, start] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  // 分析请求序号：快捷标签/全局事件在分析期间仍能再触发，先发的 A 若后返回不能盖掉 B。
  // 只认最后一次发出的请求，其余返回一律丢弃。
  const analysisSeq = useRef(0);
  const { dict, lang } = useI18n();

  // 监听全局事件：点击下方各平台榜单任意热点，一键滚动到雷达并立刻触发分析。
  // 监听器只挂一次，通过 ref 调到最新一版 executeAnalysis（否则闭包里是首渲染那份，dict/序号都是旧的）
  const executeRef = useRef<(hotTopic: string) => void>(() => {});
  useEffect(() => {
    function handleExternalTrigger(e: Event) {
      const customEvent = e as CustomEvent<{ topic: string }>;
      const topic = customEvent.detail?.topic;
      if (topic) {
        setCustom(topic);
        setSelected('');
        containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        executeRef.current(topic);
      }
    }
    window.addEventListener('beacon:analyze-hot', handleExternalTrigger);
    return () => window.removeEventListener('beacon:analyze-hot', handleExternalTrigger);
  }, []);

  // 思考态阶段步进动效
  useEffect(() => {
    if (!pending) return;
    setStep(1);
    const t1 = setTimeout(() => setStep(2), 650);
    const t2 = setTimeout(() => setStep(3), 1350);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [pending]);

  function executeAnalysis(hotTopic: string) {
    const target = hotTopic.trim();
    if (!target) {
      setErr(dict.intel.fitSelectErr);
      return;
    }
    setErr('');
    // 上一轮的结果先清掉：新分析失败时不能让旧热点的结果重新露出来，被当成这个热点的结论
    setResult(null);
    setAdoptToken('');
    setAdoptedAngles({});
    setAdoptingAngles({});
    setCopiedAngles({});

    const seq = ++analysisSeq.current;
    start(async () => {
      try {
        const r = await actAnalyzeHotFit(target);
        // 期间又发起了新分析：这份结果已过期，丢弃（新那份自己会落）
        if (seq !== analysisSeq.current) return;
        if (r.ok && r.analysis) {
          setResult(r.analysis);
          setAdoptToken(r.adoptToken ?? '');
        } else {
          setErr(r.error ?? dict.intel.fitFailedErr);
        }
      } catch {
        // 网络断了/Server Action 本身抛了：不能留一个没人接的 rejected promise，界面得有话说
        if (seq !== analysisSeq.current) return;
        setErr(dict.intel.fitFailedErr);
      }
    });
  }
  executeRef.current = executeAnalysis;

  function handleRun() {
    const hot = custom.trim() || selected;
    executeAnalysis(hot);
  }

  async function handleAdopt(angleIndex: number) {
    if (!result || !adoptToken || adoptedAngles[angleIndex] || adoptingAngles[angleIndex]) return;
    setAdoptingAngles((prev) => ({ ...prev, [angleIndex]: true }));
    try {
      const res = await actAdoptHotAngleAsTopic({ token: adoptToken, angleIndex });
      if (res.ok) {
        setAdoptedAngles((prev) => ({ ...prev, [angleIndex]: true }));
      } else {
        setErr(res.error ?? '采纳失败，请稍后重试');
      }
    } catch {
      setErr('采纳失败，请检查网络后重试');
    } finally {
      setAdoptingAngles((prev) => ({ ...prev, [angleIndex]: false }));
    }
  }

  function handleCopy(angleIndex: number, a: { angle: string; why: string }) {
    if (!result) return;
    const text = `【热点结合构思】\n目标热点：${result.hotTitle}\n契合度评分：${result.fit}/100\n切入角度：${a.angle}\n推荐理由：${a.why}`;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopiedAngles((prev) => ({ ...prev, [angleIndex]: true }));
          setTimeout(() => {
            setCopiedAngles((prev) => ({ ...prev, [angleIndex]: false }));
          }, 1800);
        })
        .catch(() => setErr(lang === 'en' ? 'Copy failed: clipboard permission denied' : '复制失败：浏览器拒绝了剪贴板权限'));
    }
  }

  // 契合度评分颜色与评级
  const fitColor = (n: number) => (n >= 75 ? 'var(--green)' : n >= 55 ? 'var(--amber)' : 'var(--red)');
  const fitLevelText = (n: number) =>
    n >= 75
      ? dict.intel.fitScoreLevelHigh
      : n >= 55
      ? dict.intel.fitScoreLevelMid
      : dict.intel.fitScoreLevelLow;

  const currentTopicValue = custom || selected;

  return (
    <div ref={containerRef} className="hotfit-container">
      {/* 顶部控制栏与人设胶囊 */}
      <div className="hotfit-header">
        <div className="hotfit-title-group">
          <div className="hotfit-icon-badge">
            <span style={{ fontSize: 16 }}>⚡️</span>
          </div>
          <div>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <b className="hotfit-title-text">{dict.intel.fitCardTitle}</b>
              <span className="badge badge-brand hotfit-radar-pill">
                {dict.intel.fitRadarBadge}
              </span>
            </div>
            <p className="small muted hotfit-sub-text">{dict.intel.fitCardSub}</p>
          </div>
        </div>

        {/* 账号人设状态锚点 */}
        <div className="hotfit-persona-pill" title="当前 AI 分析依据此账号人设与受众风格推导切入点">
          <span className="hotfit-status-dot"></span>
          <span className="small muted">{dict.intel.fitAnchorPrefix}</span>
          <span className="small bold" style={{ color: 'var(--text)' }}>
            {personaSummary?.niche || personaSummary?.identity || personaSummary?.name || dict.intel.fitAnchorDefault}
          </span>
          {personaSummary?.tone && (
            <span className="badge badge-gray" style={{ fontSize: 11, padding: '1px 5px' }}>
              {personaSummary.tone.slice(0, 10)}
            </span>
          )}
        </div>
      </div>

      {/* 今日焦点热词速测胶囊 (Quick Pills) */}
      {quickPills.length > 0 && (
        <div className="hotfit-pills-row">
          <div className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 500 }}>
            <span>🔥</span>
            <span>{dict.intel.fitQuickTitle}</span>
          </div>
          <div className="hotfit-pills-list">
            {quickPills.slice(0, 5).map((p, idx) => (
              <button
                key={idx}
                type="button"
                className={`hotfit-pill-btn ${currentTopicValue === p.title ? 'active' : ''}`}
                onClick={() => {
                  setCustom(p.title);
                  setSelected('');
                  executeAnalysis(p.title);
                }}
              >
                <span className="hotfit-pill-dot"></span>
                <span className="hotfit-pill-title">{p.title}</span>
                {p.heat ? <span className="hotfit-pill-heat">🔥 {Math.round(p.heat > 10000 ? p.heat / 10000 : p.heat)}{p.heat > 10000 ? 'w' : ''}</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 智能输入与操作栏 */}
      <div className="hotfit-input-bar">
        <div className="hotfit-input-wrapper">
          <span className="hotfit-input-search-icon">🔍</span>
          <input
            className="input hotfit-main-input"
            placeholder={dict.intel.fitCustomPlaceholder}
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              if (selected) setSelected('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !pending) handleRun();
            }}
          />
          {custom && (
            <button
              type="button"
              className="hotfit-clear-btn"
              onClick={() => {
                setCustom('');
                setSelected('');
              }}
              title={dict.intel.fitClear}
            >
              ✕
            </button>
          )}
          <span className="hotfit-enter-badge hide-mobile">Enter ↵</span>
        </div>

        {/* 备用下拉快选 */}
        <select
          className="select hotfit-select-quick hide-mobile"
          value={selected}
          onChange={(e) => {
            const val = e.target.value;
            setSelected(val);
            setCustom(val);
          }}
        >
          <option value="">{dict.intel.fitSelectTopic}</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o.length > 28 ? o.slice(0, 28) + '…' : o}
            </option>
          ))}
        </select>

        <button
          className="btn btn-primary hotfit-submit-btn"
          onClick={handleRun}
          disabled={pending}
        >
          {pending ? (
            <>
              <span className="hotfit-spinner"></span>
              <span>{dict.intel.fitPending}</span>
            </>
          ) : (
            <>
              <span>✨</span>
              <span>{dict.intel.fitBtn}</span>
            </>
          )}
        </button>
      </div>

      {err && (
        <div className="small" style={{ color: 'var(--red)', marginTop: 8, paddingLeft: 4 }}>
          ⚠️ {err}
        </div>
      )}

      {/* 渐进式 AI 思考骨架态 (Stepped Thinking Flow) */}
      {pending && (
        <div className="hotfit-thinking-card">
          <div className="row-between" style={{ marginBottom: 10 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <div className="hotfit-spinner-brand"></div>
              <b className="small" style={{ color: 'var(--brand)' }}>
                {step === 1
                  ? dict.intel.fitStep1
                  : step === 2
                  ? dict.intel.fitStep2
                  : dict.intel.fitStep3}
              </b>
            </div>
            <span className="small muted">AI 差异化推理中</span>
          </div>
          <div className="hotfit-progress-track">
            <div
              className="hotfit-progress-fill"
              style={{
                width: step === 1 ? '35%' : step === 2 ? '70%' : '95%',
              }}
            ></div>
          </div>
          <div className="hotfit-steps-grid">
            <span className={`small ${step >= 1 ? 'bold active-step' : 'muted'}`}>
              1. 人设风格校准
            </span>
            <span className={`small ${step >= 2 ? 'bold active-step' : 'muted'}`}>
              2. 受众偏好重叠测算
            </span>
            <span className={`small ${step >= 3 ? 'bold active-step' : 'muted'}`}>
              3. 差异化切入角生成
            </span>
          </div>
        </div>
      )}

      {/* 分析结果面板 (Results Dashboard) */}
      {result && !pending && (
        <div className="hotfit-result-section">
          {/* 契合度与核心裁决 Banner */}
          <div className="hotfit-verdict-banner">
            <div className="hotfit-verdict-content">
              <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="badge" style={{ background: fitColor(result.fit), color: '#fff', fontWeight: 700 }}>
                  {fitLevelText(result.fit)}
                </span>
                <span className="small muted">
                  目标热点：<b style={{ color: 'var(--text)' }}>「{result.hotTitle}」</b>
                </span>
                {result.mocked && <span className="badge badge-gray">Mock 兜底</span>}
              </div>
              <div className="hotfit-verdict-text">
                {dict.intel.fitVerdictPrefix}{result.verdict}
              </div>
            </div>

            <div className="hotfit-score-box">
              <div className="small muted" style={{ fontSize: 11, textAlign: 'right' }}>
                {dict.intel.fitScore}
              </div>
              <div className="hotfit-score-num" style={{ color: fitColor(result.fit) }}>
                {result.fit}
              </div>
            </div>
          </div>

          {/* 差异化切入角度推荐 (Angles) */}
          <div style={{ marginTop: 18 }}>
            <div className="row-between" style={{ marginBottom: 12 }}>
              <div className="field-label" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 4, height: 14, background: 'var(--brand)', borderRadius: 2, display: 'inline-block' }}></span>
                <span>{dict.intel.fitAngleTitle}</span>
              </div>
              <span className="small muted hide-mobile">
                匹配账号人设提炼 {result.angles.length} 条差异化路径
              </span>
            </div>

            <div className="grid grid-3 hotfit-angles-grid">
              {result.angles.map((a, i) => (
                <div key={i} className="hotfit-angle-card">
                  <div className="hotfit-angle-top">
                    <span className="hotfit-angle-index">0{i + 1}</span>
                    <span className="badge badge-gray" style={{ fontSize: 10 }}>角度 {i + 1}</span>
                  </div>
                  <h4 className="hotfit-angle-title">{a.angle}</h4>
                  <p className="small muted hotfit-angle-why">{a.why}</p>

                  <div className="hotfit-angle-actions">
                    <button
                      type="button"
                      className={`btn btn-sm ${adoptedAngles[i] ? 'btn-secondary' : 'btn-primary'}`}
                      style={{ flex: 1, fontSize: 12 }}
                      onClick={() => handleAdopt(i)}
                      disabled={adoptedAngles[i] || adoptingAngles[i]}
                    >
                      {adoptedAngles[i] ? `✓ ${dict.intel.fitAdopted}` : adoptingAngles[i] ? '…' : `+ ${dict.intel.fitAdoptBtn}`}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      style={{ fontSize: 12, padding: '4px 8px' }}
                      onClick={() => handleCopy(i, a)}
                    >
                      {copiedAngles[i] ? dict.intel.fitCopied : dict.intel.fitCopyBtn}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 制作建议 & 合规预警 双列布局 */}
          <div className="grid grid-2 hotfit-bottom-grid" style={{ marginTop: 18 }}>
            {/* 制作执行建议 */}
            {result.production.length > 0 && (
              <div className="hotfit-card-info">
                <div className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 0 10px' }}>
                  <span>🎬</span>
                  <span>{dict.intel.fitProductionTitle}</span>
                </div>
                <div className="stack" style={{ gap: 8 }}>
                  {result.production.map((p, i) => (
                    <div key={i} className="hotfit-prod-item">
                      <span className="hotfit-prod-num">{i + 1}</span>
                      <span className="small" style={{ lineHeight: 1.6 }}>{p}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 安全与合规防线 */}
            <div className="hotfit-card-warning">
              <div className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 0 10px', color: 'var(--amber)' }}>
                <span>🛡️</span>
                <span>{dict.intel.fitRiskTitle}</span>
              </div>
              <p className="small" style={{ lineHeight: 1.6, color: 'var(--text-2)' }}>
                {result.risk}
              </p>
              <div className="small muted" style={{ marginTop: 10, fontSize: 11, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                提示：全网热点存在快速反转可能，发布前建议在「合规检测」工位核验违禁词与版权边界。
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function QuickAnalyzeButton({
  topic,
  isGuest,
  label,
}: {
  topic: string;
  isGuest?: boolean;
  label?: string;
}) {
  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (isGuest) {
      const el = document.getElementById('hotfit-card-root');
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    window.dispatchEvent(new CustomEvent('beacon:analyze-hot', { detail: { topic } }));
  }

  return (
    <button
      type="button"
      className="hotfit-quick-trigger-btn"
      onClick={handleClick}
      title="一键结合当前账号分析此热点"
    >
      {label || '⚡️ 结合分析'}
    </button>
  );
}

