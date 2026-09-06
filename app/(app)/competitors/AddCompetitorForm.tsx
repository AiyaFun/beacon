'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PLATFORM_LIST, platformName } from '@/lib/constants';
import { parseCompetitorUrl } from '@/lib/competitor-url';
import { relTime } from '@/lib/format';
import { Icon } from '@/components/icons';
import { actAddCompetitor } from './actions';
import { useI18n } from '@/lib/i18n';

// 各平台 handle 的取值提示（体验关键：告诉用户去哪里拿这个 ID）
const HANDLE_HINT: Record<string, { placeholder: string; hint: string }> = {
  douyin: { placeholder: 'sec_user_id', hint: '抖音主页链接 /user/ 后的一长串即 sec_user_id' },
  xiaohongshu: { placeholder: '小红书号或用户 ID', hint: '个人主页「小红书号」，或主页链接 /user/profile/ 后的 ID' },
  // 公众号填**名称**而不是微信号：插件采集时要拿这个名字去后台「查找文章」里搜，
  // 且只认完全同名（搜不到就报候选、不猜）。填微信号会搜不到。
  wechat: { placeholder: '公众号名称', hint: '填公众号名称，要与后台搜索里显示的完全一致（如「央视新闻」）' },
  bilibili: { placeholder: 'UID', hint: '空间链接 space.bilibili.com/ 后面的数字' },
  x: { placeholder: '用户名（@后面部分）', hint: '如 @elonmusk 填 elonmusk' },
  youtube: { placeholder: '@handle 或频道 ID', hint: '频道主页链接中的 @handle' },
  // 存不带 @ 的 unique_id（与 X 同口径）：主页地址 /@name 里的 @ 由 competitorHomeUrl 补
  tiktok: { placeholder: '用户名（@后面部分）', hint: '主页链接 tiktok.com/@ 后面那串，如 @mrbeast 填 mrbeast' },
};

const HANDLE_HINT_EN: Record<string, { placeholder: string; hint: string }> = {
  douyin: { placeholder: 'sec_user_id', hint: 'String after /user/ in Douyin profile URL is sec_user_id' },
  xiaohongshu: { placeholder: 'RED ID or User ID', hint: 'RED ID on profile or ID after /user/profile/ in URL' },
  wechat: { placeholder: 'Official Account Name', hint: 'Account name, exact match required (e.g. CCTV News)' },
  bilibili: { placeholder: 'UID', hint: 'Digits after space.bilibili.com/' },
  x: { placeholder: 'Username (without @)', hint: 'e.g. for @elonmusk enter elonmusk' },
  youtube: { placeholder: '@handle or Channel ID', hint: '@handle in YouTube channel URL' },
  tiktok: { placeholder: 'Username (without @)', hint: 'String after tiktok.com/@, e.g. for @mrbeast enter mrbeast' },
};

