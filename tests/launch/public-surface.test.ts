import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

// 「公开面」回归守卫：这两条都是**本地怎么点都发现不了、只在生产暴露**的缺陷，
// 各自都真实发生过一次：
//   ① og:image 指向 http://localhost:3000/logo.png（metadataBase 缺席时 Next 的默认回落）
//      → 链接分享到 X/微信没有封面图，而站点本身一切正常。
//   ② /manifest.webmanifest 被登录闸拦成 307 → 浏览器在登录页拿到一份 HTML 当清单，
//      「添加到主屏幕」整个消失。
// 判据刻意取「未登录请求」与「源码里的配置」，不依赖跑起来的服务。

function req(path: string): NextRequest {
  return new NextRequest(new URL(path, 'https://beacon.example.com'));
}

describe('未登录可达的公开路径', () => {
  it('PWA 清单不被登录闸拦截', () => {
    const res = middleware(req('/manifest.webmanifest'));
    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('法务页与安装包同样公开可达（商店审核抓取要用）', () => {
    for (const p of ['/legal/privacy', '/legal/data-request', '/downloads/beacon-collector-latest.zip', '/robots.txt']) {
      const res = middleware(req(p));
      expect(res.headers.get('location'), `${p} 不该被跳转`).toBeNull();
    }
  });

  it('技能市场的目录免登可读——整机版取它时按定义没有本站会话', () => {
    // 这条是真机验证抓出来的：目录放进 public/ 就以为能访问了，
    // 结果中间件把它 307 到了登录页。而取目录的客户端里有一类是整机版：
    // 客户那台机器连的是自己的服务端、目录指向官网，它没有本站的 cookie。
    // 拦了就等于市场只对已登录用户存在，整机版装完永远是个离线快照。
    for (const p of ['/market/index.json', '/market/packs/x.json']) {
      const res = middleware(req(p));
      expect(res.headers.get('location'), `${p} 不该被跳转`).toBeNull();
    }
  });

  it('受保护页面仍然跳登录（放行不等于全站敞开）', () => {
    const res = middleware(req('/studio'));
    expect(res.headers.get('location')).toContain('/login');
  });
});

describe('分享卡片的绝对地址基准', () => {
  const layout = readFileSync(join(process.cwd(), 'app', 'layout.tsx'), 'utf8');

  it('metadata 配了 metadataBase', () => {
    expect(layout).toContain('metadataBase');
  });

  it('基准取自 BEACON_SITE_URL 而不是写死域名', () => {
    // 写死域名的话，换域名/开预发环境时 og 图会指向错的站，且没人会发现。
    expect(layout).toContain('BEACON_SITE_URL');
  });
});
