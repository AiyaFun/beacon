'use client';

import { useState, useTransition } from 'react';
import { TierBadge } from '@/components/ui';
import { Icon } from '@/components/icons';
import { PLATFORM_LIST, platformName } from '@/lib/constants';
import { actCheck, actRewriteSafe, type CheckResult, type SemanticHit } from './actions';
import type { WordHit } from '@/lib/compliance/engine';

const SAMPLE = '这款面膜效果最好，全网第一，100%有效，包治百病，稳赚不赔！加微信私聊拉你进群，还能治愈你的敏感肌。';

// 动作 → 高亮底色（block红/warn黄/suggest蓝）
const ACTION_STYLE: Record<string, { bg: string; label: string; badge: string }> = {
  block: { bg: 'rgba(220,38,38,0.22)', label: '禁用', badge: 'badge-red' },
  warn: { bg: 'rgba(234,88,12,0.20)', label: '警告', badge: 'badge-amber' },
  suggest: { bg: 'rgba(37,99,235,0.18)', label: '建议', badge: 'badge-brand' },
};

const SEVERITY: Record<string, number> = { suggest: 1, warn: 2, block: 3 };

// 把命中区间铺到每个字符上（重叠取更高严重级），再合并成连续片段
function buildSegments(text: string, hits: WordHit[]) {
  const level = new Array(text.length).fill(0);
  const label = new Array<string>(text.length).fill('');
  for (const h of hits) {
    const sev = SEVERITY[h.action] ?? 1;
    for (let i = h.start; i < h.end && i < text.length; i++) {
      if (sev >= level[i]) {
        level[i] = sev;
        label[i] = h.action;
      }
    }
  }
  const segs: { text: string; action: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    const act = label[i];
    const last = segs[segs.length - 1];
    if (last && last.action === act) last.text += text[i];
    else segs.push({ text: text[i], action: act });
  }
  return segs;
}

const RISK_BADGE: Record<string, { cls: string; label: string }> = {
  pass: { cls: 'badge-green', label: '通过 · 未发现违规' },
  warn: { cls: 'badge-amber', label: '警告 · 存在需注意的表达' },
  block: { cls: 'badge-red', label: '拦截 · 含禁用表达，勿直接发布' },
};

export type DraftOption = { id: string; title: string; content: string };

