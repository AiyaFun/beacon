'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { Overlay } from '@/components/Overlay';
import { useEffect } from 'react';
import {
  actInstallWorkflow,
  actUninstallWorkflow,
  actStartWorkflow,
  actReadWorkflowRun,
  actCreateWorkflow,
  actDeleteWorkflow,
  actExportWorkflow,
  actSetWorkflowPersona,
  actImportWorkflow,
  type RunResult,
  actEnableRoutine,
  actLedgerWrite,
  actLedgerClearSeen,
} from './actions';
import { useI18n } from '@/lib/i18n';

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
  installed: boolean;
  isBuiltin: boolean;
  costlySteps: number;
  stepLabels: string[];
  mode?: 'deterministic' | 'autonomous' | string;
  agentConfig?: string | null;
};

const SAMPLE_STEPS = JSON.stringify(
  [
    { type: 'topic', count: 1 },
    { type: 'draft', platform: 'zhihu' },
    { type: 'illustration', count: 1 },
    { type: 'publish', platforms: ['zhihu'] },
  ],
  null,
  2,
);

// 伙伴卡的「职责说明」行内编辑（自建模板可用，内置只读）。
// 智能体分工梯（agent_decision_ladder）关键约定：助手是按 persona 这句话在对话里
// 决定「用户现在提的诉求该派哪个智能体」。没这句话，智能体就只能靠用户手动点「跑一遍」。
function PersonaLine({
  template,
  readOnly,
  onSaved,
  isEn,
}: {
  template: Template;
  readOnly: boolean;
  onSaved: () => void;
  isEn?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(template.persona);
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();

  const canEdit = !readOnly && !template.isBuiltin;

  if (!editing) {
    return (
      <div className="small" style={{ marginTop: 6 }}>
        <span className="muted">{isEn ? 'Responsibilities: ' : '职责：'}</span>
        {template.persona ? (
          <span>{template.persona}</span>
        ) : (
          <span style={{ color: 'var(--amber-text, #96560A)' }}>
            {isEn
              ? '⚠ Unspecified · AI will not auto-dispatch in chat, must click "Run Once" manually'
              : '⚠ 没写 · AI 不会在对话里主动派它，只能手动点「跑一遍」'}
          </span>
        )}
        {canEdit && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ marginLeft: 6 }}
            onClick={() => { setText(template.persona); setEditing(true); }}
          >
            {template.persona ? (isEn ? 'Edit' : '改') : (isEn ? 'Add note' : '写一句')}
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
        placeholder={isEn ? 'When should this agent be dispatched? e.g. Use me when publishing to Xiaohongshu to select topic, draft, and generate cover' : '什么时候该派它上？例：要发小红书图文时用我，我会挑选题、起稿、配好封面再排发布'}
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
              if (!r.ok) { setErr(r.error ?? (isEn ? 'Save failed' : '保存失败')); return; }
              setEditing(false);
              setErr('');
              onSaved();
            })
          }
        >
          {pending ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Save' : '保存')}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={pending} onClick={() => { setEditing(false); setErr(''); }}>
          {isEn ? 'Cancel' : '取消'}
        </button>
        <span className="small muted">{text.length}/300</span>
      </div>
    </div>
  );
}


/** 自主型模板的工具白名单（agentConfig 是 JSON 字符串；坏 JSON 当空） */
function agentToolNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const o = JSON.parse(raw) as { tools?: unknown };
    return Array.isArray(o.tools) ? o.tools.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

type SkillRef = { slug: string; when: string };
type Routine = { title: string; goal: string; atHour: number; weekdays?: number[] };
/** 自主型模板的技能（带「什么时候用」）与建议定时（2026-09-05）。客户端只读展示，口径以服务端 parseAgentConfig 为准 */
function agentExtras(raw: string | null | undefined): { skills: SkillRef[]; routines: Routine[] } {
  if (!raw) return { skills: [], routines: [] };
  try {
    const o = JSON.parse(raw) as { skills?: unknown; routines?: unknown };
    const skills = Array.isArray(o.skills)
      ? o.skills.filter((x): x is SkillRef => !!x && typeof (x as SkillRef).slug === 'string' && typeof (x as SkillRef).when === 'string')
      : [];
    const routines = Array.isArray(o.routines)
      ? o.routines.filter((x): x is Routine => !!x && typeof (x as Routine).title === 'string' && typeof (x as Routine).atHour === 'number')
      : [];
    return { skills, routines };
  } catch { return { skills: [], routines: [] }; }
}

