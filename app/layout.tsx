import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ChunkErrorRecovery } from '@/components/ChunkErrorRecovery';
import { DesktopClientProbe } from '@/components/DesktopClientProbe';
import { generateKnowledgeGraphJsonLd } from '@/lib/geo/json-ld';
import { HOT_SOURCES } from '@/lib/constants';
import { SLOGAN, SUBLINE } from '@/lib/brand';

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
  keywords: [
    // 品牌与定位
    '烽火台',
    'Beacon',
    '烽火台Beacon',
    '跨平台内容作战室',
    '先知道做什么再谈怎么写',
    '创作者选题推荐引擎',
    '新媒体运营智能中枢',
    // 核心用户群与行业方案
    '自媒体',
    '自媒体运营',
    '自媒体爆款选题',
    '融媒体',
    '融媒体中心',
    '融媒体中心建设',
    '县级融媒体中心',
    '融媒体矩阵管理',
    '融媒体跨平台分发',
    'MCN机构内容运营',
    'MCN矩阵管理系统',
    '多账号矩阵分发',
    '自媒体团队协作',
    '个人IP打造与孵化',
    // 垂直平台运营与场景细分
    '抖音运营工具',
    '抖音爆款选题',
    '抖音短视频脚本',
    '小红书运营工具',
    '小红书爆款文案',
    '小红书笔记灵感',
    '小红书违禁词检测',
    '微信公众号排版',
    '公众号爆款选题',
    '公众号深度长文',
    '微信视频号运营',
    'B站UP主创作工具',
    'B站视频脚本',
    '知乎高赞回答',
    '快手短视频选题',
    // 选题来源与热点监控
    '全网热榜聚合',
    `${HOT_SOURCES.length}大平台实时热榜`,
    '跨平台竞对监控',
    '8大选题推荐来源',
    '抢跑流量窗口',
    '30天流量节点日历',
    '常青选题库',
    '爆款标题生成器',
    '短视频黄金前3秒',
    '爆款完播率提升',
    '读者痛点提问挖掘',
    '旧文翻新策略',
    // AI创作中枢与智能体
    '12视角AI选题智囊团',
    'AI创作教练',
    'AI人设记忆系统',
    'AI智能学习',
    'AI自主学习',
    '一稿四态改写',
    'AI写爆款文案',
    'AI自媒体助手',
    'AI短视频分镜脚本',
    'AI语言风格自适应',
    // 平台算法与风控教练
    '平台算法教练',
    '分平台合规检测',
    '自媒体合规风控',
    '小红书限流词检测',
    '违规敏感词过滤',
    '广告法极限词检测',
    '平台推荐算法拆解',
    // 全网搜索引擎与 AI 大模型 GEO 优化
    'GEO优化',
    '生成式引擎优化',
    'SEO优化',
    '深度SEO优化',
    '提升AI大模型引用率',
    'AI搜索引擎收录',
    'RAG大模型检索优化',
    '品牌SoV声量监测',
    '被引用率分析',
    'AI搜索大模型优化',
    'DeepSeek SEO',
    'DeepSeek收录优化',
    'ChatGPT SEO',
    'ChatGPT搜索收录',
    'Perplexity SEO',
    'Perplexity检索卡片',
    'Kimi SEO',
    'Kimi内容提取',
    '豆包AI搜索收录',
    '微信小微AI搜索',
    '微信搜一搜收录',
    '夸克AI搜索',
    '百度双Agent优化',
    '元宝AI搜索收录',
    '腾讯混元收录优化',
    '智谱清言收录优化',
    '谷歌AI Overviews收录',
    'Bing Copilot优化',
    'JSON-LD结构化数据',
    'Schema.org知识图谱',
    '语义SEO',
    '实体SEO',
    '搜索引擎收录提升',
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
