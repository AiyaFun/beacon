import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
// 【用现成的谓词，别在这里再写一遍 kind === 'crawler'】
// 同一个判断散在两处，就是 UA 表「散落 4+ 处已矛盾」那条病灶的起点
import { realCrawlers, robotsTokens } from '@/lib/geo/ai-crawler';
import { PUBLIC_ALLOW } from '@/lib/geo/public-surface';
import { recordCrawlerHitAsync } from '@/lib/geo/crawler-log';

// 只放行公开页（登录页 + 游客热榜演示页 + 法务页 + 插件下载页），其余业务页需登录、不该被索引。
//
// ⚠️ `/legal` 必须放行，别再收回去：Chrome 应用商店提交时要填隐私权政策网址，
// 它的检查器**遵守 robots.txt**——页面返回 200 也没用，被 Disallow 挡住就报「无法访问隐私权政策链接」，
// 提交直接卡住（2026-07-27 真机撞到）。法务页本来就该是公开可抓取的，不索引它没有任何好处。
// 同理放行 `/downloads`：插件安装包页要能被分享和抓取。
//
// ── 2026-08-29：AI 爬虫要逐个具名表态，不能只有一条 `*` ──
//
// 【为什么 `*` 一条不够】GEO 上最要紧的操作是**区分三种用途**：拿去训练、建检索索引、
// 用户当场提问时实时取回。只有一条 `User-agent: *` 时，这三件事只能一起允许或一起拒绝，
// 而它们的代价完全不同——拦掉检索索引等于**从此不可能被引用**，那是这条路上最贵的误操作。
// 逐个具名之后，「允许被检索、但不允许拿去训练」这种表态才第一次成为可能。
//
// 【为什么现在全部具名放行】beacon 的公开面只有登录页/热榜/法务/下载页，
// 这几页本来就该被看见。**具名的价值不在于此刻拦了谁，而在于把这几个名字写进代码里**，
// 让「要不要拦」变成一个能讨论、能改一行就生效的决定，而不是一个没有位置可写的话题。
//
// 【RFC 9309：具名组不继承 `*` 组】爬虫只读**最匹配自己的那一组**，
// 写了 `User-agent: GPTBot` 就必须把 allow/disallow 在那一组里再写一遍——
// 只写名字不写规则等于给了它一个空组（= 不受任何限制）。
// 这个坑在 HeiGe-GEO-SEO 的 gen_robots 里出现过，别再犯第二次。
const SITE = process.env.BEACON_SITE_URL?.replace(/\/$/, '') || 'https://beacon.iyunci.cn';

// 【放行清单收在 lib/geo/public-surface.ts】robots.txt / sitemap.xml / llms.txt
// 现在是同一批路径的三个消费者，各写一份必然漂移，而漂移不会报错
const ALLOW = [...PUBLIC_ALLOW];

export default async function robots(): Promise<MetadataRoute.Robots> {
  // 【顺带记一笔谁来读了 robots.txt】守规矩的爬虫**一定**先读这一页，
  // 所以它是识别 AI 爬虫成本最低、信号最干净的一个点：一个文件、极低频、没有正文。
  // 不守规矩的爬虫不会来读——但它们也不会遵守下面这些规则，记不到它们不影响结论。
  // 绝不阻塞、绝不抛（见 lib/geo/crawler-log.ts）。
  try {
    const h = await headers();
    recordCrawlerHitAsync(h.get('user-agent'), '/robots.txt');
  } catch { /* 拿不到请求头（构建期预渲染）就不记，不影响 robots 本身 */ }

  return {
    rules: [
      { userAgent: '*', allow: ALLOW, disallow: '/' },
      // 逐个具名：规则与 `*` 组**一模一样**，但位置留出来了。
      // 将来要对某一个收紧，改这里一行即可，而不必先去发明一个放规则的地方。
      ...realCrawlers().map((a) => ({
        userAgent: a.token,
        allow: ALLOW,
        disallow: '/',
      })),
      // 策略令牌（Google-Extended / Applebot-Extended）：它们**不是爬虫**，
      // 只在 robots.txt 里表态「已经抓走的内容能不能拿去训练」。
      // 这里同样给出显式许可——写出来，是为了让「要不要禁止训练」成为一个能改的决定。
      ...robotsTokens().map((a) => ({
        userAgent: a.token,
        allow: ALLOW,
        disallow: '/',
      })),
    ],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
