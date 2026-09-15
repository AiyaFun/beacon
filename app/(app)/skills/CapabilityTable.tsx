'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { actProbeCapability } from './capability-actions';
import { CAPABILITY_TYPE_LABEL, type CapabilityRow, type CapabilityType } from '@/lib/capabilities/types';
import { useI18n } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';

// 能力注册表（2026-09-11 P1）：一张表回答「这项能力装没装、有没有权、依赖齐不齐、最近用得怎么样、能派给谁」。
// 「装成功但不可用」是这张表存在的理由：只看安装状态的三个市场页看不出这一格。

export function CapabilityTable({ rows, summary }: { rows: CapabilityRow[]; summary: { total: number; usable: number; installedButUnusable: number } }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [type, setType] = useState<CapabilityType | 'all'>('all');
  const [onlyBroken, setOnlyBroken] = useState(false);
  const [pending, start] = useTransition();
  const [probe, setProbe] = useState<Record<string, string>>({});

  const list = useMemo(() => rows.filter((r) => (type === 'all' || r.type === type) && (!onlyBroken || (r.installed && !r.usable))), [rows, type, onlyBroken]);
  const types = useMemo(() => [...new Set(rows.map((r) => r.type))], [rows]);

  function doProbe(id: string) {
    start(async () => {
      const r = await actProbeCapability(id);
      setProbe((p) => ({ ...p, [id]: `${r.ok ? '✓' : '✗'} ${r.message}` }));
    });
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row wrap small" style={{ gap: 10, alignItems: 'center' }}>
        <span><strong>{summary.usable}</strong>/{summary.total} {isEn ? 'usable' : '可用'}</span>
        <button className={`btn btn-sm ${onlyBroken ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setOnlyBroken((v) => !v)}>
          {isEn ? `Installed but unusable (${summary.installedButUnusable})` : `装了但不可用（${summary.installedButUnusable}）`}
        </button>
        <select className="input" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value as CapabilityType | 'all')}>
          <option value="all">{isEn ? 'All types' : '全部类型'}</option>
          {types.map((t) => <option key={t} value={t}>{CAPABILITY_TYPE_LABEL[t]}</option>)}
        </select>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="table small" style={{ minWidth: 900 }}>
          <thead>
            <tr>
              <th>{isEn ? 'Capability' : '能力'}</th>
              <th>{isEn ? 'Type' : '类型'}</th>
              <th>{isEn ? 'State' : '状态'}</th>
              <th>{isEn ? 'Risk' : '风险'}</th>
              <th>{isEn ? '30d calls' : '近 30 天'}</th>
              <th>{isEn ? 'Assignable to' : '可派给'}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.label}</strong><div className="muted" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.description}>{r.description}</div></td>
                <td>{CAPABILITY_TYPE_LABEL[r.type]}</td>
                <td>
                  {r.usable ? <span className="badge badge-green">{isEn ? 'usable' : '可用'}</span>
                    : r.installed ? <span className="badge badge-red">{isEn ? 'installed, unusable' : '装了但不可用'}</span>
                    : <span className="badge badge-gray">{isEn ? 'not installed' : '没装'}</span>}
                  {!r.authorized && <span className="badge badge-amber" style={{ marginLeft: 4 }}>{isEn ? 'no permission / off' : '无权限或已关'}</span>}
                  {r.depsMissing.length > 0 && <div className="muted">{r.depsMissing.join('；')} · <Link href={r.fixHref}>{isEn ? 'fix →' : '去修 →'}</Link></div>}
                  {probe[r.id] && <div className="muted">{probe[r.id]}</div>}
                </td>
                <td>
                  {r.risk.contract && <span className="badge badge-red" title="签合约类：无人值守也会停下来问">{isEn ? 'contract' : '合约'}</span>}
                  {r.risk.write && <span className="badge badge-amber" title="会改数据">{isEn ? 'write' : '写'}</span>}
                  {r.risk.costly && <span className="badge badge-amber" title="会花钱">{isEn ? 'costly' : '花钱'}</span>}
                  {!r.risk.contract && !r.risk.write && !r.risk.costly && <span className="muted">{isEn ? 'read-only' : '只读'}</span>}
                </td>
                <td>{r.calls30d}{r.successRate30d !== null && ` · ${r.successRate30d}%`}{r.lastCalledAt && <div className="muted">{fmtDate(r.lastCalledAt)}</div>}</td>
                <td className="muted" style={{ maxWidth: 220 }}>{r.assignableAgents.length ? r.assignableAgents.slice(0, 4).join('、') + (r.assignableAgents.length > 4 ? ` +${r.assignableAgents.length - 4}` : '') : '—'}</td>
                <td><button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => doProbe(r.id)}>{isEn ? 'Probe' : '探针'}</button></td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={7} className="muted">{isEn ? 'Nothing matches.' : '没有匹配的能力。'}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
