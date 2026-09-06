'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Icon } from '@/components/icons';
import { looksActionable, wantsExecution } from '@/lib/agent/intent';
import { prepareReferenceImage } from '@/lib/cover/client-image';
import { ModelPicker, readPickedModel } from './ModelPicker';
import type { SelectableModel } from '@/lib/llm/selectable';
import { useI18n } from '@/lib/i18n';

/**
 * 一次最多带几张图。
 *
 * 每张内联图都要整段进请求体与模型上下文，四五张就是几 MB——
 * 而生产的 WAF 对超大请求体会回一个**假的 HTTP 200 + HTML 错误页**
 *（视频拆解上传曾因此在生产一直是坏的）。3 张够用且留足余量，
 * 与服务端 app/api/chat/stream 的 MAX_IMAGES 是同一个数。
 */
const MAX_PICS = 3;

type ChatTurn = { role: 'user' | 'assistant'; content: string };
type Msg = { role: 'user' | 'assistant'; content: string; mocked?: boolean; error?: boolean };

/**
 * 「为你推荐」——空态时摆在大标题下面的四张卡（2026-08-26，照用户给的豆包工作那个版式）。
 *
 * 【为什么是四类而不是四句现成的话】原来三条是写死的问句（「帮我想 3 个本周选题」），
 * 点了就直接发出去。问题是它们把用户框死在这三件事上，而这一页真正的承诺是
 *「什么都能说」。改成**四个方向 + 各自一句起手**：点了是把起手填进输入框（不直接发），
 * 用户还能接着改——这也是豆包那四张卡的行为。
 */
const QUICK = [
  { icon: 'bulb' as const, label: '定选题', seed: '结合我的账号人设，帮我想 3 个本周能做的选题，说清为什么适合我' },
  { icon: 'pen' as const, label: '写内容', seed: '帮我把这条选题写成一篇初稿：' },
  { icon: 'radar' as const, label: '看同行', seed: '我的对标账号最近在发什么？有什么是我该跟的' },
  { icon: 'chart' as const, label: '看数据', seed: '我最近哪几条跑得好、哪几条不行？原因可能是什么' },
];