/** 台账块：列出 kv、删单条、加/改一条、清空已见清单 */
function LedgerBlock({ slug, ledger, isEn, onChanged }: {
  slug: string;
  ledger: { kv: { key: string; value: string }[]; seen: number };
  isEn: boolean;
  onChanged: () => void;
}) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true); setErr('');
    const r = await fn();
    setBusy(false);
    if (!r.ok) setErr(r.error ?? (isEn ? 'Failed' : '没成功'));
    else { setKey(''); setValue(''); onChanged(); }
  };
  return (
    <div style={{ marginTop: 6 }} data-ledger={slug}>
      <div className="muted">
        {isEn ? 'Its ledger (what it tracks; only this bot sees it)' : '它的台账（它在盯什么、做到哪；只有它自己看得见）'}
      </div>
      {ledger.kv.length === 0 && ledger.seen === 0 ? (
        <div className="small muted">{isEn ? 'Empty — it will ask what to track on its first run.' : '还是空的——第一次派它时它会先问你要盯什么。'}</div>
      ) : (
        <ul style={{ margin: '2px 0 0', paddingLeft: 20 }}>
          {ledger.kv.map((e) => (
            <li key={e.key}>
              <b>{e.key}</b>：{e.value.length > 120 ? `${e.value.slice(0, 120)}…` : e.value}
              <button className="btn btn-xs btn-ghost" disabled={busy} data-act="ledger-delete" onClick={() => run(() => actLedgerWrite(slug, e.key, ''))}>
                {isEn ? 'Delete' : '删'}
              </button>
            </li>
          ))}
          {ledger.seen > 0 && (
            <li>
              {isEn ? `${ledger.seen} items already reported` : `已报过 ${ledger.seen} 条`}
              <button className="btn btn-xs btn-ghost" disabled={busy} data-act="ledger-clear-seen" onClick={() => run(() => actLedgerClearSeen(slug))}>
                {isEn ? 'Clear (report everything anew)' : '清空（下次全当新的再报）'}
              </button>
            </li>
          )}
        </ul>
      )}
      <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
        <input className="input input-sm" style={{ width: 120 }} placeholder={isEn ? 'key, e.g. watchlist' : '名字，如「盯单」'} value={key} onChange={(e) => setKey(e.target.value)} maxLength={40} />
        <input className="input input-sm" style={{ flex: 1, minWidth: 160 }} placeholder={isEn ? 'value' : '内容（写谁的号、盯什么话题…）'} value={value} onChange={(e) => setValue(e.target.value)} maxLength={4000} />
        <button className="btn btn-xs" disabled={busy || !key.trim() || !value.trim()} data-act="ledger-write" onClick={() => run(() => actLedgerWrite(slug, key, value))}>
          {isEn ? 'Save' : '记入'}
        </button>
      </div>
      {err && <div className="small" style={{ color: 'var(--danger, #c0392b)' }}>{err}</div>}
    </div>
  );
}

const DOW_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function routineWhen(r: Routine, isEn: boolean): string {
  const hh = `${String(r.atHour).padStart(2, '0')}:00`;
  const days = r.weekdays ?? [];
  if (days.length === 0) return isEn ? `Daily ${hh}` : `每天 ${hh}`;
  return isEn ? `${days.map((d) => DOW_EN[d]).join('/')} ${hh}` : `每周${days.map((d) => DOW_ZH[d]).join('、')} ${hh}`;
}

