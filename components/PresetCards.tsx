'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Overlay } from './Overlay';
import { actDispatchPreset } from '@/app/(app)/workflows/preset-actions';

// ── 一键任务卡：点一下就派 ────────────────────────────────────────────────────
//
// 【为什么值得单独存一张卡】派活现在要打一段字、选一个智能体、勾一次授权范围，
// 而绝大多数人反复要的就是那么三五件事。每次重打不只是麻烦——
// **授权范围每次都要重勾，勾错了没人拦得住**。

export type PresetCard = {
  id: string;
  title: string;
  goal: string;
  /** 让谁干（null = 通用助手） */
  agentName: string | null;
  /** 预授权了几组动作。0 = 每一步都先问你 */
  authorizedCount: number;
};

export function PresetCards({ presets }: { presets: PresetCard[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<PresetCard | null>(null);
  const [goal, setGoal] = useState('');
  const [err, setErr] = useState('');

  if (presets.length === 0) return null;

  function dispatch(p: PresetCard, override?: string) {
    setErr('');
    start(async () => {
      const r = await actDispatchPreset(p.id, override);
      if (!r.ok || !r.turn) { setErr(r.error ?? '没能派出去'); return; }
      setOpen(null);
      // 带上 runId 跳过去看它跑——不带的话用户落到一个空白助手页
      router.push(`/assistant?run=${r.turn.runId}`);
    });
  }

  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="row-between" style={{ marginBottom: 8 }}>
        <strong className="small">一键任务</strong>
        <a href="/workflows#presets" className="small muted">管理 →</a>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        {presets.map((p) => (
          <button
            key={p.id}
            className="btn btn-sm"
            disabled={pending}
            // 【点一下不直接跑】先开一个确认层：这张卡可能预授权过一批动作，
            // 手滑点到就直接开跑并不合适。弹层里能看清授权范围、也能临时改这次的目标。
            onClick={() => { setOpen(p); setGoal(p.goal); setErr(''); }}
            title={p.goal}
          >
            ⚡ {p.title}
          </button>
        ))}
      </div>
      {err && !open && <div className="small" style={{ marginTop: 8, color: 'var(--red)' }}>{err}</div>}

      {/* 弹层必须走 Overlay（portal）：卡片上的 transform 会把 fixed 遮罩关进卡片里 */}
      {open && (
        <Overlay label="派这条一键任务" onClose={() => setOpen(null)}>
          <div className="card" style={{ padding: 20, width: 560, maxWidth: '94vw' }}>
            <div className="row-between" style={{ marginBottom: 12 }}>
              <b>⚡ {open.title}</b>
              <button className="btn btn-sm btn-ghost" onClick={() => setOpen(null)}>关闭</button>
            </div>

            <div className="small muted" style={{ marginBottom: 8 }}>
              让 {open.agentName ?? '通用助手'} 去做 ·{' '}
              {open.authorizedCount > 0
                ? `已提前授权 ${open.authorizedCount} 个动作，这些不会再逐个问你`
                : '每一步会改数据或花钱的动作都先问你'}
            </div>

            <textarea
              className="textarea"
              rows={3}
              value={goal}
              disabled={pending}
              onChange={(e) => setGoal(e.target.value)}
              style={{ width: '100%', marginBottom: 10 }}
            />
            <div className="small muted" style={{ marginBottom: 10 }}>
              这次想改点什么就直接改，不会动到这张卡本身。
            </div>

            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn btn-primary" disabled={pending || !goal.trim()} onClick={() => dispatch(open, goal)}>
                {pending ? '正在派…' : '派出去'}
              </button>
              <a href="/workflows#presets" className="btn btn-sm btn-ghost">改这张卡 →</a>
            </div>
            {err && <div className="small" style={{ marginTop: 10, color: 'var(--red)' }}>{err}</div>}
          </div>
        </Overlay>
      )}
    </div>
  );
}
