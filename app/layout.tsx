import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ChunkErrorRecovery } from '@/components/ChunkErrorRecovery';
import { DesktopClientProbe } from '@/components/DesktopClientProbe';

// 分享卡片的绝对地址基准。**不配等于把 og:image 指向 http://localhost:3000**——
// Next 在 metadataBase 缺席时就是这么回落的，生产上表现为「链接发到 X/微信没有封面图」，
// 而页面本身一切正常，所以本地怎么看都发现不了。判据只能是抓生产 HTML 里的 og:image。
// 取值优先 BEACON_SITE_URL（微信登录回跳、支付回调也都以它为准，保持单一真相源）。
const siteUrl = process.env.BEACON_SITE_URL || process.env.BEACON_PUBLIC_URL || 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: '烽火台 · 跨平台内容作战室',
  description: '面向创作者与内容团队的多平台选题创作 SaaS：热榜聚合 · 竞对监控 · 人设记忆 · 智囊团选题 · 算法教练 · 分平台合规',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: '烽火台', statusBarStyle: 'black-translucent' },
  openGraph: {
    title: '烽火台 · 跨平台内容作战室',
    description: '面向创作者与内容团队的多平台选题创作 SaaS：热榜聚合 · 竞对监控 · 人设记忆 · 智囊团选题 · 算法教练 · 分平台合规',
    images: [{ url: '/logo.png', width: 1254, height: 1254 }],
  },
};

// 移动端视口 + 主题色（Next 15 要求 viewport 单独导出，不能塞进 metadata）。
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f1626',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <ChunkErrorRecovery />
        <DesktopClientProbe />
        {children}
      </body>
    </html>
  );
}
