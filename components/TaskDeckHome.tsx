'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { Icon } from './icons';
import { activeBadge } from '@/lib/runs/badge';
import { DispatchAuth, DEFAULT_AUTH, type DispatchAuthValue, type ToolBrief } from './DispatchAuth';
import { useI18n } from '@/lib/i18n';
import { actStartAgent, actCancelAgent } from '@/app/(app)/assistant/agent-actions';
import { useImeGuard } from '@/lib/ime';
import { ModelPicker } from '@/app/(app)/assistant/ModelPicker';
import { wantsExecution } from '@/lib/agent/intent';
import { useAskStream, MAX_PICS } from './ask/useAskStream';
import { AskMessages } from './ask/AskMessages';
import type { AgentTurn } from '@/lib/agent/run';
import type { SelectableModel } from '@/lib/llm/selectable';

// ── 任务台首屏：说一句话，它就去办；或者先问一句 ────────────────────────────
//
// 【为什么首页要分两种形态】任务台承诺的是「说一句话让它干活」。而在此之前，
// 选了任务台的用户打开首页看到的仍然是「今日概览」：四张统计卡、推荐 Top3、待办清单——
// 全是**看**的东西，一个能派活的入口都没有。
//
// 【零新路由】这不是一个新页面，是 `/` 在任务台外壳下的另一种排法。
// 造 /taskdeck 这种专属页会立刻有两套真相源，而且会被 nav-layout 的孤儿页用例判红。
//
// 【这里就是派活的唯一入口】（2026-09-06）
// 此前的两版都把「真正开跑」放在 /assistant：08-26 是跳过去预填等用户再点一次，
// 09-05 是写一个一次性 cookie 跳过去自动跑。两版的结果都一样——用户面前有两个长得一样、
// 标题都叫「今天要做什么」的框，一个是另一个的遥控器；他三次问「这两个是不是重复了」。
//
// 【「问 AI」也在这一框里】（2026-09-06 第四次问之后）派活合一之后，/assistant 还剩一个
// 只能问不能派的输入框，和首页这个只能派不能问的输入框——还是两个框。现在只留这一个：
// 同一句话，「开始执行」是派活（会动数据、花额度），「先问问」是对话（只答不动手）；
// 答案就摆在框下面，答完像是要它去做的话再给一个按钮，**那一下点击才是授权**。
// /assistant 从此只剩「执行过程」：看某一次执行、确认、追问。
//
// 【?goal= 只预填、不开跑】浮标助手的「让它直接去做」用链接把话带到这儿。链接不许触发执行——
// 任意站点放一个 /?goal=… 就能让登录用户花钱（tests/shell-modes.test.ts 钉着）。
// 真正开跑只认页面上那一下点击，而且那一下带着授权卡的选择一起送到 server action。


export type ActiveRun = {
  id: string;
  kind: string;
  title: string;
  status: 'waiting' | 'running';
  detail?: string;
  href: string;
  kindLabel: string;
  /** 这条是不是我发起的。AI 执行的「等你确认」只有发起人点得动。 */
  mine?: boolean;
  /** 不是我发起的话，在等谁（同事的名字）。 */
  waitingOn?: string;
};

