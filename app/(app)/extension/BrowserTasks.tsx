'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actCancelBrowserTask } from './actions';
import { useI18n } from '@/lib/i18n';

// 派给这个浏览器的活。
//
// 【为什么必须有这一块】运行中心里浏览器任务那一行点进来就是这一页。
// 没有它 = 「指路指到空页面」：用户看到「有 1 个等你处理」，点过来却什么都没有，
// 只能猜自己该干什么。这一页要回答的正是那个「我该干什么」——
// 答案通常是「把插件装上/打开浏览器」，所以状态说明里直接写出来。

export type TaskRow = {
  id: string;
  what: string;
  status: string;
  origin: string;
  attempts: number;
  note: string | null;
  expiresAt: string;
  createdAt: string;
};

const STATUS_ZH: Record<string, { label: string; cls: string; hint: string }> = {
  pending: { label: '等浏览器来领', cls: 'badge-accent', hint: '插件下次醒来（或你现在打开浏览器）就会执行' },
  claimed: { label: '插件正在做', cls: 'badge-gray', hint: '已经被某个装了插件的浏览器领走了' },
  done: { label: '做完了', cls: 'badge-green', hint: '' },
  failed: { label: '失败', cls: 'badge-red', hint: '试了几次都没成，多半是目标平台没登录' },
  expired: { label: '过期没做', cls: 'badge-amber', hint: '超过有效期插件一直没打开——不是失败，是没跑' },
  cancelled: { label: '已取消', cls: 'badge-gray', hint: '' },
};

const STATUS_EN: Record<string, { label: string; cls: string; hint: string }> = {
  pending: { label: 'Waiting for browser', cls: 'badge-accent', hint: 'Extension will execute on next wake-up (or when you open your browser)' },
  claimed: { label: 'In progress', cls: 'badge-gray', hint: 'Already claimed by an active browser with the extension installed' },
  done: { label: 'Completed', cls: 'badge-green', hint: '' },
  failed: { label: 'Failed', cls: 'badge-red', hint: 'Failed after multiple attempts, likely not logged in on target platform' },
  expired: { label: 'Expired', cls: 'badge-amber', hint: 'Expired before extension was opened — not a failure, just not executed' },
  cancelled: { label: 'Cancelled', cls: 'badge-gray', hint: '' },
};

const ORIGIN_ZH: Record<string, string> = { agent: 'AI 派的', schedule: '定时派的', user: '你派的' };
const ORIGIN_EN: Record<string, string> = { agent: 'Dispatched by AI', schedule: 'Scheduled', user: 'Dispatched by you' };

export function BrowserTasks({ rows, readOnly }: { rows: TaskRow[]; readOnly: boolean }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');

  if (rows.length === 0) {
    return (
      <p className="small muted" style={{ marginTop: 0 }}>
        {isEn
          ? 'No tasks dispatched to browser yet. The AI assistant queues tasks here when it needs creator studio data, and the extension executes them on next wake-up.'
          : '还没有派给浏览器的活。AI 助手在需要「只有创作后台才有」的数据时会把活排到这里，插件下次醒来就会去做。'}
      </p>
    );
  }

  const waiting = rows.filter((r) => r.status === 'pending').length;
  const statusMap = isEn ? STATUS_EN : STATUS_ZH;
  const originMap = isEn ? ORIGIN_EN : ORIGIN_ZH;

  return (
    <div>
      <p className="small muted" style={{ marginTop: 0 }}>
        {isEn
          ? 'Some data cannot be fetched server-side (completion rates, audience demographics, deep pagination of competitors) and requires borrowing your logged-in browser.'
          : '有些数据服务端拿不到（完播率、粉丝画像、要翻很多页的竞对作品），得借你已登录的浏览器去取。'}
        {waiting > 0 && (
          isEn
            ? <> Currently <strong>{waiting}</strong> waiting — opening a browser with the extension installed will start execution.</>
            : <> 现在有 <strong>{waiting}</strong> 个等着——把装了插件的浏览器打开就会跑。</>
        )}
      </p>
      {err && <p className="small" style={{ color: 'var(--red)' }}>{err}</p>}

      <div className="stack" style={{ gap: 2 }}>
        {rows.map((r) => {
          const st = statusMap[r.status] ?? { label: r.status, cls: 'badge-gray', hint: '' };
          return (
            <div key={r.id} className="tool-row">
              <span className="run-main">
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13 }}>{r.what}</strong>
                  <span className={`badge ${st.cls}`}>{st.label}</span>
                  <span className="small muted">{originMap[r.origin] ?? r.origin}</span>
                  {r.attempts > 1 && (
                    <span className="small muted">
                      {isEn ? `Tried ${r.attempts} times` : `试过 ${r.attempts} 次`}
                    </span>
                  )}
                </span>
                <span className="small muted">
                  {r.note ?? st.hint}
                  {r.status === 'pending' && (isEn ? ` · Valid until ${r.expiresAt}` : ` · ${r.expiresAt} 前有效`)}
                </span>
              </span>
              {/* 只有还没被领走的能取消：插件已经开着标签页在跑了，改库也停不下它 */}
              {!readOnly && r.status === 'pending' && (
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ flexShrink: 0 }}
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const res = await actCancelBrowserTask(r.id);
                      if (!res.ok) { setErr(res.error ?? (isEn ? 'Failed to cancel' : '取消失败')); return; }
                      setErr('');
                      router.refresh();
                    })
                  }
                >
                  {isEn ? 'Cancel task' : '不用采了'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
