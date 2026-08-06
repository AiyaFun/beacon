import type { MetadataRoute } from 'next';

const SITE = process.env.BEACON_SITE_URL?.replace(/\/$/, '') || 'https://beacon.iyunci.cn';

// 只收公开可索引页：登录页 + 游客热榜演示页。
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE}/hotlists`, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${SITE}/login`, changeFrequency: 'monthly', priority: 0.5 },
  ];
}
