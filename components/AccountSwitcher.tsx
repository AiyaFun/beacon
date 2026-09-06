'use client';

import { useState, useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actSwitchAccount } from '@/app/(app)/actions';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icons';
import { platformColor, platformName } from '@/lib/constants';

export type SwitcherAccount = { id: string; name: string; platform: string; platformLabel: string };

// 顶栏账号切换器（2026-09-06 视觉与交互升级）：
// 告别原生 select 的粗糙双箭头与灰边框，升级为现代 SaaS 风格的平台色标卡片与自定义下拉浮层。
export function AccountSwitcher({ accounts, currentId }: { accounts: SwitcherAccount[]; currentId: string }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { lang, dict } = useI18n();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (accounts.length === 0) return null;

  const currentAccount = accounts.find((a) => a.id === currentId) ?? accounts[0];

  const getAccountDisplayName = (name: string) => {
    if (lang === 'en' && (name === '我的账号' || !name)) return dict.shell.myAccount;
    return name;
  };

  function selectAccount(id: string) {
    setOpen(false);
    if (id === currentId) return;
    start(async () => {
      await actSwitchAccount(id);
      router.refresh();
    });
  }

  return (
    <div ref={boxRef} className="row" style={{ gap: 8, alignItems: 'center', flexShrink: 0, position: 'relative' }}>
      <span className="small muted hide-mobile" style={{ whiteSpace: 'nowrap', flexShrink: 0, fontSize: '12px' }}>
        {dict.shell.currentAccount}
      </span>

      {/* 自定义触发器按钮 */}
      <button
        type="button"
        disabled={pending}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          height: '30px',
          padding: '0 10px',
          borderRadius: '8px',
          background: open ? 'var(--surface-2)' : 'var(--surface)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
          fontSize: '13px',
          cursor: pending ? 'not-allowed' : 'pointer',
          opacity: pending ? 0.6 : 1,
          transition: 'all 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
          maxWidth: '240px',
        }}
        title={lang === 'en' ? 'Switch account (data isolated per account)' : '切换后，草稿/选题/记忆/发布数据跟随账号独立展示'}
      >
        {/* 平台色标小圆点 */}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: platformColor(currentAccount.platform),
            flexShrink: 0,
          }}
        />

        {/* 账号名称与平台 */}
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>
          {getAccountDisplayName(currentAccount.name)}
        </span>
        <span className="small muted" style={{ fontSize: '11.5px', whiteSpace: 'nowrap', flexShrink: 0 }}>
          · {platformName(currentAccount.platform, lang) || currentAccount.platformLabel}
        </span>

        {/* 下拉微箭头 */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            color: 'var(--text-3)',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.18s ease',
            marginLeft: '2px',
          }}
        >
          <Icon.chevron size={13} />
        </span>
      </button>

      {/* 展开浮层 */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '36px',
            left: 0,
            zIndex: 50,
              minWidth: 230,
              maxWidth: 300,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '10px',
              boxShadow: 'var(--shadow-lg)',
              padding: '6px 0',
              overflow: 'hidden',
              animation: 'fade-in 0.12s ease-out',
            }}
          >
            <div style={{ padding: '6px 12px 4px', fontSize: '11px', color: 'var(--text-3)', fontWeight: 650, letterSpacing: '0.3px' }}>
              {lang === 'en' ? 'WORKSPACE ACCOUNTS' : '当前工作区账号'}
            </div>

            <div className="stack" style={{ gap: 1 }}>
              {accounts.map((a) => {
                const isSelected = a.id === currentId;
                const color = platformColor(a.platform);
                return (
                  <div
                    key={a.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectAccount(a.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '7px 12px',
                      cursor: 'pointer',
                      background: isSelected ? 'var(--surface-2)' : 'transparent',
                      transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent';
                    }}
                  >
                    <div className="row" style={{ gap: 8, minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: color,
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          fontSize: '13px',
                          fontWeight: isSelected ? 650 : 500,
                          color: isSelected ? 'var(--text)' : 'var(--text-2)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {getAccountDisplayName(a.name)}
                      </span>
                      <span className="badge" style={{ padding: '1px 6px', fontSize: '10.5px', background: 'var(--surface-2)', color }}>
                        {platformName(a.platform, lang) || a.platformLabel}
                      </span>
                    </div>

                    {isSelected && (
                      <span style={{ color: 'var(--brand)', display: 'flex', flexShrink: 0, marginLeft: 8 }}>
                        <Icon.check size={14} />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 分割线 */}
            <div style={{ height: 1, background: 'var(--border)', margin: '5px 0' }} />

            {/* 管理账号与人设 */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                setOpen(false);
                router.push('/persona');
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 12px',
                fontSize: '12.5px',
                color: 'var(--text-2)',
                cursor: 'pointer',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--surface-2)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
            >
              <Icon.settings size={14} style={{ color: 'var(--text-3)' }} />
              <span>{dict.shell.manageAccount}</span>
            </div>
        </div>
      )}
    </div>
  );
}

