'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actMarkNotificationsRead } from '@/app/(app)/notification-actions';

export type NotifItem = { id: string; kind: string; title: string; body: string; link: string | null; read: boolean; createdAt: string };

const KIND_EMOJI: Record<string, string> = {
  performance_alert: '🚀',
  review_ready: '🔮',
  weekly_review: '📅',
  daily_recommend: '📋',
  system: '🔔',
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600_000);
  if (h < 1) return '刚刚';
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

export function NotificationBell({ count, items }: { count: number; items: NotifItem[] }) {
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function markAll() {
    start(async () => { await actMarkNotificationsRead(); });
  }
  // 先等「标已读」落库再跳转。此前是「发起 action + 立刻 window.location.href」，硬跳转
  // 会与写库竞速：落地页的顶栏在服务端渲染时往往还没读到那条已读，红点不消——用户点过了
  // 却看不出点过，只能靠再导航一次才刷新。改成 await + router.push（软导航），
  // 让 action 里的 revalidatePath('/','layout') 直接把新的未读数带出来。
  function openItem(it: NotifItem) {
    setOpen(false);
    start(async () => {
      await actMarkNotificationsRead(it.id);
      if (it.link) router.push(it.link);
    });
  }

  return (
    // notif-wrap：手机端顶栏靠这个类把铃铛钉在屏内（见 globals.css 移动端媒体查询）
    <div className="notif-wrap" style={{ position: 'relative' }}>
      <button
        className="btn btn-sm btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title="通知"
        aria-label={`通知${count > 0 ? `（${count} 条未读）` : ''}`}
        aria-expanded={open}
        style={{ position: 'relative', padding: '4px 8px' }}
      >
        🔔
        {count > 0 && (
          <span
            style={{
              position: 'absolute', top: -2, right: -2, minWidth: 16, height: 16, padding: '0 4px',
              borderRadius: 8, background: 'var(--red)', color: '#fff', fontSize: 10, lineHeight: '16px', fontWeight: 700,
            }}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div
            className="card"
            style={{ position: 'absolute', right: 0, top: 36, width: 'min(320px, calc(100vw - 32px))', maxHeight: 420, overflowY: 'auto', zIndex: 50, padding: 8 }}
          >
            <div className="row-between" style={{ padding: '4px 6px 8px' }}>
              <b className="small">通知</b>
              {count > 0 && <button className="btn btn-sm btn-ghost" onClick={markAll}>全部已读</button>}
            </div>
            {items.length === 0 ? (
              <div className="small muted" style={{ padding: '16px', textAlign: 'center' }}>暂无通知</div>
            ) : (
              <div className="stack" style={{ gap: 2 }}>
                {items.map((it) => (
                  <div
                    key={it.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openItem(it)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(it); } }}
                    style={{
                      padding: '8px 6px', borderRadius: 8, cursor: it.link ? 'pointer' : 'default',
                      background: it.read ? 'transparent' : 'var(--surface-2)',
                    }}
                  >
                    <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                      <span style={{ flexShrink: 0 }}>{KIND_EMOJI[it.kind] ?? '🔔'}</span>
                      <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                        <span className="small" style={{ fontWeight: 600 }}>{it.title}</span>
                        {it.body && <span className="small muted" style={{ lineHeight: 1.5 }}>{it.body}</span>}
                        <span className="small muted" style={{ fontSize: 11 }}>{relTime(it.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
