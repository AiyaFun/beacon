'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PLATFORM_LIST, platformName } from '@/lib/constants';
import { parseCompetitorUrl } from '@/lib/competitor-url';
import { relTime } from '@/lib/format';
import { Icon } from '@/components/icons';
import { actAddCompetitor } from './actions';

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

export function AddCompetitorForm({ sourceStatus = {} }: {
  /** 每个平台现在取不取得到数据：server=服务端可取 / plugin=要装插件 / none=没有通道 */
  sourceStatus?: Record<string, string>;
} = {}) {
  const [platform, setPlatform] = useState(PLATFORM_LIST[0].key as string);
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [parsed, setParsed] = useState<{ ok: boolean; text: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const hint = HANDLE_HINT[platform] ?? { placeholder: '账号 ID', hint: '' };

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
      setParsed({ ok: true, text: `已识别：${platformName(hit.platform)} · ${hit.handle}` });
    } else {
      setParsed({ ok: false, text: '无法从链接识别（短链或不支持的平台）——请在下方手动选平台并填 ID' });
    }
  }

  function submit() {
    setMsg(null);
    start(async () => {
      const r = await actAddCompetitor(platform, handle, name, label);
      if (!r.ok) {
        setMsg({ ok: false, text: r.error ?? '添加失败' });
        return;
      }
      // 四种结局要说四句不同的话。两个此前踩过的坑：①不管哪种都说「展示示例/降级数据」，
      // 而 Mock 现在根本不落库（isMock 闸），照旧说就是让用户去榜单里找不存在的数据；
      // ②对着一个别人已经采过、库里有几十篇的号催用户「请去采集」——竞对档案是全局共享的，
      // 他一订阅就看得到，再采只是白白消耗自己公众号后台的频率预算。
      const inherited = r.inheritedPosts ?? 0;
      const when = r.lastCrawledAt ? `${relTime(r.lastCrawledAt)}采集` : '已采集';
      setMsg({
        ok: true,
        text: !r.degraded
          ? `已添加并完成首次采集，入库 ${r.posts} 条作品。`
          : inherited > 0
            ? `已添加。这个号别人已经采过，库里已有 ${inherited} 篇（${when}），直接看下方作品榜即可；需要更新再点采集。`
            : r.pluginOnly
              ? r.platform === 'wechat'
                ? '已添加。公众号没有服务端通道，请打开「采集助手」插件点「后台采集」（需先登录你自己的公众号后台）。'
                : '已添加。该平台由「采集助手」插件采集：打开它的主页，或在插件里点一键采集。'
              : '已添加。该平台暂无可用采集通道，未入库任何作品。',
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
          placeholder="粘贴竞对主页链接一键识别（支持 B站/抖音/小红书 等平台）"
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
          <b>这个平台现在没有数据源</b>——服务端取不到，采集助手也采不了。
          加进来可以先记着，但<b>不会有作品数据</b>。这不是故障。
        </p>
      )}
      {sourceStatus[platform] === 'plugin' && (
        <p className="small muted" style={{ margin: 0, lineHeight: 1.85 }}>
          这个平台服务端拿不到数据，要装<b>采集助手</b>浏览器插件后由它去采。
        </p>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        <select className="select" style={{ maxWidth: 120 }} value={platform} onChange={(e) => { setPlatform(e.target.value); setMsg(null); }}>
          {PLATFORM_LIST.map((p) => (
            <option key={p.key} value={p.key}>{p.name}</option>
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
          placeholder="显示名（选填）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input"
          style={{ width: 130 }}
          placeholder="备注（选填）"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button className="btn btn-sm btn-primary" onClick={submit} disabled={pending || !handle.trim()}>
          <Icon.plus size={14} /> {pending ? '添加中…' : '添加对标'}
        </button>
      </div>
      <div className="small muted">
        直接粘主页链接自动识别，或手动选平台填 ID（{hint.hint}）。显示名/粉丝会在首次采集时自动补全。
      </div>
      {msg && (
        <span className="small" style={{ color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</span>
      )}
    </div>
  );
}
