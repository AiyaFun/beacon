'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PLATFORM_LIST } from '@/lib/constants';
import { Icon } from '@/components/icons';
import {
  actSwitchAccount,
  actCreateAccount,
  actUpdateAccount,
  actArchiveAccount,
  actRestoreAccount,
} from '@/app/(app)/actions';

export type ManagedAccount = {
  id: string;
  name: string;
  platform: string;
  platformLabel: string;
  handle: string | null;
  status: string;
  isCurrent: boolean;
  draftCount: number;
  publishCount: number;
};

// 多账号管理：新建/切换/编辑/归档。每个账号的人设、草稿、选题、记忆、发布数据完全独立。
export function AccountManager({ accounts }: { accounts: ManagedAccount[] }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', platform: 'douyin', handle: '' });
  const router = useRouter();

  function refreshAfter(r: { ok: boolean; error?: string }) {
    if (!r.ok) {
      setErr(r.error ?? '操作失败');
      return;
    }
    setErr('');
    setCreating(false);
    setEditingId(null);
    setForm({ name: '', platform: 'douyin', handle: '' });
    router.refresh();
  }

  function submitCreate() {
    start(async () => refreshAfter(await actCreateAccount(form.name, form.platform, form.handle)));
  }
  function submitEdit(id: string) {
    start(async () => refreshAfter(await actUpdateAccount(id, { name: form.name, platform: form.platform, handle: form.handle })));
  }

  const formBody = (onSubmit: () => void, submitLabel: string) => (
    <form className="row wrap" style={{ gap: 8, alignItems: 'center', marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <input
        className="input"
        style={{ maxWidth: 180 }}
        placeholder="账号名称（如：小红书主号）"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <select className="select" style={{ maxWidth: 130 }} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
        {PLATFORM_LIST.map((p) => (
          <option key={p.key} value={p.key}>{p.name}</option>
        ))}
        <option value="multi">多平台</option>
      </select>
      <input
        className="input"
        style={{ maxWidth: 160 }}
        placeholder="平台昵称/ID（选填）"
        value={form.handle}
        onChange={(e) => setForm({ ...form, handle: e.target.value })}
      />
      <button type="submit" className="btn btn-sm btn-primary" disabled={pending || !form.name.trim()}>
        {pending ? '保存中…' : submitLabel}
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setCreating(false); setEditingId(null); setErr(''); }} disabled={pending}>
        取消
      </button>
    </form>
  );

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="small muted">
        每个账号的人设卡、草稿、选题、长期记忆、发布数据都<b style={{ color: 'var(--text)' }}>完全独立</b>；顶栏可随时切换当前操作账号。
      </div>

      {accounts.map((a) => (
        <div key={a.id} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)', opacity: a.status === 'archived' ? 0.6 : 1 }}>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <b className="small">{a.name}</b>
            <span className="badge badge-gray">{a.platformLabel}</span>
            {a.handle && <span className="small muted">@{a.handle}</span>}
            {a.isCurrent && <span className="badge badge-brand">当前账号</span>}
            {a.status === 'archived' && <span className="badge badge-gray">已归档</span>}
            <span className="small muted">· {a.draftCount} 篇草稿 · {a.publishCount} 次发布</span>
            <span className="spacer" />
            {a.status === 'active' && !a.isCurrent && (
              <button
                className="btn btn-sm btn-ghost"
                disabled={pending}
                onClick={() => start(async () => refreshAfter(await actSwitchAccount(a.id)))}
              >
                切换到此账号
              </button>
            )}
            <button
              className="btn btn-sm btn-ghost"
              disabled={pending}
              onClick={() => {
                setEditingId(editingId === a.id ? null : a.id);
                setCreating(false);
                setForm({ name: a.name, platform: a.platform, handle: a.handle ?? '' });
              }}
            >
              编辑
            </button>
            {a.status === 'active' ? (
              <button
                className="btn btn-sm btn-ghost"
                disabled={pending}
                onClick={() => start(async () => refreshAfter(await actArchiveAccount(a.id)))}
                title="归档不删除数据，可随时恢复"
              >
                归档
              </button>
            ) : (
              <button
                className="btn btn-sm btn-ghost"
                disabled={pending}
                onClick={() => start(async () => refreshAfter(await actRestoreAccount(a.id)))}
              >
                恢复
              </button>
            )}
          </div>
          {editingId === a.id && formBody(() => submitEdit(a.id), '保存修改')}
        </div>
      ))}

      {creating ? (
        formBody(submitCreate, '创建并切换')
      ) : (
        <div>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              setCreating(true);
              setEditingId(null);
              setForm({ name: '', platform: 'douyin', handle: '' });
            }}
          >
            <Icon.plus size={14} /> 新建账号
          </button>
        </div>
      )}
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}
