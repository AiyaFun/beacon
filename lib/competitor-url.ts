// 竞对主页 URL ↔ (platform, handle) 互转。纯函数、无 IO、无 prisma——
// 客户端表单（粘链接识别）与服务端（listSubscribedCompetitors 拼 url）共用，故独立成模块。
//
// handle 语义与 CompetitorAccount.handle / 各 adapter 对齐：
//   bilibili=mid(数字)  douyin=sec_user_id  xiaohongshu=user_id  youtube=@handle 或频道ID
//   x=用户名  tiktok=unique_id（不带 @，与 X 同口径；TikTok 只有这一种身份形态，不像 YouTube 还有频道ID）

export type ParsedCompetitor = { platform: string; handle: string };

// URL 路径段解码。**handle 一律存人读得懂的原文**，只在拼 URL 时编码一次。
//
// ⚠️ 真机 2026-07-28：`youtube.com/@傑少JAY` 的 pathname 是 `/@%E5%82%91%E5%B0%91JAY`，
// 旧代码把这串**编码后**的文本当 handle 存进库，competitorHomeUrl 再 encodeURIComponent 一次，
// 变成 `%25E5%2582%2591…`——双重编码，打开就是 404。于是「打开采集」和批量采集
// 打开的都是空页面，用户看到的现象就是「采不到这个 youtuber 的账号」。
// 非 ASCII 的 handle（中文/日文频道名）必然踩中，纯英文 handle 则完全无感——所以一直没暴露。
//
// 解不开就原样返回：handle 里本来就可能有 % 字符，decodeURIComponent 遇到非法序列会抛。
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// 由 platform+handle 拼出公开主页 URL（供插件「一键打开并采集」跳转）。
export function competitorHomeUrl(platform: string, handle: string): string | null {
  switch (platform) {
    case 'bilibili':
      return `https://space.bilibili.com/${encodeURIComponent(handle)}`;
    case 'douyin':
      return `https://www.douyin.com/user/${encodeURIComponent(handle)}`;
    case 'xiaohongshu':
      return `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(handle)}`;
    case 'x':
      return `https://x.com/${encodeURIComponent(handle.replace(/^@/, ''))}`;
    case 'tiktok':
      // 主页地址是 /@<unique_id>，@ 由这里补——库里存的是不带 @ 的原值（见文件头 handle 语义）。
      // 存量里若混进了带 @ 的旧值，剥掉再拼，避免出现 /@@name。
      return `https://www.tiktok.com/@${encodeURIComponent(handle.replace(/^@/, ''))}`;
    case 'youtube':
      // @handle → /@handle；频道ID(UC…) → /channel/<id>
      // 先解一次再编码：**存量记录里可能是编码过的旧值**（修复前存进去的），
      // 直接编码会变成双重编码打不开。decode→encode 对两种形态都得到同一个正确地址。
      return /^UC[\w-]{20,}$/.test(handle)
        ? `https://www.youtube.com/channel/${handle}`
        : `https://www.youtube.com/@${encodeURIComponent(safeDecode(handle.replace(/^@/, '')))}`;
    default:
      return null;
  }
}

// X/Twitter 的一级路径保留字：这些是站内功能页而非用户名，不能当 handle。
const X_RESERVED = new Set([
  'home', 'search', 'explore', 'notifications', 'messages', 'i', 'settings',
  'compose', 'hashtag', 'about', 'tos', 'privacy',
]);

// 从粘贴的主页链接解析出 (platform, handle)。识别不了返回 null。
// 兼容不带协议（space.bilibili.com/123）与短链域名（短链无法离线解析 → 返回 null，交给用户手填）。
export function parseCompetitorUrl(input: string): ParsedCompetitor | null {
  const raw = (input || '').trim();
  if (!raw) return null;

  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean).map((s) => s.trim());

  // B站：space.bilibili.com/<mid> | m.bilibili.com/space/<mid>
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
    if (host.startsWith('space.') && /^\d+$/.test(segs[0] || '')) return { platform: 'bilibili', handle: segs[0] };
    if (segs[0] === 'space' && /^\d+$/.test(segs[1] || '')) return { platform: 'bilibili', handle: segs[1] };
    const mid = segs.find((s) => /^\d+$/.test(s)); // 兜底：路径里第一个纯数字段
    return mid ? { platform: 'bilibili', handle: mid } : null;
  }

  // 抖音：douyin.com/user/<sec_user_id>（v.douyin.com 短链无法离线解析）
  if (host === 'douyin.com' || host.endsWith('.douyin.com')) {
    const i = segs.indexOf('user');
    return i >= 0 && segs[i + 1] ? { platform: 'douyin', handle: decodeURIComponent(segs[i + 1]) } : null;
  }

  // 小红书：xiaohongshu.com/user/profile/<user_id>（xhslink.com 短链无法离线解析）
  if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com')) {
    const i = segs.indexOf('profile');
    return i >= 0 && segs[i + 1] ? { platform: 'xiaohongshu', handle: segs[i + 1] } : null;
  }

  // YouTube：/@handle | /channel/<id> | /user/<name> | /c/<name>
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    // 解码：中文/日文频道的 pathname 是百分号编码的，存原文才能和插件采到的对上，
    // 也才不会在拼 URL 时被二次编码（见 safeDecode 上方注释）。
    if ((segs[0] || '').startsWith('@')) return { platform: 'youtube', handle: safeDecode(segs[0]) };
    if (['channel', 'user', 'c'].includes(segs[0]) && segs[1]) return { platform: 'youtube', handle: safeDecode(segs[1]) };
    return null;
  }

  // TikTok：/@<unique_id>（主页与作品页都以 @ 开头，作品页是 /@user/video/<id>）
  //
  // **只认带 @ 的一级路径**，不做保留字名单：TikTok 的功能页（/foryou /explore /live /tag/xxx
  // /music/xxx /tiktokstudio…）一律不带 @，靠这一个形态就能全部排掉。名单式排除反而会漏——
  // 平台随时会加新的功能路径，漏掉一个就在竞对库里建出一个名为 "explore" 的假账号。
  // 短链（vm./vt.tiktok.com、/t/<code>）离线解析不出用户名 → 返回 null 交给用户手填。
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const first = segs[0] || '';
    if (!first.startsWith('@')) return null;
    const name = safeDecode(first.slice(1));
    return name ? { platform: 'tiktok', handle: name } : null;
  }

  // X / Twitter：/<username>
  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
    const name = (segs[0] || '').replace(/^@/, '');
    return name && !X_RESERVED.has(name.toLowerCase()) ? { platform: 'x', handle: name } : null;
  }

  return null;
}
