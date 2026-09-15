'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { actExportSupportBundle } from './health-actions';
import { HEALTH_KIND_LABEL, type HealthItem } from '@/lib/health/types';
import { useI18n } from '@/lib/i18n';
import { beijingDayKey } from '@/lib/beijing';
import { fmtDateTime } from '@/lib/format';

// 员工健康与异常收件箱（2026-09-11 P1）：六类只读诊断。每条带证据时间、影响的员工、修复入口。
// 不做自动修复：首版只读；「修」是点过去改配置，不是这里一键改。

export function HealthInbox({ items }: { items: HealthItem[] }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');

  function exportBundle() {
    setMsg('');
    start(async () => {
      const r = await actExportSupportBundle();
      if (!r.ok) { setMsg(r.error); return; }
      const blob = new Blob([r.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `beacon-support-${beijingDayKey()}.json`; a.click();
      URL.revokeObjectURL(url);
      setMsg(isEn ? 'Bundle downloaded (secrets redacted)' : '诊断包已下载（密钥已打码）');
    });
  }

  const bad = items.filter((i) => i.level === 'bad').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row wrap small" style={{ gap: 10, alignItems: 'center' }}>
        {items.length === 0
          ? <span style={{ color: 'var(--green, inherit)' }}>{isEn ? 'All six checks pass.' : '六类检查都正常。'}</span>
          : <span>{bad > 0 && <span style={{ color: 'var(--red)' }}><strong>{bad}</strong> {isEn ? 'blocking' : '条阻塞'} · </span>}<strong>{warn}</strong> {isEn ? 'warnings' : '条提醒'}</span>}
        <button className="btn btn-sm btn-ghost" disabled={pending} onClick={exportBundle}>{pending ? '…' : (isEn ? 'Export diagnostics' : '导出诊断包')}</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      {items.map((it, i) => (
        <div key={`${it.kind}-${i}`} className="tool-row">
          <span className="run-main">
            <span className="row wrap" style={{ gap: 6 }}>
              <span className={`badge ${it.level === 'bad' ? 'badge-red' : 'badge-amber'}`}>{HEALTH_KIND_LABEL[it.kind]}</span>
              <strong style={{ fontSize: 13 }}>{it.title}</strong>
              {it.affects.length > 0 && <span className="small muted">{isEn ? 'affects' : '影响'}：{it.affects.join('、')}</span>}
            </span>
            <span className="small muted">{it.evidence}{it.at ? ` · ${fmtDateTime(it.at)}` : ''}</span>
          </span>
          <Link href={it.action.href} className="btn btn-sm">{it.action.label}</Link>
        </div>
      ))}
    </div>
  );
}
