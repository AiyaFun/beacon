'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PLATFORM_LIST, platformName } from '@/lib/constants';
import {
  PERSONA_FIELD_KEYS,
  PERSONA_FIELD_LABEL,
  PERSONA_FIELD_LABEL_EN,
  isLowConfidence,
  type PersonaCard,
  type PersonaDraft,
  type PersonaQuestion,
  type PersonaAnswer,
  type PersonaFieldKey,
  type PersonaFieldState,
} from '@/lib/persona';
import { actAskPersonaQuestions, actExpandPersona, actSavePersona, actColdStartSeed } from './actions';
import { useI18n } from '@/lib/i18n';

// F3-1 冷启动：一句话 → AI 追问 3–5 问（可跳过）→ AI 扩写 → 逐项确认 → 保存。
// 三条不可让步的规矩：
//   1. 扩写结果先落在这个组件的 state 里，用户逐项确认过才 actSavePersona 进库。
//   2. Mock / 降级草稿必须自报家门 —— 「没配 Key」不许伪装成「AI 生成的人设」。
//   3. 跳过的追问所填字段打「待确认」，不许静默混进已确认字段里。

type Step = 'intro' | 'ask' | 'confirm';

export function PersonaColdStart({ onManual }: { onManual: () => void }) {
  const { lang } = useI18n();
  const [step, setStep] = useState<Step>('intro');
  const [sentence, setSentence] = useState('');
  const [questions, setQuestions] = useState<PersonaQuestion[]>([]);
  const [qFallback, setQFallback] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<PersonaDraft | null>(null);
  const [card, setCard] = useState<PersonaCard | null>(null);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  // 冷启动最小样单：贴几个链接（自有作品 / 对标账号）
  const [seedOwn, setSeedOwn] = useState('');
  const [seedComp, setSeedComp] = useState('');
  const [seedResult, setSeedResult] = useState<Awaited<ReturnType<typeof actColdStartSeed>> | null>(null);

  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

  function seed() {
    setErr('');
    start(async () => {
      try {
        const r = await actColdStartSeed({ ownUrls: lines(seedOwn), competitorUrls: lines(seedComp) });
        setSeedResult(r);
        // 认出来的清掉、没认出的留在框里让用户改——不静默丢弃用户输入
        const badOwn = new Set(r.own.failed.map((f) => f.url));
        const badComp = new Set(r.competitors.failed.map((f) => f.url));
        setSeedOwn(lines(seedOwn).filter((u) => badOwn.has(u)).join('\n'));
        setSeedComp(lines(seedComp).filter((u) => badComp.has(u)).join('\n'));
        router.refresh();
      } catch (e) {
        setErr((e as Error).message || (lang === 'en' ? 'Processing failed, please retry later' : '处理失败，请稍后重试'));
      }
    });
  }

  function ask() {
    setErr('');
    start(async () => {
      const r = await actAskPersonaQuestions(sentence);
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      setQuestions(r.questions);
      setQFallback(r.fallback);
      setStep('ask');
    });
  }

  function expand() {
    setErr('');
    const payload: PersonaAnswer[] = questions.map((q) => ({
      key: q.key,
      question: q.question,
      answer: skipped[q.key] ? '' : (answers[q.key] ?? ''),
      skipped: !!skipped[q.key] || !(answers[q.key] ?? '').trim(),
    }));
    start(async () => {
      const r = await actExpandPersona(sentence, JSON.stringify(payload));
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      setDraft(r.draft);
      setCard(r.draft.card);
      setConfirmed({}); // 逐项确认从零开始，AI 说了不算
      setStep('confirm');
    });
  }

  function save() {
    if (!card) return;
    setErr('');
    start(async () => {
      const r = await actSavePersona(JSON.stringify(card));
      if (r.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setErr(r.error ?? (lang === 'en' ? 'Save failed' : '保存失败'));
      }
    });
  }

  // ── 保存成功：先给「贴几个链接」最小样单，再放去选题引擎 ──
  // 为什么加这一步：只建完人设的话，八个候选源第一天只有三个出货（热榜/节点日历/常青），
  // 首批推荐看起来很普通。贴自有作品链接能当天打通自动回流管线（解锁翻新/跨平台补发），
  // 贴竞对主页能当天点亮竞对源——这是把首日体验从 3/8 拉到 5/8 最省力的一步。
  if (saved) {
    return (
      <div className="stack" style={{ gap: 12 }}>
        <div className="alert-gradient-brand" style={{ padding: '16px 20px' }}>
          <b style={{ color: 'var(--brand)', fontSize: 15 }}>{lang === 'en' ? 'Persona Saved' : '人设已保存'}</b>
          <p className="small" style={{ marginTop: 4, opacity: 0.9 }}>
            {lang === 'en'
              ? 'Take 1 more minute to paste links so today’s recommendations leverage your own data and benchmarks — or skip and add anytime later.'
              : '再花 1 分钟贴几个链接，今天的推荐就能用上你自己的数据和对标账号——跳过也可以，之后随时能补。'}
          </p>
        </div>

        <div className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
          <div className="field">
            <label className="field-label" style={{ fontWeight: 650 }}>
              {lang === 'en' ? 'Published Post Links (1–3, optional)' : '你已发布的作品链接（1–3 条，选填）'}
            </label>
            <p className="small muted" style={{ margin: '2px 0 6px' }}>
              {lang === 'en'
                ? 'Paste post detail URLs. The system creates a baseline entry for backfill — no numbers are fabricated; actual stats come from later sync or manual entry.'
                : '贴作品详情页链接。系统只建一条空指标的记录用来打通自动回流——不会编造任何数字，真实数据由后续回流或你手填补上。'}
            </p>
            <textarea
              className="textarea"
              rows={3}
              value={seedOwn}
              onChange={(e) => setSeedOwn(e.target.value)}
              placeholder={lang === 'en' ? 'One per line, e.g.:\nhttps://www.douyin.com/video/7123456789012345678\nhttps://mp.weixin.qq.com/s/AbCdEf...' : '每行一条，如：\nhttps://www.douyin.com/video/7123456789012345678\nhttps://mp.weixin.qq.com/s/AbCdEf...'}
            />
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <label className="field-label" style={{ fontWeight: 650 }}>
              {lang === 'en' ? 'Benchmark Profile Links (1–3, optional)' : '对标账号主页链接（1–3 条，选填）'}
            </label>
            <p className="small muted" style={{ margin: '2px 0 6px' }}>
              {lang === 'en'
                ? 'Paste profile URLs of creators in your niche for benchmark monitoring. Only public data is collected.'
                : '贴同赛道博主的主页链接，用于对标监控。只采公开可见数据。'}
            </p>
            <textarea
              className="textarea"
              rows={3}
              value={seedComp}
              onChange={(e) => setSeedComp(e.target.value)}
              placeholder={lang === 'en' ? 'One per line, e.g.:\nhttps://space.bilibili.com/123456\nhttps://www.xiaohongshu.com/user/profile/...' : '每行一条，如：\nhttps://space.bilibili.com/123456\nhttps://www.xiaohongshu.com/user/profile/...'}
            />
          </div>

          {seedResult && (
            <div className="small" style={{ marginTop: 10, lineHeight: 1.7 }}>
              <div style={{ color: 'var(--green)' }}>
                {lang === 'en'
                  ? `✓ Saved: ${seedResult.own.ok} own posts · ${seedResult.competitors.ok} benchmark accounts`
                  : `✓ 已收下：${seedResult.own.ok} 条自有作品 · ${seedResult.competitors.ok} 个对标账号`}
              </div>
              {[...seedResult.own.failed, ...seedResult.competitors.failed].map((f, i) => (
                <div key={i} style={{ color: 'var(--amber)' }}>
                  {lang === 'en'
                    ? `⚠ Unrecognized "${f.url.slice(0, 48)}${f.url.length > 48 ? '…' : ''}": ${f.reason}`
                    : `⚠ 没认出「${f.url.slice(0, 48)}${f.url.length > 48 ? '…' : ''}」：${f.reason}`}
                </div>
              ))}
            </div>
          )}
          {err && <div className="small" style={{ marginTop: 8, color: 'var(--red)' }}>{err}</div>}

          <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={seed}
              disabled={pending || (!seedOwn.trim() && !seedComp.trim())}
            >
              {pending ? (lang === 'en' ? 'Processing…' : '处理中…') : (lang === 'en' ? 'Save These Links' : '收下这些链接')}
            </button>
            <a href="/topics" className="btn btn-sm btn-ghost">
              {seedResult ? (lang === 'en' ? 'Go to Topic Engine · Generate First Recommendations →' : '去选题引擎 · 生成第一批推荐 →') : (lang === 'en' ? 'Skip to Topic Engine →' : '跳过，直接去选题引擎 →')}
            </a>
          </div>
        </div>
      </div>
    );
  }

  // ── 第 0 步：冷启动入口（新用户第一屏）──
  if (step === 'intro') {
    return (
      <div className="stack" style={{ gap: 12 }}>
        <div>
          <b>{lang === 'en' ? 'One-Sentence Persona Setup' : '一句话建人设'}</b>
          <p className="small muted" style={{ marginTop: 4 }}>
            {lang === 'en'
              ? 'Describe who you are and what you do. AI will ask a few clarifying questions and generate your persona card — you simply review and confirm.'
              : '说一句你是谁、做什么，AI 追问几个问题后帮你把人设卡写好——你只需要打勾和改错。人设是选题推荐、改写、智囊团的共同输入，填完它，下游功能才认识你。'}
          </p>
        </div>
        <textarea
          className="textarea"
          rows={2}
          maxLength={200}
          value={sentence}
          onChange={(e) => setSentence(e.target.value)}
          placeholder={lang === 'en' ? 'e.g., I am a creator teaching beginners how to use AI tools for freelance income' : '如：我是一个教普通人用 AI 工具接单做副业的博主'}
        />
        {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-sm btn-primary" onClick={ask} disabled={pending || sentence.trim().length < 4}>
            {pending ? (lang === 'en' ? 'AI is thinking…' : 'AI 思考中…') : (lang === 'en' ? 'Start · AI Questions' : '开始 · AI 追问几个问题')}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={onManual} disabled={pending}>
            {lang === 'en' ? 'Fill Manually' : '我自己手填'}
          </button>
        </div>
      </div>
    );
  }

  // ── 第 1 步：AI 追问（PRD：3–5 问，任何一问都可跳过）──
  if (step === 'ask') {
    return (
      <div className="stack" style={{ gap: 14 }}>
        <div className="row-between">
          <b>{lang === 'en' ? `AI Follow-up · ${questions.length} Questions` : `AI 追问 · ${questions.length} 个问题`}</b>
          <span className="small muted">{lang === 'en' ? 'Each question is optional; skipped ones are filled with AI defaults marked "To Confirm"' : '每题都可跳过，跳过的由 AI 填默认值并标「待确认」'}</span>
        </div>
        {qFallback && (
          <Notice tone="amber">
            {lang === 'en'
              ? 'Model returned no usable follow-up questions; using standard three questions (what to sell / for whom / why you). These are generic fallback questions.'
              : '模型未返回可用的追问，已改用标准三问（卖什么 / 给谁 / 凭什么）。这些问题不是 AI 针对你那句话生成的。'}
          </Notice>
        )}
        <div className="stack" style={{ gap: 12 }}>
          {questions.map((q, i) => {
            const isSkip = !!skipped[q.key];
            return (
              <div key={q.key} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
                <div className="row-between" style={{ marginBottom: 6, alignItems: 'baseline' }}>
                  <span className="small"><b>{i + 1}. {q.question}</b></span>
                  <button
                    type="button"
                    className={`badge ${isSkip ? 'badge-amber' : 'badge-gray'}`}
                    style={{ cursor: 'pointer', border: 'none' }}
                    onClick={() => setSkipped((p) => ({ ...p, [q.key]: !p[q.key] }))}
                  >
                    {isSkip ? (lang === 'en' ? '✓ Skipped' : '✓ 已跳过') : (lang === 'en' ? 'Skip Question' : '跳过这问')}
                  </button>
                </div>
                {q.hint && <div className="small muted" style={{ marginBottom: 6 }}>{q.hint}</div>}
                <input
                  className="input"
                  disabled={isSkip}
                  value={answers[q.key] ?? ''}
                  onChange={(e) => setAnswers((p) => ({ ...p, [q.key]: e.target.value }))}
                  placeholder={isSkip ? (lang === 'en' ? 'Skipped — AI will fill with low-confidence default' : '已跳过——AI 会用低置信度默认值填充') : (lang === 'en' ? 'Your answer' : '你的回答')}
                />
              </div>
            );
          })}
        </div>
        {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-sm btn-primary" onClick={expand} disabled={pending}>
            {pending ? (lang === 'en' ? 'AI Expanding…' : 'AI 扩写中…') : (lang === 'en' ? 'Generate Persona Card' : '生成人设卡')}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setStep('intro')} disabled={pending}>
            {lang === 'en' ? 'Previous' : '上一步'}
          </button>
        </div>
      </div>
    );
  }

  // ── 第 2 步：逐项确认（AC：用户逐项确认，全部确认才能保存）──
  if (!draft || !card) return null;

  const filledKeys = PERSONA_FIELD_KEYS.filter((k) => !isEmptyField(card, k));
  const allConfirmed = filledKeys.length > 0 && filledKeys.every((k) => confirmed[k]);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row-between">
        <b>{lang === 'en' ? 'Item-by-Item Review' : '逐项确认'}</b>
        <span className="small muted">
          {lang === 'en'
            ? `Confirmed ${filledKeys.filter((k) => confirmed[k]).length}/${filledKeys.length}`
            : `已确认 ${filledKeys.filter((k) => confirmed[k]).length}/${filledKeys.length}`}
        </span>
      </div>

      {/* 来源标注：Mock / 降级草稿绝不冒充「AI 生成的人设」 */}
      {draft.degraded ? (
        <Notice tone="amber">
          <b>{lang === 'en' ? 'This is a local fallback draft, not AI-generated.' : '这不是 AI 生成的人设，是本地草稿。'}</b>
          {draft.mocked
            ? (lang === 'en' ? 'No model API key configured; using dev Mock channel which does not produce real personas.' : '当前未配置任何模型 API Key，走的是 dev Mock 通道，Mock 不会产出真实人设卡。')
            : (lang === 'en' ? 'Model output failed persona card schema validation and was degraded.' : '模型返回的内容没通过人设卡校验，已降级。')}
          {lang === 'en' ? ' Fields below just mirror your input; please complete each before saving.' : ' 下面各字段只是把你自己填的话原样搬了过来，请逐项补齐后再保存。'}
          {draft.issues.length > 0 && (
            <div className="small mono" style={{ marginTop: 6, opacity: 0.75 }}>
              {lang === 'en' ? `Validation failed: ${draft.issues.join('; ')}` : `校验未通过：${draft.issues.join('；')}`}
            </div>
          )}
        </Notice>
      ) : draft.mocked ? (
        <Notice tone="amber">
          <b>{lang === 'en' ? 'Mock Data' : 'Mock 数据'}</b>——{lang === 'en' ? 'No model API key configured. Content generated via dev Mock channel for testing only.' : '未配置模型 API Key，内容由 dev Mock 通道产出，不具备参考价值。'}
        </Notice>
      ) : (
        <Notice tone="brand">
          {lang === 'en'
            ? `Expanded by ${draft.provider} · ${draft.model}. AI may hallucinate or make assumptions — please verify each item, especially skipped questions.`
            : `由 ${draft.provider} · ${draft.model} 扩写。AI 会犯错也会脑补，请逐项核对——尤其是你跳过的那几问。`}
        </Notice>
      )}

      <div className="stack" style={{ gap: 10 }}>
        {PERSONA_FIELD_KEYS.map((k) => (
          <FieldRow
            key={k}
            fieldKey={k}
            card={card}
            state={draft.fields[k]}
            confirmed={!!confirmed[k]}
            onConfirm={(v) => setConfirmed((p) => ({ ...p, [k]: v }))}
            onChange={(next) => {
              setCard(next);
              setConfirmed((p) => ({ ...p, [k]: true })); // 亲手改过 = 已确认
            }}
            lang={lang}
          />
        ))}
      </div>

      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={pending || !allConfirmed}>
          {pending ? (lang === 'en' ? 'Saving…' : '保存中…') : (lang === 'en' ? 'Save Persona Card' : '保存人设卡')}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setConfirmed(Object.fromEntries(filledKeys.map((k) => [k, true])))}
          disabled={pending}
        >
          {lang === 'en' ? 'Confirm All' : '全部确认'}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setStep('ask')} disabled={pending}>
          {lang === 'en' ? 'Back to Answers' : '返回改答案'}
        </button>
        {!allConfirmed && <span className="small muted">{lang === 'en' ? 'Review all items before saving (empty fields can remain empty)' : '逐项确认后才能保存（空字段可留空）'}</span>}
      </div>
    </div>
  );
}

