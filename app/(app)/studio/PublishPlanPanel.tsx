'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Overlay } from '@/components/Overlay';
import { platformName } from '@/lib/constants';
import { PUBLISH_CAPS, channelLabel, TASK_STATUS_LABEL } from '@/lib/publish/capability';
import { AIGC_LABEL } from '@/lib/compliance/aigc';
import {
  actCreatePublishPlan,
  actLatestPlanForDraft,
  actReadPublishPlan,
  actRunApiPublish,
  actMarkPublishTask,
} from './publish-actions';

type TaskView = {
  id: string;
  platform: string;
  platformLabel: string;
  channel: string;
  status: string;
  title: string;
  content: string;
  extra: { usedBaseDraft?: boolean; submitToPublish?: boolean };
  error: string | null;
  publishedUrl: string | null;
  requires: string;
  why: string;
  calibrated: boolean;
};

type PlanView = { id: string; draftId: string; status: string; tasks: TaskView[] };

const ALL_PLATFORMS = Object.keys(PUBLISH_CAPS);

// 一键发布面板。**界面上必须让人分清三件事**：
//   哪些平台我们能替你发（公众号）、哪些是插件帮你填好你来点、哪些只能你自己复制去发。
// 把它们混成一个「发布」按钮，用户永远搞不清稿子到底出去了没有。
export function PublishPlanPanel({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [aigc, setAigc] = useState(false);
  const [submitWx, setSubmitWx] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [urlDraft, setUrlDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    start(async () => {
      const r = await actLatestPlanForDraft(draftId);
      if (r.ok && r.plan) setPlan(r.plan as PlanView);
    });
  }, [open, draftId]);

  function refresh(planId: string) {
    start(async () => {
      const r = await actReadPublishPlan(planId);
      if (r.ok) setPlan(r.plan as PlanView);
    });
  }

  function create() {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await actCreatePublishPlan({ draftId, platforms: picked, aigcConfirmed: aigc });
      if (!r.ok || !r.planId) {
        setErr(r.error ?? '创建失败');
        return;
      }
      const read = await actReadPublishPlan(r.planId);
      if (read.ok) setPlan(read.plan as PlanView);
      router.refresh();
    });
  }

  function runApi(task: TaskView) {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await actRunApiPublish(task.id, { submitToPublish: submitWx });
      if (!r.ok) setErr(r.error ?? '发布失败');
      else setMsg(r.note ?? '已提交');
      if (plan) refresh(plan.id);
    });
  }

  function mark(task: TaskView, status: 'published' | 'skipped') {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await actMarkPublishTask(task.id, status, urlDraft[task.id]);
      if (!r.ok) setErr(r.error ?? '操作失败');
      else setMsg(r.warning ? `已记录，但${r.warning}` : '已记录');
      if (plan) refresh(plan.id);
      router.refresh();
    });
  }

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
        <h3 style={{ margin: '0 0 6px' }}>一键发布</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          公众号可由服务端直接写进草稿箱；抖音/小红书/B站/视频号由采集助手把内容填进你自己的创作后台，
          <strong>发布按钮由你来点</strong>（不代点，也不模拟点击）；其余平台只能复制内容手动发。
        </p>

        {!plan && (
          <>
            <div className="row wrap" style={{ gap: 8, margin: '14px 0' }}>
              {ALL_PLATFORMS.map((p) => {
                const on = picked.includes(p);
                const cap = PUBLISH_CAPS[p];
                return (
                  <button
                    key={p}
                    className={`btn btn-sm ${on ? 'btn-primary' : ''}`}
                    title={cap.why}
                    onClick={() => setPicked(on ? picked.filter((x) => x !== p) : [...picked, p])}
                  >
                    {platformName(p) || p}
                    <span className="small" style={{ opacity: 0.75, marginLeft: 6 }}>
                      {channelLabel(cap.channel)}
                    </span>
                  </button>
                );
              })}
            </div>

            <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={aigc} onChange={(e) => setAigc(e.target.checked)} />
              <span>{AIGC_LABEL}</span>
            </label>

            <div className="row" style={{ gap: 8, marginTop: 14 }}>
              <button className="btn btn-primary" disabled={pending || !aigc || picked.length === 0} onClick={create}>
                生成发布计划
              </button>
              <button className="btn" disabled={pending} onClick={() => setOpen(false)}>关闭</button>
            </div>
          </>
        )}

        {plan && (
          <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
            {plan.tasks.map((t) => (
              <div key={t.id} className="card" style={{ padding: 14 }}>
                <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <strong>{t.platformLabel}</strong>
                    <span className="badge badge-gray">{channelLabel(t.channel)}</span>
                    <span className={`badge ${t.status === 'published' ? 'badge-green' : t.status === 'failed' ? 'badge-red' : 'badge-amber'}`}>
                      {TASK_STATUS_LABEL[t.status] ?? t.status}
                    </span>
                    {t.extra.usedBaseDraft && <span className="badge badge-gray">用的是原稿（没派生该平台版本）</span>}
                    {t.channel === 'extension' && !t.calibrated && (
                      <span className="badge badge-amber" title="选择器尚未在真机上校准，可能填不进去；填不进去时请手动复制">
                        填充脚本未真机校准
                      </span>
                    )}
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => navigator.clipboard?.writeText(`${t.title}\n\n${t.content}`)}
                      title="复制标题与正文"
                    >
                      复制内容
                    </button>
                    {t.channel === 'api' && t.status !== 'published' && (
                      <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => runApi(t)}>
                        写进公众号草稿箱
                      </button>
                    )}
                    <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => mark(t, 'skipped')}>
                      跳过
                    </button>
                  </span>
                </div>

                {t.channel === 'api' && t.status !== 'published' && (
                  <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
                    <input type="checkbox" checked={submitWx} onChange={(e) => setSubmitWx(e.target.checked)} />
                    同时提交群发（不可撤销，订阅号每天仅一次机会）
                  </label>
                )}

                <div className="small muted" style={{ marginTop: 6 }}>{t.why}</div>
                {t.requires && <div className="small muted">需要：{t.requires}</div>}
                {t.error && <div className="small" style={{ color: 'var(--red)', marginTop: 6 }}>{t.error}</div>}

                {t.status !== 'published' && (
                  <div className="row" style={{ gap: 6, marginTop: 8 }}>
                    <input
                      className="input"
                      placeholder="发布后把作品链接贴这里，数据才能自动回流"
                      value={urlDraft[t.id] ?? ''}
                      onChange={(e) => setUrlDraft({ ...urlDraft, [t.id]: e.target.value })}
                      style={{ flex: 1, fontSize: 12.5 }}
                    />
                    <button className="btn btn-sm" disabled={pending} onClick={() => mark(t, 'published')}>
                      标记已发布
                    </button>
                  </div>
                )}
                {t.publishedUrl && (
                  <div className="small" style={{ marginTop: 6 }}>
                    <a href={t.publishedUrl} target="_blank" rel="noreferrer">{t.publishedUrl}</a>
                  </div>
                )}
              </div>
            ))}

            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm" disabled={pending} onClick={() => refresh(plan.id)}>刷新状态</button>
              <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => setOpen(false)}>关闭</button>
            </div>
          </div>
        )}

        {(msg || err) && (
          <div className="small" style={{ marginTop: 12, color: err ? 'var(--red)' : 'var(--green)' }}>{err || msg}</div>
        )}
      </div>
    </Overlay>
  );
}
