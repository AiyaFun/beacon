'use client';

import { useState } from 'react';
import { AUTH_GROUPS, groupOf, toolsForGroups, type AuthGroupKey } from '@/lib/agent/auth-groups';

// ── 派发时的授权卡 ────────────────────────────────────────────────────────────
//
// 默认什么都不用管：不展开就是「每一步都先问你」，与以前完全一样。
// 想让它一口气跑完的人，展开勾两下再派——这一下点击就是授权本身。
//
// 【为什么这个组件两个壳共用】任务台首页的派活框与助手页的执行面板，
// 是同一件事的两个入口。授权只做在其中一处的话，另一边的用户就得先切外壳
// 才能用上这个功能——而「想用某个能力就得先换一种布局」正是两壳对等那条守卫要防的。

export type ToolBrief = { name: string; label: string; costly?: boolean; contract?: boolean };

export type DispatchAuthValue = {
  authMode: 'confirm_each' | 'preauthorized';
  preauthorizedTools: string[];
};

/** 缺省：一步都不预先授权（= 旧行为）。 */
export const DEFAULT_AUTH: DispatchAuthValue = { authMode: 'confirm_each', preauthorizedTools: [] };

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
  const [open, setOpen] = useState(false);
  const checked = new Set<AuthGroupKey>(
    AUTH_GROUPS.filter((g) => tools.some((t) => groupOf(t) === g.key && value.preauthorizedTools.includes(t.name)))
      .map((g) => g.key),
  );

  function toggle(key: AuthGroupKey) {
    const next = new Set(checked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    const names = toolsForGroups(tools, [...next]);
    onChange(names.length ? { authMode: 'preauthorized', preauthorizedTools: names } : DEFAULT_AUTH);
  }

  const on = value.authMode === 'preauthorized' && value.preauthorizedTools.length > 0;

  return (
    <div className="small" style={{ marginTop: 8 }}>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {on ? `已提前授权 ${checked.size} 组动作` : '每一步都先问我'}
        <span style={{ marginLeft: 6, opacity: 0.6 }}>{open ? '收起' : '改一下'}</span>
      </button>

      {open && (
        <div className="card" style={{ padding: 12, marginTop: 8 }}>
          <p className="small muted" style={{ margin: '0 0 10px' }}>
            勾上的这几类，这次执行中不再逐个问你；没勾的照旧停下来等你点头。
            {callBudget ? `本次最多消耗 ${callBudget} 次 AI 调用。` : ''}
          </p>

          {AUTH_GROUPS.map((g) => {
            const inGroup = tools.filter((t) => groupOf(t) === g.key);
            if (inGroup.length === 0) return null;
            return (
              <div key={g.key} style={{ marginBottom: 10 }}>
                <label className="row" style={{ gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={checked.has(g.key)}
                    onChange={() => toggle(g.key)}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <strong>{g.name}</strong>
                    <span className="muted" style={{ marginLeft: 6 }}>{g.hint}</span>
                    <details style={{ marginTop: 4 }}>
                      <summary className="muted" style={{ cursor: 'pointer' }}>
                        这一类有 {inGroup.length} 个动作
                      </summary>
                      <span className="muted">{inGroup.map((t) => t.label).join('、')}</span>
                    </details>
                  </span>
                </label>
              </div>
            );
          })}

          {/* 签合约那一组即使勾了也仍然会问——机制级的闸，不是这张卡说了算。
              不写清楚的话，用户勾了它、发现还是被问，会以为是 bug。 */}
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            建发布计划、写长期记忆、配定时、拼新智能体这几样
            <strong>无论如何都会再问你一次</strong>：它们做完之后会一直生效，不该由 AI 一个人决定。
          </p>
        </div>
      )}
    </div>
  );
}
