'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { actRunRecipeNow, actDeleteRecipe } from './recipe-actions';

export type RecipeView = {
  id: string; name: string; origin: string; status: string;
  version: number; failCount: number; fields: string[];
  /**
   * 最近抓到的那一条（没有就是 null）。
   *
   * 【为什么必须显示出来】在补上落库之前，配方卡上只有状态与「跑一次」——
   * 用户看得到「能用」，却看不到**它到底抓到了什么**。而这条路上最贵的误解正是
   * 「以为数据在积累」。一张卡上没有数据，用户就没有理由怀疑库里是空的。
   */
  last: { at: Date; got: number; want: number; rowCount: number; pairs: [string, string][] } | null;
  /** 一共存了多少条。0 但状态是「能用」，说明它只是**跑得通**，从没存下过东西 */
  total: number;
};

/** 距今多久。整点粒度就够——采集是 6 小时一轮，分钟数没有意义。 */
function ago(d: Date): string {
  const h = Math.floor((Date.now() - new Date(d).getTime()) / 3_600_000);
  if (h < 1) return '刚刚';
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

// 【状态要说人话，不是把英文原样印出来】用户看到 'broken' 只会问「什么坏了」。
// 而且每一种都要说清**下一步该他做什么**——「等你登录」比「需要登录」有用，
// 因为后者读起来像是在陈述现象，前者是在派活。
const STATUS: Record<string, { text: string; cls: string; hint: string }> = {
  active: { text: '能用', cls: 'badge-green', hint: '' },
  learning: { text: '还没学会', cls: '', hint: '点「跑一次」让它学一遍' },
  broken: { text: '抓不到了', cls: 'badge-amber', hint: '站点可能改版了，下一轮会自动重学' },
  needs_login: { text: '等你登录', cls: 'badge-amber', hint: '点「跑一次」，它会把登录页推到你眼前' },
  // 【和「等你登录」必须分开说】处置一样（跳过、不计失败），但下一步完全不同：
  // 登录墙要你去登录，风控要你等一会儿。合成一句就必然给错建议
  // 站点权利人申请了停采。**不是坏了**，也不是他能修的——所以话要说清楚是谁停的
  stopped: {
    text: '已停采', cls: 'badge-gray',
    hint: '这个站点的权利人要求不要再抓取。已经取到的数据也一并删掉了；配方留着但不会再跑',
  },
  rate_limited: {
    text: '被站点拦下了', cls: 'badge-amber',
    hint: '这次遇到人机验证或「访问过于频繁」。不是配方坏了，过一阵会自动再试；一直这样就把频率调低',
  },
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
                  {/* 抓到了什么，就地给一眼。只印最近一条 + 总条数——
                      配方卡不是数据页，但「一条都没有」这件事必须在这里看得见 */}
                  {r.last ? (
                    <p className="small" style={{ margin: '4px 0 0', lineHeight: 1.7, color: 'var(--text-2)' }}>
                      {ago(r.last.at)}抓到：
                      {r.last.rowCount > 0 && <b>{r.last.rowCount} 行</b>}
                      {r.last.rowCount > 0 && r.last.pairs.length > 0 && '，'}
                      {r.last.pairs.map(([k, v]) => `${k}=${v}`).join('，')}
                      {r.last.rowCount === 0 && r.last.got < r.last.want && (
                        <span className="badge badge-amber" style={{ marginLeft: 6 }}>
                          少了 {r.last.want - r.last.got} 个字段
                        </span>
                      )}
                      <span className="muted"> · 共 {r.total} 条</span>
                    </p>
                  ) : (
                    <p className="small muted" style={{ margin: '4px 0 0' }}>
                      还没存下过数据{r.status === 'active' && '（配方是通的，但每次抓到的值都没留下来——点「跑一次」试试）'}
                    </p>
                  )}
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
