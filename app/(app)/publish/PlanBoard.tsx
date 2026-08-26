'use client';

import { useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { PlanCreator, PlanTasks, type PlanView } from './PlanTasks';

// 发布中心页面上的两块交互：进行中的计划、给某篇稿子新建计划。
//
// 【为什么是客户端组件】任务往下走要一条一条点（写草稿箱 → 贴链接 → 标记已发布），
// 每点一次都要拿回新的任务状态。挂在服务端渲染的卡片里就是本项目记过的那个坑：
// server action 一 revalidate 就重渲当前路由，正在填的那个输入框连同刚拿到的
// 计划一起被冲掉，用户「做完还要接着点」的下一步就没了。所以计划的状态留在客户端。

export function OpenPlans({
  plans,
}: {
  plans: (PlanView & { draftTitle: string; createdAt: string })[];
}) {
  const [live, setLive] = useState<Record<string, PlanView>>({});

  if (plans.length === 0) {
    return <p className="small muted">没有进行中的发布计划。在下面挑一篇稿子开一条，或者在创作工坊里点「一键发布」。</p>;
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {plans.map((p) => {
        const plan = live[p.id] ?? p;
        const done = plan.tasks.filter((t) => t.status === 'published').length;
        return (
          <div key={p.id}>
            <div className="row-between wrap" style={{ gap: 8, marginBottom: 8 }}>
              <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <strong>{p.draftTitle}</strong>
                <span className="badge badge-gray">
                  {done}/{plan.tasks.length} 已发布
                </span>
              </span>
              <span className="small muted">{fmtDateTime(new Date(p.createdAt))}</span>
            </div>
            <PlanTasks plan={plan} onChanged={(next) => setLive({ ...live, [p.id]: next })} />
          </div>
        );
      })}
    </div>
  );
}

export function NewPlan({ drafts }: { drafts: { id: string; title: string; platform: string; updatedAt: string }[] }) {
  const [draftId, setDraftId] = useState('');
  const [plan, setPlan] = useState<PlanView | null>(null);

  if (drafts.length === 0) {
    return <p className="small muted">还没有写好正文、又没发出去的稿子。先去创作工坊写一篇。</p>;
  }

  return (
    <>
      <div className="row wrap" style={{ gap: 8, marginBottom: 4 }}>
        {drafts.map((d) => (
          <button
            key={d.id}
            className={`btn btn-sm ${d.id === draftId ? 'btn-primary' : ''}`}
            onClick={() => {
              setDraftId(d.id === draftId ? '' : d.id);
              setPlan(null);
            }}
          >
            {d.title || '（无标题）'}
          </button>
        ))}
      </div>

      {draftId && !plan && <PlanCreator draftId={draftId} onCreated={setPlan} compact />}
      {draftId && plan && (
        <div style={{ marginTop: 12 }}>
          <PlanTasks plan={plan} onChanged={setPlan} />
        </div>
      )}
    </>
  );
}
