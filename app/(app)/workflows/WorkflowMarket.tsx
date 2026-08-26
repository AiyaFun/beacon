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
  actSetWorkflowPersona,
  actImportWorkflow,
  type RunResult,
} from './actions';

type Template = {
  id: string;
  slug: string;
  name: string;
  description: string;
  persona: string;
  /** 跑之前得先有什么。空 = 装上就能直接跑 */
  requires: string;
  emoji: string;
  category: string;
  isBuiltin: boolean;
  installed: boolean;
  stepLabels: string[];
  costlySteps: number;
};

const SAMPLE_STEPS = `[
  { "kind": "draft", "platform": "xiaohongshu" },
  { "kind": "skill", "slug": "xhs-format" },
  { "kind": "cover" }
]`;

// 职责说明这一行：没写就当场能写，不用跳去别的地方。
//
// 【为什么内置的不给改】内置模板是**全租户共用同一行**，改了会波及所有人。
// 想要自己团队的说法，先「导出」再「导入」成自建的——那条路已经有了。
// 这里如实说明原因，而不是把编辑按钮藏起来让人以为不能改。
function PersonaLine({
  template,
  readOnly,
  onSaved,
}: {
  template: Template;
  readOnly: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(template.persona);
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();

  const canEdit = !readOnly && !template.isBuiltin;

  if (!editing) {
    return (
      <div className="small" style={{ marginTop: 6 }}>
        <span className="muted">职责：</span>
        {template.persona ? (
          <span>{template.persona}</span>
        ) : (
          <span className="muted">没写 · AI 不会在对话里主动派它，只能手动点「跑一遍」</span>
        )}
        {canEdit && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ marginLeft: 6 }}
            onClick={() => { setText(template.persona); setEditing(true); }}
          >
            {template.persona ? '改' : '写一句'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 6, marginTop: 6 }}>
      <textarea
        className="input"
        rows={2}
        maxLength={300}
        placeholder="什么时候该派它上？例：要发小红书图文时用我，我会挑选题、起稿、配好封面再排发布"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
      <div className="row" style={{ gap: 6 }}>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await actSetWorkflowPersona(template.id, text);
              if (!r.ok) { setErr(r.error ?? '保存失败'); return; }
              setEditing(false);
              setErr('');
              onSaved();
            })
          }
        >
          {pending ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={pending} onClick={() => { setEditing(false); setErr(''); }}>
          取消
        </button>
        <span className="small muted">{text.length}/300</span>
      </div>
    </div>
  );
}

export function WorkflowMarket({ templates, readOnly }: { templates: Template[]; readOnly: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [run, setRun] = useState<RunResult | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  // 【为什么单独记「是哪一张在跑」】useTransition 的 pending 是整个组件共享的一个布尔。
  // 只用它来渲按钮，用户点了「小红书日更三件套」，三张卡的按钮会一起变成「跑着…」——
  // 看上去像是三条智能体同时开跑，而每条都要花额度。记住 id，只让那一张变。
  const [busyId, setBusyId] = useState('');
  const [form, setForm] = useState({ name: '', description: '', persona: '', emoji: '🧩', steps: SAMPLE_STEPS });
  const [importJson, setImportJson] = useState('');
  const [exported, setExported] = useState('');

  function doRun(t: Template) {
    setErr('');
    setRun(null);
    setBusyId(t.id);
    start(async () => {
      const r = await actRunWorkflow(t.id);
      setBusyId('');
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

  // 已装/未装分区（2026-08-25 画廊化）：第一眼是「我的班底」，市场候补在下面——
  // 与豆包「工作伙伴」的心智一致：先看我雇了谁，再看还能雇谁。
  const mine = templates.filter((t) => t.installed);
  const rest = templates.filter((t) => !t.installed);

  // 单张伙伴卡。步骤清单收进 <details>：它是「装之前核对细节」用的，
  // 摊开印在每张卡上（最多 10 行）正是这一页显得密的头号原因。
  // ⚠️ busyId 三元与 doRun 的时序有 tests/workflow/market-ui.test.ts 源码级守卫，别改写法。
  const renderCard = (t: Template) => (
    <div key={t.id} className="card" style={{ padding: 14 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <span className="persona-avatar" style={{ background: 'var(--brand-soft)', fontSize: 17 }}>{t.emoji}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
            <strong>{t.name}</strong>
            {t.isBuiltin ? <span className="badge badge-gray">内置</span> : <span className="badge badge-brand">我建的</span>}
            <span className="badge badge-amber" title="跑一次会真实消耗额度的步数">{t.costlySteps} 步花额度</span>
          </div>
          <div className="small muted" style={{ marginTop: 2 }}>{t.description}</div>
        </div>
      </div>
      {/* 职责说明：AI 助手在对话里靠它决定「用户这句话该派谁」。
          没写就明说「AI 不会主动派它」——留白会让人以为写不写都一样。 */}
      <PersonaLine template={t} readOnly={readOnly} onSaved={() => router.refresh()} />
      {/* 前置条件写在**点之前**能看到的地方。
          「小红书日更三件套」第一步是从最高分选题写初稿，而新账号一条选题都没有——
          不写在这儿的话，用户是花了一次点击、看到「没有可用选题」之后才知道的。 */}
      {t.requires && (
        <div className="small" style={{ marginTop: 6, color: 'var(--amber-text, var(--text-2))' }}>
          ⚠️ 跑之前：{t.requires}
        </div>
      )}
      <details className="small" style={{ margin: '8px 0' }}>
        <summary className="muted" style={{ cursor: 'pointer' }}>流程 {t.stepLabels.length} 步 · 点开看每一步</summary>
        <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>
          {t.stepLabels.map((l, i) => <li key={i}>{l}</li>)}
        </ol>
      </details>
      {!readOnly && (
        <div className="row wrap" style={{ gap: 6 }}>
          {t.installed ? (
            <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => doRun(t)}>
              {busyId === t.id ? '跑着…' : '跑一遍'}
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
  );

  return (
    <>
      <Card
        title="智能体班底"
        sub="已装的排上面点了就跑 · 市场里的装上即用 · 自建可导出分享"
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
              <input
                className="input"
                placeholder="职责：什么时候该派它上（写了 AI 才会在对话里主动派它）"
                value={form.persona}
                onChange={(e) => setForm({ ...form, persona: e.target.value })}
                style={{ flex: 1, minWidth: 260 }}
              />
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
              <code>cover</code>(styleKey/specKey) · <code>illustration</code>(count) · <code>publish</code>(platforms) ·
              <code>analyze</code>(target: performance/rivals/readers) · <code>notify</code>(title)。
              {' '}<code>analyze</code> 看一眼已有数据出一份简报，<code>notify</code> 把结果推到你配好的群机器人——
              两个连起来就是「每天自动看一眼、有事说一声」。
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
                      setForm({ name: '', description: '', persona: '', emoji: '🧩', steps: SAMPLE_STEPS });
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

        {mine.length > 0 && (
          <>
            <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>我的班底 · {mine.length} 位</div>
            <div className="grid grid-2" style={{ gap: 12 }}>{mine.map(renderCard)}</div>
          </>
        )}
        {rest.length > 0 && (
          <>
            <div className="small" style={{ fontWeight: 600, margin: mine.length > 0 ? '16px 0 8px' : '0 0 8px' }}>
              市场里还有 · 装上即用
            </div>
            <div className="grid grid-2" style={{ gap: 12 }}>{rest.map(renderCard)}</div>
          </>
        )}
        {templates.length === 0 && <p className="small muted">市场里暂时没有模板。</p>}

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