export function AddCompetitorForm({ sourceStatus = {} }: {
  /** 每个平台现在取不取得到数据：server=服务端可取 / plugin=要装插件 / none=没有通道 */
  sourceStatus?: Record<string, string>;
} = {}) {
  const { lang } = useI18n();
  const [platform, setPlatform] = useState(PLATFORM_LIST[0].key as string);
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [parsed, setParsed] = useState<{ ok: boolean; text: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const hintDict = lang === 'en' ? HANDLE_HINT_EN : HANDLE_HINT;
  const hint = hintDict[platform] ?? { placeholder: lang === 'en' ? 'Account ID' : '账号 ID', hint: '' };

  // 粘贴主页链接 → 自动识别平台 + 账号 ID，回填下方字段
  function onUrlChange(value: string) {
    setUrlInput(value);
    setMsg(null);
    const v = value.trim();
    if (!v) { setParsed(null); return; }
    const hit = parseCompetitorUrl(v);
    if (hit) {
      setPlatform(hit.platform);
      setHandle(hit.handle);
      setParsed({
        ok: true,
        text: lang === 'en'
          ? `Detected: ${platformName(hit.platform)} · ${hit.handle}`
          : `已识别：${platformName(hit.platform)} · ${hit.handle}`,
      });
    } else {
      setParsed({
        ok: false,
        text: lang === 'en'
          ? 'Unable to detect from link (short URL or unsupported platform) — select platform and enter ID manually below'
          : '无法从链接识别（短链或不支持的平台）——请在下方手动选平台并填 ID',
      });
    }
  }

  function submit() {
    setMsg(null);
    start(async () => {
      const r = await actAddCompetitor(platform, handle, name, label);
      if (!r.ok) {
        setMsg({ ok: false, text: r.error ?? (lang === 'en' ? 'Failed to add' : '添加失败') });
        return;
      }
      const inherited = r.inheritedPosts ?? 0;
      const when = r.lastCrawledAt
        ? (lang === 'en' ? `crawled ${relTime(r.lastCrawledAt)}` : `${relTime(r.lastCrawledAt)}采集`)
        : (lang === 'en' ? 'crawled' : '已采集');
      setMsg({
        ok: true,
        text: !r.degraded
          ? (lang === 'en'
              ? `Added and finished initial crawl, saved ${r.posts} posts.`
              : `已添加并完成首次采集，入库 ${r.posts} 条作品。`)
          : inherited > 0
            ? (lang === 'en'
                ? `Added. This account was previously crawled by others, with ${inherited} posts (${when}). View posts below; click crawl whenever an update is needed.`
                : `已添加。这个号别人已经采过，库里已有 ${inherited} 篇（${when}），直接看下方作品榜即可；需要更新再点采集。`)
            : r.pluginOnly
              ? r.platform === 'wechat'
                ? (lang === 'en'
                    ? 'Added. WeChat has no server channel. Open "Collector Extension" and click "Background Crawl" (requires logging into your WeChat Official Account admin).'
                    : '已添加。公众号没有服务端通道，请打开「采集助手」插件点「后台采集」（需先登录你自己的公众号后台）。')
                : (lang === 'en'
                    ? 'Added. Crawled via "Collector Extension": open its profile page, or click 1-click crawl in extension.'
                    : '已添加。该平台由「采集助手」插件采集：打开它的主页，或在插件里点一键采集。')
              : (lang === 'en'
                  ? 'Added. No active crawl channel for this platform currently, 0 posts saved.'
                  : '已添加。该平台暂无可用采集通道，未入库任何作品。'),
      });
      setHandle('');
      setName('');
      setLabel('');
      setUrlInput('');
      setParsed(null);
      router.refresh();
    });
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 10, alignItems: 'center', width: '100%' }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 280 }}
          placeholder={lang === 'en' ? 'Paste competitor profile URL for auto-detection (Bilibili, Douyin, RED, etc.)' : '粘贴竞对主页链接一键识别（支持 B站/抖音/小红书 等平台）'}
          value={urlInput}
          onChange={(e) => onUrlChange(e.target.value)}
        />
        {parsed && (
          <span className="small" style={{ color: parsed.ok ? 'var(--green)' : 'var(--red)' }}>
            {parsed.ok ? <Icon.check size={13} /> : null} {parsed.text}
          </span>
        )}
      </div>
      {/* 【加之前就说，不是加完才发现】选到一个没有数据源的平台时当场提示——
          这是用户最容易得出「产品坏了」结论的那一刻，而真相是这条通道还不存在。
          注意**不拦着他加**：他可能就是想先记下来，等通道开了再采。 */}
      {sourceStatus[platform] === 'none' && (
        <p className="small" style={{ margin: 0, color: 'var(--amber, #b45309)', lineHeight: 1.85 }}>
          {lang === 'en' ? (
            <>
              <b>No data source for this platform yet</b> — unavailable via server and collector extension. You can add it for tracking, but <b>no post data will be ingested</b>. This is not a malfunction.
            </>
          ) : (
            <>
              <b>这个平台现在没有数据源</b>——服务端取不到，采集助手也采不了。
              加进来可以先记着，但<b>不会有作品数据</b>。这不是故障。
            </>
          )}
        </p>
      )}
      {sourceStatus[platform] === 'plugin' && (
        <p className="small muted" style={{ margin: 0, lineHeight: 1.85 }}>
          {lang === 'en' ? (
            <>
              Server crawls unavailable for this platform; install <b>Collector Extension</b> to fetch data.
            </>
          ) : (
            <>
              这个平台服务端拿不到数据，要装<b>采集助手</b>浏览器插件后由它去采。
            </>
          )}
        </p>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        <select className="select" style={{ maxWidth: 120 }} value={platform} onChange={(e) => { setPlatform(e.target.value); setMsg(null); }}>
          {PLATFORM_LIST.map((p) => (
            <option key={p.key} value={p.key}>{platformName(p.key)}</option>
          ))}
        </select>
        <input
          className="input"
          style={{ flex: 1, minWidth: 150 }}
          placeholder={hint.placeholder}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
        <input
          className="input"
          style={{ width: 130 }}
          placeholder={lang === 'en' ? 'Name (optional)' : '显示名（选填）'}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input"
          style={{ width: 130 }}
          placeholder={lang === 'en' ? 'Note (optional)' : '备注（选填）'}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button className="btn btn-sm btn-primary" onClick={submit} disabled={pending || !handle.trim()}>
          <Icon.plus size={14} /> {pending ? (lang === 'en' ? 'Adding…' : '添加中…') : (lang === 'en' ? 'Add Competitor' : '添加对标')}
        </button>
      </div>
      <div className="small muted">
        {lang === 'en'
          ? `Paste profile URL to auto-detect, or select platform and enter ID (${hint.hint}). Name & follower count update on first crawl.`
          : `直接粘主页链接自动识别，或手动选平台填 ID（${hint.hint}）。显示名/粉丝会在首次采集时自动补全。`}
      </div>
      {msg && (
        <span className="small" style={{ color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</span>
      )}
    </div>
  );
}
