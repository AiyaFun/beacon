import { platformName, platformColor, PLATFORM_LIST } from '@/lib/constants';
import { fmtNum, relTime } from '@/lib/format';
import { ActionButton } from '@/components/ActionButton';
import { actRemoveWatch } from './actions';

// 对标账号名单 —— **一份实现两处用**：页面上的「对标账号」折叠卡，和点「监控账号数」弹出的明细层。
// 两处内容必须一样：此前只有页面上有名单，用户想核对「我到底在盯谁、采到没有」要一路滚到底。
//
// 服务端组件：移除按钮直接 bind server action，不用把 action 数组当 props 透给客户端组件。

const PLATFORM_EMOJI: Record<string, string> = {
  douyin: '🎵',
  xiaohongshu: '📕',
  wechat: '💬',
  bilibili: '📺',
  x: '✖️',
  youtube: '▶️',
  tiktok: '🎶',
};

/** 超过这个时长没采到就算「停更」——采集链路断了（插件没装/登录态过期）时最先表现为它一直不动 */
const STALE_MS = 7 * 86400000;

export type RosterRow = {
  /** WatchlistItem.id，移除时用它（不是 competitorId：竞对档案全局共享，删的只是本工作区的订阅） */
  watchId: string;
  name: string;
  handle: string;
  platform: string;
  label: string | null;
  followers: number;
  lastCrawledAt: Date | null;
  /** 该竞对在库作品数 */
  posts: number;
  /** 近 7 天新作品数 */
  weekPosts: number;
};

import { getServerLang } from '@/lib/i18n/server';

function Status({ row, lang }: { row: RosterRow; lang: string }) {
  if (!row.lastCrawledAt) return <span className="badge badge-amber">{lang === 'en' ? 'Not collected' : '未采集'}</span>;
  if (Date.now() - row.lastCrawledAt.getTime() > STALE_MS)
    return <span className="badge badge-gray">{lang === 'en' ? 'Inactive >7d' : '7 天没采到'}</span>;
  return null;
}

export async function CompetitorRoster({ rows }: { rows: RosterRow[] }) {
  const lang = await getServerLang();

  // 按平台分组
  const groups = PLATFORM_LIST.map((p) => ({
    key: p.key as string,
    rows: rows.filter((r) => r.platform === p.key),
  })).filter((g) => g.rows.length > 0);

  const known = new Set(PLATFORM_LIST.map((p) => p.key as string));
  const rest = rows.filter((r) => !known.has(r.platform));
  if (rest.length > 0) groups.push({ key: rest[0].platform, rows: rest });

  return (
    <div className="stack" style={{ gap: 14 }}>
      {groups.map((g) => (
        <div key={g.key}>
          <div className="row" style={{ gap: 6, marginBottom: 2 }}>
            <span className="badge" style={{ background: 'var(--surface-2)', color: platformColor(g.key) }}>
              {platformName(g.key)}
            </span>
            <span className="small muted">{g.rows.length} {lang === 'en' ? 'accounts' : '个'}</span>
          </div>
          {g.rows.map((r) => (
            <div key={r.watchId} className="list-row" style={{ gap: 10 }}>
              <span
                className="persona-avatar"
                style={{ background: 'var(--surface-2)', color: platformColor(r.platform) }}
              >
                {PLATFORM_EMOJI[r.platform] ?? r.name.slice(0, 1)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6 }}>
                  <b className="small">{r.name}</b>
                  {r.label && <span className="badge badge-gray">{r.label}</span>}
                  <Status row={r} lang={lang} />
                </div>
                <div className="small muted" style={{ marginTop: 2 }}>
                  @{r.handle}
                  {r.followers > 0 ? (lang === 'en' ? ` · ${fmtNum(r.followers)} followers` : ` · ${fmtNum(r.followers)} 粉丝`) : ''}
                  {lang === 'en' ? ` · ${r.posts} in library` : ` · 在库 ${r.posts} 篇`}
                  {r.weekPosts > 0 ? (lang === 'en' ? ` · +${r.weekPosts} in 7d` : ` · 近 7 天 +${r.weekPosts}`) : ''} ·{' '}
                  {r.lastCrawledAt ? (lang === 'en' ? `Crawled ${relTime(r.lastCrawledAt)}` : `${relTime(r.lastCrawledAt)}采集`) : (lang === 'en' ? 'Never crawled' : '未采集')}
                </div>
              </div>
              <ActionButton action={actRemoveWatch.bind(null, r.watchId)} loadingText={lang === 'en' ? 'Removing…' : '移除中…'}>
                {lang === 'en' ? 'Remove' : '移除'}
              </ActionButton>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
