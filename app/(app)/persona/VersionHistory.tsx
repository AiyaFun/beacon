'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actRollbackPersona } from './actions';

export type VersionRow = {
  id: string;
  version: number;
  editedBy: string | null;
  createdAt: string;
  identity: string;
  audience: string;
};

// 人设版本历史 + 回滚。
// PersonaVersion 此前只写不读：每次编辑都存快照，页面却从不查它——
// 设计时想做的回滚一直不存在，用户改坏了人设只能凭记忆手动改回来。
export function VersionHistory({ rows }: { rows: VersionRow[] }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  function rollback(v: VersionRow) {
    if (!window.confirm(`回到 v${v.version} 的人设？\n\n当前版本不会被删除——回滚会生成一个新版本，历史完整保留。`)) return;
    setMsg('');
    start(async () => {
      const r = await actRollbackPersona(v.id);
      setMsg(r.ok ? `已回到 v${v.version} 的内容（存为 v${r.version}）` : r.error ?? '回滚失败');
      if (r.ok) router.refresh();
    });
  }

  if (rows.length === 0) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <button className="btn btn-sm btn-ghost" onClick={() => setOpen((v) => !v)}>
        {open ? '收起版本历史' : `版本历史（${rows.length} 版）`}
      </button>
      {msg && <span className="small" style={{ marginLeft: 8, color: 'var(--green)' }}>{msg}</span>}

      {open && (
        <div className="stack" style={{ gap: 6, marginTop: 10 }}>
          {rows.map((v, i) => (
            <div
              key={v.id}
              className="row wrap"
              style={{
                gap: 8,
                alignItems: 'center',
                padding: '8px 10px',
                borderRadius: 8,
                background: 'var(--surface-2)',
              }}
            >
              <span className="badge badge-gray">v{v.version}</span>
              {i === 0 && <span className="badge badge-green">当前</span>}
              <span className="small" style={{ flex: 1, minWidth: 160 }}>
                {v.identity || '（未填定位）'}
                {v.audience && <span className="muted"> · 受众：{v.audience}</span>}
              </span>
              <span className="small muted">{new Date(v.createdAt).toLocaleString('zh-CN')}</span>
              {v.editedBy && <span className="small muted">· {v.editedBy}</span>}
              {/* 当前版本没有「回到这一版」的意义 */}
              {i !== 0 && (
                <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => rollback(v)} style={{ fontSize: 11 }}>
                  回到这一版
                </button>
              )}
            </div>
          ))}
          <div className="small muted">回滚会生成新版本而不是删除历史——「谁在什么时候回滚过」同样查得到。</div>
        </div>
      )}
    </div>
  );
}
