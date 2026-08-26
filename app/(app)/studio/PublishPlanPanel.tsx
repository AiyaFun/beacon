'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { Overlay } from '@/components/Overlay';
import { actLatestPlanForDraft } from '../publish/actions';
import { PlanCreator, PlanTasks, CHANNEL_INTRO, type PlanView } from '../publish/PlanTasks';

// 创作工坊里的「写完就发」抽屉。
//
// 【它和发布中心（/publish）的分工】这里是**当前这篇**的快捷入口：刚写完、正看着稿子，
// 不该为了发它跳走一次。发布中心是**全部**在跑的计划、待你点发布的任务、和平台通道说明。
// 两处的选平台/任务清单是同一份组件（../publish/PlanTasks），动作是同一份 server action，
// 所以不会出现「工坊里显示已发布、发布中心里还是待填」这种自相矛盾。
export function PublishPlanPanel({ draftId }: { draftId: string }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<PlanView | null>(null);

  useEffect(() => {
    if (!open) return;
    start(async () => {
      const r = await actLatestPlanForDraft(draftId);
      if (r.ok && r.plan) setPlan(r.plan as PlanView);
    });
  }, [open, draftId]);

  if (!open) {
    return (
      <button className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>
        一键发布
      </button>
    );
  }

  return (
    <Overlay label="一键发布" onClose={() => setOpen(false)} closable={!pending}>
      <div className="card" style={{ width: 720, maxWidth: '94vw', maxHeight: '86vh', overflow: 'auto', padding: 24 }}>
        <div className="row-between" style={{ gap: 8, alignItems: 'flex-start' }}>
          <h3 style={{ margin: '0 0 6px' }}>一键发布</h3>
          <Link href="/publish" className="btn btn-sm btn-ghost">
            发布中心 →
          </Link>
        </div>
        <p className="small muted" style={{ marginTop: 0 }}>
          {CHANNEL_INTRO}
        </p>

        {!plan && <PlanCreator draftId={draftId} onCreated={setPlan} />}
        {plan && (
          <div style={{ marginTop: 14 }}>
            <PlanTasks plan={plan} onChanged={setPlan} />
          </div>
        )}

        <div className="row" style={{ gap: 8, marginTop: 14 }}>
          <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => setOpen(false)}>
            关闭
          </button>
        </div>
      </div>
    </Overlay>
  );
}
