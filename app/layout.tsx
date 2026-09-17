import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ChunkErrorRecovery } from '@/components/ChunkErrorRecovery';
import { DesktopClientProbe } from '@/components/DesktopClientProbe';
import { generateKnowledgeGraphJsonLd } from '@/lib/geo/json-ld';
import { SLOGAN, SUBLINE } from '@/lib/brand';
import { SITE_KEYWORDS } from '@/lib/geo/keywords';
import { siteVerification } from '@/lib/geo/verification';

// 分享卡片的绝对地址基准。取值优先 BEACON_SITE_URL。
const siteUrl = process.env.BEACON_SITE_URL || process.env.BEACON_PUBLIC_URL || 'https://beacon.iyunci.cn';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  // 一句话定位收在 lib/brand.ts（2026-09-05）：首页、登录页、总览页、商店描述用的都是同一句
  title: {
    default: `烽火台 · ${SLOGAN} | 跨平台内容作战室`,
    template: '%s | 烽火台 · 跨平台内容作战室',
  },
  description: `${SUBLINE} 八条选题来源，只有两条看热榜；每条推荐都带「为什么是你、为什么是现在」。热榜聚合 · 竞对监控 · 人设记忆 · 12 视角智囊团 · 分平台合规 · 一键发布 · 数据回流。`,
  // 关键词清单收在 lib/geo/keywords.ts —— 网页 <meta keywords> 与 JSON-LD 知识图谱
  // 此前各写一份，七成重合、两次手写，加词只加一处的漂移**不会报错**。
  keywords: [...SITE_KEYWORDS],
  authors: [{ name: '烽火台团队', url: siteUrl }],
  publisher: '烽火台科技',
  alternates: {
    canonical: siteUrl,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  // 站长平台归属验证（百度/Bing/Google/头条/搜狗/360/神马）。全部读 env，没配就一个标签都不输出。
  // 这是「能不能提交收录」的前置条件，不是锦上添花：验不了站就拿不到主动推送的 token。
  verification: siteVerification(),
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: '烽火台', statusBarStyle: 'black-translucent' },
  openGraph: {
    title: `烽火台 · ${SLOGAN}`,
    description: SUBLINE,
    url: siteUrl,
    siteName: '烽火台 Beacon',
    // 分享卡片用产品截图（1200×630），不再是一张 logo
    images: [{ url: `${siteUrl}/og.png`, width: 1200, height: 630, alt: '烽火台 · 选题引擎：每条推荐都带为什么是你、为什么是现在' }],
    locale: 'zh_CN',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: `烽火台 · ${SLOGAN}`,
    description: SUBLINE,
    images: [`${siteUrl}/og.png`],
  },
  other: {
    baiduspider: 'index, follow, max-snippet:-1, max-image-preview:large',
    googlebot: 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1',
    bingbot: 'index, follow, max-snippet:-1, max-image-preview:large',
    bytespider: 'index, follow',
    '360Spider': 'index, follow',
    sogouspider: 'index, follow',
    'applicable-device': 'pc,mobile',
    renderer: 'webkit',
    'force-rendering': 'webkit',
    'format-detection': 'telephone=no',
  },
};

// 移动端视口 + 主题色（Next 15 要求 viewport 单独导出，不能塞进 metadata）。
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f1626',
};

import { I18nProvider } from '@/lib/i18n';
import { getServerLang } from '@/lib/i18n/server';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [initialLang, jsonLdGraph] = await Promise.all([
    getServerLang(),
    Promise.resolve(generateKnowledgeGraphJsonLd(siteUrl)),
  ]);

  return (
    <html lang={initialLang === 'en' ? 'en' : 'zh-CN'}>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdGraph) }}
        />
      </head>
      <body>
        <I18nProvider initialLang={initialLang}>
          <ChunkErrorRecovery />
          <DesktopClientProbe />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
