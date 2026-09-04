'use client';

import { useState } from 'react';
import { Overlay } from '@/components/Overlay';
import { Icon } from '@/components/icons';

// 「监控账号数」指标卡 → 点开弹出这些账号的明细（在盯谁、采到没有、在库多少篇）。
//
// 名单本身由服务端渲染好当 children 传进来（里面的「移除」是 server action），
// 客户端这层只管开合：server action 会重渲整条路由，但这个组件挂在页面根部不会被卸载，
// open 状态因此保得住——移除一个号之后弹层还在，可以接着移除下一个。
import { useI18n } from '@/lib/i18n';

export function MonitorStat({
  label,
  value,
  foot,
  dialogTitle,
  dialogSub,
  children,
}: {
  label: string;
  value: React.ReactNode;
  foot?: React.ReactNode;
  dialogTitle: string;
  dialogSub?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { lang } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="stat"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title={lang === 'en' ? 'Click to view watchlist details' : '点开查看监控明细'}
      >
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        <div className="stat-foot row" style={{ gap: 4 }}>
          {foot}
          <span style={{ color: 'var(--brand)' }}>{lang === 'en' ? 'Details →' : '明细 →'}</span>
        </div>
      </button>

      {open && (
        <Overlay label={dialogTitle} onClose={() => setOpen(false)}>
          <div
            className="card"
            style={{ width: 640, maxWidth: '94vw', maxHeight: '86vh', overflowY: 'auto', background: 'var(--surface)' }}
          >
            <div className="row-between wrap" style={{ marginBottom: 14 }}>
              <div className="card-title">
                {dialogTitle} {dialogSub && <span className="card-sub">{dialogSub}</span>}
              </div>
              <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} aria-label={lang === 'en' ? 'Close' : '关闭'}>
                <Icon.x size={14} /> {lang === 'en' ? 'Close' : '关闭'}
              </button>
            </div>
            {children}
          </div>
        </Overlay>
      )}
    </>
  );
}
