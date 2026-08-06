// 公众号文章导入 · 解析 wechat-article-exporter 的导出文件（纯函数，无 IO / 无 prisma）。
// 客户端（导入组件先解析再分批提交）与服务端（server action 二次校验）共用，故独立成模块。
//
// 通道定位（与 lib/adapters/rsshub.ts 同一档）：**只做「竞对发了什么」的内容监控，不做指标**。
// 公众号是烽火台唯一插件采不到的平台——PLUGIN_COLLECTABLE 里没有 wechat，因为公众号没有
// 公开网页主页，阅读/在看要微信登录态才可见。这条通道补的就是这个空白：标题/链接/发布时间
// 进选题库与标题矩阵，指标那一栏保持空白，等官方通道来填。
//
// 合规边界（2026-07-28 用户拍板，沿用既定的「不走灰色」红线）：
//   · 文章列表来自用户自己公众号后台的「查找文章」（工具扫码登录的是**用户自己的号**），
//     取到的是公开可见的图文元数据；导出在用户本地跑完，本模块只认文件、不发任何网络请求。
//   · **阅读量/在看/评论一律丢弃**（见 DROPPED_METRIC_KEYS）。exporter 要拿这些数，得让用户
//     抓包截取微信客户端的 key/uin/pass_ticket，那是灰色通道，与视频号 110 万判例同一性质。
//     自有号的阅读/完读率走官方第三方平台 getarticletotaldetail，不从这条路来。
//   · 顺带的安全收益：导出的 mp 链接里可能夹带抓包得来的 key/pass_ticket，normalizeArticleUrl
//     只保留寻址必需的参数，凭证不会跟着 URL 落库。

export type ParsedWechatPost = {
  platformItemId: string;
  title: string;
  summary?: string;
  url?: string;
  /** ISO 字符串——要过 server action 的序列化边界，不用 Date */
  publishedAt?: string;
};

export type WechatExportParseResult = {
  posts: ParsedWechatPost[];
  /** 从 _accountName / nickname 猜到的公众号名，仅用于导入前给用户核对归属 */
  accountName: string | null;
  /** 文件里的原始条目数 */
  total: number;
  /** 缺标题或定不出身份而丢弃的条目数 */
  skipped: number;
  /** 带阅读/点赞等字段、被有意忽略的条目数（用于在 UI 上明说「没导这些」） */
  droppedMetrics: number;
};

// 导出文件的根形状：exporter 各版本/各格式不一，数组和常见包裹键都认。
const LIST_KEYS = ['articles', 'data', 'list', 'items', 'posts', 'result'] as const;

// 有意丢弃的互动指标字段（exporter 的 ArticleMetadata 用驼峰，别的导出工具用下划线，都列上）
const DROPPED_METRIC_KEYS = [
  'readNum', 'read_num', 'likeNum', 'like_num', 'oldLikeNum', 'old_like_num',
  'shareNum', 'share_num', 'commentNum', 'comment_num',
] as const;

// mp 文章链接里唯一需要保留的参数——其余（scene/srcid/sharer_*/key/pass_ticket/uin…）
// 要么是埋点，要么是抓包得来的会话凭证，一律不落库。
const KEEP_URL_PARAMS = ['__biz', 'mid', 'idx', 'sn', 'chksm'];

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function pick(item: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const s = str(item[k]);
    if (s) return s;
  }
  return '';
}

// create_time 是秒级 unix 时间戳；也兼容毫秒与 '2026-07-28 10:00' 这类日期串。
// 微信图文不可能早于 2011 年（公众平台上线），早于该点的值当脏数据丢掉。
const WECHAT_EPOCH = Date.UTC(2011, 0, 1);

function toIso(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;
    return ms >= WECHAT_EPOCH && ms <= Date.now() + 86400_000 ? new Date(ms).toISOString() : undefined;
  }
  const s = str(v);
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return toIso(Number(s));
  const d = new Date(s);
  const ms = d.getTime();
  return Number.isNaN(ms) || ms < WECHAT_EPOCH ? undefined : d.toISOString();
}

// 链接归一：升 https、去 fragment、mp 域名只留寻址参数。超长（>500，ingest schema 上限）则放弃 URL
// 而不是截断——截断出来的链接点开是坏的，还不如没有。
export function normalizeArticleUrl(raw: unknown): string | undefined {
  const s = str(raw);
  if (!s) return undefined;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return undefined;
  }
  u.protocol = 'https:';
  u.hash = '';
  if (/(^|\.)mp\.weixin\.qq\.com$/i.test(u.hostname)) {
    // 逐段过滤**原始**查询串，而不是用 URLSearchParams 重建：后者按表单编码序列化，
    // 会把 `__biz=MzA5NDU5NTQwMA==` 的 `=` 转成 `%3D`。__biz 尾部的 `==` 是它的固有形态，
    // 改了形态就是在赌微信服务端一定会解码——同「小红书笔记链接丢 xsec_token 就打不开」那类坑，
    // 链接坏了要等用户点开才发现。原样保留最省事也最安全。
    const kept = u.search
      .replace(/^\?/, '')
      .split('&')
      .filter((kv) => kv && KEEP_URL_PARAMS.includes(kv.split('=')[0]));
    u.search = kept.length ? `?${kept.join('&')}` : '';
  }
  const out = u.toString();
  return out.length <= 500 ? out : undefined;
}

