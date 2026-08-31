'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { usePortalReady } from '@/components/Overlay';
import { PLATFORM_LIST } from '@/lib/constants';
import { TierBadge } from '@/components/ui';
import { Icon } from '@/components/icons';
import { HighlightedEditor, type Mark } from './HighlightedEditor';
import { supportsMarkdown, hasMarkdownMarkers, mdLiteToHtml, mdLiteToPlain } from '@/lib/studio/markdown';
import { copyRichText } from '@/lib/clipboard/rich';
import { AIGC_LABEL } from '@/lib/compliance/aigc';
import { actRewrite, actSaveHumanVersion, actCoachDiagnose, actCoachOptimize, actDeflavor, type CoachDiagnoseResult } from './actions';
import { applyLinePrefix as applyLinePrefixAt, wrapSelection as wrapSelectionAt, type EditResult } from './md-lite-edit';

type Hit = { word: string; tier: string; action: string; start: number; end: number; suggestion?: string; platform?: string };
type RewriteResult = {
  rewritten: string;
  compliance: { hits: Hit[]; riskLevel: string; platform: string };
  mocked: boolean;
  degraded?: boolean;
  // 一键优化附带的前后分数对比（普通改写无此字段）。
  // null 与 undefined 含义不同：undefined = 这条不是教练优化路径；
  // null = 是教练优化，但该平台规则表不全给不出分（此时改渲染 coachNote）。
  coachBefore?: number | null;
  coachAfter?: number | null;
  coachNote?: string | null;
  // 一键去 AI 味附带的人味分对比（其余入口无此字段）
  humanBefore?: number;
  humanAfter?: number;
  humanNote?: string;
  // danger 专给「凭空造了引语/来源」用：那是一整套虚构归因，比「数字对不上」重一档，
  // 用红色和别的提示拉开距离。仍然只是提示，不拦导出。
  humanNoteLevel?: 'info' | 'warn' | 'danger';
  // 改写后冒出来的、原文里没有的链接。这一类是唯一会**拦住采纳**的漂移：
  // 别的漂移还可能是换了个写法，而一条原文里不存在的 URL 指向具体地址，编的就是编的。
  driftUrls?: string[];
};

const RISK_LABEL: Record<string, { text: string; cls: string }> = {
  pass: { text: '合规通过', cls: 'badge-green' },
  warn: { text: '存在提示项', cls: 'badge-amber' },
  block: { text: '命中红线·禁止导出', cls: 'badge-red' },
};

function sevDot(sev: string): string {
  if (sev === 'good') return 'dot-green';
  if (sev === 'bad') return 'dot-red';
  return 'dot-amber';
}

// 本机暂存时间的相对说法。只在客户端 effect 之后渲染（restorable 是 effect 里才置上的），
// 不会像服务端渲染那样撞 hydration 不一致。
function relLocal(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--green)';
  if (score >= 60) return 'var(--amber)';
  return 'var(--red)';
}