// ── 单字段：值 + 来源徽标 + 确认勾 ──
function FieldRow({
  fieldKey,
  card,
  state,
  confirmed,
  onConfirm,
  onChange,
  lang,
}: {
  fieldKey: PersonaFieldKey;
  card: PersonaCard;
  state: PersonaFieldState;
  confirmed: boolean;
  onConfirm: (v: boolean) => void;
  onChange: (next: PersonaCard) => void;
  lang?: string;
}) {
  const empty = isEmptyField(card, fieldKey);
  const low = isLowConfidence(state);

  return (
    <div
      className="card"
      style={{
        padding: 12,
        boxShadow: 'none',
        background: confirmed ? 'var(--green-soft)' : low ? 'var(--amber-soft)' : 'var(--surface-2)',
        border: 'none',
      }}
    >
      <div className="row-between" style={{ marginBottom: 6, alignItems: 'center' }}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="small muted">{lang === 'en' ? PERSONA_FIELD_LABEL_EN[fieldKey] : PERSONA_FIELD_LABEL[fieldKey]}</span>
          {low && <span className="badge badge-amber">{lang === 'en' ? 'To Confirm' : '待确认'}</span>}
          {state.source === 'ai-guess' && <span className="badge badge-gray">{lang === 'en' ? 'Question Skipped' : '你跳过了这问'}</span>}
          {state.source === 'local' && <span className="badge badge-gray">{lang === 'en' ? 'Local Draft' : '本地草稿'}</span>}
        </div>
        <label className="row small" style={{ gap: 6, cursor: empty ? 'not-allowed' : 'pointer', opacity: empty ? 0.5 : 1 }}>
          <input type="checkbox" checked={confirmed} disabled={empty} onChange={(e) => onConfirm(e.target.checked)} />
          {lang === 'en' ? 'Confirm' : '确认'}
        </label>
      </div>
      {state.note && <div className="small muted" style={{ marginBottom: 6 }}>{state.note}</div>}
      <FieldInput fieldKey={fieldKey} card={card} onChange={onChange} lang={lang} />
    </div>
  );
}

