'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { actRunRecipeNow, actDeleteRecipe } from './recipe-actions';

export type RecipeView = {
  id: string; name: string; origin: string; status: string;
  version: number; failCount: number; fields: string[];
};

// 【状态要说人话，不是把英文原样印出来】用户看到 'broken' 只会问「什么坏了」。
// 而且每一种都要说清**下一步该他做什么**——「等你登录」比「需要登录」有用，
// 因为后者读起来像是在陈述现象，前者是在派活。
const STATUS: Record<string, { text: string; cls: string; hint: string }> = {
  active: { text: '能用', cls: 'badge-green', hint: '' },
  learning: { text: '还没学会', cls: '', hint: '点「跑一次」让它学一遍' },
  broken: { text: '抓不到了', cls: 'badge-amber', hint: '站点可能改版了，下一轮会自动重学' },
  needs_login: { text: '等你登录', cls: 'badge-amber', hint: '点「跑一次」，它会把登录页推到你眼前' },
};

export function RecipeList({ items, readOnly, canRun }: { items: RecipeView[]; readOnly: boolean; canRun: boolean }) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const router = useRouter();

  if (items.length === 0) {
    return (
      <Card title="采集配方" sub="任意站点：指个网址、说要抓什么，学一次就记住">
        <p className="small muted" style={{ margin: 0, lineHeight: 1.9 }}>
          还没有。在任务台跟 AI 说<b>「帮我抓 xxx 网址的标题和点赞数」</b>就会建一个。
          它学会之后能反复用，站点改版抓不到时会<b>自己重新学</b>。
          {!canRun && <><br />（本机浏览器驱动只在整机版可用；云端版可以用采集助手插件那条路。）</>}
        </p>
      </Card>
    );
  }

  return (
    <Card title="采集配方" sub={`${items.length} 个 · 抓不到时会自己重学`}>
      <div className="stack" style={{ gap: 10 }}>
        {items.map((r) => {
          const st = STATUS[r.status] ?? { text: r.status, cls: '', hint: '' };
          return (
            <div key={r.id} className="card" style={{ padding: 12 }}>
              <div className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <b className="small">{r.name}</b>
                  <span className={`badge ${st.cls}`} style={{ marginLeft: 8 }}>{st.text}</span>
                  {r.version > 1 && <span className="badge" style={{ marginLeft: 6 }}>学过 {r.version - 1} 次</span>}
                  <p className="small muted" style={{ margin: '4px 0 0', lineHeight: 1.7, wordBreak: 'break-all' }}>
                    {r.origin}
                    {r.fields.length > 0 && <> · 抓 {r.fields.join('、')}</>}
                  </p>
                  {st.hint && <p className="small muted" style={{ margin: '2px 0 0' }}>{st.hint}</p>}
                </div>
                {!readOnly && (
                  <div className="row" style={{ gap: 6 }}>
                    {canRun && (
                      <button
                        type="button" className="btn btn-sm btn-primary" disabled={pending}
                        onClick={() => {
                          setMsg(null); setBusy(r.id);
                          start(async () => {
                            const res = await actRunRecipeNow(r.id);
                            setBusy(null);
                            setMsg({ id: r.id, text: res.detail ?? res.error ?? '', ok: res.ok });
                            router.refresh();
                          });
                        }}
                      >
                        {busy === r.id && pending ? '跑着…' : '跑一次'}
                      </button>
                    )}
                    <button
                      type="button" className="btn btn-sm btn-ghost" disabled={pending}
                      onClick={() => {
                        setMsg(null);
                        start(async () => {
                          const res = await actDeleteRecipe(r.id);
                          if (!res.ok) setMsg({ id: r.id, text: res.error ?? '删不掉', ok: false });
                          else router.refresh();
                        });
                      }}
                    >
                      删除
                    </button>
                  </div>
                )}
              </div>
              {/* 结果就地显示：跑一次是有输出的动作，把结果甩到别处等于让人自己去找 */}
              {msg?.id === r.id && msg.text && (
                <p className="small" style={{ margin: '8px 0 0', lineHeight: 1.8, color: msg.ok ? 'var(--text-2)' : 'var(--red)' }}>
                  {msg.text}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
