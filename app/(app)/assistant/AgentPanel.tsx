'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Icon } from '@/components/icons';
import { actStartAgent, actDecideAgentStep, actCancelAgent, actGetAgentRun, actAppendNote } from './agent-actions';
import { DispatchAuth, DEFAULT_AUTH, type DispatchAuthValue } from '@/components/DispatchAuth';
import type { AgentTurn } from '@/lib/agent/run';
import { SaveAsSkillButton } from '@/components/SaveAsSkillButton';

// 执行面板：一句话 → AI 自己查、自己做，写操作停下来等你点头。
//
// 界面上必须让人看清三件事，否则「AI 帮我做了什么」永远是个黑箱：
//   ① 它调了哪些工具、参数是什么；② 哪一步在等你确认；③ 最后到底做成了什么。
//
// 【必须能把一次已存在的运行读回来】原来这里只有本地 state：一次执行停在
// 「等你确认」之后，刷新浏览器、或者从运行中心点「去 AI 助手」过来，看到的都是
// 一个空白输入框——那次执行于是**永远确认不了**，而库里它还挂在 awaiting_confirm。
// 恢复用的 actGetAgentRun 当时就写好了，只是一个调用方都没有（写了没接的老形状）。

const QUICK = [
  '看看我最近作品数据怎么样，给点建议',
  '按我的人设生成 6 条选题推荐',
  '把我最近这篇草稿读一下，帮我改标题',
];

type ToolInfo = { name: string; label: string; write: boolean; costly: boolean; contract: boolean; description: string };

/** 已经结束的三种状态。跑完之后才出现「接着跑 / 换个说法重新派」那一栏。 */
const ENDED: AgentTurn['status'][] = ['done', 'failed', 'cancelled'];