export function Chat({
  accountName,
  models,
  onHandoff,
}: {
  accountName: string;
  /** 可选模型清单（自动 / 自接入 / 外接入）。空数组 = 不显示选择器 */
  models: SelectableModel[];
  /** 「让它直接去做」：把这句话交给执行那一侧。不传 = 不显示那个按钮 */
  onHandoff?: (goal: string) => void;
}) {
  const { lang } = useI18n();
  // 空态不放开场白气泡（豆包式：留白+大标题就是欢迎）。第一句欢迎信息在 hero 副标题里。
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  /**
   * 刚问完的这句话像不像「让它去做」（lib/agent/intent.ts 判的，不问模型）。
   * 只留最近一句：每条回答后面都挂一个按钮就成了背景噪音。
   */
  const [handoffGoal, setHandoffGoal] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * 待发送的参考图（data: URI，已在客户端压过）。
   *
   * 【为什么图不进 messages 历史】历史每一轮都会整段重发给模型，图片带进去
   * 会让第三轮的请求体变成几 MB——而生产的 WAF 对超大请求体会回一个**假的 200**。
   * 图只跟着**这一次提问**走，问完就清空。
   */
  const [pics, setPics] = useState<string[]>([]);
  const [picErr, setPicErr] = useState('');
  /**
   * 这次用哪个模型。**初值不能直接读 localStorage**——服务端渲染时没有这个 API，
   * 首屏 HTML 与 hydrate 后的值不一致会触发 hydration mismatch。
   * 所以初值取清单第一项（自动档），挂载后再把上次的选择读回来。
   */
  const [modelId, setModelId] = useState(() => models[0]?.id ?? 'auto');
  useEffect(() => { setModelId(readPickedModel(models)); }, [models]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    // 只发图不打字也算数：「这张图怎么样」是很自然的问法
    if ((!q && pics.length === 0) || streaming) return;

    // 「帮我去执行/执行一下」这种明说要执行的话，不再先答一篇计划再给按钮——
    // 直接交给执行那一侧开跑（2026-08-26 用户原话「并没办法去执行」；这一下发送就是授权）
    if (onHandoff && wantsExecution(q)) {
      setInput('');
      onHandoff(q);
      return;
    }

    const history: ChatTurn[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: q || (lang === 'en' ? `(Sent ${pics.length} image${pics.length > 1 ? 's' : ''})` : `（发了 ${pics.length} 张图）`) },
    ]);
    setInput('');
    const sending = pics;
    setPics([]); // 图只跟这一次提问走
    setPicErr('');
    setStreaming(true);
    // 上一句的按钮先撤掉：留着的话它指的是上上句，点下去做的是用户已经翻过去的事
    setHandoffGoal(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history, images: sending, modelId }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setMessages((prev) => [...prev, { role: 'assistant', content: errBody.error || (lang === 'en' ? `Request failed (${res.status})` : `请求失败 (${res.status})`), error: true }]);
        return;
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      // 【为什么攒着刷】SSE 每个 delta 通常就一两个字，逐条 setMessages 会让文字
      // 一字一顿地蹦（用户原话「要流畅点，不要一个字一个字的吐」）。攒进 acc、
      // 每 80ms 批量追加一次——观感是成句地流出来，重渲染次数也降一个量级。
      let acc = '';
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        flushTimer = null;
        if (!acc) return;
        const chunk = acc;
        acc = '';
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { ...last, content: last.content + chunk };
          return copy;
        });
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop()!;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') break;
          try {
            acc += JSON.parse(payload) as string;
            if (!flushTimer) flushTimer = setTimeout(flush, 80);
          } catch { /* skip */ }
        }
      }
      // 收尾必须把余量刷出去，且要清掉挂着的定时器——不然最后一截会在 80ms 后
      // 才蹦出来，或者组件卸载后 setMessages 打在已卸载的组件上
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      // 答完了再判：答之前就亮按钮，等于在回答还没出来时催用户做决定。
      // 出错/中断的分支各自 return，不会走到这里——那种时候更不该催他去执行
      if (looksActionable(q)) setHandoffGoal(q);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: (lang === 'en' ? 'Something went wrong: ' : '出了点问题：') + (e as Error).message.slice(0, 60), error: true },
      ]);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
    // pics 要进依赖：漏了的话闭包里永远是第一次渲染时的空数组，
    // 表现为「传了图但发出去的还是没有图」——不报错，只是图白传了
  // modelId 必须在依赖里：useCallback 的闭包否则永远捕获首次那个值，
  // 表现为「下拉选了别的模型，发出去的还是自动档」——选项形同虚设。
  }, [messages, streaming, pics, modelId, lang]);

  /** 选了图：客户端先压一遍再入队。压缩复用封面工位那一份，不另写第二套。 */
  async function addPics(files: File[]) {
    setPicErr('');
    const room = MAX_PICS - pics.length;
    if (room <= 0) { setPicErr(lang === 'en' ? `Up to ${MAX_PICS} images` : `最多 ${MAX_PICS} 张`); return; }
    const next: string[] = [];
    for (const f of files.slice(0, room)) {
      try {
        const prepared = await prepareReferenceImage(f);
        next.push(prepared.dataUrl);
      } catch (e) {
        // 一张坏图不该把其余几张一起弃掉——如实说是哪一张不行
        setPicErr(`${f.name}：${(e as Error).message}`);
      }
    }
    if (next.length) setPics((list) => [...list, ...next]);
    if (files.length > room) setPicErr(lang === 'en' ? `Up to ${MAX_PICS} images, excess images ignored` : `最多 ${MAX_PICS} 张，多出来的没有加进来`);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <div className="chat-stage">
      {/* 空态（只有开场白那一条）时给豆包式的落地：大标题 + 为你推荐四张卡。
          聊起来之后整段消失——它是「不知道从哪开始」的解药，不是常驻装饰。 */}
      {messages.length === 0 ? (
        <div className="chat-hero chat-hero-doubao">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" width={64} height={64} style={{ borderRadius: 16, marginBottom: 18 }} />
          <h2 className="chat-hero-title">
            {lang === 'en'
              ? `What are you working on today, ${accountName === '我的账号' || !accountName ? 'My Account' : accountName}?`
              : `今天要做什么，${accountName}？`}
          </h2>
          <p className="small muted chat-hero-sub">
            {lang === 'en'
              ? 'Just say a word. Brainstorm topics, write drafts, check rivals, or inspect analytics. If an action is required, AI will ask to execute.'
              : '说一句话就行。选题、写稿、看同行、看数据都可以问；需要动手做的，答完会问你要不要去做。'}
          </p>
          <div className="chat-hero-cards">
            {(lang === 'en' ? [
              { icon: 'bulb' as const, color: 'var(--amber)', label: 'Pick Topic', seed: 'Based on my persona, propose 3 content topics for this week with rationale' },
              { icon: 'pen' as const, color: 'var(--brand)', label: 'Write Copy', seed: 'Help me write a draft based on this topic: ' },
              { icon: 'radar' as const, color: 'var(--accent)', label: 'Rival Intel', seed: 'What have my benchmark accounts posted recently? Anything I should follow?' },
              { icon: 'chart' as const, color: 'var(--green)', label: 'Analytics', seed: 'Which of my recent posts performed best and why?' },
            ] : [
              { icon: 'bulb' as const, color: 'var(--amber)', label: '定选题', seed: '结合我的账号人设，帮我想 3 个本周能做的选题，说清为什么适合我' },
              { icon: 'pen' as const, color: 'var(--brand)', label: '写内容', seed: '帮我把这条选题写成一篇初稿：' },
              { icon: 'radar' as const, color: 'var(--accent)', label: '看同行', seed: '我的对标账号最近在发什么？有什么是我该跟的' },
              { icon: 'chart' as const, color: 'var(--green)', label: '看数据', seed: '我最近哪几条跑得好、哪几条不行？原因可能是什么' },
            ]).map((q) => {
              const IconCmp = Icon[q.icon];
              return (
                <button
                  key={q.label}
                  type="button"
                  className="chat-hero-card"
                  disabled={streaming}
                  onClick={() => setInput(q.seed)}
                >
                  <span style={{ color: q.color, display: 'flex' }}><IconCmp size={15} /></span>
                  <span>{q.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="divider" style={{ marginTop: 0 }} />

      <div ref={listRef} className="stack" style={{ gap: 14, flex: 1, overflowY: 'auto', paddingRight: 4 }}>
        {messages.map((m, i) => (
          <Bubble key={i} msg={m} />
        ))}
        {streaming && messages[messages.length - 1]?.content === '' && (
          <div className="row" style={{ gap: 8, alignSelf: 'flex-start' }}>
            <span className="persona-avatar" style={{ background: 'var(--brand)' }}>
              <Icon.chat size={15} />
            </span>
            <div className="card" style={{ padding: '10px 14px', boxShadow: 'none', background: 'var(--surface-2)' }}>
              <span className="small muted">{lang === 'en' ? 'Thinking…' : '思考中…'}</span>
            </div>
          </div>
        )}
      </div>

      {/* 「先答后做」的那道门：只有点了它才会真的去操作系统。
          放在输入框上方、紧贴刚读完的那段回答——放页面底部等于要用户先滚过输入框 */}
      {handoffGoal && onHandoff && !streaming && (
        <div className="handoff-bar">
          <span className="small muted handoff-why">
            {lang === 'en' ? 'I can execute this directly (write operations still confirm with you)' : '这件事我可以直接去做（写操作默认仍会逐条问你）'}
          </span>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              const goal = handoffGoal;
              setHandoffGoal(null);
              onHandoff(goal);
            }}
          >
            <Icon.sparkles size={13} /> {lang === 'en' ? 'Execute Directly' : '让它直接去做'}
          </button>
        </div>
      )}

      <div className="divider" />

      <div className="chat-input-box">
        {/* 参考图待发送预览：内嵌在输入盒内部上方 */}
        {(pics.length > 0 || picErr) && (
          <div className="row wrap" style={{ gap: 8, paddingBottom: 8, marginBottom: 8, borderBottom: '1px dashed var(--border)', alignItems: 'center' }}>
            {pics.map((src, i) => (
              <span key={i} style={{ position: 'relative', display: 'inline-block', width: 52, height: 52, flexShrink: 0 }}>
                <img
                  src={src}
                  alt={lang === 'en' ? `Reference image ${i + 1}` : `参考图 ${i + 1}`}
                  style={{ width: 52, height: 52, maxWidth: 52, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', display: 'block' }}
                />
                <button
                  type="button"
                  aria-label={lang === 'en' ? 'Remove this image' : '移除这张图'}
                  onClick={() => setPics((list) => list.filter((_, j) => j !== i))}
                  style={{
                    position: 'absolute',
                    top: -6,
                    right: -6,
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                    display: 'grid',
                    placeItems: 'center',
                    cursor: 'pointer',
                    fontSize: 11,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </span>
            ))}
            {picErr && <span className="small" style={{ color: 'var(--red)', fontWeight: 600 }}>{picErr}</span>}
          </div>
        )}

        {/* 沉浸式多行文本输入区 */}
        <textarea
          className="textarea"
          style={{ width: '100%', minHeight: 64, maxHeight: 220, resize: 'none', border: 'none', background: 'transparent' }}
          placeholder={lang === 'en' ? 'Ask anything... (Enter to send, Shift+Enter for new line)' : '问点什么…（Enter 发送，Shift+Enter 换行）'}
          value={input}
          disabled={streaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
        />

        {/* 底部一体化动作栏 */}
        <div className="chat-bottom-bar">
          {/* 左侧：模型选择器 + 图片附件 */}
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            {models.length > 1 && (
              <ModelPicker models={models} value={modelId} onChange={setModelId} />
            )}

            <label
              className="chat-action-btn"
              title={pics.length >= MAX_PICS ? (lang === 'en' ? `Up to ${MAX_PICS} images` : `最多 ${MAX_PICS} 张`) : (lang === 'en' ? 'Attach reference image' : '带一张参考图问')}
              style={{ cursor: streaming || pics.length >= MAX_PICS ? 'not-allowed' : 'pointer' }}
            >
              <Icon.image size={14} />
              <span>{lang === 'en' ? 'Image' : '图片'}{pics.length > 0 ? ` (${pics.length})` : ''}</span>
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                disabled={streaming || pics.length >= MAX_PICS}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  void addPics(files);
                }}
              />
            </label>

            {pics.length > 0 && (
              <span className="small muted hide-mobile" style={{ fontSize: 11.5 }}>
                {lang === 'en' ? 'Vision-capable model active' : '已就绪看图模型'}
              </span>
            )}
          </div>

          {/* 右侧：快捷键说明 + 发送按钮 */}
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <span className="small muted hide-mobile" style={{ fontSize: 11, opacity: 0.65 }}>
              {streaming ? (lang === 'en' ? 'Thinking…' : '正在回答…') : (lang === 'en' ? 'Enter ↵ to send' : 'Enter ↵ 发送')}
            </span>

            <button
              type="button"
              className={`chat-send-btn ${!streaming && (input.trim() || pics.length > 0) ? 'active' : ''}`}
              disabled={streaming || (!input.trim() && pics.length === 0)}
              onClick={() => send(input)}
              title={lang === 'en' ? 'Send' : '发送'}
            >
              {streaming ? (
                <span className="row" style={{ gap: 4, alignItems: 'center' }}>
                  <Icon.refresh size={13} className="spin" />
                  <span>{lang === 'en' ? 'Stop' : '中止'}</span>
                </span>
              ) : (
                <span className="row" style={{ gap: 4, alignItems: 'center' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5"></line>
                    <polyline points="5 12 12 5 19 12"></polyline>
                  </svg>
                  <span>{lang === 'en' ? 'Send' : '发送'}</span>
                </span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: Msg }) {
  const { lang } = useI18n();
  const isUser = msg.role === 'user';
  const isError = !isUser && !!msg.error;
  return (
    <div
      className="row"
      style={{ gap: 8, alignItems: 'flex-start', alignSelf: isUser ? 'flex-end' : 'flex-start', maxWidth: '82%', flexDirection: isUser ? 'row-reverse' : 'row' }}
    >
      <span className="persona-avatar" style={{ background: isUser ? 'var(--surface-3, #64748b)' : isError ? 'var(--red)' : 'var(--brand)' }}>
        {isUser ? <Icon.user size={15} /> : <Icon.chat size={15} />}
      </span>
      <div
        className="card"
        style={{
          padding: '10px 14px',
          boxShadow: 'none',
          background: isUser ? 'var(--brand)' : isError ? 'var(--red-soft)' : 'var(--surface-2)',
          color: isUser ? '#fff' : 'var(--text)',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
        }}
      >
        {isError && (
          <span className="badge badge-red" style={{ marginBottom: 6, display: 'inline-block' }}>{lang === 'en' ? 'Unable to respond' : '暂时没能回答'}</span>
        )}
        {!isUser && msg.mocked && (
          <span className="badge badge-amber" style={{ marginBottom: 6, display: 'inline-block' }}>Mock</span>
        )}
        <div className="small" style={{ color: isError ? 'var(--red)' : 'inherit' }}>{msg.content}</div>
      </div>
    </div>
  );
}