function FieldInput({
  fieldKey,
  card,
  onChange,
  lang,
}: {
  fieldKey: PersonaFieldKey;
  card: PersonaCard;
  onChange: (next: PersonaCard) => void;
  lang?: string;
}) {
  if (fieldKey === 'platforms') {
    return (
      <div className="wrap" style={{ gap: 8 }}>
        {PLATFORM_LIST.map((p) => {
          const on = card.platforms.includes(p.key);
          return (
            <button
              key={p.key}
              type="button"
              className={`badge ${on ? 'badge-brand' : 'badge-gray'}`}
              style={{ cursor: 'pointer', border: 'none' }}
              onClick={() =>
                onChange({
                  ...card,
                  platforms: on ? card.platforms.filter((x) => x !== p.key) : [...card.platforms, p.key],
                })
              }
            >
              {on ? '✓ ' : ''}{platformName(p.key)}
            </button>
          );
        })}
      </div>
    );
  }
  if (fieldKey === 'canDo' || fieldKey === 'cantDo') {
    return (
      <textarea
        className="textarea"
        rows={3}
        value={card[fieldKey].join('\n')}
        placeholder={lang === 'en' ? 'One per line' : '每行一条'}
        onChange={(e) =>
          onChange({ ...card, [fieldKey]: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })
        }
      />
    );
  }
  return (
    <input
      className="input"
      value={card[fieldKey] ?? ''}
      placeholder={lang === 'en' ? '(Empty) please complete' : '（空）请补充'}
      onChange={(e) => onChange({ ...card, [fieldKey]: e.target.value })}
    />
  );
}

function isEmptyField(card: PersonaCard, k: PersonaFieldKey): boolean {
  const v = card[k];
  return Array.isArray(v) ? v.length === 0 : !(v ?? '').trim();
}

function Notice({ tone, children }: { tone: 'amber' | 'brand'; children: React.ReactNode }) {
  const cls = tone === 'amber' ? 'alert-gradient-amber' : 'alert-gradient-brand';
  return (
    <div
      className={`small ${cls}`}
      style={{
        padding: '12px 14px',
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}