export function AgentPanel({
  tools,
  initialRunId,
  initialGoal,
  handoff,
}: {
  tools: ToolInfo[];
  /** 深链带来的运行 id：进来就把那次执行读回来 */
  initialRunId?: string | null;
  /** 从浮标移交过来的那句话：**只填进输入框**，等用户自己按「开始执行」 */
  initialGoal?: string | null;
  /** 从「问一句」那边交接过来的目标。seq 变化即一次新交接（同一句话也能再来一次） */
  handoff?: { goal: string; seq: number } | null;
}) {
  const [pending, start] = useTransition();
  const [goal, setGoal] = useState('');
  /** 派发时的授权范围。缺省是「每一步都先问我」，与以前完全一样 */
  const [auth, setAuth] = useState<DispatchAuthValue>(DEFAULT_AUTH);
  /** 追问 / 确认时的附言。两处共用一个框：同一时刻只会出现其中一个 */
  const [note, setNote] = useState('');
  const [turn, setTurn] = useState<AgentTurn | null>(null);
  const [err, setErr] = useState('');
  /** 已经处理过的交接序号。不记的话 React 每次重渲都会再开一次执行（花钱的那种） */
  const doneHandoff = useRef(0);

  function run(fn: () => Promise<{ ok: boolean; turn?: AgentTurn; error?: string }>) {
    setErr('');
    start(async () => {
      const r = await fn();
      if (!r.ok || !r.turn) {
        setErr(r.error ?? '执行失败');
        return;
      }
      setTurn(r.turn);
    });
  }

  // 浮标移交：把那句话填进输入框就停手。**绝不自动开跑**——
  // 那样一个链接就能让登录用户发起一次付费执行，刷新一次再来一次
  useEffect(() => {
    if (initialGoal) setGoal(initialGoal);
  }, [initialGoal]);

  // 深链恢复：只读，不会触发任何写操作或模型调用
  useEffect(() => {
    if (!initialRunId) return;
    setErr('');
    start(async () => {
      const r = await actGetAgentRun(initialRunId);
      if (!r.ok || !r.turn) {
        setErr(r.error ?? '这次执行读不回来了');
        return;
      }
      setTurn(r.turn);
    });
    // start 来自 useTransition，引用稳定；只认 runId 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRunId]);

  // 「问一句」那边点了「让它直接去做」：直接开跑，不再让用户在这儿把同一句话点第二遍。
  // 那一下点击就是用户的授权；真正会改数据的每一步在下面还要各自确认一次。
  useEffect(() => {
    if (!handoff || handoff.seq <= doneHandoff.current) return;
    doneHandoff.current = handoff.seq;
    setGoal(handoff.goal);
    run(() => actStartAgent(handoff.goal, auth));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff]);

  // 执行已经改成后台跑了：这里拿到的第一帧只是「已经开始了」，步骤和答案要轮询读回来。
  //
  // 【为什么是轮询而不是推送】要推得建一条 SSE/WebSocket 长连接，而这个产品的部署形态里
  // 有一档是整机版（用户自己机器上的 next start，前面可能还有各种反代），长连接是新的
  // 一类故障面。轮询在「一次执行几十秒到几分钟」这个量级上足够，且没有连接状态要维护。
  //
  // 只在**还没停下来**时轮：done/failed/cancelled 之后一次都不再发。
  // 停在「等你确认」也不轮——那时候要动的是用户，不是机器。
  const live =
    turn?.status === 'running' ||
    turn?.status === 'queued' ||
    turn?.status === 'waiting_browser' ||
    turn?.status === 'waiting_quota';
  useEffect(() => {
    if (!live || !turn) return;
    // 等浏览器插件可能要等到用户下次打开浏览器（以小时计），一直 5 秒一问没有意义。
    // 等额度更久——要等到北京时间 0 点，慢到一分钟一问都算勤快；留着轮是为了
    // 用户真守着看时能看到它自己活过来。
    const everyMs =
      turn.status === 'waiting_quota' ? 60_000
      : turn.status === 'waiting_browser' ? 30_000
      : turn.status === 'queued' ? 10_000
      : 5_000;
    const timer = setInterval(async () => {
      const r = await actGetAgentRun(turn.runId);
      // 只更新，不报错：轮询失败多半是网络抖了一下，下一轮就好了。
      // 在这里 setErr 会让页面上突然冒出一条红字，而执行其实好好的
      if (r.ok && r.turn) setTurn(r.turn);
    }, everyMs);
    return () => clearInterval(timer);
  }, [live, turn]);

  const busy = pending;

  /** 确认/拒绝时如果填了附言，先记下来再决定——它要跟着这次决定一起送进模型 */
  function decideWithNote(runId: string, approve: boolean) {
    const t = note.trim();
    setNote('');
    run(async () => {
      if (t) await actAppendNote(runId, t);
      return actDecideAgentStep(runId, approve);
    });
  }
  // 只有会改数据或花钱的才需要授权；只读工具没什么可授权的，摆上去只是噪音
  const authorizable = tools.filter((t) => t.write || t.costly);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card" style={{ padding: 16 }}>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <span className="badge badge-brand"><Icon.sparkles size={13} /> 执行模式</span>
          <span className="small muted">
            AI 会真的操作这个系统。会改数据或花钱的动作<strong>默认</strong>逐个停下来问你；也可以在开始前一次授权这次要用的那些。
          </span>
        </div>

        <textarea
          className="textarea"
          rows={3}
          value={goal}
          disabled={busy}
          placeholder="说清楚你要它做什么，例如：把我监控的对标账号都采一遍最新数据，然后告诉我谁涨得最快"
          onChange={(e) => setGoal(e.target.value)}
          style={{ width: '100%', marginBottom: 10 }}
        />

        <div className="row wrap" style={{ gap: 8 }}>
          <button
            className="btn btn-primary"
            disabled={busy || !goal.trim()}
            onClick={() => run(() => actStartAgent(goal, auth))}
          >
            {busy ? '执行中…' : '开始执行'}
          </button>
          {QUICK.map((q) => (
            <button key={q} className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setGoal(q)}>
              {q}
            </button>
          ))}
        </div>

        <DispatchAuth tools={authorizable} value={auth} onChange={setAuth} />

        {err && <div className="small" style={{ marginTop: 10, color: 'var(--red)' }}>{err}</div>}
      </div>

      {/* 跑起来必须显眼（2026-08-26 用户「开始跑的时候最好显眼点，同时可以在后台慢慢跑，最后提示一个结果」）：
          执行本来就是后台跑的，但界面上没人说——用户以为要守着。这条横幅把三件事说清：
          在跑、可以走、跑完会叫你（完成通知 lib/agent/notify-run.ts 早已在发）。 */}
      {turn && (turn.status === 'running' || turn.status === 'queued') && (
        <div className="alert-gradient-brand run-live-banner" style={{ padding: '12px 16px', marginBottom: 12 }}>
          <span className="run-live-spinner" aria-hidden />
          <span className="small" style={{ lineHeight: 1.7 }}>
            <b>正在后台执行…</b> 可以离开本页去做别的——跑完（或需要你确认时）右上角 🔔 会提醒你，
            「任务记录」里也随时能看到这一条。
          </span>
        </div>
      )}
      {turn && (
        <div className="card" style={{ padding: 16 }}>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <strong>执行过程</strong>
            <span className="row" style={{ gap: 8 }}>
              <StatusBadge status={turn.status} mine={turn.mine} />
              {/* 还没结束的都要能终止——等额度那种尤其要：不然一次派错的活会挂到 0 点 */}
              {turn.mine && (turn.status === 'awaiting_confirm' ||
                turn.status === 'running' ||
                turn.status === 'queued' ||
                turn.status === 'waiting_browser' ||
                turn.status === 'waiting_quota') && (
                <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => actCancelAgent(turn.runId))}>
                  终止
                </button>
              )}
            </span>
          </div>

          {turn.steps.length === 0 && <p className="small muted">还没有步骤。</p>}

          <ol style={{ display: 'grid', gap: 8, margin: 0, paddingLeft: 18 }}>
            {turn.steps.map((s) => (
              <li key={s.seq} className="small">
                <StepLine step={s} />
              </li>
            ))}
          </ol>

          {/* 跑通了才值得存做法。失败/中止的不给这个按钮——存下来的是错的走法。
              别人派的也不给：技能带着工具白名单，得由亲手跑过的人决定要不要留 */}
          {turn.status === 'done' && turn.mine && <SaveAsSkillButton runId={turn.runId} />}

          {/* 不是我发起的：确认/追问都做不了（服务端会拒），所以一个按钮都不摆——
              摆一排点了必定报错的按钮，正是 /runs 不放确认按钮所防的事 */}
          {turn.pending && !turn.mine && (
            <div className="small muted" style={{ marginTop: 12 }}>
              这一步在等发起人确认（这次执行不是你派的，你看得到过程但推不动它）。
            </div>
          )}

          {turn.pending && turn.mine && (
            <div
              className="card"
              style={{ marginTop: 14, padding: 14, borderColor: 'var(--amber)', background: 'var(--amber-soft)' }}
            >
              <div style={{ fontWeight: 650, marginBottom: 6 }}>
                需要你确认：{turn.pending.label}
                {turn.pending.costly && <span className="badge badge-amber" style={{ marginLeft: 8 }}>会消耗额度/产生费用</span>}
              </div>
              {/* 人话在前、原始参数收进折叠里。
                  这里原来直接渲染 JSON.stringify——对着一段 {"draftId":"cm4x9k…"} 点「确认执行」，
                  用户点的其实是「我信你」而不是「我看懂了」。而这个产品的用户是内容创作者。 */}
              {turn.pending.argsSummary && (
                <div className="small" style={{ margin: '0 0 10px', lineHeight: 1.8 }}>
                  {turn.pending.argsSummary}
                </div>
              )}
              <details style={{ marginBottom: 10 }}>
                <summary className="small muted" style={{ cursor: 'pointer' }}>看原始参数</summary>
                <pre
                  className="small"
                  style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 180, overflow: 'auto' }}
                >
                  {JSON.stringify(turn.pending.args, null, 2)}
                </pre>
              </details>
              {/* 附言：拒绝一步时最想说的往往是「不是这个，你应该……」。
                  没有这个框的话，用户只能拒绝、等它自己猜，猜不中再拒绝一次。 */}
              <input
                className="input"
                value={note}
                disabled={busy}
                placeholder="想补一句？（可留空，比如：标题往情绪化改）"
                onChange={(e) => setNote(e.target.value)}
                style={{ width: '100%', marginBottom: 8 }}
              />
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => decideWithNote(turn.runId, true)}>
                  确认执行
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => decideWithNote(turn.runId, false)}>
                  不执行这一步
                </button>
              </div>
            </div>
          )}

          {turn.waitingFor && (
            <div className="small" style={{ marginTop: 12, color: 'var(--muted)' }}>
              {/* 这句话曾经只能对「等插件」那种说——浏览器任务有自己的站内通知，
                  而 AI 执行当时一条通知都不发，照抄给别的挂起态就是让用户
                  去等一条永远不会来的消息。现在执行本身也会在结束/挂起时通知了，
                  所以这句对所有挂起态都成立。（守卫 tests/agent/transition.test.ts
                  盯着这两件事的一致性：通知没接上时不许承诺，接上了就该说回来。） */}
              {turn.waitingFor}。你可以关掉这一页去做别的，跑完会在通知里告诉你。
            </div>
          )}

          {turn.answer && (
            <div style={{ marginTop: 14, whiteSpace: 'pre-wrap', lineHeight: 1.75 }}>{turn.answer}</div>
          )}
          {/* 这次花了多少。**按 token 而不只按次数**：长任务后段每次调用都背着
              接近上限的对话，单次成本是短调用的十倍量级——只报次数会让人低估。 */}
          {turn.cost && (
            <div className="small muted" style={{ marginTop: 10 }}>
              这次用了 {turn.cost.calls} 次 AI 调用
              {turn.cost.tokens > 0 && ` · 约 ${(turn.cost.tokens / 1000).toFixed(1)}k tokens`}
            </div>
          )}

          {/* 【产物清单】确认闸管的是动作**之前**（这一步要不要做），
              这里管的是**之后**（做出来的东西对不对）。两道闸互补——
              预授权跑完的那些没有前一道，更需要后一道。
              此前「AI 改了我哪些东西」只能从步骤流水的截断文本里读，点不动也回不去。 */}
          {turn.artifacts && turn.artifacts.length > 0 && (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <div className="small" style={{ marginBottom: 8, fontWeight: 600 }}>
                这次做出来的东西（{turn.artifacts.length}）
              </div>
              <div className="stack" style={{ gap: 6 }}>
                {turn.artifacts.map((a, i) => (
                  <div key={`${a.kind}-${a.refId}-${i}`} className="row" style={{ gap: 8, minWidth: 0 }}>
                    <span className="badge badge-gray">{a.kindLabel}</span>
                    {a.href ? (
                      <a href={a.href} className="small" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {a.label}
                      </a>
                    ) : (
                      // 没登记落点的种类不编一个链接出来：指到猜的页面比不给链接更糟
                      <span className="small">{a.label}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 还没送达的追问：用户打完字就以为生效了，而正在跑的那一轮已经把话说出口了 */}
          {turn.pendingNotes ? (
            <div className="small" style={{ marginTop: 10, color: 'var(--amber-ink, var(--muted))' }}>
              有 {turn.pendingNotes} 句补充还没送到它那儿，下一轮就会带上。
            </div>
          ) : null}

          {/* 跑完之后：接着说一句就能让**同一条任务**继续，不用从头再派一次。
              三个出口的差别写进 hint —— 「接着跑」与「重跑一次」语义相反，
              不说清楚用户建立不起预期。 */}
          {ENDED.includes(turn.status) && turn.mine && (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <div className="small" style={{ marginBottom: 6, fontWeight: 600 }}>还想让它接着做点什么？</div>
              <textarea
                className="textarea"
                rows={2}
                value={note}
                disabled={busy}
                placeholder="例如：第二条标题太平了，换个更有情绪的说法"
                onChange={(e) => setNote(e.target.value)}
                style={{ width: '100%', marginBottom: 8 }}
              />
              <div className="row wrap" style={{ gap: 8 }}>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={busy || !note.trim()}
                  onClick={() => { const t = note; setNote(''); run(() => actAppendNote(turn.runId, t)); }}
                  title="继续这条任务，保留已经做过的步骤和产物"
                >
                  接着跑
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={busy}
                  onClick={() => { setGoal(turn.goal); setTurn(null); setNote(''); }}
                  title="从头新开一条：把原来那句话填回输入框，你可以改了再派"
                >
                  换个说法重新派
                </button>
              </div>
            </div>
          )}

          {/* 等额度不是失败：那条 error 里存的是配额原文（含升级引导），
              上面的 waitingFor 已经把「在等什么、什么时候好」说清楚了，
              再摆一遍红字既重复又像报错。 */}
          {turn.error && turn.status !== 'waiting_quota' && (
            <div className="small" style={{ marginTop: 14, color: 'var(--red)' }}>{turn.error}</div>
          )}
        </div>
      )}

      <details className="card" style={{ padding: 16 }}>
        <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
          AI 能调用的系统能力（{tools.length} 项，按你的角色过滤）
        </summary>
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table">
            {/* 能力列钉住不换行：不钉的话窄屏下「查选题」会断成竖排两行（用户截图） */}
            <thead><tr><th style={{ whiteSpace: 'nowrap' }}>能力</th><th>说明</th><th style={{ width: 96, whiteSpace: 'nowrap' }}>是否需确认</th></tr></thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.name}>
                  <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{t.label}</td>
                  <td className="small muted">{t.description}</td>
                  <td className="small">
                    {t.write || t.costly ? <span className="badge badge-amber">要你点头</span> : <span className="badge badge-gray">只读</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          这张表就是 AI 能做的全部事情——表外的它做不了，也没有「让 AI 写段代码跑一下」的通道。
        </p>
      </details>
    </div>
  );
}

function StatusBadge({ status, mine }: { status: AgentTurn['status']; mine?: boolean }) {
  // 「等你确认」对**不是发起人的人**是句错话——他推不动它。
  // 下面那行说明虽然补救了，但徽章先入眼，两处口径要一致（同活动条那条）。
  if (status === 'awaiting_confirm' && mine === false) {
    return <span className="badge badge-gray">等发起人确认</span>;
  }
  const map: Record<string, { cls: string; text: string }> = {
    running: { cls: 'badge-gray', text: '进行中' },
    awaiting_confirm: { cls: 'badge-amber', text: '等你确认' },
    // 与运行中心同一口径：等浏览器**不是**「进行中」——没有任何机器在推进它，
    // 它在等那台浏览器打开。说成进行中会让用户以为等着就行
    waiting_browser: { cls: 'badge-amber', text: '等浏览器插件' },
    // 等额度是**机器在等**，用户什么都不用做（0 点重置后自己接着跑）——所以配灰色而不是
    // 琥珀色。琥珀色在这一套里的意思是「该你动手了」，用在这里是叫人去做一件不存在的事。
    waiting_quota: { cls: 'badge-gray', text: '等额度重置' },
    // 排队同理是机器在等：灰色。说「排队中」而不是「进行中」——它一步都还没开始
    queued: { cls: 'badge-gray', text: '排队中' },
    done: { cls: 'badge-green', text: '已完成' },
    failed: { cls: 'badge-red', text: '未完成' },
    cancelled: { cls: 'badge-gray', text: '已终止' },
  };
  const m = map[status] ?? map.running;
  return <span className={`badge ${m.cls}`}>{m.text}</span>;
}

function StepLine({ step }: { step: AgentTurn['steps'][number] }) {
  if (step.kind === 'tool_call') {
    return (
      <span>
        <span className="badge badge-gray">调用</span> {step.label}
        <span className="muted"> {JSON.stringify(step.args).slice(0, 120)}</span>
      </span>
    );
  }
  if (step.kind === 'tool_result') {
    return (
      <span style={{ color: step.ok ? 'inherit' : 'var(--red)' }}>
        <span className={`badge ${step.ok ? 'badge-green' : 'badge-red'}`}>{step.ok ? '完成' : '失败'}</span>{' '}
        {step.label}
        <span className="muted"> {summaryOf(step.result)}</span>
      </span>
    );
  }
  if (step.kind === 'rejected') {
    return <span><span className="badge badge-amber">已拒绝</span> {step.label}（你选择了不执行）</span>;
  }
  return <span><span className="badge badge-brand">回答</span> {step.result.slice(0, 100)}</span>;
}

/** 工具结果是给模型看的 JSON；界面上只展示它的 summary 字段，展不开就截断。 */
function summaryOf(result: string): string {
  try {
    const j = JSON.parse(result) as { summary?: string; error?: string };
    return j.summary || j.error || '';
  } catch {
    return result.slice(0, 100);
  }
}
