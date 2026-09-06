'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Overlay } from '@/components/Overlay';
import { fmtDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { actSyncBotChats } from './bot-actions';
import type { BotRow } from './BotIntegrationCard';
import type { BotChatRow } from '@/lib/bot/chat-summary';

// 「群聊与用户」抽屉

type Props = { providerName: string; providerKey: string; rows: BotRow[]; onClose: () => void };

type UserAgg = { id: string; name?: string; n: number; at: string; chats: number };

function label(c: BotChatRow): string {
  return c.chatName || c.chatId;
}

export function BotChatsDialog({ providerName, providerKey, rows, onClose }: Props) {
  const { lang } = useI18n();
  const router = useRouter();
  const [tab, setTab] = useState<'group' | 'p2p' | 'users'>('group');
  const [msg, setMsg] = useState('');
  const [pending, start] = useTransition();

  const chats = useMemo(
    () => rows.flatMap((r) => r.chats.map((c) => ({ ...c, botLabel: r.label, botId: r.id }))),
    [rows],
  );
  const groups = chats.filter((c) => c.chatType === 'group');
  const p2p = chats.filter((c) => c.chatType !== 'group');
  const users = useMemo(() => {
    const m = new Map<string, UserAgg>();
    for (const c of chats) {
      for (const s of c.senders) {
        const u = m.get(s.id) ?? { id: s.id, name: s.name, n: 0, at: s.at, chats: 0 };
        u.n += s.n;
        u.chats += 1;
        if (s.at > u.at) u.at = s.at;
        if (s.name) u.name = s.name;
        m.set(s.id, u);
      }
    }
    return [...m.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [chats]);

  const syncable = rows.filter((r) => r.provider === 'feishu' && r.inboundKey && r.hasAppSecret);

  function sync() {
    start(async () => {
      let total = 0;
      let err = '';
      for (const r of syncable) {
        const res = await actSyncBotChats(r.id);
        if (res.ok) total += res.synced ?? 0;
        else err = res.error ?? (lang === 'en' ? 'Sync failed' : '同步失败');
      }
      setMsg(
        err
          ? (lang === 'en' ? `Sync failed: ${err}` : `同步失败：${err}`)
          : (lang === 'en' ? `Synced ${total} groups from Feishu` : `已从飞书同步 ${total} 个群`),
      );
      router.refresh();
    });
  }

  const Empty = ({ text }: { text: string }) => (
    <div className="small muted" style={{ padding: '24px 0', textAlign: 'center' }}>{text}</div>
  );

  const titleText = `${providerName} · ${lang === 'en' ? 'Groups & Users' : '群聊与用户'}`;

  return (
    <Overlay label={titleText} onClose={onClose}>
      <div className="dialog-card" style={{ width: 'min(760px, 94vw)', maxHeight: '86vh', overflowY: 'auto', padding: 18 }}>
        <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 12 }}>
          <b style={{ fontSize: 16, flex: 1 }}>{titleText}</b>
          <button className="btn btn-sm btn-ghost" aria-label={lang === 'en' ? 'Close' : '关闭'} onClick={onClose}>✕</button>
        </div>

        <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 12 }}>
          {([
            ['group', lang === 'en' ? `Groups ${groups.length}` : `群聊 ${groups.length}`],
            ['p2p', lang === 'en' ? `Direct Chats ${p2p.length}` : `私聊 ${p2p.length}`],
            ['users', lang === 'en' ? `Users ${users.length}` : `用户 ${users.length}`],
          ] as const).map(([k, t]) => (
            <button key={k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(k)}>{t}</button>
          ))}
          <span style={{ flex: 1 }} />
          {syncable.length > 0 && (
            <button
              className="btn btn-sm btn-ghost"
              onClick={sync}
              disabled={pending}
              title={
                lang === 'en'
                  ? 'Call Feishu im/v1/chats API to discover all groups bot has joined'
                  : '调飞书 im/v1/chats 列出机器人所在的全部群（含还没说过话的）'
              }
            >
              {pending
                ? (lang === 'en' ? 'Syncing…' : '同步中…')
                : (lang === 'en' ? '⟳ Sync Feishu Groups' : '⟳ 从飞书同步群列表')}
            </button>
          )}
          {msg && <span className="small muted">{msg}</span>}
        </div>

        {tab === 'group' && (groups.length === 0 ? (
          <Empty
            text={
              providerKey === 'feishu' && syncable.length > 0
                ? (lang === 'en'
                    ? 'No groups yet. Click "Sync Feishu Groups" or @mention the bot in a group chat.'
                    : '还没有群。点「从飞书同步群列表」，或在群里 @ 一次机器人')
                : (lang === 'en'
                    ? 'No groups yet — will appear here once the bot receives its first message in a group.'
                    : '还没有群——机器人在群里收到第一条消息后就会出现在这里')
            }
          />
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {groups.map((c) => (
              <div key={`${c.botId}:${c.chatId}`} className="row wrap" style={{ gap: 12, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <b>{label(c)}</b>
                  {rows.length > 1 && <span className="small muted" style={{ marginLeft: 8 }}>{c.botLabel}</span>}
                  {!c.chatName && (
                    <div className="small muted">
                      {lang === 'en'
                        ? 'Group name pending (sync Feishu; auto-recorded for DingTalk/WeCom on next message)'
                        : '还没拿到群名（飞书点同步；钉钉/企微收到下一条消息时自动记）'}
                    </div>
                  )}
                </div>
                <span className="small muted">
                  {lang === 'en' ? `${c.senders.length} participants` : `${c.senders.length} 人说过话`}
                </span>
                <span className="small muted">
                  {lang === 'en' ? `${c.msgCount} messages` : `${c.msgCount} 条消息`}
                </span>
                <span className="small muted">
                  {c.lastMessageAt ? fmtDateTime(c.lastMessageAt) : (lang === 'en' ? 'No messages' : '还没消息')}
                </span>
                <span className="small" style={{ color: c.accountName ? 'var(--brand)' : 'var(--muted)' }}>
                  {c.accountName
                    ? (lang === 'en' ? `Account: ${c.accountName}` : `账号：${c.accountName}`)
                    : (lang === 'en' ? 'Unlinked Account' : '未绑账号')}
                </span>
              </div>
            ))}
          </div>
        ))}

        {tab === 'p2p' && (p2p.length === 0 ? (
          <Empty text={lang === 'en' ? 'No direct chats yet — will appear here once someone messages the bot directly.' : '还没有私聊——有人私聊机器人后会出现在这里'} />
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {p2p.map((c) => (
              <div key={`${c.botId}:${c.chatId}`} className="row wrap" style={{ gap: 12, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <b>{label(c)}</b>
                  {rows.length > 1 && <span className="small muted" style={{ marginLeft: 8 }}>{c.botLabel}</span>}
                </div>
                <span className="small muted">
                  {lang === 'en' ? `${c.msgCount} messages` : `${c.msgCount} 条消息`}
                </span>
                <span className="small muted">
                  {c.lastMessageAt ? fmtDateTime(c.lastMessageAt) : (lang === 'en' ? 'No messages' : '还没消息')}
                </span>
              </div>
            ))}
          </div>
        ))}

        {tab === 'users' && (users.length === 0 ? (
          <Empty text={lang === 'en' ? 'No users have interacted with the bot yet.' : '还没有人和机器人说过话'} />
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {users.map((u) => (
              <div key={u.id} className="row wrap" style={{ gap: 12, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <b>{u.name || u.id}</b>
                  {u.name && <code className="small mono muted" style={{ marginLeft: 8 }}>{u.id}</code>}
                </div>
                <span className="small muted">
                  {lang === 'en' ? `${u.n} messages` : `${u.n} 条消息`}
                </span>
                <span className="small muted">
                  {lang === 'en' ? `In ${u.chats} conversations` : `出现在 ${u.chats} 个会话`}
                </span>
                <span className="small muted">{fmtDateTime(u.at)}</span>
              </div>
            ))}
          </div>
        ))}

        <div className="small muted" style={{ marginTop: 12, lineHeight: 1.7 }}>
          {lang === 'en'
            ? 'Real-time counters tracked from inbound webhook events (up to 200 participants per conversation). Pruned when the bot integration is removed.'
            : '数字都是真数：从收到的每条消息里记下的会话、发言人与计数（每个会话最多记 200 位发言人）。删除机器人时一并删除。'}
        </div>
      </div>
    </Overlay>
  );
}