const DISMISS_KEY = 'beacon.routine-dismissed';
function readDismissed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as string[]); } catch { return new Set(); }
}
function writeDismissed(set: Set<string>) {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...set])); } catch { /* 隐私模式等：不记就每次都问，无害 */ }
}

export function WorkflowMarket({
  templates,
  readOnly,
  activeRun,
  lang,
  routineState,
  canSchedule,
  ledgerState,
}: {
  templates: Template[];
  readOnly: boolean;
  /** 服务端查到的「正在跑的手点运行」：跳走再回来时接着盯它，别让同一条被再派一次 */
  activeRun?: { runId: string; templateId: string } | null;
  lang?: string;
  /** 每个模板哪几条建议定时已经在跑（下标） */
  routineState?: Record<string, number[]>;
  /** 这台部署有没有后台调度；没有就不问「要不要定时」（问了也建不出会跑的） */
  canSchedule?: boolean;
  /** 每个已装职能 bot 的台账（按 slug）：盯单/进度 + 已见条数 */
  ledgerState?: Record<string, { kv: { key: string; value: string }[]; seen: number }>;
}) {
  const router = useRouter();
  const { lang: i18nLang } = useI18n();
  const isEn = (lang ?? i18nLang) === 'en';
  const [pending, start] = useTransition();
  const [run, setRun] = useState<RunResult | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  // 「不用」只记在这台浏览器上：它不是用户的配置，只是别再问
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  useEffect(() => { setDismissed(readDismissed()); }, []);
  const dismissRoutine = (key: string) => {
    const next = new Set(dismissed); next.add(key); setDismissed(next); writeDismissed(next);
  };
  // 【为什么单独记「是哪一张在跑」】useTransition 的 pending 是整个组件共享的一个布尔。
  // 只用它来渲按钮，用户点了「小红书日更三件套」，三张卡的按钮会一起变成「跑着…」——
  // 看上去像是三条智能体同时开跑，而每条都要花额度。记住 id，只让那一张变。
  const [busyId, setBusyId] = useState(activeRun?.templateId ?? '');
  // 正在盯的那次运行（后台在跑，前端轮询进度）。null = 没有在跑的
  const [watchId, setWatchId] = useState<string | null>(activeRun?.runId ?? null);
  const [form, setForm] = useState({ name: '', description: '', persona: '', emoji: '🧩', steps: SAMPLE_STEPS });
  // 页头「＋ 新建智能体」发的信号（components/AgentCreateActions.tsx）——表单留在这里弹窗
  useEffect(() => {
    const open = () => setCreating(true);
    window.addEventListener('beacon:new-agent', open);
    return () => window.removeEventListener('beacon:new-agent', open);
  }, []);
  const [importJson, setImportJson] = useState('');
  /** 「让 AI 生成」那一行的许愿描述 */
  const [aiWish, setAiWish] = useState('');
  const [exported, setExported] = useState('');

  // 【为什么是「派出去 + 轮询」而不是等 action 跑完】server action 在途时，
  // Next 会把同一客户端的后续导航与其它 action 全排在它后面——同步跑一条几分钟的
  // 工作流 = 用户点完「跑一遍」整个站点点不动（真机撞到的：跳不了页、
  // 技能页的安装/卸载全部灰死）。现在 action 只负责建行并立刻返回 runId，
  // 执行在服务端后台进行，每一步实时落库，这里每 2 秒读一次进度。
  function doRun(t: Template) {
    setErr('');
    setRun(null);
    setBusyId(t.id);
    start(async () => {
      const r = await actStartWorkflow(t.id);
      if (!r.ok || !r.runId) {
        setBusyId('');
        setErr(r.error ?? (isEn ? 'Failed to dispatch' : '没派出去'));
        return;
      }
      setWatchId(r.runId);
    });
  }

  useEffect(() => {
    if (!watchId) return;
    let alive = true;
    let polls = 0;
    const stopWatching = () => {
      setWatchId(null);
      setBusyId('');
    };
    const tick = async () => {
      if (!alive) return;
      polls += 1;
      const r = await actReadWorkflowRun(watchId).catch(() => null);
      if (!alive) return;
      if (!r?.ok || !r.run) {
        setErr(r?.error ?? (isEn ? 'Cannot load run progress; check Task Records' : '读不到这次运行的进度了，去「任务记录」里找它'));
        stopWatching();
        return;
      }
      setRun(r);
      if (r.run.status !== 'running') {
        stopWatching();
        // 跑完的草稿/封面/发布计划要在别的板块出现，刷一次服务端数据
        router.refresh();
        return;
      }
      // ~8 分钟还没完就不盯了：它仍在后台跑（跑飞的由巡检如实判死），任务记录里能继续看
      if (polls >= 240) {
        setErr(isEn ? 'This task is taking longer; progress updates stopped on this page but continue in the background. Check Task Records.' : '这条跑得比较久，页面先不盯着了——它还在后台继续，去「任务记录」看进度。');
        stopWatching();
        return;
      }
      setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [watchId, router, isEn]);

  function simple(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setErr('');
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? (isEn ? 'Operation failed' : '操作失败'));
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
            {t.isBuiltin ? <span className="badge badge-gray">{isEn ? 'Built-in' : '内置'}</span> : <span className="badge badge-brand">{isEn ? 'Custom' : '我建的'}</span>}
            <span className="badge badge-amber" title={isEn ? 'Steps that consume quota on each run' : '跑一次会真实消耗额度的步数'}>
              {t.costlySteps} {isEn ? 'costly steps' : '步花额度'}
            </span>
          </div>
          <div className="small muted" style={{ marginTop: 2 }}>{t.description}</div>
        </div>
      </div>
      {/* 职责说明：AI 助手在对话里靠它决定「用户这句话该派谁」。
          没写就明说「AI 不会主动派它」——留白会让人以为写不写都一样。 */}
      <PersonaLine template={t} readOnly={readOnly} onSaved={() => router.refresh()} isEn={isEn} />
      {/* 前置条件写在**点之前**能看到的地方。
          「小红书日更三件套」第一步是从最高分选题写初稿，而新账号一条选题都没有——
          不写在这儿的话，用户是花了一次点击、看到「没有可用选题」之后才知道的。 */}
      {t.requires && (
        <div className="small" style={{ marginTop: 6, color: 'var(--amber-text, var(--text-2))' }}>
          {isEn ? `⚠️ Prerequisites: ${t.requires}` : `⚠️ 跑之前：${t.requires}`}
        </div>
      )}
      {t.mode === 'autonomous' ? (
        // 职能型 bot（自主型）没有步骤，边界是工具白名单——把它摆出来，用户才知道「情报员」到底能做什么、不能做什么
        <details className="small" style={{ margin: '8px 0' }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>
            {isEn ? `Autonomous · ${agentToolNames(t.agentConfig).length} tools · Click to view` : `自主型 · 能用 ${agentToolNames(t.agentConfig).length} 项工具 · 点开看边界`}
          </summary>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            {agentToolNames(t.agentConfig).map((n) => <li key={n}><code>{n}</code></li>)}
          </ul>
          {/* 技能带「什么时候用」、建议定时——bot 的另外两块（2026-09-05） */}
          {agentExtras(t.agentConfig).skills.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="muted">{isEn ? 'Skills (when to use)' : '技能（什么时候用）'}</div>
              <ul style={{ margin: '2px 0 0', paddingLeft: 20 }}>
                {agentExtras(t.agentConfig).skills.map((sk) => <li key={sk.slug}><code>{sk.slug}</code> · {sk.when}</li>)}
              </ul>
            </div>
          )}
          {agentExtras(t.agentConfig).routines.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="muted">{isEn ? 'Suggested routines (off by default)' : '建议定时（默认关）'}</div>
              <ul style={{ margin: '2px 0 0', paddingLeft: 20 }}>
                {agentExtras(t.agentConfig).routines.map((r, i) => <li key={i}>{routineWhen(r, isEn)} · {r.title}</li>)}
              </ul>
            </div>
          )}
          {/* 台账（2026-09-05）：它在盯什么、做到哪——用户看得见、改得了、清得掉。
              只有已装的才有（没装的 bot 不会跑，也就没有台账）。 */}
          {t.installed && !readOnly && (
            <LedgerBlock
              slug={t.slug}
              ledger={ledgerState?.[t.slug] ?? { kv: [], seen: 0 }}
              isEn={isEn}
              onChanged={() => router.refresh()}
            />
          )}
        </details>
      ) : (
        <details className="small" style={{ margin: '8px 0' }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>
            {isEn ? `${t.stepLabels.length} steps · Click to view details` : `流程 ${t.stepLabels.length} 步 · 点开看每一步`}
          </summary>
          <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            {t.stepLabels.map((l, i) => <li key={i}>{l}</li>)}
          </ol>
        </details>
      )}
      {/* 装上之后问一次「要不要定时」：默认关，点「开启」才建卡与定时；「不用」只在这台浏览器上不再问。
          已经在跑的画成「已定时」并指到定时区块。没后台调度的部署不问（建出来也不会跑）。 */}
      {!readOnly && canSchedule && t.installed && t.mode === 'autonomous' && agentExtras(t.agentConfig).routines.map((r, i) => {
        const on = (routineState?.[t.id] ?? []).includes(i);
        const key = `${t.id}:${i}`;
        if (!on && dismissed.has(key)) return null;
        return (
          <div key={key} className="row wrap small" data-routine-offer={key} style={{ gap: 6, alignItems: 'center', margin: '4px 0' }}>
            <span>⏰ {routineWhen(r, isEn)} · {r.title}</span>
            {on ? (
              <>
                <span className="badge badge-green">{isEn ? 'Scheduled' : '已定时'}</span>
                <a className="small muted" href="#schedules">{isEn ? 'Manage' : '去定时任务里改'}</a>
              </>
            ) : (
              <>
                <button className="btn btn-xs" disabled={pending} data-act="enable-routine" onClick={() => simple(() => actEnableRoutine(t.id, i))}>
                  {isEn ? 'Turn on' : '开启'}
                </button>
                <button className="btn btn-xs btn-ghost" onClick={() => dismissRoutine(key)}>{isEn ? 'No thanks' : '不用'}</button>
              </>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <div className="row wrap" style={{ gap: 6 }}>
          {t.installed ? (
            // 一次只盯一条：有在跑的就不再派第二条（结果卡只有一张，同时跑两条会互相顶掉进度）
            <button className="btn btn-sm btn-primary" disabled={pending || watchId !== null} onClick={() => doRun(t)}>
              {isEn ? (busyId === t.id ? 'Running...' : 'Run Once') : (busyId === t.id ? '跑着…' : '跑一遍')}
            </button>
          ) : (
            <button className="btn btn-sm" disabled={pending} onClick={() => simple(() => actInstallWorkflow(t.id))}>
              {isEn ? 'Install' : '装上'}
            </button>
          )}
          {t.isBuiltin && t.installed && (
            <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => simple(() => actUninstallWorkflow(t.id))}>
              {isEn ? 'Remove' : '移除'}
            </button>
          )}
          <button
            className="btn btn-sm btn-ghost"
            disabled={pending}
            onClick={() => start(async () => {
              const r = await actExportWorkflow(t.id);
              if (r.ok && r.json) setExported(r.json);
              else setErr(r.error ?? (isEn ? 'Export failed' : '导出失败'));
            })}
          >
            {isEn ? 'Export' : '导出'}
          </button>
          {!t.isBuiltin && (
            <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => simple(() => actDeleteWorkflow(t.id))}>
              {isEn ? 'Delete' : '删除'}
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      <Card
        title={isEn ? 'AI Agent Fleet' : '智能体班底'}
        sub={isEn ? 'Installed run on click · Ready to use from market · Custom agents can be exported & shared' : '已装的排上面点了就跑 · 市场里的装上即用 · 自建可导出分享'}
      >
        {creating && !readOnly && (
          <Overlay label={isEn ? 'New Agent' : '新建智能体'} onClose={() => setCreating(false)}>
          {/* 弹窗化（2026-08-26 用户按豆包「新建定时任务」的样式指定）：
              字段没变，只是从页内展开改成居中弹窗——入口在页头，业务区不再被表单顶开 */}
          <div className="dialog-card" style={{ display: 'grid', gap: 10 }}>
            <div className="row-between" style={{ marginBottom: 2 }}>
              <b style={{ fontSize: 16 }}>{isEn ? 'New Agent' : '新建智能体'}</b>
              <button className="btn btn-sm btn-ghost" onClick={() => setCreating(false)}>✕</button>
            </div>
            {/* AI 一键生成（2026-08-26 用户要求）：不在这儿现场生成——执行器已有
                draft_workflow 通道（起草后停下来要确认，合约不能 AI 一个人签）。
                这里把用户的一句描述带过去预填，走的就是那条被守卫钉着的安全通道。 */}
            <div className="row" style={{ gap: 8, padding: '8px 10px', background: 'var(--brand-soft)', borderRadius: 10 }}>
              <span className="small" style={{ flexShrink: 0, alignSelf: 'center' }}>{isEn ? '✨ In a hurry?' : '✨ 懒得配？'}</span>
              <input
                className="input"
                placeholder={isEn ? 'Describe your desired agent in one sentence, e.g., Pick a top topic daily, draft a long Zhihu article with cover' : '一句话说你想要的智能体，例：每天挑一条选题写成知乎长文并配图'}
                value={aiWish}
                onChange={(e) => setAiWish(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-sm btn-primary"
                disabled={!aiWish.trim()}
                onClick={() => {
                  window.location.href = `/assistant?goal=${encodeURIComponent(isEn ? `Draft an agent for me using draft_workflow: ${aiWish.trim()}. Please specify the steps, persona, and name, and wait for my confirmation when drafted.` : `用 draft_workflow 帮我起草一个智能体：${aiWish.trim()}。步骤、职责说明、名字都由你拟好，起草完等我确认`)}`;
                }}
              >
                {isEn ? 'Generate with AI' : '让 AI 生成'}
              </button>
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <input className="input" placeholder={isEn ? 'Template Name' : '模板名'} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ maxWidth: 200 }} />
              <input className="input" placeholder={isEn ? 'Emoji' : 'emoji'} value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} style={{ maxWidth: 80 }} />
              <input className="input" placeholder={isEn ? 'One-line description' : '一句话说明'} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ flex: 1, minWidth: 200 }} />
              <input
                className="input"
                placeholder={isEn ? 'Role: when to dispatch this agent (required for AI auto-dispatch in chat)' : '职责：什么时候该派它上（写了 AI 才会在对话里主动派它）'}
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
            {isEn ? (
              <div className="small muted">
                Step types: <code>topic</code>(count) · <code>draft</code>(platform/topicId) · <code>skill</code>(slug) ·{' '}
                <code>cover</code>(styleKey/specKey) · <code>illustration</code>(count) · <code>publish</code>(platforms) ·{' '}
                <code>analyze</code>(target: performance/rivals/readers) · <code>notify</code>(title).{' '}
                <code>analyze</code> inspects existing data for a brief, <code>notify</code> pushes results to your configured webhook bot.{' '}
                Max 10 steps; <code>publish</code> only creates a publish plan without sending.
              </div>
            ) : (
              <div className="small muted">
                步骤类型：<code>topic</code>(count) · <code>draft</code>(platform/topicId) · <code>skill</code>(slug) ·
                <code>cover</code>(styleKey/specKey) · <code>illustration</code>(count) · <code>publish</code>(platforms) ·
                <code>analyze</code>(target: performance/rivals/readers) · <code>notify</code>(title)。
                {' '}<code>analyze</code> 看一眼已有数据出一份简报，<code>notify</code> 把结果推到你配好的群机器人——
                两个连起来就是「每天自动看一眼、有事说一声」。
                最多 10 步；<code>publish</code> 只建发布计划，不会真的发出去。
              </div>
            )}
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn btn-sm btn-primary"
                disabled={pending || !form.name.trim() || !form.persona.trim()}
                title={!form.persona.trim() ? (isEn ? 'Role description required: AI uses it to decide whom to dispatch' : '职责说明必填：AI 靠它决定对话里该派谁') : undefined}
                onClick={() =>
                  simple(async () => {
                    let steps: unknown;
                    try {
                      steps = JSON.parse(form.steps);
                    } catch {
                      return { ok: false, error: isEn ? 'Steps is not valid JSON' : '步骤不是合法的 JSON' };
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
                {isEn ? 'Save Template' : '保存模板'}
              </button>
              <input
                className="input"
                placeholder={isEn ? 'Or paste template JSON shared by others' : '或粘贴别人分享的模板 JSON'}
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
                {isEn ? 'Import' : '导入'}
              </button>
            </div>
          </div>
          </Overlay>
        )}

        {mine.length > 0 && (
          <>
            <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>
              {isEn ? `My Fleet · ${mine.length}` : `我的班底 · ${mine.length} 位`}
            </div>
            <div className="grid grid-2" style={{ gap: 12 }}>{mine.map(renderCard)}</div>
          </>
        )}
        {rest.length > 0 && (
          <>
            <div className="small" style={{ fontWeight: 600, margin: mine.length > 0 ? '16px 0 8px' : '0 0 8px' }}>
              {isEn ? 'More in Market · Ready to install' : '市场里还有 · 装上即用'}
            </div>
            <div className="grid grid-2" style={{ gap: 12 }}>{rest.map(renderCard)}</div>
          </>
        )}
        {templates.length === 0 && <p className="small muted">{isEn ? 'No templates in the market yet.' : '市场里暂时没有模板。'}</p>}

        {exported && (
          <div style={{ marginTop: 12 }}>
            <div className="small muted">{isEn ? 'Share this JSON with others, they can import it on this page:' : '把这段 JSON 发给别人，他在这一页导入即可：'}</div>
            <textarea className="textarea" rows={8} readOnly value={exported} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
          </div>
        )}

        {err && <div className="small" style={{ marginTop: 10, color: 'var(--red)' }}>{err}</div>}
      </Card>

      {run?.run && (
        <Card
          title={isEn ? (run.run.status === 'running' ? 'Running…' : 'Run Result') : (run.run.status === 'running' ? '正在跑…' : '这一次跑的结果')}
          sub={
            isEn
              ? (run.run.status === 'running'
                  ? `Step ${run.run.stepIndex + 1} in progress · Runs in background, safe to leave this page`
                  : run.run.status === 'done' ? 'All completed' : 'Stopped midway')
              : (run.run.status === 'running'
                  ? `第 ${run.run.stepIndex + 1} 步进行中 · 在后台跑，离开这页也不影响`
                  : run.run.status === 'done' ? '全部跑完' : '中途停下了')
          }
          style={{ marginTop: 16 }}
        >
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {run.run.logs.map((l, i) => (
              <li key={i} className="small" style={{ color: l.ok ? 'inherit' : 'var(--red)' }}>
                {l.label} — {l.message}
              </li>
            ))}
            {run.run.status === 'running' && (
              <li className="small muted">
                {isEn ? `Step ${run.run.stepIndex + 1} in progress…` : <>第 {run.run.stepIndex + 1} 步正在进行…</>}
              </li>
            )}
          </ol>
          {run.run.error && <div className="small" style={{ marginTop: 8, color: 'var(--red)' }}>{run.run.error}</div>}
          <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
            {run.run.draftId && run.run.status !== 'running' && (
              <a className="btn btn-sm" href={`/studio?draft=${run.run.draftId}`}>{isEn ? 'View Draft' : '去看这篇稿子'}</a>
            )}
            <a className="btn btn-sm btn-ghost" href="/runs">{isEn ? 'View in Task Records' : '在任务记录里看'}</a>
          </div>
        </Card>
      )}
    </>
  );
}
