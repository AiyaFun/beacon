'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actInstallWorkflow, actUninstallWorkflow } from './actions';
import { useI18n } from '@/lib/i18n';

/** 档案页头上的三个动作：停用/启用、派任务、看运行。派任务只预填首页的框，不直接开跑。 */
export function AgentOverviewActions({ id, installed, persona, name }: { id: string; installed: boolean; persona: string; name: string }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');

  function toggle() {
    setErr('');
    start(async () => {
      const r = await (installed ? actUninstallWorkflow(id) : actInstallWorkflow(id));
      if (!r.ok) { setErr((r as { error?: string }).error || (isEn ? 'Failed' : '没成功')); return; }
      router.refresh();
    });
  }

  const goal = isEn ? `Dispatch agent "${name}": ` : `派「${name}」去做：${persona ? '' : ''}`;
  return (
    <span className="row wrap" style={{ gap: 6 }}>
      {installed && (
        <a className="btn btn-sm btn-primary" href={`/?goal=${encodeURIComponent(goal)}`}>{isEn ? 'Dispatch' : '派任务'}</a>
      )}
      <a className="btn btn-sm" href="/runs">{isEn ? 'Runs' : '看运行记录'}</a>
      <button className="btn btn-sm btn-ghost" disabled={pending} onClick={toggle}>
        {pending ? '…' : installed ? (isEn ? 'Pause (uninstall)' : '停用') : (isEn ? 'Enable (install)' : '启用')}
      </button>
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
    </span>
  );
}
