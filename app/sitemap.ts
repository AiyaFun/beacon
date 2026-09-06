import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { recordCrawlerHitAsync } from '@/lib/geo/crawler-log';

const SITE = process.env.BEACON_SITE_URL?.replace(/\/$/, '') || 'https://beacon.iyunci.cn';

/**
 * 烽火台动态与静态 Sitemap 生成器。
 * 包含所有公开可检索与索引的入口页面。
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    const h = await headers();
    recordCrawlerHitAsync(h.get('user-agent'), '/sitemap.xml');
  } catch {
    /* 构建期预渲染拿不到请求头，不记，不影响 sitemap 本身 */
  }

  const now = new Date();

  return [
    { url: `${SITE}`, lastModified: now, changeFrequency: 'daily', priority: 1.0 },
    { url: `${SITE}/topics-today`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${SITE}/hotlists`, lastModified: now, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${SITE}/pricing`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    // 下载入口是**页面**（/desktop、/extension），不是 /downloads 那个静态文件目录——
    // 此前 sitemap 递交的是一个没有网页的路径，搜索引擎抓到的是目录或 404。
    { url: `${SITE}/desktop`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${SITE}/extension`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${SITE}/login`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${SITE}/legal/privacy`, lastModified: now, changeFrequency: 'monthly', priority: 0.3 },
    { url: `${SITE}/legal/terms`, lastModified: now, changeFrequency: 'monthly', priority: 0.3 },
    { url: `${SITE}/legal/data-request`, lastModified: now, changeFrequency: 'monthly', priority: 0.3 },
  ];
}