export function Rewriter({
  draftId,
  initialText,
  draftTitle,
  initialPlatform,
}: {
  draftId?: string;
  initialText?: string;
  draftTitle?: string;
  initialPlatform?: string;
}) {
  const [text, setText] = useState(initialText ?? '');
  const [platform, setPlatform] = useState(
    initialPlatform && PLATFORM_LIST.some((p) => p.key === initialPlatform) ? initialPlatform : (PLATFORM_LIST[0].key as string),
  );
  const [result, setResult] = useState<RewriteResult | null>(null);
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState('');
  // 「我已逐条核对这些链接」。只对 driftUrls 生效，且每出一次新结果就清零（见 deflavor）。
  const [urlsChecked, setUrlsChecked] = useState(false);
  const router = useRouter();

  // ── 专注写作：整屏只剩编辑框 ──
  //
  // 编辑框原来夹在「说明文字」和「教练卡 + 改写结果」中间，是一个 8 行的窄条：
  // 真要坐下来写一篇 1500 字的稿子，得在这个小格子里滚来滚去。
  // 专注模式只留正文和字数，AI 那几个按钮**故意不给**——它们的产出要占半屏才看得清，
  // 在这里点等于按下去什么都没发生。
  const [focus, setFocus] = useState(false);
  const portalReady = usePortalReady();
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocus(false); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // 覆盖层是 fixed，底下那页不该还能滚
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [focus]);

  // 字数按**不含空白**算：各平台的字数上限都是按可见字符卡的，把换行也算进去会虚高
  const stats = useMemo(() => ({
    chars: text.replace(/\s/g, '').length,
    paras: text.split('\n').filter((s) => s.trim()).length,
  }), [text]);

  // ── 本地自动保存 ──
  //
  // 在编辑框里改完不点「保存我的修改」就切走 / 关页面，改动直接没了，没有任何提示。
  // 这里只做**本地暂存**，不偷偷写库：写库会凭空造出用户没打算留下的版本，
  // 而版本线是要拿去学偏好的，脏一条就一直脏着。
  // 恢复也不自动覆盖编辑框——回来时正文可能已经被别处（AI 起草、技能存版本）更新过，
  // 直接盖上去就是拿旧稿冲掉新稿。给一条横幅让人自己选。
  const baseText = initialText ?? '';
  const storageKey = `beacon.studio.draft.${draftId ?? 'new'}`;
  const dirty = text !== baseText;
  const [restorable, setRestorable] = useState<{ text: string; at: number } | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as { text?: string; at?: number };
      // 暂存的内容和服务端最新版一样 → 没什么可恢复的，顺手清掉
      if (!saved?.text || saved.text === baseText) {
        window.localStorage.removeItem(storageKey);
        return;
      }
      setRestorable({ text: saved.text, at: saved.at ?? 0 });
    } catch {
      // 隐私模式 / 存储配额 / 内容损坏：自动保存是兜底功能，坏了就当没有，不能拦住写作
    }
    // 组件在 page.tsx 里按 draftId 做了 key，换草稿即重挂，所以这里只需跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!dirty) {
      try { window.localStorage.removeItem(storageKey); } catch { /* 同上 */ }
      return;
    }
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify({ text, at: Date.now() }));
      } catch { /* 同上 */ }
    }, 800);
    return () => clearTimeout(t);
  }, [text, dirty, storageKey]);

  // 关标签页 / 刷新时拦一下。只在真有未保存改动时挂监听——常挂着会让整站的正常跳转都弹确认框。
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  // ── 轻结构 markdown（只在文章型平台出现，见 lib/studio/markdown.ts）──
  const mdOn = supportsMarkdown(platform);
  const [preview, setPreview] = useState(false);
  const [mdCopied, setMdCopied] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // 记号写好了却换到不认排版的平台：`**` 会被原样发出去。这种错发出去才发现，成本很高
  const markerMismatch = !mdOn && hasMarkdownMarkers(text);

  /** 在光标所在行的行首插入记号（## / - / >）。多行选区则每一行都加。 */
  /** 工具条按钮：读选区 → 交给纯函数算 → 写回去。算的部分在 ./md-lite-edit（有覆盖）。 */
  function runEdit(fn: (t: string, s: number, e: number) => EditResult) {
    const ta = taRef.current;
    if (!ta) return;
    const r = fn(text, ta.selectionStart, ta.selectionEnd);
    setText(r.value);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(r.selStart, r.selEnd);
    });
  }

  const applyLinePrefix = (prefix: string) => runEdit((t, s, e) => applyLinePrefixAt(t, s, e, prefix));
  const wrapSelection = (mark: string) => runEdit((t, s, e) => wrapSelectionAt(t, s, e, mark));

  async function copyPreviewRich() {
    const html = mdLiteToHtml(text);
    await copyRichText(html, mdLiteToPlain(text));
    setMdCopied(true);
    setTimeout(() => setMdCopied(false), 1800);
  }

  // ── 算法教练实时诊断（防抖 700ms，确定性规则零 LLM 成本）──
  const [coach, setCoach] = useState<CoachDiagnoseResult | null>(null);
  // 产出这份诊断时的正文原文。命中位置是**相对那一份正文**算的，用户接着又敲了几个字之后
  // 这些偏移就会整体错位、把色块盖到隔壁的词上。所以只有快照与当前正文完全一致时才画标注，
  // 不一致就一个都不画——宁可暂时没有标注，也不能标错地方。
  const [coachFor, setCoachFor] = useState('');
  const [coachLoading, setCoachLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const body = text.trim();
    if (body.length < 30) {
      setCoach(null);
      setCoachFor('');
      return;
    }
    debounceRef.current = setTimeout(() => {
      const seq = ++seqRef.current;
      const snapshot = text; // 传原文而不是 trim 过的：action 返回的偏移相对它收到的那个字符串
      setCoachLoading(true);
      actCoachDiagnose(snapshot, platform, draftTitle)
        .then((r) => {
          if (seq !== seqRef.current) return; // 丢弃过期响应
          if ('error' in r) {
            setCoach(null);
            setCoachFor('');
          } else {
            setCoach(r);
            setCoachFor(snapshot);
          }
        })
        .finally(() => {
          if (seq === seqRef.current) setCoachLoading(false);
        });
    }, 700);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [text, platform, draftTitle]);

  function run() {
    setErr('');
    setSaved('');
    start(async () => {
      const r = await actRewrite(text, platform);
      if ('error' in r) {
        setErr(r.error);
        setResult(null);
      } else {
        setResult(r);
      }
    });
  }

  // 教练一键优化：按诊断结论 + 平台算法信号重写，结果进入既有「改写结果」流程（合规高亮/采纳落稿）
  function optimize() {
    setErr('');
    setSaved('');
    start(async () => {
      const r = await actCoachOptimize(text, platform, draftTitle);
      if ('error' in r) {
        setErr(r.error);
        return;
      }
      setResult({
        rewritten: r.optimized,
        compliance: r.compliance,
        mocked: r.mocked,
        degraded: r.degraded,
        coachBefore: r.before.score,
        coachAfter: r.after.score,
        coachNote: r.after.scoreNote,
      });
    });
  }

  // 一键去 AI 味：与教练优化并列的另一条重写路径。
  // 两者目标不同且偶尔冲突（教练鼓励标准钩子/CTA，那恰是 AI 腔重灾区），
  // 所以分成两个按钮各自给分，让用户自己挑这一版要哪个。
  function deflavor() {
    setErr('');
    setSaved('');
    start(async () => {
      const r = await actDeflavor(text, platform);
      if ('error' in r) {
        setErr(r.error);
        return;
      }
      setResult({
        rewritten: r.rewritten,
        compliance: r.compliance,
        mocked: r.mocked,
        degraded: r.degraded,
        humanBefore: r.before.score,
        humanAfter: r.after.score,
        // 事实漂移优先说：那是「可能编了个数」，比「样本不足效果打折」严重得多
        humanNote:
          r.driftWarning ??
          (r.hasExemplar
            ? undefined
            : '没找到你自己的文风样本，这次只按通用规则去味。到素材库添加「文风样本」，或粘一篇你写过的稿子建草稿，效果会明显不同。'),
        humanNoteLevel: r.driftLevel === 'attribution' ? 'danger' : r.driftWarning ? 'warn' : 'info',
        driftUrls: r.driftUrls,
      });
      setUrlsChecked(false); // 新结果 = 新的一批链接，上一次的确认不能顺延
    });
  }

  function saveAsHuman() {
    if (!draftId || !result) return;
    start(async () => {
      const r = await actSaveHumanVersion(draftId, result.rewritten);
      if (r.ok) {
        setSaved(`已存为人工终稿 第${r.seq}版`);
        router.refresh();
      } else {
        setErr(r.error ?? '保存失败');
      }
    });
  }

  function saveManualEdit() {
    if (!draftId || !text.trim()) return;
    start(async () => {
      const r = await actSaveHumanVersion(draftId, text);
      if (r.ok) {
        setSaved(`已存为人工终稿 第${r.seq}版`);
        router.refresh();
      } else {
        setErr(r.error ?? '保存失败');
      }
    });
  }

  const risk = result ? RISK_LABEL[result.compliance.riskLevel] ?? RISK_LABEL.pass : null;

  // ── 内联标注：合规命中 + 套话命中，合成一串互不重叠的区间 ──
  // 诊断快照与当前正文不一致时一个都不画（偏移会整体错位，见 coachFor）。
  const marks: Mark[] = useMemo(() => {
    if (!coach || coachFor !== text) return [];
    const raw = [
      ...coach.compliance.hits.map((h) => ({
        start: h.start,
        end: h.end,
        kind: (h.action === 'block' ? 'block' : 'warn') as Mark['kind'],
        rank: h.action === 'block' ? 0 : 1,
      })),
      ...coach.humanize.hits.map((h) => ({ start: h.start, end: h.end, kind: 'ai' as const, rank: 2 })),
    ];
    // 同一处可能既是慎用词又是套话。按 start 排、同起点让更严重的先占位，再贪心跳过重叠区间：
    // 一个词标两种颜色，用户会以为是两个问题。
    raw.sort((a, b) => a.start - b.start || a.rank - b.rank || b.end - a.end);
    const out: Mark[] = [];
    let cursor = 0;
    for (const m of raw) {
      if (m.start < cursor) continue;
      out.push({ start: m.start, end: m.end, kind: m.kind });
      cursor = m.end;
    }
    return out;
  }, [coach, coachFor, text]);

  // 编辑框下面那条「有哪些词」：合规命中要能点开看建议，所以列在这儿（镜像层是 pointer-events:none，
  // 挂不了 tooltip）。套话的明细在教练卡里已经有一份，这里只报个数，不重复列。
  const inlineHits = coach && coachFor === text ? coach.compliance.hits : [];
  const aiHitCount = coach && coachFor === text ? coach.humanize.hits.length : 0;

  const renderCoachCard = (coach || coachLoading) ? (
    <div className="card" style={{ padding: 16, boxShadow: 'none', background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <div className="row-between" style={{ marginBottom: 10 }}>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <Icon.gauge size={15} style={{ color: 'var(--brand)' }} />
          <b className="small" style={{ fontSize: 13.5 }}>算法教练 · 实时诊断</b>
          {coachLoading && <span className="small muted">诊断中…</span>}
        </div>
        {coach && (
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            {coach.personalized ? (
              <span className="badge badge-brand" title="诊断阈值已结合账号真实回流数据">
                已结合你 {coach.sample} 条真实数据
              </span>
            ) : (
              <span className="badge badge-gray" title="到数据看板登记回流数据后，诊断会切换为个性化基线">
                通用规则（暂无回流数据）
              </span>
            )}
            {/* score 为 null = 该平台规则表不全，给不出可比的分。印「— 分」也不行：
                用户会读成「0 分」或「坏了」，而真相是「这一项我们没测」。 */}
            {coach.score === null ? (
              <span className="badge badge-gray" style={{ fontSize: 13.5 }} title={coach.scoreNote ?? undefined}>
                本平台不给总分
              </span>
            ) : (
              <span className="badge" style={{ background: 'var(--surface)', color: scoreColor(coach.score), fontSize: 13.5, fontWeight: 700 }}>
                {coach.score} 分
              </span>
            )}
          </div>
        )}
      </div>

      {coach && (
        <div className="stack" style={{ gap: 10 }}>
          {coach.findings.map((f, i) => (
            <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span className={`dot ${sevDot(f.severity)}`} style={{ marginTop: 5, flexShrink: 0 }} />
              <div className="small" style={{ lineHeight: 1.6 }}>
                <b style={{ color: 'var(--text)' }}>{f.dimension}</b>
                <span className="muted">｜{f.finding}</span>
                {f.severity !== 'good' && <div className="muted" style={{ color: 'var(--brand-dark, var(--text-2))' }}>→ {f.advice}</div>}
              </div>
            </div>
          ))}
          {/* 人味体检：与算法诊断同一次防抖算出，零 LLM。
              分数只在样本足够时才显示——120 字以下的稿子算不出句长方差，给分就是拿噪声骗人。 */}
          <div className="divider" style={{ margin: '6px 0' }} />
          <div className="row-between" style={{ marginBottom: 6 }}>
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <Icon.user size={14} style={{ color: 'var(--brand)' }} />
              <b className="small" style={{ fontSize: 13 }}>人味体检</b>
              <span className="small muted" title="检测大模型套话、句子节奏、对仗密度、口语碎句——全部是确定性规则，不花 AI 额度">
                像不像人写的
              </span>
            </div>
            {coach.humanize.sufficient ? (
              <span className="badge" style={{ background: 'var(--surface)', color: scoreColor(coach.humanize.score), fontSize: 13.5, fontWeight: 700 }}>
                {coach.humanize.score} 分
              </span>
            ) : (
              <span className="badge badge-gray" title="不足 120 字或不足 5 句，方差类指标算不出可信结果">
                字数不够，暂不评分
              </span>
            )}
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {coach.humanize.findings.map((f, i) => (
              <div key={`h${i}`} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <span className={`dot ${sevDot(f.severity)}`} style={{ marginTop: 5, flexShrink: 0 }} />
                <div className="small" style={{ lineHeight: 1.6 }}>
                  <b style={{ color: 'var(--text)' }}>{f.dimension}</b>
                  <span className="muted">｜{f.finding}</span>
                  {f.severity !== 'good' && <div className="muted">→ {f.advice}</div>}
                </div>
              </div>
            ))}
            {coach.humanize.hits.length > 0 && (
              <div className="row wrap" style={{ gap: 6 }}>
                {coach.humanize.hits.slice(0, 12).map((h, i) => (
                  <span
                    key={`fw${i}`}
                    className="badge badge-amber"
                    style={{ fontSize: 11 }}
                    title={`${h.suggestion}`}
                  >
                    {h.word}
                  </span>
                ))}
                {coach.humanize.hits.length > 12 && (
                  <span className="small muted">等 {coach.humanize.hits.length} 处</span>
                )}
              </div>
            )}
          </div>

          {coach.signals.length > 0 && (
            <>
              <div className="divider" style={{ margin: '6px 0' }} />
              <div className="small muted">
                {PLATFORM_LIST.find((p) => p.key === platform)?.name}核心信号：
                <span style={{ color: 'var(--text-2)' }}>{coach.signals.map((s) => s.signal).join(' · ')}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  ) : null;

  // 采纳闸：只拦「凭空多出来的链接」这一类，且勾了确认就放行。
  // 与合规红线那道闸并列（riskLevel==='block'），但语义不同——红线是平台禁词、永远不能发；
  // 这条是「可能是编的，你核一下」，判断权在用户手上，产品不替他决定链接真假。
  const urlDrift = result?.driftUrls ?? [];
  const urlBlocked = urlDrift.length > 0 && !urlsChecked;

  const renderResultCard = result ? (
    <div className="card" style={{ padding: 16, boxShadow: 'none', background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <div className="row-between" style={{ marginBottom: 10 }}>
        <b className="small" style={{ fontSize: 13.5 }}>
          {result.coachAfter !== undefined ? '教练优化结果' : '改写结果'} · {PLATFORM_LIST.find((p) => p.key === platform)?.name}
        </b>
        <div className="row" style={{ gap: 6 }}>
          {/* null（该平台规则表不全）走下面的 coachNote 说明，不能落进这里印成「null → null 分」 */}
          {typeof result.coachBefore === 'number' && typeof result.coachAfter === 'number' && (
            <span className="badge badge-brand" title="按平台算法要点打的分，优化前 → 优化后">
              {result.coachBefore} → {result.coachAfter} 分
            </span>
          )}
          {result.coachAfter === null && result.coachNote && (
            <span className="badge badge-gray" title={result.coachNote}>
              本平台不给总分
            </span>
          )}
          {result.humanBefore !== undefined && result.humanAfter !== undefined && (
            <span className="badge badge-brand" title="人味分（套话/节奏/对仗/碎句），处理前 → 处理后">
              人味 {result.humanBefore} → {result.humanAfter} 分
            </span>
          )}
          {risk && <span className={`badge ${risk.cls}`}>{risk.text}</span>}
          {result.mocked && (
            <span className="badge badge-amber" title={result.degraded ? 'AI 服务临时失败，已用演示内容占位——点「重试」可再试一次' : '尚未接入真实模型，这是内置的演示产出，仅用于预览流程'}>
              {result.degraded ? 'AI 临时失败（演示占位）' : '演示结果（未接入真实 AI）'}
            </span>
          )}
        </div>
      </div>

      {result.humanNote && (
        <div
          className="small"
          style={{
            marginBottom: 8,
            lineHeight: 1.6,
            color:
              result.humanNoteLevel === 'danger'
                ? 'var(--red)'
                : result.humanNoteLevel === 'warn'
                  ? 'var(--amber)'
                  : 'var(--muted)',
          }}
        >
          {result.humanNoteLevel === 'danger' ? '🚩' : result.humanNoteLevel === 'warn' ? '⚠️' : 'ℹ️'}{' '}
          {result.humanNote}
        </div>
      )}

      <div className="small" style={{
        whiteSpace: 'pre-wrap',
        lineHeight: 1.7,
        background: 'var(--surface)',
        padding: '12px 14px',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border-subtle, var(--border))',
        maxHeight: 320,
        overflowY: 'auto'
      }}>
        <Highlighted text={result.rewritten} hits={result.compliance.hits} />
      </div>

      {result.compliance.hits.length > 0 && (
        <>
          <div className="divider" style={{ margin: '10px 0' }} />
          <div className="small muted" style={{ marginBottom: 6 }}>合规命中 {result.compliance.hits.length} 处</div>
          <div className="stack" style={{ gap: 6 }}>
            {result.compliance.hits.map((h, i) => (
              <div key={i} className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                <TierBadge tier={h.tier} />
                <span className="mono small">「{h.word}」</span>
                <span className="badge badge-gray">{h.action === 'block' ? '禁用' : h.action === 'warn' ? '慎用' : '建议'}</span>
                {h.suggestion && <span className="small muted">→ {h.suggestion}</span>}
              </div>
            ))}
          </div>
        </>
      )}

      {/* 凭空多出来的链接：唯一会拦住采纳的一类漂移。逐条列出来让人能直接点开核，
          而不是只说一句「有链接对不上」——核不动的告警等于没有告警。 */}
      {urlDrift.length > 0 && (
        <>
          <div className="divider" style={{ margin: '10px 0' }} />
          <div className="small" style={{ color: 'var(--red)', lineHeight: 1.6, marginBottom: 6 }}>
            🚩 改写后多出了 {urlDrift.length} 条原文里没有的链接。别的漂移还可能只是换了个写法，
            链接不会——模型拼出来的地址就是编的。逐条核完再采纳：
          </div>
          <div className="stack" style={{ gap: 4, marginBottom: 8 }}>
            {urlDrift.map((u) => (
              <code key={u} className="mono small" style={{ wordBreak: 'break-all', color: 'var(--red)' }}>{u}</code>
            ))}
          </div>
          <label className="row small" style={{ gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={urlsChecked} onChange={(e) => setUrlsChecked(e.target.checked)} />
            我已逐条核对这些链接，确认它们真实存在且指向我要引的内容
          </label>
        </>
      )}

      <div className="divider" style={{ margin: '10px 0' }} />
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        {draftId ? (
          <button
            className="btn btn-sm btn-accent"
            onClick={saveAsHuman}
            disabled={pending || result.compliance.riskLevel === 'block' || urlBlocked}
            title={urlBlocked ? '先逐条核对上面那几条链接并勾选确认' : undefined}
          >
            <Icon.check size={14} /> 采纳为人工终稿
          </button>
        ) : (
          <span className="small muted">选中左侧草稿后可存为人工终稿</span>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => setText(result.rewritten)} disabled={pending}>
          回填到编辑框继续改
        </button>
        {result.compliance.riskLevel === 'block' && <span className="small" style={{ color: 'var(--red)' }}>命中红线，需先修改后才能落稿</span>}
        {saved && <span className="small" style={{ color: 'var(--green)' }}>{saved}</span>}
      </div>
    </div>
  ) : null;

  const body = (
    <div className={focus ? 'focus-layer' : 'stack'} style={focus ? undefined : { gap: 14 }}>
      {/* 专注模式的顶条：正在写哪篇、写了多少、当前两个分数。分数放这儿是为了不用退出就知道好不好 */}
      {focus && (
        <div className="row-between wrap" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <b style={{ fontSize: 14 }}>{draftTitle ?? '未命名草稿'}</b>
            <span className="badge badge-gray">{PLATFORM_LIST.find((p) => p.key === platform)?.name}</span>
            <span className="small muted">{stats.chars} 字 · {stats.paras} 段</span>
            {coachLoading && <span className="small muted">诊断中…</span>}
            {coach && coach.score !== null && (
              <span className="badge" style={{ background: 'var(--surface-2)', color: scoreColor(coach.score) }}>
                算法 {coach.score}
              </span>
            )}
            {coach?.humanize.sufficient && (
              <span className="badge" style={{ background: 'var(--surface-2)', color: scoreColor(coach.humanize.score) }}>
                人味 {coach.humanize.score}
              </span>
            )}
          </div>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            {draftId && (
              <button className="btn btn-sm" onClick={saveManualEdit} disabled={pending || !text.trim()}>
                保存我的修改
              </button>
            )}
            <button className="btn btn-sm btn-ghost" onClick={() => setFocus(false)}>
              <Icon.minimize size={14} /> 退出专注（Esc）
            </button>
            {saved && <span className="small" style={{ color: 'var(--green)' }}>{saved}</span>}
            {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
          </div>
        </div>
      )}

      {/* 未保存改动的恢复入口。上次离开时暂存在本地的正文，回来时由用户自己决定要不要用 */}
      {!focus && restorable && (
        <div
          className="card"
          style={{ padding: '10px 14px', boxShadow: 'none', background: 'var(--surface-2)', borderLeft: '3px solid var(--amber)' }}
        >
          <div className="row-between wrap" style={{ gap: 10 }}>
            <div className="small" style={{ lineHeight: 1.6 }}>
              这篇有一份<b>没保存的修改</b>（{restorable.at ? relLocal(restorable.at) : '上次'}留在本机），
              和当前正文不一样。
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <button
                className="btn btn-sm btn-accent"
                onClick={() => { setText(restorable.text); setRestorable(null); }}
              >
                恢复它
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  try { window.localStorage.removeItem(storageKey); } catch { /* 见上 */ }
                  setRestorable(null);
                }}
              >
                丢弃
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        className="field"
        style={focus
          ? { marginBottom: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }
          : { marginBottom: 0 }}
      >
        {!focus && (
          <div className="row-between wrap" style={{ gap: 8, marginBottom: 6 }}>
            <label className="field-label" style={{ fontWeight: 650, marginBottom: 0 }}>原始正文</label>
            <span className="small muted">
              {stats.chars} 字 · {stats.paras} 段
              {coachLoading ? ' · 诊断中…' : ''}
              {dirty && <span style={{ color: 'var(--amber)' }}> · 有未保存的修改（已暂存本机）</span>}
            </span>
          </div>
        )}

        {/* 轻结构工具条：只在文章型平台出现。插的是纯文本记号，正文仍然是纯文本 */}
        {mdOn && !preview && (
          <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
            <span className="small muted">排版</span>
            <button className="btn btn-sm btn-ghost" onClick={() => applyLinePrefix('## ')} title="把光标所在行变成小标题">小标题</button>
            <button className="btn btn-sm btn-ghost" onClick={() => wrapSelection('**')} title="加粗选中的字">加粗</button>
            <button className="btn btn-sm btn-ghost" onClick={() => applyLinePrefix('- ')} title="把选中的几行变成列表">列表</button>
            <button className="btn btn-sm btn-ghost" onClick={() => applyLinePrefix('> ')} title="把光标所在行变成引用块">引用</button>
            <span className="small muted" title="记号只是普通字符，草稿存的仍然是纯文本；预览和「复制富文本」时才渲染成排版">
              记号存的是纯文本
            </span>
          </div>
        )}

        <HighlightedEditor
          value={text}
          onChange={setText}
          marks={marks}
          taRef={taRef}
          focusMode={focus}
          rows={12}
          minHeight={focus ? undefined : 260}
          fontSize={focus ? 15 : undefined}
          lineHeight={focus ? 1.9 : undefined}
          placeholder="粘贴或输入正文——算法教练会边写边诊断（钩子/篇幅/结构/互动引导），命中的敏感词和套话会直接标在字下面。"
        />

        {/* 标注图例 + 合规命中明细。镜像层挂不了 tooltip，能点开看建议的入口只能放这儿 */}
        {!focus && (inlineHits.length > 0 || aiHitCount > 0) && (
          <div className="row wrap" style={{ gap: 6, marginTop: 8, alignItems: 'center' }}>
            {inlineHits.length > 0 && (
              <span className="small muted">正文里标出 {inlineHits.length} 处用词：</span>
            )}
            {inlineHits.slice(0, 10).map((h, i) => (
              <span
                key={i}
                className={`badge ${h.action === 'block' ? 'badge-red' : 'badge-amber'}`}
                title={`${h.action === 'block' ? '禁用' : h.action === 'warn' ? '慎用' : '建议'}${h.suggestion ? ` → ${h.suggestion}` : ''}`}
              >
                {h.word}
              </span>
            ))}
            {inlineHits.length > 10 && <span className="small muted">等 {inlineHits.length} 处</span>}
            {aiHitCount > 0 && (
              <span className="small muted" title="下方教练卡里有逐条明细">
                · 另有 {aiHitCount} 处套话（虚线标注）
              </span>
            )}
          </div>
        )}

        {markerMismatch && (
          <div className="small" style={{ marginTop: 8, color: 'var(--amber)', lineHeight: 1.6 }}>
            ⚠️ 正文里有 ## / ** / - 这类排版记号，但{PLATFORM_LIST.find((p) => p.key === platform)?.name}
            的编辑器不认——发出去会原样显示成符号。改平台，或把记号删掉。
          </div>
        )}
      </div>

      {/* 排版预览：只渲染给人看，草稿存的还是带记号的纯文本 */}
      {!focus && mdOn && preview && (
        <div className="card" style={{ padding: 16, boxShadow: 'none', background: 'var(--surface-2)' }}>
          <div className="row-between wrap" style={{ gap: 8, marginBottom: 10 }}>
            <b className="small">排版预览 · 公众号</b>
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn btn-sm btn-accent" onClick={copyPreviewRich} disabled={!text.trim()}>
                {mdCopied ? '已复制 ✓' : '复制富文本'}
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setPreview(false)}>回到编辑</button>
            </div>
          </div>
          <div
            className="md-preview"
            style={{ background: 'var(--surface)', padding: '14px 16px', borderRadius: 'var(--radius-sm)' }}
            // mdLiteToHtml 先转义再套标签，产出由构造保证安全（见 lib/studio/markdown.ts）
            dangerouslySetInnerHTML={{ __html: mdLiteToHtml(text) }}
          />
          <div className="small muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
            「复制富文本」把排版和「{AIGC_LABEL}」标识一起写进剪贴板，可直接粘进公众号编辑器。
            草稿本身存的仍是带记号的纯文本，合规检测、教练诊断、版本对比全都照常工作。
          </div>
        </div>
      )}

      {/* 专注模式下不出这一排：AI 那几个动作的产出要占半屏才看得清，在只剩编辑框的界面里点等于石沉大海 */}
      {!focus && (
        <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
          <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)} style={{ maxWidth: 180 }}>
            {PLATFORM_LIST.map((p) => (
              <option key={p.key} value={p.key}>
                目标平台 · {p.name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary btn-sm" onClick={run} disabled={pending || !text.trim()}>
            <Icon.sparkles size={14} /> {pending ? '处理中…' : '一键改写 + 合规检测'}
          </button>
          <button className="btn btn-accent btn-sm" onClick={optimize} disabled={pending || !text.trim()}>
            <Icon.gauge size={14} /> {pending ? '处理中…' : '教练一键优化'}
          </button>
          <button
            className="btn btn-sm"
            onClick={deflavor}
            disabled={pending || !text.trim()}
            title="按你自己的原句样本改掉套话与均匀节奏，信息不增不减"
          >
            <Icon.user size={14} /> {pending ? '处理中…' : '一键去 AI 味'}
          </button>
          {draftId && (
            <button
              className="btn btn-sm"
              onClick={saveManualEdit}
              disabled={pending || !text.trim()}
              title="把编辑框里的当前内容直接存为人工终稿"
            >
              保存我的修改
            </button>
          )}
          {mdOn && (
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setPreview((v) => !v)}
              title="看排版记号渲染出来是什么样，并可复制成富文本直接粘进公众号"
            >
              <Icon.eye size={14} /> {preview ? '收起预览' : '排版预览'}
            </button>
          )}
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => setFocus(true)}
            title="整屏只留编辑框，专心写正文（Esc 退出）"
          >
            <Icon.maximize size={14} /> 专注写作
          </button>
          {saved && !err && <span className="small" style={{ color: 'var(--green)' }}>{saved}</span>}
          {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
        </div>
      )}

      {/* 诊断卡片与改写结果：若两者同时存在则展示为双栏，避免单纵列拉得过长 */}
      {!focus && (renderCoachCard && renderResultCard ? (
        <div className="grid grid-2" style={{ gap: 16 }}>
          {renderCoachCard}
          {renderResultCard}
        </div>
      ) : (
        <>
          {renderCoachCard}
          {renderResultCard}
        </>
      ))}
    </div>
  );

  // 专注层必须挂到 body 上：它的祖先 .card 在鼠标悬停时带 transform，
  // 而 transform 元素是 position:fixed 的包含块——就地渲染时"全屏"层只有卡片那么大。
  // 详见 components/Overlay.tsx。
  return focus && portalReady ? createPortal(body, document.body) : body;
}

// 把命中词高亮标出（按 start/end 切片）
function Highlighted({ text, hits }: { text: string; hits: Hit[] }) {
  if (hits.length === 0) return <>{text}</>;
  const sorted = [...hits].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((h, i) => {
    if (h.start < cursor) return; // 跳过重叠命中
    if (h.start > cursor) parts.push(<span key={`t${i}`}>{text.slice(cursor, h.start)}</span>);
    const color = h.action === 'block' ? 'var(--red)' : 'var(--amber)';
    parts.push(
      <mark key={`h${i}`} style={{ background: 'transparent', color, fontWeight: 600, textDecoration: 'underline wavy', textUnderlineOffset: 3 }}>
        {text.slice(h.start, h.end)}
      </mark>,
    );
    cursor = h.end;
  });
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>);
  return <>{parts}</>;
}
