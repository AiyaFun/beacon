'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actSwitchAccount } from '@/app/(app)/actions';
import { useI18n } from '@/lib/i18n';

export type SwitcherAccount = { id: string; name: string; platform: string; platformLabel: string };

// 顶栏账号切换器：一个用户多个创作者账号，切换后全站内容数据（草稿/选题/记忆/发布/会诊）随之隔离切换
export function AccountSwitcher({ accounts, currentId }: { accounts: SwitcherAccount[]; currentId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { dict } = useI18n();

  if (accounts.length === 0) return null;

  function onChange(id: string) {
    if (id === '__manage__') {
      router.push('/persona');
      return;
    }
    if (id === currentId) return;
    start(async () => {
      await actSwitchAccount(id);
      router.refresh();
    });
  }

  return (
    <div className="row" style={{ gap: 8, alignItems: 'center', flexShrink: 0, whiteSpace: 'nowrap' }}>
      <span className="small muted hide-mobile" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
        {dict.shell.currentAccount}
      </span>
      <select
        className="select"
        style={{ width: 'auto', minWidth: 160, maxWidth: 220, opacity: pending ? 0.6 : 1, paddingRight: 24, flexShrink: 0 }}
        value={currentId}
        disabled={pending}
        onChange={(e) => onChange(e.target.value)}
        title="切换后，草稿/选题/记忆/发布数据都跟随该账号独立展示"
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {a.platformLabel}
          </option>
        ))}
        <option value="__manage__">{dict.shell.manageAccount}</option>
      </select>
    </div>
  );
}
