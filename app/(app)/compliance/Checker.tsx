'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { PLATFORM_LIST, platformName } from '@/lib/constants';
import { actCheck, actRewriteSafe, type CheckResult } from './actions';
import type { WordHit } from '@/lib/compliance/engine';
import { useI18n } from '@/lib/i18n';

const SAMPLE = '这款面膜效果最好，全网第一，100%有效，包治百病。加微信私聊拉你进群，还能治愈你的敏感肌。';
const SAMPLE_EN = 'This face mask works the best, #1 on the entire web, 100% effective, cures all illnesses, guaranteed profit! Add WeChat to DM and join group, cures sensitive skin.';

// 动作 → 高亮底色（block红/warn黄/suggest蓝）
const ACTION_STYLE: Record<string, { bg: string; label: string; labelEn: string; badge: string }> = {
  block: { bg: 'rgba(220,38,38,0.22)', label: '禁用', labelEn: 'Block', badge: 'badge-red' },
  warn: { bg: 'rgba(234,88,12,0.20)', label: '警告', labelEn: 'Warn', badge: 'badge-amber' },
  suggest: { bg: 'rgba(37,99,235,0.18)', label: '建议', labelEn: 'Suggest', badge: 'badge-brand' },
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

const RISK_BADGE: Record<string, { cls: string; label: string; labelEn: string }> = {
  pass: { cls: 'badge-green', label: '通过 · 未发现违规', labelEn: 'Pass · No violations found' },
  warn: { cls: 'badge-amber', label: '警告 · 存在需注意的表达', labelEn: 'Warning · Cautionary expressions found' },
  block: { cls: 'badge-red', label: '拦截 · 含禁用表达，勿直接发布', labelEn: 'Block · Prohibited terms found, do not publish' },
};

export type DraftOption = { id: string; title: string; content: string };

export function Checker({ drafts = [], canCheck }: { drafts?: DraftOption[]; canCheck: boolean }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [text, setText] = useState(isEn ? SAMPLE_EN : SAMPLE);
  const [platform, setPlatform] = useState<string>('douyin');
  const [draftId, setDraftId] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);
  const [rewrite, setRewrite] = useState<{ text: string; mocked: boolean; check: CheckResult } | null>(null);
  const [checking, startCheck] = useTransition();
  const [rewriting, startRewrite] = useTransition();
  // 检测请求序号：并发两次检测时晚返回的旧请求不能盖掉新请求；只认最后一次发出的
  const checkSeq = useRef(0);
  // 改写请求同样要序号：改写期间改了文案或平台，旧改写稿回来不能再显示
  const rewriteSeq = useRef(0);

  // 报告只对「检测时的那份文案 × 那个平台」成立：命中区间是按旧文本的字符偏移算的，
  // 文案一改高亮就错位，平台一换规则就不同。任何一方变了，旧报告和改写稿一律作废。
  function invalidateReport() {
    checkSeq.current++; // 在途的检测也作废：否则它稍后返回会把刚清掉的报告填回来
    rewriteSeq.current++;
    setResult(null);
    setRewrite(null);
  }

  function runCheckFor(content: string, target: string, id?: string) {
    if (!canCheck) return;
    const seq = ++checkSeq.current;
    startCheck(async () => {
      const r = await actCheck(content, target, id);
      if (seq !== checkSeq.current) return; // 期间又发起了新检测，这份已过期
      setResult(r);
    });
  }

  // 选中草稿：填进检测框并直接按当前目标平台跑一次检测
  function pickDraft(id: string) {
    setDraftId(id);
    const d = drafts.find((x) => x.id === id);
    if (!d) return;
    setText(d.content);
    invalidateReport();
    // 传 draftId：命中项会落进检测历史（ComplianceCheck），供合规战报与 billing 统计
    runCheckFor(d.content, platform, id);
  }

  function runCheck() {
    rewriteSeq.current++;
    setRewrite(null);
    // 选过草稿就带上它的 id；纯手输文本没有对应草稿，不落历史（外键必填）
    runCheckFor(text, platform, draftId || undefined);
  }

  function runRewrite() {
    const seq = ++rewriteSeq.current;
    startRewrite(async () => {
      const r = await actRewriteSafe(text, platform);
      if (seq !== rewriteSeq.current) return; // 期间文案/平台变了或又发起了新改写，这份已过期
      setRewrite({ text: r.rewritten, mocked: r.mocked, check: r.check });
    });
  }

  function fillSampleAndCheck() {
    const s = isEn ? SAMPLE_EN : SAMPLE;
    setText(s);
    setDraftId('');
    invalidateReport();
    runCheckFor(s, platform);
  }

  useEffect(() => {
    runCheckFor(text, platform);
  }, []);

  const totalHits = (result?.hits.length ?? 0) + (result?.semantic?.hits.length ?? 0);

  return (
    <div className="surface checker-grid">
      {/* ── 左栏：输入与设置 ── */}
      <div className="checker-input">
        <div className="checker-fields">
          <select className="select" value={draftId} onChange={(e) => pickDraft(e.target.value)}>
            <option value="">{isEn ? 'Select from recent drafts' : '从最近草稿选择'}</option>
            {drafts.map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </select>

          <select
            className="select"
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value);
              invalidateReport();
            }}
          >
            {PLATFORM_LIST.map((p) => (
              <option key={p.key} value={p.key}>{platformName(p.key, lang)}</option>
            ))}
          </select>
        </div>

        <textarea
          className="compliance-text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            invalidateReport();
          }}
          placeholder={isEn ? 'Paste or type content to inspect...' : '输入或粘贴需要体检的文案...'}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="meta">
            {isEn
              ? `${text.length} chars, inspection text will be sent to server`
              : `${text.length} 字，检测内容将发送到服务器`}
          </span>
          <button
            className="btn primary"
            style={{ marginLeft: 'auto' }}
            disabled={!canCheck || checking || !text.trim()}
            onClick={runCheck}
          >
            {checking ? (isEn ? 'Checking…' : '正在体检…') : (isEn ? 'Run Compliance Check' : '开始合规体检')}
          </button>
        </div>
      </div>

      {/* ── 右栏：体检结果 ── */}
      <div className="checker-result">
        {checking ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>
            <p className="small">{isEn ? 'Inspecting across 427+ redline rules…' : '正在比对 427+ 条合规红线与平台规范…'}</p>
          </div>
        ) : result ? (
          <>
            {totalHits > 0 ? (
              <div className="result-summary">
                <b>
                  {isEn
                    ? `Found ${totalHits} high-risk expressions`
                    : `发现 ${totalHits} 处高风险表达`}
                </b>
                <div className="small" style={{ marginTop: 4 }}>
                  {isEn
                    ? 'Requires revision before publish. Statutory redlines will block export.'
                    : '发布前需要修改，法律级红线将阻止导出。'}
                </div>
              </div>
            ) : (
              <div className="result-summary" style={{ background: 'rgba(16, 185, 129, 0.1)', color: '#059669' }}>
                <b>{isEn ? 'Pass · No violations found' : '通过 · 未发现违规'}</b>
                <div className="small" style={{ marginTop: 4 }}>
                  {isEn ? 'All content passed static rules and platform guidelines.' : '文案符合该平台的各项规范与广告法规定。'}
                </div>
              </div>
            )}

            {/* 词库命中细项 */}
            {result.hits.map((h, idx) => (
              <div key={`hit-${idx}`} className="risk-item">
                <div className="risk-item-head">
                  <span className={`tag ${h.tier === 'legal' ? 'brand' : h.tier === 'platform' ? 'amber' : 'brand'}`}>
                    {h.tier === 'legal' ? (isEn ? 'Legal' : '法律级') : h.tier === 'platform' ? (isEn ? 'Platform' : '平台级') : (isEn ? 'Industry' : '行业级')}
                  </span>
                  <strong>{h.word}</strong>
                  {h.suggestion && (
                    <button
                      className="btn small"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => {
                        const rep = h.suggestion || '';
                        if (rep) {
                          const next = text.replaceAll(h.word, rep);
                          setText(next);
                          runCheckFor(next, platform, draftId || undefined);
                        }
                      }}
                    >
                      {isEn ? 'Use Suggestion' : '使用建议'}
                    </button>
                  )}
                </div>
                <p>
                  {h.suggestion
                    ? (isEn ? `Suggested: ${h.suggestion}` : `建议改为可验证的具体体验描述：${h.suggestion}。`)
                    : (isEn ? 'Potentially absolute or unsubstantiated claims. Consider rephrasing.' : '涉及绝对化或不可证实的功效承诺，建议改为可验证的具体体验描述。')}
                </p>
              </div>
            ))}

            {/* 语义命中细项 */}
            {result.semantic?.hits.map((sh, idx) => (
              <div key={`sem-${idx}`} className="risk-item">
                <div className="risk-item-head">
                  <span className="tag amber">{isEn ? 'Platform' : '平台级'}</span>
                  <strong>{sh.snippet}</strong>
                  {sh.suggestion && (
                    <button
                      className="btn small"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => {
                        const next = text.replace(sh.snippet, sh.suggestion || '');
                        setText(next);
                        runCheckFor(next, platform, draftId || undefined);
                      }}
                    >
                      {isEn ? 'Use Suggestion' : '使用建议'}
                    </button>
                  )}
                </div>
                <p>{sh.reason || (isEn ? 'May trigger platform community rules.' : '可能触发站外引流或违规导流规则，建议改为平台内咨询或删除。')}</p>
              </div>
            ))}
          </>
        ) : (
          <div className="result-summary">
            <b>{canCheck ? (isEn ? 'Ready to check' : '等待合规体检') : (isEn ? 'Read-only preview' : '只读预览')}</b>
            <div className="small" style={{ marginTop: 4 }}>
              {canCheck
                ? (isEn ? 'Run a check to see findings for this content and platform.' : '开始体检后，这里会显示当前文案与平台的检测结果。')
                : (isEn ? 'An editor, admin or owner account is required to run checks.' : '当前账号可查看词库；合规体检需要编辑、管理员或所有者权限。')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
