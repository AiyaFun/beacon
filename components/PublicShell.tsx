import Link from 'next/link';
import Image from 'next/image';
import { PRODUCT_NAME, SLOGAN } from '@/lib/brand';
import { getServerLang } from '@/lib/i18n/server';
import { edition } from '@/lib/edition';

// 游客（未登录）看到的轻量外壳（2026-09-05）：顶部一行导航 + 页脚资质。
//
// 两个地方用它：(public) 组的游客分支，以及 (app)/layout 对 `/` `/desktop` `/extension`
// 三页的游客放行。此前 (public)/layout 里内联了一份，只带 logo 和「登录 / 注册」——
// 现在公开面有五页，导航要能在它们之间走。
//
// 🔒 这里没有任何登录闸，也不读 session：它只回答「没登录的人看到什么壳」。
export async function PublicShell({ children }: { children: React.ReactNode }) {
  const lang = await getServerLang();
  const en = lang === 'en';
  const saas = edition() === 'saas';
  const nav = [
    { href: '/topics-today', label: en ? 'Today’s topics' : '今日选题榜' },
    { href: '/hotlists', label: en ? 'Trending' : '热榜' },
    { href: '/pricing', label: en ? 'Pricing' : '价格' },
    { href: '/desktop', label: en ? 'Desktop app' : '客户端' },
    { href: '/extension', label: en ? 'Extension' : '插件' },
  ];
  return (
    <div className="public-shell">
      <header className="public-header">
        <Link href="/" className="brand" style={{ textDecoration: 'none' }}>
          <Image src="/logo.png" alt={PRODUCT_NAME} width={34} height={34} className="brand-logo-img" />
          <div>
            <div className="brand-name">{PRODUCT_NAME}</div>
            <div className="brand-sub">{SLOGAN}</div>
          </div>
        </Link>
        <nav className="public-nav">
          {nav.map((n) => (
            <Link key={n.href} href={n.href}>{n.label}</Link>
          ))}
        </nav>
        <div className="row" style={{ gap: 8 }}>
          <Link href="/login" className="btn btn-sm">{en ? 'Log in' : '登录'}</Link>
          <Link href="/login" className="btn btn-primary btn-sm">{en ? 'Start free' : '免费开始'}</Link>
        </div>
      </header>
      <div className="public-content">{children}</div>
      <footer className="public-footer">
        <div className="public-footer-links">
          <Link href="/legal/privacy">{en ? 'Privacy' : '隐私政策'}</Link>
          <Link href="/legal/terms">{en ? 'Terms' : '服务条款'}</Link>
          <Link href="/legal/data-request">{en ? 'Data removal' : '数据移除申请'}</Link>
          <a href="https://github.com/AiyaFun/beacon" target="_blank" rel="noreferrer">GitHub · AGPL-3.0</a>
        </div>
        {/* 资质只在 SaaS 印：印在客户自建实例上等于拿我们的资质给别人背书（见 app/login/page.tsx） */}
        {saas ? (
          <div className="public-footer-line">
            <span>Copyright © 2013 - 2026 Yunci All Rights Reserved. 云磁数字 版权所有</span>
            <span>闽ICP备2020021857号-1</span>
            <span>闽公网安备 35010402351451 号</span>
            <span>增值电信业务经营许可证 闽B2-20230811</span>
          </div>
        ) : (
          <div className="public-footer-line"><span>烽火台</span></div>
        )}
      </footer>
    </div>
  );
}
