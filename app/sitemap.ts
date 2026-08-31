import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { recordCrawlerHitAsync } from '@/lib/geo/crawler-log';

const SITE = process.env.BEACON_SITE_URL?.replace(/\/$/, '') || 'https://beacon.iyunci.cn';

// 只收公开可索引页：登录页 + 游客热榜演示页。
//
// 【为什么这里也记一笔】sitemap.xml 和 robots.txt 一样，是**只有爬虫会来读**的端点，
// 信号最干净：来读它的一定是在做收录，不是路过。
// 代价是这一页从静态变成按请求渲染——它只有两条 URL，那点开销可以忽略，
// 而换来的是「哪个爬虫在认真做索引」这个 robots.txt 回答不了的问题
//（很多爬虫读了 robots 就走，真去读 sitemap 的才是要收录你）。
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    const h = await headers();
    recordCrawlerHitAsync(h.get('user-agent'), '/sitemap.xml');
  } catch { /* 构建期预渲染拿不到请求头，不记，不影响 sitemap 本身 */ }

  return [
    { url: `${SITE}/hotlists`, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${SITE}/login`, changeFrequency: 'monthly', priority: 0.5 },
  ];
}
