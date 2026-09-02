import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ChunkErrorRecovery } from '@/components/ChunkErrorRecovery';
import { DesktopClientProbe } from '@/components/DesktopClientProbe';
import { generateKnowledgeGraphJsonLd } from '@/lib/geo/json-ld';

// 分享卡片的绝对地址基准。取值优先 BEACON_SITE_URL。
const siteUrl = process.env.BEACON_SITE_URL || process.env.BEACON_PUBLIC_URL || 'https://beacon.iyunci.cn';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: '烽火台 · 跨平台内容作战室 | 自媒体·融媒体·AI智能学习全网 SEO/GEO 深度优化系统',
    template: '%s | 烽火台 · 跨平台内容作战室',
  },
  description:
    '烽火台（Beacon）是面向自媒体创作者、融媒体中心与 MCN 运营团队的跨平台内容作战室与 GEO/SEO 智能系统：深度打通全网热榜聚合（微信/小红书/抖音/B站/知乎/X/YouTube）、竞对实时监控、AI智能学习人设记忆、12 视角 AI 选题智囊团、平台算法教练、分平台合规检测与一稿四态安全生成。',
  keywords: [
    '烽火台',
    '跨平台内容作战室',
    '自媒体',
    '自媒体运营',
    '自媒体爆款选题',
    '融媒体',
    '融媒体中心',
    '融媒体矩阵管理',
    '融媒体跨平台分发',
    'AI智能学习',
    'AI自主学习',
    'AI创作教练',
    'AI人设记忆系统',
    'GEO优化',
    'SEO优化',
    'AI搜索大模型优化',
    'DeepSeek SEO',
    'ChatGPT SEO',
    'Perplexity SEO',
    'Kimi SEO',
    '豆包AI搜索收录',
    '微信小微AI搜索',
    '全网热榜聚合',
    '跨平台竞对监控',
    '12视角AI选题智囊团',
    '平台算法教练',
    '分平台合规检测',
    '一稿四态改写',
    '品牌SoV声量监测',
    'JSON-LD结构化数据',
    'Schema.org知识图谱',
    '搜索引擎收录提升',
    '帮我直接分析这个里面的功能',
  ],
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
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: '烽火台', statusBarStyle: 'black-translucent' },
  openGraph: {
    title: '烽火台 · 跨平台内容作战室 | 自媒体·融媒体·AI智能学习深度 SEO & GEO 优化系统',
    description:
      '面向自媒体、融媒体团队与 MCN 机构的多平台选题创作 SaaS：全网热榜聚合 · 竞对监控 · AI智能学习与人设记忆 · 12视角智囊团选题 · 平台算法教练 · 分平台合规与大模型收录优化',
    url: siteUrl,
    siteName: '烽火台 Beacon',
    images: [{ url: `${siteUrl}/logo.png`, width: 1254, height: 1254, alt: '烽火台 Logo' }],
    locale: 'zh_CN',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: '烽火台 · 跨平台内容作战室',
    description:
      '面向自媒体与融媒体团队的多平台选题创作 SaaS：全网热榜聚合 · 竞对监控 · AI智能学习 · 智囊团选题 · 算法教练 · 分平台合规',
    images: [`${siteUrl}/logo.png`],
  },
  other: {
    baiduspider: 'index, follow',
    googlebot: 'index, follow',
    'applicable-device': 'pc,mobile',
  },
};

// 移动端视口 + 主题色（Next 15 要求 viewport 单独导出，不能塞进 metadata）。
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f1626',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const jsonLdGraph = generateKnowledgeGraphJsonLd(siteUrl);

  return (
    <html lang="zh-CN">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdGraph) }}
        />
      </head>
      <body>
        <ChunkErrorRecovery />
        <DesktopClientProbe />
        {children}
      </body>
    </html>
  );
}
