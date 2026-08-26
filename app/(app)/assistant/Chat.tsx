'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Icon } from '@/components/icons';
import { looksActionable } from '@/lib/agent/intent';
import { prepareReferenceImage } from '@/lib/cover/client-image';
import { ModelPicker, readPickedModel } from './ModelPicker';
import type { SelectableModel } from '@/lib/llm/selectable';

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
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'assistant',
      content: `你好，我是「${accountName}」的 AI 运营助手。选题、文案、运营变现随便问——我会带上你的账号人设和历史记忆来答。`,
    },
  ]);
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

    const history: ChatTurn[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: q || `（发了 ${pics.length} 张图）` },
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
        setMessages((prev) => [...prev, { role: 'assistant', content: errBody.error || `请求失败 (${res.status})`, error: true }]);
        return;
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

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
            const delta = JSON.parse(payload) as string;
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = { ...last, content: last.content + delta };
              return copy;
            });
          } catch { /* skip */ }
        }
      }
      // 答完了再判：答之前就亮按钮，等于在回答还没出来时催用户做决定。
      // 出错/中断的分支各自 return，不会走到这里——那种时候更不该催他去执行
      if (looksActionable(q)) setHandoffGoal(q);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: '出了点问题：' + (e as Error).message.slice(0, 60), error: true },
      ]);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
    // pics 要进依赖：漏了的话闭包里永远是第一次渲染时的空数组，
    // 表现为「传了图但发出去的还是没有图」——不报错，只是图白传了
  // modelId 必须在依赖里：useCallback 的闭包否则永远捕获首次那个值，
  // 表现为「下拉选了别的模型，发出去的还是自动档」——选项形同虚设。
  }, [messages, streaming, pics, modelId]);

  /** 选了图：客户端先压一遍再入队。压缩复用封面工位那一份，不另写第二套。 */
  async function addPics(files: File[]) {
    setPicErr('');
    const room = MAX_PICS - pics.length;
    if (room <= 0) { setPicErr(`最多 ${MAX_PICS} 张`); return; }
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
    if (files.length > room) setPicErr(`最多 ${MAX_PICS} 张，多出来的没有加进来`);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 220px)', minHeight: 440 }}>
      {/* 空态（只有开场白那一条）时给豆包式的落地：大标题 + 为你推荐四张卡。
          聊起来之后整段消失——它是「不知道从哪开始」的解药，不是常驻装饰。 */}
      {messages.length <= 1 ? (
        <div className="chat-hero">
          <h2 className="chat-hero-title">今天要做什么？</h2>
          <p className="small muted chat-hero-sub">
            说一句话就行。选题、写稿、看同行、看数据都可以问；需要动手做的，答完会问你要不要去做。
          </p>
          <div className="chat-hero-cards">
            {QUICK.map((q) => {
              const IconCmp = Icon[q.icon];
              return (
                <button
                  key={q.label}
                  type="button"
                  className="chat-hero-card"
                  disabled={streaming}
                  // 填进输入框而不是直接发：让用户还能接着改（豆包那四张卡也是这个行为）
                  onClick={() => setInput(q.seed)}
                >
                  <IconCmp size={15} />
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
              <span className="small muted">思考中…</span>
            </div>
          </div>
        )}
      </div>

      {/* 「先答后做」的那道门：只有点了它才会真的去操作系统。
          放在输入框上方、紧贴刚读完的那段回答——放页面底部等于要用户先滚过输入框 */}
      {handoffGoal && onHandoff && !streaming && (
        <div className="handoff-bar">
          <span className="small muted handoff-why">这件事我可以直接去做（写操作默认仍会逐条问你）</span>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              const goal = handoffGoal;
              setHandoffGoal(null);
              onHandoff(goal);
            }}
          >
            <Icon.sparkles size={13} /> 让它直接去做
          </button>
        </div>
      )}

      <div className="divider" />

      {/* 参考图：给「问一句」补上看图的能力。
          出图工位与封面工位早就能传参考图，唯独对话不行——而对话恰恰是
          用户最想说「你看看这张」的地方。 */}
      {(pics.length > 0 || picErr) && (
        <div className="row wrap" style={{ gap: 6, marginBottom: 8, alignItems: 'center' }}>
          {/* 【为什么外层必须是 inline-block 且给死宽高】globals.css 有一条
              `.card img { max-width: 100% }`，而这个包裹层如果是普通 inline span，
              它的宽度由内容（也就是这张图）决定——两者互相依赖，浏览器解出来是 2px。
              真机上看到的就是一条 2×52 的竖线，而图片本身 400×300 且已经加载完。
              给外层一个确定的尺寸，这个循环就断了。 */}
          {pics.map((src, i) => (
            <span key={i} style={{ position: 'relative', display: 'inline-block', width: 52, height: 52, flexShrink: 0 }}>
              <img
                src={src}
                alt={`参考图 ${i + 1}`}
                style={{ width: 52, height: 52, maxWidth: 52, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)', display: 'block' }}
              />
              <button
                className="btn btn-sm btn-ghost"
                aria-label="移除这张图"
                onClick={() => setPics((list) => list.filter((_, j) => j !== i))}
                style={{ position: 'absolute', top: -6, right: -6, padding: '0 6px', lineHeight: 1.4 }}
              >
                ×
              </button>
            </span>
          ))}
          {picErr && <span className="small" style={{ color: 'var(--red)' }}>{picErr}</span>}
        </div>
      )}
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>

        <textarea
          className="textarea"
          style={{ flex: 1, minHeight: 52, resize: 'none' }}
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
          value={input}
          disabled={streaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
        />
        <label
          className="btn"
          title={pics.length >= MAX_PICS ? `最多 ${MAX_PICS} 张` : '带一张参考图问'}
          style={{ cursor: streaming || pics.length >= MAX_PICS ? 'not-allowed' : 'pointer' }}
        >
          <Icon.upload size={13} /> 图
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            disabled={streaming || pics.length >= MAX_PICS}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = ''; // 允许连着选同一张
              void addPics(files);
            }}
          />
        </label>
        <button className="btn btn-primary" disabled={streaming || (!input.trim() && pics.length === 0)} onClick={() => send(input)}>
          {streaming ? '生成中…' : '发送'}
        </button>
      </div>

      {/* 输入框下的工具条：用哪个模型摆在这儿（照用户给的豆包工作那个位置），
          而不是顶栏——顶栏那个是**只读状态**，这里是这次派活真正要用的那个。 */}
      {models.length > 1 && (
        <div className="row wrap chat-toolbar" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
          <ModelPicker models={models} value={modelId} onChange={setModelId} />
          {pics.length > 0 && (
            // 带图那一路走视觉模型（llmVision），不吃这里选的那个——不说清楚
            // 用户会以为自己选的模型在看图
            <span className="small muted">带图时自动用支持看图的模型</span>
          )}
        </div>
      )}
    </div>
  );
}

function Bubble({ msg }: { msg: Msg }) {
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
          <span className="badge badge-red" style={{ marginBottom: 6, display: 'inline-block' }}>暂时没能回答</span>
        )}
        {!isUser && msg.mocked && (
          <span className="badge badge-amber" style={{ marginBottom: 6, display: 'inline-block' }}>Mock</span>
        )}
        <div className="small" style={{ color: isError ? 'var(--red)' : 'inherit' }}>{msg.content}</div>
      </div>
    </div>
  );
}
