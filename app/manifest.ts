import type { MetadataRoute } from 'next';
import { SLOGAN, SUBLINE } from '@/lib/brand';

// PWA manifest（Next 15 App Router 约定文件，自动挂到 /manifest.webmanifest）。
// 目的：手机上「添加到主屏幕」后有独立图标与全屏启动，作为轻量移动场景的着陆点。
// 只声明现有静态资源（/logo.png），不引入新依赖、不改任何运行时行为。
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `烽火台 · ${SLOGAN}`,
    short_name: '烽火台',
    description: SUBLINE,
    // 主屏幕图标落到「今天」；长按图标给三条手机上最常做的事（2026-09-05 移动触点，最小一步）
    start_url: '/',
    shortcuts: [
      { name: '看今天的选题', short_name: '选题', url: '/topics', description: '今天该做什么，每条带理由' },
      { name: '存一个灵感', short_name: '灵感', url: '/inspiration', description: '刷到的东西随手存进灵感箱' },
      { name: '看昨天的数据', short_name: '数据', url: '/data', description: '发出去之后跑得怎么样' },
    ],
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
