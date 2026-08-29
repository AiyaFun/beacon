'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { actRunProcedure, actDeleteProcedure } from './procedure-actions';

export type ProcView = {
  id: string;
  name: string;
  description: string;
  steps: { tool: string; why: string }[];
  usedCount: number;
};

/**
 * 流程技能列表。
 *
 * 【为什么把步骤摊开给人看】这是「上次是怎么做成的」，不是黑盒。用户得能判断
 * 这个技能还适不适用——只给个名字，他没法决定要不要按下去。
 */
export function ProcedureList({ items, readOnly }: { items: ProcView[]; readOnly: boolean }) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  if (items.length === 0) {
    return (
      <Card title="做法技能" sub="把跑通过的一次任务存下来，下次一键重跑">
        <p className="small muted" style={{ margin: 0, lineHeight: 1.9 }}>
          还没有。派一次 AI 执行、跑完之后，在执行结果下方点<b>「把这次的做法存成技能」</b>就会出现在这里。
          它记的是<b>上次实际用过哪些工具</b>，不是模型编的步骤。
        </p>
      </Card>
    );
  }

  return (
    <Card title="做法技能" sub={`${items.length} 个 · 记的是上次实际走通的步骤`}>
      {err && <p className="small" style={{ color: 'var(--red)', marginTop: 0 }}>{err}</p>}
      <div className="stack" style={{ gap: 10 }}>
        {items.map((p) => (
          <div key={p.id} className="card" style={{ padding: 12 }}>
            <div className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <b className="small">{p.name}</b>
                {p.usedCount > 0 && <span className="badge" style={{ marginLeft: 8 }}>用过 {p.usedCount} 次</span>}
                <p className="small muted" style={{ margin: '4px 0 0', lineHeight: 1.7 }}>{p.description}</p>
              </div>
              {!readOnly && (
                <div className="row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={pending}
                    onClick={() => {
                      setErr(null); setBusy(p.id);
                      start(async () => {
                        const r = await actRunProcedure(p.id);
                        setBusy(null);
                        // 派出去之后跳到执行页看它跑——留在技能页只能干等
                        if (r.ok && r.runId) router.push(`/assistant?run=${r.runId}`);
                        else setErr(r.error ?? '跑不起来');
                      });
                    }}
                  >
                    {busy === p.id && pending ? '派发中…' : '用一次'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={pending}
                    onClick={() => {
                      setErr(null);
                      start(async () => {
                        const r = await actDeleteProcedure(p.id);
                        if (!r.ok) setErr(r.error ?? '删不掉');
                        else router.refresh();
                      });
                    }}
                  >
                    删除
                  </button>
                </div>
              )}
            </div>
            {p.steps.length > 0 && (
              <p className="small muted" style={{ margin: '8px 0 0', lineHeight: 1.7 }}>
                步骤：{p.steps.map((s) => s.tool).join(' → ')}
              </p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
