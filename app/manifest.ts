import type { MetadataRoute } from 'next';

// PWA manifest（Next 15 App Router 约定文件，自动挂到 /manifest.webmanifest）。
// 目的：手机上「添加到主屏幕」后有独立图标与全屏启动，作为轻量移动场景的着陆点。
// 只声明现有静态资源（/logo.png），不引入新依赖、不改任何运行时行为。
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '烽火台 · 跨平台内容作战室',
    short_name: '烽火台',
    description:
      '面向创作者与内容团队的多平台选题创作 SaaS：热榜聚合 · 竞对监控 · 人设记忆 · 智囊团选题 · 算法教练 · 分平台合规',
    start_url: '/',
    display: 'standalone',
    background_color: '#0f1626',
    theme_color: '#0f1626',
    lang: 'zh-CN',
    icons: [
      { src: '/logo.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/logo.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
