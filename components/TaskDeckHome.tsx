'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Icon } from './icons';
import { activeBadge } from '@/lib/runs/badge';
import { type ToolBrief } from './DispatchAuth';

// ── 任务台首屏：说一句话，它就去办 ──────────────────────────────────────────
//
// 【为什么首页要分两种形态】任务台承诺的是「说一句话让它干活」。而在此之前，
// 选了任务台的用户打开首页看到的仍然是「今日概览」：四张统计卡、推荐 Top3、待办清单——
// 全是**看**的东西，一个能派活的入口都没有，要说话得先点进「新任务」。
// 于是任务台成了「换了排法的导航壳」，那句承诺一直没兑现。
//
// 【零新路由】这不是一个新页面，是 `/` 在任务台外壳下的另一种排法——
// 与 /assistant 在任务台下压缩标题区是同一个先例。造 /taskdeck 这种专属页会立刻
// 有两套真相源，而且会被 nav-layout 的孤儿页用例判红。
//
// 【为什么不在这里做完整对话】完整对话（流式回答、追问、移交）在 /assistant，
// 这里只做「派活」这一下：输入 → 建一次执行 → 跳过去看它跑。
// 两处都做一遍对话，就是两套要各自维护的状态机，而它们迟早会不一致。

const QUICK = [
  '看看我最近作品数据怎么样，给点建议',
  '按我的人设生成 6 条选题推荐',
  '今天有什么热点适合我',
];

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
}: {
  memberName: string;
  initialActive: ActiveRun[];
  /** 这次能用到的会改数据/花钱的动作。派发卡按后果分组让用户一次授权 */
  authorizableTools?: ToolBrief[];
}) {
  const router = useRouter();
  const [goal, setGoal] = useState('');
  const [err, setErr] = useState('');
  const [active, setActive] = useState(initialActive);

  // 有东西在跑时才轮询，跑完即停。**只在这一页轮**：侧栏那份清单是布局里的服务端快照，
  // 给它也加轮询等于每 15 秒把整个布局的五张表再查一遍
  useEffect(() => {
    if (active.length === 0) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/runs/active', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { rows: ActiveRun[] };
        setActive(data.rows);
      } catch {
        // 轮询失败不报错：网络抖一下而已，下一轮就好。
        // 在这里弹红字会让一个好好跑着的任务看起来像是出了事
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [active.length]);

  /**
   * 把这句话**交给「新任务」页**，不在这里直接开跑。
   *
   * 【2026-08-26 改这件事的原因】用户问「今天和新任务的功能是否有重复」——查下来
   * 不只是重复，是**行为分歧**：两处的标题都写着「今天要做什么」，但
   *   · 这里回车 → 直接 actStartAgent，立刻开一次执行（花配额）；
   *   · 「新任务」回车 → 先答话，答完才问你要不要真去做。
   * 界面上看不出区别，于是在首页随手打一句就付费开跑了，而用户以为自己在聊天。
   *
   * 现在只有一处决定「这句话是聊还是做」（/assistant）。`?goal=` 是**只预填不自动跑**的，
   * 那条性质有守卫钉着（tests/shell-modes.test.ts：URL 参数不许触发执行，
   * 否则任意站点一个链接就能让登录用户花钱）。
   */
  function dispatch(text: string) {
    const q = text.trim();
    if (!q) return;
    setErr('');
    router.push(`/assistant?goal=${encodeURIComponent(q.slice(0, 2000))}`);
  }

  return (
    <div style={{ display: 'grid', gap: 16, marginBottom: 16 }}>
      <div className="card" style={{ padding: 18 }}>
        <div className="row wrap" style={{ gap: 8, alignItems: 'baseline', marginBottom: 12 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>今天要做什么，{memberName}？</h1>
          {/* ⚠️ 文案必须跟着真实行为走：这一框现在**只是起个头**——
              带到「新任务 → 让它去做」预填好，按了那边的开始才真的跑（也才花配额）。
              早先写「说一句话，我去办」而回车直接开跑，用户以为自己在聊天就付了钱。
              也不能反过来写成「它会先答你」——落点是执行那一侧，不是对话。 */}
          <span className="small muted">写下要做的事，带到「新任务」预填好——你在那边按开始它才真的跑。</span>
        </div>

        <textarea
          className="textarea"
          rows={3}
          value={goal}
         
          placeholder="例如：把我监控的对标账号都采一遍最新数据，然后告诉我谁涨得最快"
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
          <button className="btn btn-primary" disabled={!goal.trim()} onClick={() => dispatch(goal)}>
            去派活 →
          </button>
          {QUICK.map((q) => (
            <button key={q} className="btn btn-sm btn-ghost" onClick={() => setGoal(q)}>
              {q}
            </button>
          ))}
        </div>

        {/* 授权范围的选择在「新任务 → 让它去做」那一侧（AgentPanel 用的是同一个
            DispatchAuth 组件）。这里已经不直接派活了，摆一个此刻不起作用的授权卡
            只会让人以为自己已经授过权。两壳对等仍然成立：功能都在，只是收在一处。 */}

        {err && <div className="small" style={{ marginTop: 10, color: 'var(--red)' }}>{err}</div>}
      </div>

      {/* 活动条：**只放还没结束的**。历史清单在侧栏和运行中心已经各有一份，
          再摆一份同源列表只会让首屏变长而信息没变多 */}
      {active.length > 0 && (
        <div className="card" style={{ padding: 14 }}>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <strong className="small">正在办的事</strong>
            <Link href="/runs" className="small muted">全部记录 →</Link>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            {active.map((r) => (
              <Link key={`${r.kind}-${r.id}`} href={r.href} className="row-between" style={{ gap: 10, textDecoration: 'none' }}>
                <span className="row" style={{ gap: 8, minWidth: 0 }}>
                  {/* 徽章文案与配色是纯函数算的（lib/runs 的 activeBadge）：
                      「等你处理」只对**自己发起的**那条说——同事的运行也在这个列表里
                      （工作区级，刻意的），但他那条只有他点得动。 */}
                  <span className={`badge ${activeBadge(r).cls}`}>{activeBadge(r).text}</span>
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
