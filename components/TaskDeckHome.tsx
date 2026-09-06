'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { Icon } from './icons';
import { activeBadge } from '@/lib/runs/badge';
import { DispatchAuth, DEFAULT_AUTH, type DispatchAuthValue, type ToolBrief } from './DispatchAuth';
import { useI18n } from '@/lib/i18n';
import { actStartAgent } from '@/app/(app)/assistant/agent-actions';
import type { AgentTurn } from '@/lib/agent/run';

// ── 任务台首屏：说一句话，它就去办 ──────────────────────────────────────────
//
// 【为什么首页要分两种形态】任务台承诺的是「说一句话让它干活」。而在此之前，
// 选了任务台的用户打开首页看到的仍然是「今日概览」：四张统计卡、推荐 Top3、待办清单——
// 全是**看**的东西，一个能派活的入口都没有。
// 于是任务台成了「换了排法的导航壳」，那句承诺一直没兑现。
//
// 【零新路由】这不是一个新页面，是 `/` 在任务台外壳下的另一种排法。
// 造 /taskdeck 这种专属页会立刻有两套真相源，而且会被 nav-layout 的孤儿页用例判红。
//
// 【这里就是派活的唯一入口】（2026-09-06）
// 此前的两版都把「真正开跑」放在 /assistant：08-26 是跳过去预填等用户再点一次，
// 09-05 是写一个一次性 cookie 跳过去自动跑。两版的结果都一样——用户面前有两个长得一样、
// 标题都叫「今天要做什么」的框，一个是另一个的遥控器；他三次问「这两个是不是重复了」。
// 现在只留这一个：在这儿写、在这儿授权、在这儿开跑；执行过程去 /assistant?run= 看。
// /assistant 不再有独立的派活输入框，它只做两件事：对话问答，以及某一次执行的过程与追问。
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
}: {
  memberName: string;
  initialActive: ActiveRun[];
  /** 这次能用到的会改数据/花钱的动作。授权卡按后果分组让用户一次授权 */
  authorizableTools?: ToolBrief[];
  /** 从浮标助手带过来的那句话：**只填进输入框**，等用户自己按「开始执行」 */
  initialGoal?: string | null;
}) {
  const [goal, setGoal] = useState('');
  /** 派发时的授权范围。缺省是「直接跑完，不逐步问我」（2026-09-03 起） */
  const [auth, setAuth] = useState<DispatchAuthValue>(DEFAULT_AUTH);
  const [err, setErr] = useState('');
  const [active, setActive] = useState(initialActive);
  /** 刚从这个框派出去的那一条：给一句「已经开始了」和去看过程的链接 */
  const [started, setStarted] = useState<AgentTurn | null>(null);
  const [pending, start] = useTransition();

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

  /** 就地开跑。授权卡上的选择跟这句话一起送过去——授权只认这一下点击。 */
  function dispatch(text: string) {
    const goal = text.trim();
    if (!goal || pending) return;
    setErr('');
    start(async () => {
      const r = await actStartAgent(goal, auth);
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

  const { lang, dict } = useI18n();

  return (
    <div style={{ display: 'grid', gap: 16, marginBottom: 16 }}>
      <div className="card" style={{ padding: 18 }}>
        <div className="row wrap" style={{ gap: 8, alignItems: 'baseline', marginBottom: 12 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>
            {dict.today.greeting.replace('{name}', memberName || (lang === 'en' ? 'Creator' : '创作者'))}
          </h1>
        </div>

        <textarea
          data-flow="派活"
          className="textarea"
          rows={3}
          value={goal}
          disabled={pending}
          placeholder={dict.today.placeholder}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            // Enter 直接派活、Shift+Enter 换行：这一框绝大多数时候只写一行
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              dispatch(goal);
            }
          }}
          style={{ width: '100%', marginBottom: 10 }}
        />

        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn btn-primary" disabled={pending || !goal.trim()} onClick={() => dispatch(goal)}>
            {pending ? dict.today.dispatching : dict.today.dispatchBtn}
          </button>
          {dict.today.quick.map((q) => (
            <button key={q} className="btn btn-sm btn-ghost" disabled={pending} onClick={() => setGoal(q)}>
              {q}
            </button>
          ))}
        </div>

        <DispatchAuth tools={authorizableTools} value={auth} onChange={setAuth} />

        {err && <div className="small" style={{ marginTop: 10, color: 'var(--red)' }}>{err}</div>}

        {/* 派出去之后：执行本来就是后台跑的，但界面上得有人说，否则用户以为要守着。
            过程与追问在 /assistant?run=，这里只给一句话和一个去处 */}
        {started && !err && (
          <div className="alert-gradient-brand" style={{ padding: '10px 14px', marginTop: 12 }}>
            <span className="small" style={{ lineHeight: 1.7 }}>
              <b>{dict.today.startedTitle}</b> {dict.today.startedHint}{' '}
              <Link href={`/assistant?run=${started.runId}`} className="btn btn-sm" style={{ marginLeft: 8 }}>
                {dict.today.startedLink}
              </Link>
            </span>
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
              <Link key={`${r.kind}-${r.id}`} href={r.href} className="row-between" style={{ gap: 10, textDecoration: 'none' }}>
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
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
