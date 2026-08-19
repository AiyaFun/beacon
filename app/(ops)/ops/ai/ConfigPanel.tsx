'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import type { PlatformAiConfig } from '@/lib/ops/platform-config';
import { actSavePlatformAiConfig } from './actions';

// 每功能参数 + 预算闸。空格子 = 不覆盖（沿用调用点自己的值 / provider 默认 30s），
// 这一点必须在界面上写出来：否则空白会被当成「0」，而温度 0 与「不覆盖」是两回事。
export function ConfigPanel({
  config,
  functions,
}: {
  config: PlatformAiConfig;
  functions: { key: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<PlatformAiConfig>(config);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function setFn(fn: string, patch: { temperature?: string; timeoutMs?: string }) {
    const cur = draft.functions[fn as keyof typeof draft.functions] ?? {};
    const next = {
      ...draft,
      functions: {
        ...draft.functions,
        [fn]: {
          temperature: patch.temperature !== undefined ? (patch.temperature === '' ? null : Number(patch.temperature)) : cur.temperature ?? null,
          timeoutMs: patch.timeoutMs !== undefined ? (patch.timeoutMs === '' ? null : Number(patch.timeoutMs)) : cur.timeoutMs ?? null,
        },
      },
    };
    setDraft(next);
  }

  function save() {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await actSavePlatformAiConfig(draft);
      if (!r.ok) {
        setErr(r.error ?? '保存失败');
        return;
      }
      setMsg('已保存并立即生效（缓存同时失效）');
      router.refresh();
    });
  }

  const val = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

  return (
    <Card
      title="全域参数与预算"
      sub="留空 = 不覆盖调用点的值 · 预算只约束平台垫付部分"
      action={
        <button className="btn btn-sm btn-primary" disabled={pending} onClick={save}>
          保存
        </button>
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>功能</th>
              <th style={{ width: 160 }}>温度（0–2）</th>
              <th style={{ width: 200 }}>超时（毫秒，1000–600000）</th>
            </tr>
          </thead>
          <tbody>
            {functions.map((f) => {
              const p = draft.functions[f.key as keyof typeof draft.functions];
              return (
                <tr key={f.key}>
                  <td>{f.label}</td>
                  <td>
                    <input
                      className="input"
                      type="number"
                      step="0.1"
                      min={0}
                      max={2}
                      placeholder="不覆盖"
                      value={val(p?.temperature)}
                      onChange={(e) => setFn(f.key, { temperature: e.target.value })}
                      style={{ maxWidth: 120, fontSize: 12.5 }}
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      type="number"
                      step="1000"
                      placeholder="不覆盖（默认 30000）"
                      value={val(p?.timeoutMs)}
                      onChange={(e) => setFn(f.key, { timeoutMs: e.target.value })}
                      style={{ maxWidth: 170, fontSize: 12.5 }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row wrap" style={{ gap: 12, marginTop: 14, alignItems: 'flex-end' }}>
        <label className="small" style={{ display: 'grid', gap: 4 }}>
          每日预算上限（美元）
          <input
            className="input"
            type="number"
            step="1"
            min={0}
            placeholder="留空 = 不设闸"
            value={val(draft.budget.dailyUsdCap)}
            onChange={(e) =>
              setDraft({ ...draft, budget: { ...draft.budget, dailyUsdCap: e.target.value === '' ? null : Number(e.target.value) } })
            }
            style={{ maxWidth: 160 }}
          />
        </label>
        <label className="small" style={{ display: 'grid', gap: 4 }}>
          每月预算上限（美元）
          <input
            className="input"
            type="number"
            step="1"
            min={0}
            placeholder="留空 = 不设闸"
            value={val(draft.budget.monthlyUsdCap)}
            onChange={(e) =>
              setDraft({ ...draft, budget: { ...draft.budget, monthlyUsdCap: e.target.value === '' ? null : Number(e.target.value) } })
            }
            style={{ maxWidth: 160 }}
          />
        </label>
        <span className="small muted" style={{ maxWidth: 460 }}>
          预算用尽后，平台垫付的调用会被拒绝并提示用户「配自己的 Key 即可继续」——不是静默降级成示例内容。
          自带 Key 的租户不受影响。
        </span>
      </div>

      {(msg || err) && (
        <div className="small" style={{ marginTop: 10, color: err ? 'var(--red)' : 'var(--green)' }}>{err || msg}</div>
      )}
    </Card>
  );
}
