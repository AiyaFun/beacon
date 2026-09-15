'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { actSetAiToolStatus, actDeleteAiTool } from './ai-tool-actions';
import { useI18n } from '@/lib/i18n/context';

// AI 自写的工具：审核台。模型起草的代码在这里给人看，看过才能启用。
// 代码用 <details> 收着：一屏放不下五段 JS；但**默认不展开也要能看到它用了哪些内置工具**——
// 那是决定「敢不敢启用」的第一判据（用了 write 类工具就意味着它能改数据）。

export type AiToolView = {
  id: string;
  name: string;
  label: string;
  description: string;
  uses: string[];
  code: string;
  status: string;
  write: boolean;
  costly: boolean;
  contract: boolean;
  usedCount: number;
  lastError: string | null;
  createdAt: string;
};

export function AiToolList({ items, readOnly, supported }: { items: AiToolView[]; readOnly: boolean; supported: boolean }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setMsg('');
    start(async () => {
      const r = await fn();
      if (!r.ok) setMsg(r.error ?? (isEn ? 'Failed' : '失败'));
      router.refresh();
    });
  }

  const statusBadge = (s: string) =>
    s === 'enabled' ? <span className="badge badge-green">{isEn ? 'Enabled' : '已启用'}</span>
    : s === 'disabled' ? <span className="badge badge-gray">{isEn ? 'Disabled' : '已停用'}</span>
    : <span className="badge badge-amber">{isEn ? 'Draft · review' : '草稿 · 待审核'}</span>;

  return (
    <Card
      title={isEn ? 'AI-authored tools' : 'AI 自写的工具'}
      sub={isEn
        ? 'Drafted by the AI from existing tools; runs in a sandbox. Read the code, then enable.'
        : '模型用现有工具拼出来的新工具，在沙箱里跑。看过代码再启用；启用后下次执行就能调。'}
    >
      {!supported && (
        <p className="small muted" style={{ marginBottom: 8 }}>
          {isEn ? 'Not available in this edition (appliance / private only). Drafts are kept but cannot be enabled.' : '这个版本不提供（只在整机版 / 私有化版开放）。草稿会保留，但不能启用。'}
        </p>
      )}
      {items.length === 0 ? (
        <p className="small muted">{isEn ? 'Nothing drafted yet. The AI drafts one when a task needs the same tools combined repeatedly.' : '还没有起草过。同一串做法要反复拼时，AI 会给自己起草一个。'}</p>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {items.map((t) => (
            <div key={t.id} className="card" style={{ padding: 12 }}>
              <div className="row-between wrap" style={{ gap: 8 }}>
                <span className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                  <b>{t.label}</b>
                  <code className="small muted">{t.name}</code>
                  {statusBadge(t.status)}
                  {t.write && <span className="badge badge-amber" title={isEn ? 'Uses tools that change data' : '用到了会改数据的工具'}>{isEn ? 'writes' : '会改数据'}</span>}
                  {t.costly && <span className="badge badge-amber">{isEn ? 'costs' : '会花钱'}</span>}
                </span>
                {!readOnly && (
                  <span className="row" style={{ gap: 6 }}>
                    {t.status !== 'enabled' && supported && (
                      <button className="btn btn-sm btn-primary" disabled={pending} onClick={() => act(() => actSetAiToolStatus(t.id, 'enabled'))}>
                        {isEn ? 'Enable' : '启用'}
                      </button>
                    )}
                    {t.status === 'enabled' && (
                      <button className="btn btn-sm" disabled={pending} onClick={() => act(() => actSetAiToolStatus(t.id, 'disabled'))}>
                        {isEn ? 'Disable' : '停用'}
                      </button>
                    )}
                    <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => act(() => actDeleteAiTool(t.id))}>
                      {isEn ? 'Delete' : '删除'}
                    </button>
                  </span>
                )}
              </div>
              <p className="small" style={{ margin: '6px 0' }}>{t.description}</p>
              <p className="small muted" style={{ margin: 0 }}>
                {isEn ? 'Uses' : '会调用'}：{t.uses.join('、') || '—'} · {isEn ? 'used' : '用过'} {t.usedCount} {isEn ? 'times' : '次'}
                {t.lastError && <span style={{ color: 'var(--red)' }}> · {isEn ? 'last error' : '最近失败'}：{t.lastError.slice(0, 120)}</span>}
              </p>
              <details style={{ marginTop: 6 }}>
                <summary className="small muted" style={{ cursor: 'pointer' }}>{isEn ? 'View code' : '看代码'}</summary>
                <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', maxHeight: 360, overflow: 'auto' }}>{t.code}</pre>
              </details>
            </div>
          ))}
        </div>
      )}
      {msg && <p className="small" style={{ color: 'var(--red)', marginTop: 8 }}>{msg}</p>}
    </Card>
  );
}
