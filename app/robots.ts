import type { MetadataRoute } from 'next';

// 只放行公开页（登录页 + 游客热榜演示页 + 法务页 + 插件下载页），其余业务页需登录、不该被索引。
//
// ⚠️ `/legal` 必须放行，别再收回去：Chrome 应用商店提交时要填隐私权政策网址，
// 它的检查器**遵守 robots.txt**——页面返回 200 也没用，被 Disallow 挡住就报「无法访问隐私权政策链接」，
// 提交直接卡住（2026-07-27 真机撞到）。法务页本来就该是公开可抓取的，不索引它没有任何好处。
// 同理放行 `/downloads`：插件安装包页要能被分享和抓取。
const SITE = process.env.BEACON_SITE_URL?.replace(/\/$/, '') || 'https://beacon.iyunci.cn';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/login', '/hotlists', '/legal', '/legal/', '/downloads'],
      disallow: '/',
    },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
