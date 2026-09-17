import { PUBLIC_PAGES, allowedByRobots } from './public-surface';

// 主动推送：不等爬虫自己发现，把变了的 URL 推给引擎（2026-09-17）。
//
// ── 为什么这件事值得做 ──
// 一个新站被自然发现要几天到几周。robots/sitemap 只是**摆在那里等人来读**；
// 主动推送是反过来敲门。对「快速收录」这个目标，这是代码侧能做的最直接的一件事。
//
// ── 必须说破它做不到什么 ──
// 推送只影响**收录速度**，不影响排名。没有任何一家引擎承诺「推了就收、收了就靠前」。
// 推了之后页面照样可能不被收录——因为内容本身不够（见下面那条）。
// 把推送当成排名手段，是这类工具最常见的误用。
//
// ⚠️ 真正的天花板在别处：这个站公开可抓的只有 llms.txt 里列的那十来个页面，
//    其中只有 /hotlists 和 /topics-today 有真内容。**没有内容就没有排名**，
//    推送再勤也改不了这一条。这件事必须让人知道，而不是用绿色的推送日志掩盖过去。

/** IndexNow 的 key。没配就是没启用——调用方要按「没启用」处理，不许拿空串去推。 */
export function indexNowKey(): string | undefined {
  const k = process.env.BEACON_INDEXNOW_KEY?.trim();
  return k || undefined;
}

function site(): string {
  return (process.env.BEACON_SITE_URL || process.env.BEACON_PUBLIC_URL || 'https://beacon.iyunci.cn').replace(/\/$/, '');
}

/**
 * 该推哪些 URL。
 *
 * 【判据是 robots 放行】推一个自己 Disallow 掉的 URL 是自相矛盾的：
 * 引擎收到提交后会先读 robots.txt，发现不许抓，于是什么都不会发生——
 * 而推送接口仍然回 200，日志上看是成功的。这类「绿色的失败」是这个项目反复栽的形状。
 */
export function submittableUrls(): string[] {
  const base = site();
  return PUBLIC_PAGES.filter((p) => allowedByRobots(p.path)).map((p) => `${base}${p.path}`);
}

export type PushResult = {
  channel: 'indexnow' | 'baidu';
  ok: boolean;
  /** 说人话的结论。失败时必须写清**为什么**，不许只有一个状态码。 */
  detail: string;
  submitted: number;
};

/**
 * IndexNow（Bing / Yandex / Naver / Seznam 共用一个端点）。
 *
 * 【keyLocation 为什么一定要带】协议默认去 `https://host/{key}.txt` 找密钥，
 * 而我们把它放在固定的 /indexnow-key.txt（见那个路由顶部的说明）。
 * 不带 keyLocation，引擎会去一个不存在的地址找 key，比对失败 → 静默不抓。
 */
export async function pushIndexNow(urls: string[]): Promise<PushResult> {
  const key = indexNowKey();
  if (!key) {
    return { channel: 'indexnow', ok: false, submitted: 0, detail: 'BEACON_INDEXNOW_KEY 没配置，跳过（不是失败，是没启用）' };
  }
  if (urls.length === 0) {
    return { channel: 'indexnow', ok: false, submitted: 0, detail: '没有可提交的 URL' };
  }

  const host = new URL(site()).host;
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key, keyLocation: `${site()}/indexnow-key.txt`, urlList: urls }),
  });

  // 200 = 收下了；202 = 收下了但 key 还在验证中（首次推送常见，不是错误）
  const ok = res.status === 200 || res.status === 202;
  const hint = res.status === 403
    ? '403 = key 校验没过：确认线上 /indexnow-key.txt 能打开且内容就是这串 key'
    : res.status === 422
      ? '422 = URL 与 host 对不上，或这批 URL 不属于这个域名'
      : '';
  return {
    channel: 'indexnow',
    ok,
    submitted: ok ? urls.length : 0,
    detail: `HTTP ${res.status}${res.status === 202 ? '（已收下，key 验证中）' : ''}${hint ? ' —— ' + hint : ''}`,
  };
}

/**
 * 百度普通收录 API。
 *
 * 【token 从哪来】百度资源平台 →「普通收录 → API 提交」。拿 token 的前提是**站点已验证归属**
 *（见 lib/geo/verification.ts）——这就是为什么验证插槽是这条链路的第一步而不是可选项。
 *
 * 【配额】每天有上限（新站通常每天几十条）。这个站公开页只有十来个，天然不会撞上；
 * 但把它接进定时任务、每小时推一次全量，就会在几天后开始静默被拒。所以这里不自动定时——
 * 由 `npm run seo:push` 在部署后手动跑一次。
 */
export async function pushBaidu(urls: string[]): Promise<PushResult> {
  const token = process.env.BEACON_BAIDU_PUSH_TOKEN?.trim();
  if (!token) {
    return { channel: 'baidu', ok: false, submitted: 0, detail: 'BEACON_BAIDU_PUSH_TOKEN 没配置，跳过（不是失败，是没启用）' };
  }
  if (urls.length === 0) {
    return { channel: 'baidu', ok: false, submitted: 0, detail: '没有可提交的 URL' };
  }

  const endpoint = `http://data.zz.baidu.com/urls?site=${encodeURIComponent(site())}&token=${encodeURIComponent(token)}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: urls.join('\n'),
  });
  const text = await res.text();

  // 成功：{"remain":4999,"success":3}；失败：{"error":401,"message":"token is not valid"}
  let parsed: { success?: number; remain?: number; error?: number; message?: string } = {};
  try { parsed = JSON.parse(text) as typeof parsed; } catch { /* 非 JSON 原样带出去 */ }

  if (typeof parsed.success === 'number') {
    return {
      channel: 'baidu',
      ok: true,
      submitted: parsed.success,
      detail: `收下 ${parsed.success} 条，今日剩余配额 ${parsed.remain ?? '未知'}`,
    };
  }
  return {
    channel: 'baidu',
    ok: false,
    submitted: 0,
    detail: `HTTP ${res.status} ${parsed.error ? `error=${parsed.error} ` : ''}${parsed.message ?? text.slice(0, 200)}`,
  };
}
