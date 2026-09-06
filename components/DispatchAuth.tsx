'use client';

import { useState } from 'react';
import { AUTH_GROUPS, groupOf, toolsForGroups, type AuthGroupKey } from '@/lib/agent/auth-groups';
import { useI18n } from '@/lib/i18n/context';

// ── 派发时的授权卡 ────────────────────────────────────────────────────────────
//
// 缺省什么都不用管：不展开就是「直接跑完，不逐步问我」（2026-09-03 用户拍板：
// 只要是任务就直接完成）。想盯着它一步步来的人，展开选「每一步都先问我」，
// 还可以只给其中几类动作提前放行——这一下点击就是授权本身。

export type ToolBrief = { name: string; label: string; costly?: boolean; contract?: boolean };

export type DispatchAuthValue = {
  authMode: 'unattended' | 'confirm_each' | 'preauthorized';
  preauthorizedTools: string[];
};

/** 缺省：直接跑完，不逐步问。 */
export const DEFAULT_AUTH: DispatchAuthValue = { authMode: 'unattended', preauthorizedTools: [] };

/** 缺省档之外的那一档：逐步确认，一个动作都没提前放行。 */
export const ASK_EACH: DispatchAuthValue = { authMode: 'confirm_each', preauthorizedTools: [] };

export function authSummary(value: DispatchAuthValue, groupCount: number, lang: string = 'zh'): string {
  if (lang === 'en') {
    if (value.authMode === 'unattended') return 'Run autonomously without asking';
    if (value.authMode === 'preauthorized' && value.preauthorizedTools.length > 0) {
      return `${groupCount} action groups preauthorized; ask for rest`;
    }
    return 'Ask before each step';
  }
  if (value.authMode === 'unattended') return '直接跑完，不逐步问我';
  if (value.authMode === 'preauthorized' && value.preauthorizedTools.length > 0) {
    return `已提前授权 ${groupCount} 组动作，其余先问我`;
  }
  return '每一步都先问我';
}

export function DispatchAuth({
  tools,
  value,
  onChange,
  callBudget,
}: {
  /** 这次能用到的会改数据/花钱的工具（按角色与工作区开关过滤过的） */
  tools: ToolBrief[];
  value: DispatchAuthValue;
  onChange: (v: DispatchAuthValue) => void;
  /** 这次最多烧几次模型调用。摆在卡上是为了让「授权」有个量级概念 */
  callBudget?: number;
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [open, setOpen] = useState(false);
  const checked = new Set<AuthGroupKey>(
    AUTH_GROUPS.filter((g) => tools.some((t) => groupOf(t) === g.key && value.preauthorizedTools.includes(t.name)))
      .map((g) => g.key),
  );
  const askEach = value.authMode !== 'unattended';

  function toggle(key: AuthGroupKey) {
    const next = new Set(checked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    const names = toolsForGroups(tools, [...next]);
    onChange(names.length ? { authMode: 'preauthorized', preauthorizedTools: names } : ASK_EACH);
  }

  return (
    <div className="small" style={{ marginTop: 8 }}>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {authSummary(value, checked.size, lang)}
        <span style={{ marginLeft: 6, opacity: 0.6 }}>{open ? (isEn ? 'Collapse' : '收起') : (isEn ? 'Change' : '改一下')}</span>
      </button>

      {open && (
        <div className="card" style={{ padding: 12, marginTop: 8 }}>
          <label className="row" style={{ gap: 8, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 8 }}>
            <input
              type="radio"
              name="dispatch-auth-mode"
              checked={!askEach}
              onChange={() => onChange(DEFAULT_AUTH)}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>{isEn ? 'Run autonomously' : '直接跑完'}</strong>
              <span className="muted" style={{ marginLeft: 6 }}>
                {isEn ? 'Execute without asking each step, report at completion.' : '会改数据、花额度的动作都不逐个问你，做完汇报。'}
              </span>
            </span>
          </label>
          <label className="row" style={{ gap: 8, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 8 }}>
            <input
              type="radio"
              name="dispatch-auth-mode"
              checked={askEach}
              onChange={() => onChange(ASK_EACH)}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>{isEn ? 'Ask before each step' : '每一步都先问我'}</strong>
              <span className="muted" style={{ marginLeft: 6 }}>
                {isEn ? 'Preauthorize categories below; others will pause and wait for your confirmation.' : '可以只给下面几类提前放行，没勾的照旧停下来等你点头。'}
              </span>
            </span>
          </label>
          {callBudget ? (
            <p className="small muted" style={{ margin: '0 0 10px' }}>
              {isEn ? `At most ${callBudget} AI calls consumed this run.` : `本次最多消耗 ${callBudget} 次 AI 调用。`}
            </p>
          ) : null}

          {askEach && AUTH_GROUPS.map((g) => {
            const inGroup = tools.filter((t) => groupOf(t) === g.key);
            if (inGroup.length === 0) return null;
            return (
              <div key={g.key} style={{ marginBottom: 10, marginLeft: 24 }}>
                <label className="row" style={{ gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={checked.has(g.key)}
                    onChange={() => toggle(g.key)}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <strong>{isEn ? g.nameEn : g.name}</strong>
                    <span className="muted" style={{ marginLeft: 6 }}>{isEn ? g.hintEn : g.hint}</span>
                    <details style={{ marginTop: 4 }}>
                      <summary className="muted" style={{ cursor: 'pointer' }}>
                        {isEn ? `${inGroup.length} actions in this group` : `这一类有 ${inGroup.length} 个动作`}
                      </summary>
                      <span className="muted">{inGroup.map((t) => t.label).join(isEn ? ', ' : '、')}</span>
                    </details>
                  </span>
                </label>
              </div>
            );
          })}

          {/* 签合约那一组无论哪一档都仍然会问——机制级的闸，不是这张卡说了算。
              不写清楚的话，用户选了直接跑完、发现还是被问，会以为是 bug。 */}
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            {isEn ? (
              <>
                Publish plans, long-term memory, recurring schedules, and new agents{' '}
                <strong>will always ask for confirmation regardless of setting</strong>: they persist after completion and cannot be committed by AI alone.
              </>
            ) : (
              <>
                建发布计划、写长期记忆、配定时、拼新智能体这几样
                <strong>无论选哪种都会再问你一次</strong>：它们做完之后会一直生效，不该由 AI 一个人决定。
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
