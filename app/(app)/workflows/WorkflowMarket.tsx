'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import {
  actInstallWorkflow,
  actUninstallWorkflow,
  actRunWorkflow,
  actCreateWorkflow,
  actDeleteWorkflow,
  actExportWorkflow,
  actImportWorkflow,
  type RunResult,
} from './actions';

type Template = {
  id: string;
  slug: string;
  name: string;
  description: string;
  emoji: string;
  category: string;
  isBuiltin: boolean;
  installed: boolean;
  stepLabels: string[];
  costlySteps: number;
};

const SAMPLE_STEPS = `[
  { "kind": "draft", "platform": "xiaohongshu" },
  { "kind": "skill", "slug": "xhs-note" },
  { "kind": "cover" }
]`;

export function WorkflowMarket({ templates, readOnly }: { templates: Template[]; readOnly: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [run, setRun] = useState<RunResult | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', emoji: '🧩', steps: SAMPLE_STEPS });
  const [importJson, setImportJson] = useState('');
  const [exported, setExported] = useState('');

  function doRun(t: Template) {
    setErr('');
    setRun(null);
    start(async () => {
      const r = await actRunWorkflow(t.id);
      if (!r.ok) {
        setErr(r.error ?? '跑失败了');
        return;
      }
      setRun(r);
      router.refresh();
    });
  }

  function simple(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setErr('');
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? '操作失败');
      router.refresh();
    });
  }

  return (
    <>
      <Card
        title="模板市场"
        sub="内置模板装上即用 · 自建模板可导出分享"
        action={
          !readOnly && (
            <button className="btn btn-sm" onClick={() => setCreating((v) => !v)}>
              {creating ? '收起' : '+ 自建模板'}
            </button>
          )
        }
      >
        {creating && !readOnly && (
          <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <input className="input" placeholder="模板名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ maxWidth: 200 }} />
              <input className="input" placeholder="emoji" value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} style={{ maxWidth: 80 }} />
              <input className="input" placeholder="一句话说明" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ flex: 1, minWidth: 200 }} />
            </div>
            <textarea
              className="textarea"
              rows={8}
              value={form.steps}
              onChange={(e) => setForm({ ...form, steps: e.target.value })}
              style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}
            />
            <div className="small muted">
              步骤类型：<code>topic</code>(count) · <code>draft</code>(platform/topicId) · <code>skill</code>(slug) ·
              <code>cover</code>(styleKey/specKey) · <code>illustration</code>(count) · <code>publish</code>(platforms)。
              最多 10 步；<code>publish</code> 只建发布计划，不会真的发出去。
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn btn-sm btn-primary"
                disabled={pending || !form.name.trim()}
                onClick={() =>
                  simple(async () => {
                    let steps: unknown;
                    try {
                      steps = JSON.parse(form.steps);
                    } catch {
                      return { ok: false, error: '步骤不是合法的 JSON' };
                    }
                    const r = await actCreateWorkflow({ ...form, steps });
                    if (r.ok) {
                      setCreating(false);
                      setForm({ name: '', description: '', emoji: '🧩', steps: SAMPLE_STEPS });
                    }
                    return r;
                  })
                }
              >
                保存模板
              </button>
              <input
                className="input"
                placeholder="或粘贴别人分享的模板 JSON"
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                style={{ flex: 1, minWidth: 200 }}
              />
              <button
                className="btn btn-sm"
                disabled={pending || !importJson.trim()}
                onClick={() => simple(async () => {
                  const r = await actImportWorkflow(importJson);
                  if (r.ok) setImportJson('');
                  return r;
                })}
              >
                导入
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-2" style={{ gap: 12 }}>
          {templates.map((t) => (
            <div key={t.id} className="card" style={{ padding: 14 }}>
              <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span className="row" style={{ gap: 8 }}>
                  <span style={{ fontSize: 20 }}>{t.emoji}</span>
                  <strong>{t.name}</strong>
                  {t.isBuiltin ? <span className="badge badge-gray">内置</span> : <span className="badge badge-brand">我建的</span>}
                </span>
                <span className="badge badge-amber" title="跑一次会真实消耗额度的步数">
                  {t.costlySteps} 步花额度
                </span>
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>{t.description}</div>
              <ol className="small" style={{ margin: '8px 0', paddingLeft: 20 }}>
                {t.stepLabels.map((l, i) => <li key={i}>{l}</li>)}
              </ol>
              {!readOnly && (
                <div className="row wrap" style={{ gap: 6 }}>
                  {t.installed ? (
                    <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => doRun(t)}>
                      {pending ? '跑着…' : '跑一遍'}
                    </button>
                  ) : (
                    <button className="btn btn-sm" disabled={pending} onClick={() => simple(() => actInstallWorkflow(t.id))}>
                      装上
                    </button>
                  )}
                  {t.isBuiltin && t.installed && (
                    <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => simple(() => actUninstallWorkflow(t.id))}>
                      移除
                    </button>
                  )}
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={pending}
                    onClick={() => start(async () => {
                      const r = await actExportWorkflow(t.id);
                      if (r.ok && r.json) setExported(r.json);
                      else setErr(r.error ?? '导出失败');
                    })}
                  >
                    导出
                  </button>
                  {!t.isBuiltin && (
                    <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => simple(() => actDeleteWorkflow(t.id))}>
                      删除
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {exported && (
          <div style={{ marginTop: 12 }}>
            <div className="small muted">把这段 JSON 发给别人，他在这一页导入即可：</div>
            <textarea className="textarea" rows={8} readOnly value={exported} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
          </div>
        )}

        {err && <div className="small" style={{ marginTop: 10, color: 'var(--red)' }}>{err}</div>}
      </Card>

      {run?.run && (
        <Card title="这一次跑的结果" sub={run.run.status === 'done' ? '全部跑完' : '中途停下了'} style={{ marginTop: 16 }}>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {run.run.logs.map((l, i) => (
              <li key={i} className="small" style={{ color: l.ok ? 'inherit' : 'var(--red)' }}>
                {l.label} — {l.message}
              </li>
            ))}
          </ol>
          {run.run.error && <div className="small" style={{ marginTop: 8, color: 'var(--red)' }}>{run.run.error}</div>}
          {run.run.draftId && (
            <a className="btn btn-sm" href={`/studio?draft=${run.run.draftId}`} style={{ marginTop: 10, display: 'inline-flex' }}>
              去看这篇稿子
            </a>
          )}
        </Card>
      )}
    </>
  );
}
