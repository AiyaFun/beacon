import { headers } from 'next/headers';
import { recordCrawlerHitAsync } from '@/lib/geo/crawler-log';
import { indexNowKey } from '@/lib/geo/submit';

// `/indexnow-key.txt` —— IndexNow 协议的密钥文件。
//
// ── 它为什么必须存在 ──
// IndexNow 是「网站主动告诉搜索引擎：这几个 URL 变了，来抓」的协议（Bing、Yandex 支持，
// Naver/Seznam 也接）。为了防止任何人都能替别人的站提交 URL，协议要求：
// 提交时带一个 key，同时这个 key 必须能在**你自己的域名下**被取到。
// 引擎收到提交后会来读这个文件，比对一致才认。
//
// 换句话说：**没有这一页，推送一定失败**，而失败是静默的（引擎只是不来抓）。
//
// ── 为什么放在固定路径而不是 `/{key}.txt` ──
// 协议默认找 `https://host/{key}.txt`，但允许在提交时用 `keyLocation` 指定任意 URL。
// 用固定路径换来的是：不必为此加一条会吞掉所有根级 .txt 的动态路由
//（那种路由会把 /robots.txt /llms.txt 一起接管，是个比它解决的问题更大的麻烦）。
// 提交侧在 lib/geo/submit.ts 里如实带上 keyLocation。
//
// ⚠️ 没配 key 就 404。输出一个空文件会让引擎认为「key 是空串」→ 比对失败，
//    而你会在推送日志里看到 200、以为一切正常。
export const dynamic = 'force-dynamic';

export async function GET() {
  const key = indexNowKey();
  if (!key) {
    return new Response('IndexNow 未启用：BEACON_INDEXNOW_KEY 没有配置。\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  try {
    const h = await headers();
    recordCrawlerHitAsync(h.get('user-agent'), '/indexnow-key.txt');
  } catch { /* 拿不到请求头就不记，绝不影响这个文件本身 */ }

  // 协议要求：正文就是 key 本身，没有别的东西。
  return new Response(key, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