// platformItemId = `${appmsgid}_${itemidx}`（exporter 的 aid 就是这个形状，如 2247484123_1）。
//
// 为什么不用文章 URL 当主键：微信官方「内容分析」接口 getarticletotaldetail 的键是 msgid+index，
// msgid 即 appmsgid——将来接上官方通道，两条通道才能 upsert 到同一条记录（见
// docs/方案-微信授权与多平台官方数据回流.md）。URL 里还带 chksm 等易变参数，做主键会分裂成两条。
//
// 定不出身份就返回 null 让调用方丢弃：拿标题或序号凑一个 ID，会造出一条永远对不上任何文章的
// 记录（同一坑见 lib/adapters/competitor-real.ts 的视频 ID 校验）。
function itemId(item: Record<string, unknown>, url: string | undefined): string | null {
  const aid = pick(item, ['aid', 'article_id']);
  if (/^\d+_\d+$/.test(aid)) return aid;

  const appmsgid = pick(item, ['appmsgid', 'app_msg_id', 'msgid', 'mid']);
  const idx = pick(item, ['itemidx', 'idx', 'index']);
  if (/^\d+$/.test(appmsgid)) return `${appmsgid}_${/^\d+$/.test(idx) ? idx : '1'}`;

  if (url) {
    try {
      const q = new URL(url).searchParams;
      const mid = q.get('mid');
      if (mid && /^\d+$/.test(mid)) {
        const i = q.get('idx');
        return `${mid}_${i && /^\d+$/.test(i) ? i : '1'}`;
      }
      // 少数导出只剩 sn（分享链接形态）：sn 也唯一标识一篇，加前缀避免和 mid_idx 混淆
      const sn = q.get('sn');
      if (sn) return `sn_${sn}`;
    } catch {
      /* url 已归一过，理论上不会到这里 */
    }
  }
  return aid || null;
}

// 根节点 → 条目数组。接受：已解析的 JSON、JSON 文本、NDJSON 文本、常见包裹键。
function toItemList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;

  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    try {
      return toItemList(JSON.parse(text));
    } catch {
      // NDJSON（一行一条）兜底
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const out: unknown[] = [];
      for (const line of lines) {
        let v: unknown;
        try {
          v = JSON.parse(line);
        } catch {
          return []; // 有一行不是 JSON 就不是 NDJSON，别半解析出一堆残缺数据
        }
        // 一行可能是一条文章对象，也可能是一整个数组/包裹对象
        const nested = toItemList(v);
        if (nested.length > 0) out.push(...nested);
        else if (asRecord(v)) out.push(v);
      }
      return out;
    }
  }

  const obj = asRecord(raw);
  if (!obj) return [];
  for (const k of LIST_KEYS) {
    if (Array.isArray(obj[k])) return obj[k] as unknown[];
    // 再下一层（{data:{list:[...]}} 这种）
    const nested = asRecord(obj[k]);
    if (nested) {
      for (const k2 of LIST_KEYS) if (Array.isArray(nested[k2])) return nested[k2] as unknown[];
    }
  }
  return [];
}

export function parseWechatExport(raw: unknown): WechatExportParseResult {
  const items = toItemList(raw);
  const rootName = str(asRecord(raw)?.nickname) || str(asRecord(asRecord(raw)?.account)?.nickname);

  const posts: ParsedWechatPost[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let droppedMetrics = 0;
  let accountName = rootName || null;

  for (const it of items) {
    const item = asRecord(it);
    if (!item) {
      skipped++;
      continue;
    }
    if (!accountName) accountName = pick(item, ['_accountName', 'nickname', 'account_name']) || null;
    if (DROPPED_METRIC_KEYS.some((k) => typeof item[k] === 'number' || /^\d+$/.test(str(item[k])))) {
      droppedMetrics++;
    }

    const title = pick(item, ['title', 'Title', '标题']).slice(0, 300);
    const url = normalizeArticleUrl(item.link ?? item.url ?? item.content_url ?? item['链接']);
    const id = itemId(item, url);
    if (!title || !id) {
      skipped++;
      continue;
    }
    if (seen.has(id)) continue; // 同一篇在文件里出现多次（分页重叠）只留第一条
    seen.add(id);

    const summary = pick(item, ['digest', 'summary', 'desc', 'description', '摘要']).slice(0, 500);
    posts.push({
      platformItemId: id.slice(0, 128),
      title,
      ...(summary ? { summary } : {}),
      ...(url ? { url } : {}),
      ...(() => {
        const iso = toIso(item.create_time ?? item.createTime ?? item.publish_time ?? item.update_time ?? item.updateTime ?? item['发布时间']);
        return iso ? { publishedAt: iso } : {};
      })(),
    });
  }

  // 新的在前：分批导入时先入库的是最新几篇，中途失败也是「少了旧文章」而不是「少了新文章」
  posts.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));

  return { posts, accountName, total: items.length, skipped, droppedMetrics };
}