export function Checker({ drafts = [] }: { drafts?: DraftOption[] }) {
  const [text, setText] = useState(SAMPLE);
  const [platform, setPlatform] = useState<string>(PLATFORM_LIST[0].key);
  const [draftId, setDraftId] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);
  const [rewrite, setRewrite] = useState<{ text: string; mocked: boolean; check: CheckResult } | null>(null);
  const [checking, startCheck] = useTransition();
  const [rewriting, startRewrite] = useTransition();

  // 选中草稿：填进检测框并直接按当前目标平台跑一次检测
  function pickDraft(id: string) {
    setDraftId(id);
    const d = drafts.find((x) => x.id === id);
    if (!d) return;
    setText(d.content);
    setRewrite(null);
    startCheck(async () => {
      // 传 draftId：命中项会落进检测历史（ComplianceCheck），供合规战报与 billing 统计
      const r = await actCheck(d.content, platform, id);
      setResult(r);
    });
  }

  function runCheck() {
    setRewrite(null);
    startCheck(async () => {
      // 选过草稿就带上它的 id；纯手输文本没有对应草稿，不落历史（外键必填）
      const r = await actCheck(text, platform, draftId || undefined);
      setResult(r);
    });
  }

  function runRewrite() {
    startRewrite(async () => {
      const r = await actRewriteSafe(text, platform);
      setRewrite({ text: r.rewritten, mocked: r.mocked, check: r.check });
    });
  }

  const risk = result ? RISK_BADGE[result.riskLevel] : null;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
        {drafts.length > 0 && (
          <div className="field" style={{ minWidth: 200 }}>
            <label className="field-label">从最近的草稿选择</label>
            <select className="select" value={draftId} onChange={(e) => pickDraft(e.target.value)}>
              <option value="">选一条草稿填进来…</option>
              {drafts.map((d) => (
                <option key={d.id} value={d.id}>{d.title}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field" style={{ minWidth: 160 }}>
          <label className="field-label">目标平台</label>
          <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {PLATFORM_LIST.map((p) => (
              <option key={p.key} value={p.key}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={runCheck} disabled={checking}>
          {checking ? '检测中…' : '开始检测'}
        </button>
      </div>

      <div className="field">
        <label className="field-label">待检测文案</label>
        <textarea
          className="textarea"
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="从上方选一条草稿，或直接粘贴要发布的标题、正文…"
        />
        <div className="small muted" style={{ marginTop: 4 }}>
          {text.length} 字 · 目标平台「{platformName(platform)}」 · 也可以粘贴站外文案来查
        </div>
      </div>

      {result && (
        <>
          {/* 顶部风险条 */}
          <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
            <span className={`badge ${risk!.cls}`} style={{ fontSize: 13, padding: '5px 12px' }}>{risk!.label}</span>
            <span className="small muted">命中 {result.hits.length} 处</span>
            {result.redline && (
              <span className="badge badge-red" style={{ fontWeight: 600 }}>
                <Icon.shield size={13} /> 红线命中，禁止导出
              </span>
            )}
          </div>

          {result.redline && (
            <div
              className="card"
              style={{ boxShadow: 'none', border: '1px solid var(--red)', background: 'rgba(220,38,38,0.08)', padding: 14 }}
            >
              <div className="row" style={{ gap: 8, color: 'var(--red)', fontWeight: 600 }}>
                <Icon.x size={16} /> 已触发法律级红线（极限词／虚假承诺／违规承诺等）
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>
                此类表达涉及广告法等法定红线，系统禁止一键导出或直接发布，请务必先改写规避。
              </div>
            </div>
          )}

          {/* 正文四色高亮 */}
          <div className="field">
            <label className="field-label">正文高亮（红=禁用 / 黄=警告 / 蓝=建议）</label>
            <div
              className="card"
              style={{ boxShadow: 'none', background: 'var(--surface-2)', padding: 14, lineHeight: 1.9, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {buildSegments(text, result.hits).map((seg, i) =>
                seg.action ? (
                  <span key={i} style={{ background: ACTION_STYLE[seg.action]?.bg, borderRadius: 3, padding: '1px 1px' }}>{seg.text}</span>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </div>
          </div>

          {/* 命中列表 */}
          <div className="field">
            <label className="field-label">命中明细</label>
            {result.hits.length === 0 ? (
              <div className="small muted">未命中任何敏感词，可以放心发布到「{platformName(platform)}」。</div>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {result.hits.map((h, i) => {
                  const st = ACTION_STYLE[h.action];
                  return (
                    <div key={i} className="list-row" style={{ alignItems: 'center' }}>
                      <span className="mono" style={{ minWidth: 90, fontWeight: 600 }}>{h.word}</span>
                      <TierBadge tier={h.tier} />
                      <span className={`badge ${st?.badge ?? 'badge-gray'}`}>{st?.label ?? h.action}</span>
                      <span className="small muted" style={{ flex: 1 }}>
                        {h.suggestion ? `建议改为：${h.suggestion}` : '建议删除或换一种说法'}
                        {h.platform ? ` · 平台规则：${platformName(h.platform)}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* F6-3 LLM 语义审核结果 */}
          {result.semantic && result.semantic.hits.length > 0 && (
            <div className="field">
              <label className="field-label">
                <Icon.sparkles size={13} /> AI 语义审核
                {result.semantic.mocked && <span className="badge badge-amber" style={{ marginLeft: 8, fontSize: 10 }}>Mock</span>}
                <span className="badge badge-brand" style={{ marginLeft: 8, fontSize: 10 }}>
                  发现 {result.semantic.hits.length} 处
                </span>
              </label>
              <div className="small muted" style={{ marginBottom: 8 }}>
                以下问题无法被词库匹配捕获，由 AI 语义分析发现
              </div>
              <div className="stack" style={{ gap: 8 }}>
                {result.semantic.hits.map((h, i) => (
                  <SemanticHitRow key={i} hit={h} />
                ))}
              </div>
            </div>
          )}
          {result.semantic && result.semantic.hits.length === 0 && (
            <div className="small muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Icon.sparkles size={13} /> AI 语义审核未发现额外问题
              {result.semantic.mocked && <span className="badge badge-amber" style={{ fontSize: 10 }}>Mock</span>}
            </div>
          )}

          {/* 一键 AI 改写规避 */}
          <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
            <button className="btn btn-accent" onClick={runRewrite} disabled={rewriting}>
              <Icon.sparkles size={14} /> {rewriting ? 'AI 改写中…' : '一键 AI 改写规避'}
            </button>
            {rewrite?.mocked && <span className="small muted">演示改写：还没接入真实 AI，去「设置」填上你的模型 Key 后生效</span>}
          </div>

          {rewrite && (
            <div className="field">
              <label className="field-label">
                AI 合规改写版
                {rewrite.check.riskLevel === 'pass' ? (
                  <span className="badge badge-green" style={{ marginLeft: 8 }}>复检通过</span>
                ) : (
                  <span className={`badge ${RISK_BADGE[rewrite.check.riskLevel].cls}`} style={{ marginLeft: 8 }}>
                    复检仍有 {rewrite.check.hits.length} 处，可再改
                  </span>
                )}
              </label>
              <div
                className="card"
                style={{ boxShadow: 'none', background: 'var(--surface-2)', padding: 14, lineHeight: 1.9, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
              >
                {rewrite.text}
              </div>
              <button
                className="btn btn-sm btn-ghost"
                style={{ marginTop: 8 }}
                onClick={() => { setText(rewrite.text); setRewrite(null); setResult(null); }}
              >
                <Icon.check size={13} /> 采用改写版并回填
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SemanticHitRow({ hit }: { hit: SemanticHit }) {
  const isWarn = hit.action === 'warn';
  return (
    <div
      className="card"
      style={{
        boxShadow: 'none',
        padding: '10px 14px',
        background: isWarn ? 'rgba(234,88,12,0.08)' : 'rgba(37,99,235,0.06)',
        border: `1px solid ${isWarn ? 'rgba(234,88,12,0.25)' : 'rgba(37,99,235,0.2)'}`,
      }}
    >
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <span className={`badge ${isWarn ? 'badge-amber' : 'badge-brand'}`} style={{ fontSize: 10, flexShrink: 0 }}>
          {isWarn ? '风险' : '建议'}
        </span>
        <div style={{ flex: 1 }}>
          <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>"{hit.snippet}"</span>
          <div className="small muted" style={{ marginTop: 4 }}>{hit.reason}</div>
          {hit.suggestion && (
            <div className="small" style={{ marginTop: 4, color: 'var(--brand)' }}>
              建议改为：{hit.suggestion}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
