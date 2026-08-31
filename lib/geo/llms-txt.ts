// 生成 `/llms.txt`（2026-08-29，学自 GEOFlow）。
//
// ── 三个文件的分工，别混 ──
//   robots.txt   给爬虫的**许可**：你可不可以读（机器指令，有 RFC）
//   sitemap.xml  给爬虫的**清单**：有哪些页（机器格式，有标准）
//   llms.txt     给模型的**说明**：这个站是干什么的、哪几页值得读（人话，社区提案）
//
// ── 必须说破：它有没有用，目前没有定论 ──
// llms.txt 是 2024 年的社区提案，**没有任何一家引擎公开承诺会读它**。
// 所以这份东西是一次没有回报保证的投入。我们仍然发，因为它极便宜；
// 但同时把 `/llms.txt` 接进 AI 爬虫计数——几个月后，「到底有没有引擎来读它」
// 这个问题我们能用**自己的数据**回答。
// 这条纪律和这个项目别处一样：宁可承认不知道，也不拿别人的猜测当结论。
//
// ── 只写公开页 ──
// 业务页要登录，列进来既没用（模型打不开）又等于对外公布内部路由结构。
// 页面清单与 robots 的放行清单都收在 lib/geo/public-surface.ts —— 三个文件同源，
// 各写一份必然漂移成「robots 说能读的页，llms.txt 里没有」，而漂移不会报错。

import { PUBLIC_PAGES, allowedByRobots } from './public-surface';

/** 站点根地址。与 robots.ts / sitemap.ts 同一个来源。 */
function site(): string {
  return process.env.BEACON_SITE_URL?.replace(/\/$/, '') || 'https://beacon.iyunci.cn';
}


/**
 * 一句话说清这个站是什么。
 *
 * 【为什么这段比链接列表重要】模型抓一个站时最缺的不是链接，是「先告诉我你是谁」。
 * 写得含糊（「领先的一站式智能平台」）等于什么都没说，而那正是 llms.txt 最常见的写法。
 */
const SUMMARY = [
  '烽火台是给内容创作者用的跨平台内容运营系统：把全网热榜与竞对数据汇到一处，',
  '据此生成选题、成稿、做合规检查，再分发到抖音、小红书、微信公众号、B站等平台，',
  '并把发布后的表现数据回流用于复盘。',
].join('');

/** 只在网站上真实成立的事实写进来。写不出证据的一律不写。 */
const FACTS: readonly string[] = [
  '公开可读的部分只有热榜页与法务页；其余功能需要登录。',
  '采集遵守目标站点的 robots.txt，并使用标识自身身份的 User-Agent（BeaconBot）。',
  '被监控账号的作者可通过 /legal/data-request 要求移除其数据。',
];

/**
 * 生成 llms.txt 正文。
 *
 * 格式按社区提案：H1 站名 → 引用块一句话简介 → 若干 H2 分节，每节是链接列表，
 * 每条 `- [标题](链接): 说明`。**保持朴素**——它是给模型读的，不是给人看的落地页。
 */
export function buildLlmsTxt(): string {
  const base = site();
  const lines: string[] = [];
  lines.push('# 烽火台（Beacon）');
  lines.push('');
  lines.push(`> ${SUMMARY}`);
  lines.push('');
  lines.push('## 公开页面');
  lines.push('');
  // 【运行时也过一遍，不只在测试里】守卫能拦住「新加的页忘了在 robots 放行」，
  // 但守卫只在 CI 跑。这里再过一道：万一漏了，产出的是**少一行**，
  // 而不是把一个我们自己声明不许抓的页面推荐给模型去读——后者是自相矛盾。
  for (const p of PUBLIC_PAGES) {
    if (!allowedByRobots(p.path)) continue;
    lines.push(`- [${p.title}](${base}${p.path}): ${p.desc}`);
  }
  lines.push('');
  lines.push('## 需要知道的事实');
  lines.push('');
  for (const f of FACTS) lines.push(`- ${f}`);
  lines.push('');
  lines.push('## 抓取说明');
  lines.push('');
  lines.push(`- 抓取许可以 ${base}/robots.txt 为准（其中对各家 AI 爬虫逐个具名表态）。`);
  lines.push(`- 页面清单见 ${base}/sitemap.xml。`);
  lines.push('- 登录后的业务页不对外开放，请勿尝试抓取。');
  lines.push('');
  return lines.join('\n');
}
