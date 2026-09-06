import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { allowedByRobots, PUBLIC_PAGES } from '@/lib/geo/public-surface';
import { GUEST_READABLE_APP_PATHS, PATHNAME_HEADER } from '@/lib/auth-constants';
import { safeNextPath } from '@/lib/auth/safe-next';

// 公开面（2026-09-05 增长缺口整改）：陌生人看首页、下载页、价格页不该先填手机号。
// 这一组守的是「放行了、且只放行了这几页」——公开首页不等于全站敞开。

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const req = (path: string) => new NextRequest(new URL(path, 'https://beacon.example.com'));

describe('中间件：五个公开页 + 上报接口不跳登录', () => {
  it.each(['/', '/desktop', '/extension', '/pricing', '/topics-today', '/api/track'])('%s 放行', (p) => {
    const res = middleware(req(p));
    expect(res.headers.get('location'), `${p} 被跳到了登录页`).toBeNull();
  });

  it('🔒 放行根路径不等于放行一切：/studio /topics /billing 仍跳登录', () => {
    for (const p of ['/studio', '/topics', '/billing', '/settings/keys', '/ops']) {
      expect(middleware(req(p)).headers.get('location'), `${p} 该跳登录`).toContain('/login');
    }
  });

  it('🔒 路径头由中间件写入（客户端伪造无效）', () => {
    const r = new NextRequest(new URL('/desktop', 'https://beacon.example.com'), { headers: { [PATHNAME_HEADER]: '/' } });
    const res = middleware(r);
    // NextResponse.next({ request }) 把改写后的请求头挂在 x-middleware-request-* 上
    expect(res.headers.get(`x-middleware-request-${PATHNAME_HEADER}`)).toBe('/desktop');
  });
});

describe('(app)/layout：只对三页放行游客，且只在 SaaS', () => {
  const layout = code('app/(app)/layout.tsx');
  it('用的是常量清单，不是散写的字符串', () => {
    expect(layout).toContain('GUEST_READABLE_APP_PATHS.includes(p)');
    expect(GUEST_READABLE_APP_PATHS).toEqual(['/', '/desktop', '/extension']);
  });
  it('🔒 形态闸在：整机/私有化没有对外营销面', () => {
    expect(layout).toMatch(/edition\(\) === 'saas' && GUEST_READABLE_APP_PATHS/);
  });
  it('游客拿到的是 PublicShell，登录用户仍是 TenantShell', () => {
    expect(layout).toContain('<PublicShell>');
    expect(layout).toContain('<TenantShell');
    // 放行之外仍然跳登录——这条是 choke point 的本体
    expect(layout).toMatch(/redirect\('\/login'\)/);
  });
  it('三页都真的用 getSessionOrNull（用 getSession() 的页在游客那里会抛）', () => {
    for (const f of ['app/(app)/page.tsx', 'app/(app)/desktop/page.tsx', 'app/(app)/extension/page.tsx']) {
      expect(code(f), `${f} 没用 getSessionOrNull`).toContain('getSessionOrNull');
    }
  });
  it('首页：游客渲染 Landing，且落地页在派活框之前分支（不影响登录用户的 chat-first）', () => {
    const home = code('app/(app)/page.tsx');
    expect(home).toContain('return <Landing />');
    expect(home.indexOf('return <Landing />')).toBeLessThan(home.indexOf('<TaskDeckHome'));
  });
});

describe('robots / sitemap / llms.txt 三处同源', () => {
  it('首页只放行自己（/$），不把全站放开', () => {
    expect(allowedByRobots('/')).toBe(true);
    expect(allowedByRobots('/studio')).toBe(false);
    expect(allowedByRobots('/topics')).toBe(false);
  });
  it('新公开页都在放行清单里且 llms.txt 有说明', () => {
    for (const p of ['/pricing', '/desktop', '/extension', '/topics-today']) {
      expect(allowedByRobots(p), `${p} 没被 robots 放行`).toBe(true);
      expect(PUBLIC_PAGES.some((x) => x.path === p), `${p} 不在 llms.txt 清单`).toBe(true);
    }
  });
  it('sitemap 递交的是页面不是静态目录', () => {
    const sm = read('app/sitemap.ts');
    expect(sm).not.toContain('`${SITE}/downloads`');
    for (const p of ['/desktop', '/extension', '/pricing', '/topics-today']) expect(sm).toContain('`${SITE}' + p + '`');
  });
});

describe('safeNextPath：只认站内相对路径', () => {
  it('合法', () => {
    expect(safeNextPath('/topics')).toBe('/topics');
    expect(safeNextPath('/data?tab=genes')).toBe('/data?tab=genes');
  });
  it('🔒 非法一律 null', () => {
    for (const bad of ['//evil.com', 'https://evil.com', '/javascript:alert(1)', '/login', '/login?x=1', '/api/track', '', null, undefined, '/a b', '/x\\y']) {
      expect(safeNextPath(bad), `${String(bad)} 该被拒`).toBeNull();
    }
  });
});

describe('定位统一：一句话来自 lib/brand.ts', () => {
  it('登录轮播、总览、根布局、首页都引用 SLOGAN，且不再出现「毫秒级」', () => {
    for (const f of ['app/login/PromoCarousel.tsx', 'app/layout.tsx', 'components/landing/Landing.tsx']) {
      expect(code(f), `${f} 没引用 lib/brand`).toContain("from '@/lib/brand'");
    }
    expect(code('app/login/PromoCarousel.tsx')).not.toContain('毫秒级');
    expect(code('app/(public)/overview/OverviewView.tsx')).toContain('先知道做什么，再谈怎么写');
  });
  it('桌面版下载页第一句不再是「装不装都不影响使用」', () => {
    const v = code('app/(app)/desktop/DesktopView.tsx');
    expect(v).not.toContain('功能一模一样，装不装都不影响使用');
    expect(v).toContain('syncTitle');
    expect(v.indexOf('t.syncTitle')).toBeLessThan(v.indexOf('t.downloadTitle'));
  });
});
