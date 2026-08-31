import { headers } from 'next/headers';
import { recordCrawlerHitAsync } from '@/lib/geo/crawler-log';
import { buildLlmsTxt } from '@/lib/geo/llms-txt';

// `/llms.txt` —— 给大模型看的站点说明（GEOFlow 那边有，我们没有，直接学过来）。
//
// ── 它是什么 ──
// robots.txt 说「你**可不可以**读」，sitemap.xml 说「有**哪些**页」，
// llms.txt 说「这个站是干什么的、**哪几页值得读**」。
// 前两个是给爬虫的机器指令，这一个是给**模型**的一段人话——
// 提案的出发点是：模型抓一个站时最缺的不是链接列表，是「先告诉我你是谁」。
//
// ── 说破一件事：它到底有没有用，没人知道 ──
// llms.txt 是 2024 年的社区提案，**没有任何一家引擎公开承诺会读它**。
// 所以照着规范发一份，本身是一次没有回报保证的投入。
// 我们仍然发，理由是它极便宜（一个静态路由）；但**同时把它接进 AI 爬虫计数**——
// 于是「有没有引擎真的来读 /llms.txt」这个问题，几个月后我们能用自己的数据回答，
// 而不是继续引用别人的猜测。这比单纯照着规范抄一份有价值得多。
//
// ⚠️ 这里**只写公开页**。业务页要登录，把它们列进来既没用（模型打不开）
// 又等于对外公布内部路由结构。
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const h = await headers();
    recordCrawlerHitAsync(h.get('user-agent'), '/llms.txt');
  } catch { /* 拿不到请求头就不记，绝不影响这个文件本身 */ }

  return new Response(buildLlmsTxt(), {
    headers: {
      // text/plain：规范就是一份 Markdown 文本文件，不是网页
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
