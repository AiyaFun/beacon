'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { WORK_STAGES, STAGE_LABEL, type WorkStage, type WorkItemView } from '@/lib/workitem/stages';
import { actCreateWorkItem, actAdvanceWorkItem, actAcceptWorkItem, actRejectWorkItem, actCancelWorkItem, actLinkWorkItem, actSyncWorkItem, actDispatchWorkItem } from './work-actions';
import { useI18n } from '@/lib/i18n';

// 内容工单看板（2026-09-11 P1）：六列按阶段；卡上只放关联与流程动作，正文点过去看。
// 验收/驳回只在「审校」列；驳回必须填原因（服务端也拦）。

export type BoardOptions = {
  accounts: { id: string; name: string }[];
  agents: { id: string; label: string }[];
  drafts: { id: string; title: string; accountId: string }[];
  publishRecords: { id: string; title: string; accountId: string; platform: string }[];
};

export function WorkBoard({ items, options, readOnly, showClosed }: { items: WorkItemView[]; options: BoardOptions; readOnly: boolean; showClosed: boolean }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; bad: boolean; href?: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: '', accountId: options.accounts[0]?.id ?? '', agentTemplateId: options.agents[0]?.id ?? '', dueAt: '', inputs: '', acceptance: '', draftId: '' });
  const [linkPick, setLinkPick] = useState<Record<string, string>>({});

  function run(fn: () => Promise<{ ok: boolean; error?: string; runHref?: string }>, okText: string) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) { setMsg({ text: r.error ?? (isEn ? 'Failed' : '没成功'), bad: true }); return; }
      setMsg({ text: okText, bad: false, href: r.runHref });
      router.refresh();
    });
  }

  const byStage = new Map<WorkStage, WorkItemView[]>();
  for (const st of WORK_STAGES) byStage.set(st, []);
  for (const it of items) if (it.status === 'open' || showClosed) byStage.get(it.stage)?.push(it);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        {!readOnly && <button className="btn btn-sm btn-primary" onClick={() => setCreating((v) => !v)}>{creating ? (isEn ? 'Close' : '收起') : (isEn ? 'New work item' : '新建工单')}</button>}
        <Link href={showClosed ? '/runs?view=work' : '/runs?view=work&closed=1'} className="btn btn-sm btn-ghost">{showClosed ? (isEn ? 'Hide closed' : '只看进行中') : (isEn ? 'Show closed' : '含已关闭')}</Link>
        {msg && <span className="small" style={{ color: msg.bad ? 'var(--red)' : 'inherit' }}>{msg.text}{msg.href && <> · <a href={msg.href}>{isEn ? 'View run →' : '去看运行 →'}</a></>}</span>}
      </div>

      {creating && (
        <div className="surface" style={{ padding: 12 }}>
          <div className="stack" style={{ gap: 6 }}>
            <input className="input" placeholder={isEn ? 'Title (what to deliver)' : '标题：要交付什么'} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <div className="row wrap" style={{ gap: 6 }}>
              <select className="input" style={{ width: 'auto' }} value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value, draftId: '' })}>{options.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
              <select className="input" style={{ width: 'auto' }} value={form.agentTemplateId} onChange={(e) => setForm({ ...form, agentTemplateId: e.target.value })}>
                <option value="">{isEn ? 'No agent (manual)' : '不派员工（人做）'}</option>
                {options.agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
              <input className="input" type="date" style={{ width: 'auto' }} value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
              <select className="input" style={{ width: 'auto', maxWidth: 240 }} value={form.draftId} onChange={(e) => setForm({ ...form, draftId: e.target.value })}>
                <option value="">{isEn ? 'Start from topic (no draft)' : '从选题开始（没有草稿）'}</option>
                {options.drafts.filter((d) => d.accountId === form.accountId).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
              </select>
            </div>
            <textarea className="input" rows={2} placeholder={isEn ? 'Inputs for the executor' : '给执行者的输入：写给谁看、有什么约束、参考什么'} value={form.inputs} onChange={(e) => setForm({ ...form, inputs: e.target.value })} />
            <textarea className="input" rows={2} placeholder={isEn ? 'Acceptance criteria' : '验收标准：验收时对着它看'} value={form.acceptance} onChange={(e) => setForm({ ...form, acceptance: e.target.value })} />
            <div>
              <button className="btn btn-sm btn-primary" disabled={pending || !form.title.trim() || !form.accountId} onClick={() => run(async () => { const r = await actCreateWorkItem({ ...form, agentTemplateId: form.agentTemplateId || null, dueAt: form.dueAt || null, draftId: form.draftId || null }); if (r.ok) { setCreating(false); setForm({ ...form, title: '', inputs: '', acceptance: '', draftId: '' }); } return r; }, isEn ? 'Created' : '建好了')}>{isEn ? 'Create' : '建单'}</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${WORK_STAGES.length}, minmax(200px, 1fr))`, gap: 8, minWidth: 1200 }}>
          {WORK_STAGES.map((st) => {
            const list = byStage.get(st) ?? [];
            return (
              <div key={st} className="surface" style={{ padding: 8, minHeight: 120 }}>
                <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{isEn ? STAGE_LABEL[st].en : STAGE_LABEL[st].zh} <span className="muted">{list.length}</span></div>
                <div className="stack" style={{ gap: 6 }}>
                  {list.length === 0 && <span className="small muted">—</span>}
                  {list.map((it) => (
                    <div key={it.id} className="card" style={{ padding: 8 }}>
                      <div className="small" style={{ fontWeight: 600 }}>{it.title}</div>
                      <div className="small muted" style={{ marginTop: 2 }}>
                        {it.accountName}{it.agentName ? ` · ${it.agentName}` : ''}{it.ownerName ? ` · ${it.ownerName}` : ''}
                        {it.dueAt && <span style={{ color: it.overdue ? 'var(--red)' : undefined }}> · {isEn ? 'due' : '截止'} {it.dueAt.slice(0, 10)}</span>}
                        {it.reworkCount > 0 && <span> · {isEn ? `rework ×${it.reworkCount}` : `返工 ${it.reworkCount} 次`}</span>}
                        {it.status !== 'open' && <span> · {it.status}</span>}
                      </div>
                      {it.rejectReason && it.stage === 'drafting' && <div className="small" style={{ color: 'var(--red)', marginTop: 2 }}>{isEn ? 'Rejected: ' : '驳回：'}{it.rejectReason}</div>}
                      <div className="row wrap small" style={{ gap: 6, marginTop: 4 }}>
                        {it.draftId && <Link href={`/studio?draft=${it.draftId}`}>{isEn ? 'draft' : '草稿'}{it.draftVersions ? ` v${it.draftVersions}` : ''}</Link>}
                        {it.runs.map((r) => <Link key={r.id} href={r.href} className="muted">{isEn ? 'run' : '运行'}·{r.status}</Link>)}
                        {it.publishPlanId && <Link href={`/publish?plan=${it.publishPlanId}`}>{isEn ? 'plan' : '发布计划'}</Link>}
                      </div>
                      {!readOnly && it.status === 'open' && (
                        <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
                          {it.agentTemplateId && (st === 'topic' || st === 'drafting') && (
                            <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => run(() => actDispatchWorkItem(it.id), isEn ? 'Dispatched' : '派出去了')}>{isEn ? 'Dispatch' : '派给员工'}</button>
                          )}
                          {st === 'topic' && <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actAdvanceWorkItem(it.id, 'drafting'), isEn ? 'Moved' : '进起稿了')}>{isEn ? '→ Drafting' : '进起稿'}</button>}
                          {st === 'drafting' && !it.draftId && (
                            <>
                              {it.runIds.length > 0 && <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actSyncWorkItem(it.id), isEn ? 'Synced' : '已从运行产物挂上')}>{isEn ? 'Pull from run' : '从运行挂草稿'}</button>}
                              <select className="input" style={{ width: 'auto', maxWidth: 160 }} value={linkPick[it.id] ?? ''} onChange={(e) => setLinkPick({ ...linkPick, [it.id]: e.target.value })}>
                                <option value="">{isEn ? 'Link a draft…' : '挂一篇草稿…'}</option>
                                {options.drafts.filter((d) => d.accountId === it.accountId).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                              </select>
                              <button className="btn btn-sm" disabled={pending || !linkPick[it.id]} onClick={() => run(() => actLinkWorkItem(it.id, 'draft', linkPick[it.id]), isEn ? 'Linked' : '挂上了')}>{isEn ? 'Link' : '挂'}</button>
                            </>
                          )}
                          {st === 'drafting' && it.draftId && <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actAdvanceWorkItem(it.id, 'review'), isEn ? 'Sent to review' : '送审了')}>{isEn ? '→ Review' : '送审校'}</button>}
                          {st === 'review' && (
                            <>
                              <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => run(() => actAcceptWorkItem(it.id), isEn ? 'Accepted' : '验收通过')}>{isEn ? 'Accept' : '验收'}</button>
                              <button className="btn btn-sm" disabled={pending} onClick={() => { const why = window.prompt(isEn ? 'Reject reason (required)' : '驳回原因（必填，返工的人要照它改）'); if (why && why.trim()) run(() => actRejectWorkItem(it.id, why), isEn ? 'Rejected' : '已驳回，退回起稿'); }}>{isEn ? 'Reject' : '驳回'}</button>
                            </>
                          )}
                          {st === 'ready' && (
                            <>
                              <Link href="/publish" className="btn btn-sm">{isEn ? 'Go publish' : '去发布'}</Link>
                              <select className="input" style={{ width: 'auto', maxWidth: 160 }} value={linkPick[it.id] ?? ''} onChange={(e) => setLinkPick({ ...linkPick, [it.id]: e.target.value })}>
                                <option value="">{isEn ? 'Link publish record…' : '挂发布记录…'}</option>
                                {options.publishRecords.filter((p) => p.accountId === it.accountId).map((p) => <option key={p.id} value={p.id}>{p.platform} · {p.title}</option>)}
                              </select>
                              <button className="btn btn-sm" disabled={pending || !linkPick[it.id]} onClick={() => run(async () => { const r = await actLinkWorkItem(it.id, 'publish_record', linkPick[it.id]); return r.ok ? actAdvanceWorkItem(it.id, 'published') : r; }, isEn ? 'Marked published' : '标成已发布')}>{isEn ? 'Published' : '已发布'}</button>
                            </>
                          )}
                          {st === 'published' && <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actAdvanceWorkItem(it.id, 'retro'), isEn ? 'Closed as retro' : '进复盘并结单')}>{isEn ? '→ Retro (close)' : '复盘结单'}</button>}
                          <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => { if (window.confirm(isEn ? 'Cancel this work item?' : '取消这单？')) run(() => actCancelWorkItem(it.id), isEn ? 'Cancelled' : '已取消'); }}>{isEn ? 'Cancel' : '取消'}</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