export function TaskDeckHome({
  memberName,
  initialActive,
  authorizableTools = [],
  initialGoal,
  models = [],
}: {
  memberName: string;
  initialActive: ActiveRun[];
  /** 这次能用到的会改数据/花钱的动作。授权卡按后果分组让用户一次授权 */
  authorizableTools?: ToolBrief[];
  /** 从浮标助手带过来的那句话：**只填进输入框**，等用户自己按「开始执行」 */
  initialGoal?: string | null;
  /** 「先问问」可选的模型清单（自动 / 自接入 / 平台）。空数组 = 不显示选择器 */
  models?: SelectableModel[];
}) {
  const { lang, dict } = useI18n();
  const [goal, setGoal] = useState('');
  /** 派发时的授权范围。缺省是「直接跑完，不逐步问我」（2026-09-03 起） */
  const [auth, setAuth] = useState<DispatchAuthValue>(DEFAULT_AUTH);
  const [err, setErr] = useState('');
  const [active, setActive] = useState(initialActive);
  /** 刚从这个框派出去的那一条：给一句「已经开始了」和去看过程的链接 */
  const [started, setStarted] = useState<AgentTurn | null>(null);
  const [pending, start] = useTransition();
  /** 正在终止的那条 runId：按钮转圈用，也防连点 */
  const [cancelling, setCancelling] = useState<string | null>(null);
  const ask = useAskStream({ models, lang });
  // 中文输入法组字时的回车是「上屏」，不是「派活」。少了这道守卫，
  // 想打一串英文按回车让字母上屏，任务就已经派出去了（见 lib/ime.ts）
  const ime = useImeGuard();

  // 浮标移交：把那句话填进输入框就停手。**绝不自动开跑**
  useEffect(() => {
    if (initialGoal) setGoal(initialGoal);
  }, [initialGoal]);

  async function refreshActive() {
    try {
      const res = await fetch('/api/runs/active', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { rows: ActiveRun[] };
      setActive(data.rows);
    } catch {
      // 轮询失败不报错：网络抖一下而已，下一轮就好。
      // 在这里弹红字会让一个好好跑着的任务看起来像是出了事
    }
  }

  // 有东西在跑时才轮询，跑完即停。**只在这一页轮**：侧栏那份清单是布局里的服务端快照，
  // 给它也加轮询等于每 15 秒把整个布局的五张表再查一遍
  useEffect(() => {
    if (active.length === 0) return;
    const timer = setInterval(refreshActive, 15_000);
    return () => clearInterval(timer);
  }, [active.length]);

  const busy = pending || ask.streaming;

  /** 就地开跑。授权卡上的选择跟这句话一起送过去——授权只认这一下点击。 */
  function dispatch(text: string) {
    const goal = text.trim();
    if (!goal || busy) return;
    setErr('');
    ask.setHandoffGoal(null);
    start(async () => {
      // 派活也带上模型选择：同一个选择器，问一句和直接去做走同一条渠道
      const r = await actStartAgent(goal, auth, ask.modelId);
      if (!r.ok || !r.turn) {
        setErr(r.error ?? (lang === 'en' ? 'Failed to start' : '没派出去'));
        return;
      }
      setStarted(r.turn);
      setGoal('');
      // 立刻把它摆进「正在办的事」，别让用户等 15 秒才看见自己刚派的活
      await refreshActive();
    });
  }

  /**
   * 手动终止一条正在跑的活。派错了、或者按回车误发了，得能当场收回来。
   *
   * 服务端 cancelAgentRun 已经把难的部分做完了：乐观锁（跑完的不会被拉回来）、
   * 连带终止它派出去的子运行、清租约。这里只负责发起与刷新列表。
   */
  function cancelRun(runId: string) {
    if (cancelling) return;
    setErr('');
    setCancelling(runId);
    start(async () => {
      try {
        const r = await actCancelAgent(runId);
        if (!r.ok) {
          setErr(r.error ?? dict.today.cancelFailed);
        } else if (started?.runId === runId) {
          // 刚派出去那条被收回来了，「已经开始」那条横幅就不该再挂着
          setStarted(null);
        }
        await refreshActive();
      } finally {
        setCancelling(null);
      }
    });
  }

  /** 先问问：只答不动手。明说「帮我执行」的话不绕弯，直接派——那一下发送就是授权 */
  function askIt(text: string) {
    const q = text.trim();
    if ((!q && ask.pics.length === 0) || busy) return;
    if (wantsExecution(q)) { dispatch(q); return; }
    setErr('');
    setStarted(null);
    void ask.send(q).then((sent) => { if (sent) setGoal(''); });
  }

  return (
    <div className="taskdeck-home-wrapper" style={{ display: 'grid', gap: 16, marginBottom: 16 }}>
      <div className="card taskdeck-card">
        <div className="taskdeck-header">
          <div className="taskdeck-title-row">
            <span className="taskdeck-icon-badge">
              <Icon.fire size={18} />
            </span>
            <h1 className="taskdeck-title">
              {dict.today.greeting.replace('{name}', memberName || (lang === 'en' ? 'Creator' : '创作者'))}
            </h1>
          </div>
        </div>

        {/* 沉浸式一体化指挥输入舱 */}
        <div className="taskdeck-input-container">
          {/* 待发的参考图：只跟「先问问」走，问完即清 */}
          {(ask.pics.length > 0 || ask.picErr) && (
            <div className="row wrap taskdeck-pics-preview">
              {ask.pics.map((src, i) => (
                <span key={i} style={{ position: 'relative', display: 'inline-block', width: 52, height: 52, flexShrink: 0 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt={lang === 'en' ? `Reference image ${i + 1}` : `参考图 ${i + 1}`}
                    style={{ width: 52, height: 52, maxWidth: 52, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', display: 'block' }}
                  />
                  <button
                    type="button"
                    className="ask-pic-remove"
                    aria-label={lang === 'en' ? 'Remove this image' : '移除这张图'}
                    onClick={() => ask.removePic(i)}
                  >
                    ✕
                  </button>
                </span>
              ))}
              {ask.picErr && <span className="small" style={{ color: 'var(--red)', fontWeight: 600 }}>{ask.picErr}</span>}
            </div>
          )}

          <textarea
            data-flow="派活"
            className="taskdeck-textarea"
            rows={3}
            value={goal}
            disabled={busy}
            placeholder={dict.today.placeholder}
            onChange={(e) => setGoal(e.target.value)}
            {...ime.composition}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // 输入法还在组字：这一下回车是选词/让英文字母上屏，不是发送。
              // **必须早于 preventDefault**，否则字上不了屏
              if (ime.isComposing(e)) return;
              // Shift+Enter 换行；⌘/Ctrl+Enter 先问问；Enter 直接派活——这一框绝大多数时候只写一行
              if (e.shiftKey) return;
              e.preventDefault();
              if (e.metaKey || e.ctrlKey) askIt(goal);
              else dispatch(goal);
            }}
          />

          {/* 输入舱内嵌一体化工具与操作条 */}
          <div className="taskdeck-toolbar">
            {/* 左侧：模型选择 + 参考图 */}
            <div className="taskdeck-toolbar-left">
              {models.length > 1 && (
                <ModelPicker models={models} value={ask.modelId} onChange={ask.setModelId} />
              )}

              <label
                className="taskdeck-tool-btn"
                title={ask.pics.length >= MAX_PICS ? (lang === 'en' ? `Up to ${MAX_PICS} images` : `最多 ${MAX_PICS} 张`) : dict.today.attachImageTip}
                style={{ cursor: busy || ask.pics.length >= MAX_PICS ? 'not-allowed' : 'pointer' }}
              >
                <Icon.image size={13} />
                <span>{dict.today.attachImage}{ask.pics.length > 0 ? ` (${ask.pics.length})` : ''}</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  disabled={busy || ask.pics.length >= MAX_PICS}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    void ask.addPics(files);
                  }}
                />
              </label>
            </div>

            {/* 右侧：先问问 + 授权范围 + 开始执行 */}
            <div className="taskdeck-toolbar-right">
              {ask.streaming ? (
                <button
                  type="button"
                  className="taskdeck-btn-ask active"
                  onClick={() => ask.stop()}
                  title={dict.today.stopBtn}
                >
                  <Icon.refresh size={13} className="spin" />
                  <span>{dict.today.stopBtn}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="taskdeck-btn-ask"
                  disabled={busy || (!goal.trim() && ask.pics.length === 0)}
                  onClick={() => askIt(goal)}
                  title={lang === 'en' ? 'Just ask AI (⌘/Ctrl+Enter)' : '先问问（⌘/Ctrl+Enter）'}
                >
                  <Icon.chat size={14} />
                  <span>{dict.today.askBtn}</span>
                  <kbd className="taskdeck-kbd hide-mobile">⌘↵</kbd>
                </button>
              )}

              <DispatchAuth tools={authorizableTools} value={auth} onChange={setAuth} />

              <button
                type="button"
                className={`taskdeck-btn-dispatch ${!busy && goal.trim() ? 'active' : ''}`}
                disabled={busy || !goal.trim()}
                onClick={() => dispatch(goal)}
                title={lang === 'en' ? 'Start execution (Enter)' : '开始执行（Enter）'}
              >
                {pending ? (
                  <span className="row" style={{ gap: 5, alignItems: 'center' }}>
                    <Icon.refresh size={13} className="spin" />
                    <span>{dict.today.dispatching}</span>
                  </span>
                ) : (
                  <span className="row" style={{ gap: 5, alignItems: 'center' }}>
                    <Icon.sparkles size={14} />
                    <span>{dict.today.dispatchBtn}</span>
                    <kbd className="taskdeck-kbd-primary hide-mobile">↵</kbd>
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* 快捷指令胶囊行 */}
        <div className="taskdeck-quick-row">
          <div className="taskdeck-quick-chips">
            <span className="taskdeck-quick-badge">
              <Icon.bulb size={12} />
              <span>{lang === 'en' ? 'Suggestions' : '快捷指令'}</span>
            </span>
            {dict.today.quick.map((q) => (
              <button
                key={q}
                type="button"
                className="taskdeck-chip"
                disabled={busy}
                onClick={() => setGoal(q)}
              >
                <span>{q}</span>
              </button>
            ))}
          </div>
          <span className="taskdeck-shortcuts-hint hide-mobile">
            {dict.today.askKeyHint}
          </span>
        </div>

        {err && <div className="small" style={{ marginTop: 10, color: 'var(--red)' }}>{err}</div>}

        {/* 派出去之后：执行本来就是后台跑的，但界面上得有人说，否则用户以为要守着。
            过程与追问在 /assistant?run=，这里只给一句话和一个去处 */}
        {started && !err && (
          <div className="alert-gradient-brand taskdeck-started-banner">
            <span className="run-live-spinner" aria-hidden />
            <span className="small" style={{ lineHeight: 1.7 }}>
              <b>{dict.today.startedTitle}</b> {dict.today.startedHint}{' '}
              <Link href={`/assistant?run=${started.runId}`} className="btn btn-sm btn-primary" style={{ marginLeft: 8 }}>
                {dict.today.startedLink}
              </Link>
              {/* 派错了要能当场收回来——尤其是回车误发的那种。不跳页，就在这儿终止 */}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ marginLeft: 6 }}
                disabled={cancelling === started.runId}
                onClick={() => cancelRun(started.runId)}
                title={dict.today.cancelTip}
              >
                {cancelling === started.runId ? dict.today.cancelling : dict.today.cancelBtn}
              </button>
            </span>
          </div>
        )}

        {/* 问出来的答案就在框下面。答完像是要它去做的话再给一个按钮——先答后做，
            「会不会动数据」的边界比让模型自己决定硬得多：我按了那个按钮，所以它会动 */}
        {ask.messages.length > 0 && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <AskMessages messages={ask.messages} streaming={ask.streaming} />
            {ask.handoffGoal && !ask.streaming && (
              <div className="handoff-card" style={{ marginTop: 12 }}>
                <div className="handoff-card-left">
                  <span className="handoff-icon-badge"><Icon.sparkles size={15} /></span>
                  <div className="handoff-text-wrap">
                    <strong className="handoff-title">{dict.today.handoffTitle}</strong>
                    <span className="small muted handoff-why">{dict.today.handoffHint}</span>
                  </div>
                </div>
                <button className="btn btn-sm btn-primary handoff-btn" disabled={busy} onClick={() => dispatch(ask.handoffGoal!)}>
                  {dict.today.handoffBtn}
                </button>
              </div>
            )}
            {!ask.streaming && (
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                <button className="btn btn-sm btn-ghost" onClick={() => ask.reset()}>{dict.today.clearThread}</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 活动条：**只放还没结束的** */}
      {active.length > 0 && (
        <div className="card" style={{ padding: 14 }}>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <strong className="small">{dict.today.activeTitle}</strong>
            <Link href="/runs" className="small muted">{dict.today.allRecords}</Link>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            {active.map((r) => (
              // 整行原来就是一个 <Link>。终止按钮不能放进去：<a> 里套 <button> 既不合法，
              // 点一下还会顺带跳走。所以外面包一层 div，按钮与链接并排
              <div key={`${r.kind}-${r.id}`} className="row-between" style={{ gap: 8 }}>
              <Link href={r.href} className="row-between" style={{ gap: 10, textDecoration: 'none', flex: 1, minWidth: 0 }}>
                <span className="row" style={{ gap: 8, minWidth: 0 }}>
                  {/* 徽章文案与配色是纯函数算的（lib/runs 的 activeBadge）：
                      「等你处理」只对**自己发起的**那条说——同事的运行也在这个列表里
                      （工作区级，刻意的），但他那条只有他点得动。 */}
                  <span className={`badge ${activeBadge(r).cls}`}>
                    {lang === 'en'
                      ? (activeBadge(r).text === '进行中'
                          ? 'In Progress'
                          : activeBadge(r).text.startsWith('等 ')
                          ? activeBadge(r).text.replace('等 ', 'Waiting on ')
                          : 'Waiting for action')
                      : activeBadge(r).text}
                  </span>
                  <span className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.title}
                  </span>
                </span>
                <span className="small muted row" style={{ gap: 4, flexShrink: 0 }}>
                  {r.detail}
                  <Icon.chevron size={13} />
                </span>
              </Link>
              {/* 只给 AI 执行这一类：终止走的是 cancelAgentRun，只认 AgentRun。
                  采集/发布/浏览器任务各有自己的收口，仍在运行中心里 */}
              {r.kind === 'agent' && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  style={{ flexShrink: 0 }}
                  disabled={cancelling === r.id}
                  onClick={() => cancelRun(r.id)}
                  title={dict.today.cancelTip}
                >
                  {cancelling === r.id ? dict.today.cancelling : dict.today.cancelBtn}
                </button>
              )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
