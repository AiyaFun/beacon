'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui';
import { HubHeader } from '@/components/HubHeader';
import { Icon } from '@/components/icons';
import type { DesktopBuild, DesktopManifest, ApplianceManifest, DesktopOs } from '@/lib/downloads';
import { ApplianceUpdateCard } from './ApplianceUpdateCard';

export type Lang = 'zh' | 'en';

const DESKTOP_OS_LABEL: Record<DesktopOs, string> = { mac: 'macOS', win: 'Windows' };

const BrandIcon = {
  mac: ({ size = 20, className = '' }: { size?: number; className?: string }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.84c.65-.79 1.09-1.89.97-3-.99.04-2.18.66-2.88 1.48-.61.71-1.14 1.83-1 2.92 1.1.08 2.22-.57 2.91-1.4z" />
    </svg>
  ),
  win: ({ size = 20, className = '' }: { size?: number; className?: string }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M3 5.479l7.377-1.016v7.127H3V5.48zm0 13.042l7.377 1.017v-7.04H3v6.023zm8.188 1.13L21 21V11.59h-9.812v8.061zm0-15.304v7.243H21V3l-9.812 1.347z" />
    </svg>
  ),
  window: ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="2" y1="7" x2="22" y2="7" />
      <line x1="6" y1="21" x2="18" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  tray: ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <path d="M7 10h10" />
      <path d="M12 10v5m0 0l-2.5-2.5m2.5 2.5l2.5-2.5" />
    </svg>
  ),
  bolt: ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  ),
  storage: ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  sync: ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 21h5v-5" />
    </svg>
  ),
  shieldCheck: ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  ),
  shieldAlert: ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  ),
  rocket: ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6.05 11a22.35 22.35 0 0 1-3.95 2z" />
    </svg>
  ),
  packageUpdate: ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  ),
};

const I18N = {
  zh: {
    pageTitle: '桌面客户端与整机版',
    pageHint: '独立窗口、托盘常驻、开机自启 · 功能一模一样，装不装都不影响使用',
    extensionBtn: '采集插件',
    clientVer: '客户端版本',
    desktopShell: '桌面壳',
    notPackaged: '还没打包',
    downloadable: '可下载',
    none: '无',
    serverVer: '服务端版本',
    webCore: '网页与功能本体',
    localServiceUpdate: '本机服务更新',
    canOneClickUpdate: '可一键更新',
    noUpdatePack: '未发布更新包',
    
    // 下载卡片
    downloadTitle: '下载安装包',
    recSub: (name: string) => `已按你的系统推荐：${name}`,
    selectSub: '选一个和你系统匹配的',
    recBadge: '推荐给你',
    archApple: 'Apple 芯片 (M 系列)',
    archIntel: 'Intel / x64',
    downloadBtn: '下载',
    
    // 差异与特性合并
    diffTitle: '客户端和网页，差在哪',
    diffSub: '功能一模一样 · 差别只在怎么打开、能不能连本机',
    featuresTitle: '桌面客户端专属体验',
    extras: [
      { t: '独立窗口', d: '有自己的图标和任务栏位置，不会被一堆标签页淹掉', iconType: 'window' as const },
      { t: '托盘常驻', d: '点关闭只是收进托盘，后台照常待命，随手点回来', iconType: 'tray' as const },
      { t: '开机自启', d: '开机自动在后台起来，不用每次去找入口', iconType: 'bolt' as const },
      { t: '独立本地缓存', d: '登录态存在客户端自己的数据目录，清浏览器缓存不影响它', iconType: 'storage' as const },
      { t: '自动更新（1.2.5 起）', d: '有新版会自己弹提示，点一下原地升级——不用再回这页手动下载覆盖', iconType: 'sync' as const },
    ],
    
    whichTitle: '哪件事该用哪个',
    tableHeaders: ['要做的事', '网页版', '桌面客户端', '采集插件'],
    splitMatrix: [
      ['选题、起稿、改稿、配图、发布', '✓', '✓', '—'],
      ['看数据、竞对监控、作战报告', '✓', '✓', '—'],
      ['派 AI 任务、定时任务', '✓', '✓', '—'],
      ['抓你自己后台的经营数据', '—', '—', '✓ 只能靠它'],
      ['抓公众号 / 视频号竞对', '—', '—', '✓ 只能靠它'],
      ['抓其他平台竞对', '✓ 服务端自动', '✓ 同左', '✓ 可补采'],
      ['独立窗口 / 托盘 / 开机自启', '—', '✓', '—'],
      ['连这台机器上的整机版', '手动输地址', '✓ 自动探测并记住', '—'],
    ],
    extNoticePrefix: '注意',
    extNoticeBold: '客户端替代不了插件',
    extNoticeMiddle: '：采集用的是你自己浏览器里的登录态，而客户端是独立窗口、装不了浏览器扩展。想让数据自动回流，插件仍要装在你日常用的 Chrome 里 —— ',
    extNoticeLink: '去装采集插件',
    
    noManifestTitle: '还没有可下载的安装包',
    noManifestSub: '打包之后这里会出现下载按钮',
    noManifestDesc: '桌面壳要在对应操作系统上构建（Tauri 不支持交叉编译）：Mac 上 cd desktop && npm run build 出 .dmg，Windows 上同样命令出 .msi / .exe；之后在项目根目录跑一次 npm run pack:desktop 收集产物，这一页就有下载了。详见 desktop/README.md。',
    
    // 安装与指引
    installGuideTitle: '安装与安全提示',
    macSecurityTitle: '🍎 macOS · 已签名并公证',
    macSecurityDesc: '拖进「应用程序」双击即可，没有任何安全提示。签名主体：厦门云磁数字科技有限公司，已通过 Apple 公证。',
    winSecurityTitle: '🪟 Windows · 会弹提示，按这三步',
    winStep1: '浏览器提示「不常下载」→ 点 保留',
    winStep2: '双击后蓝屏「Windows 已保护你的电脑」→ 点左下角 更多信息',
    winStep3: '展开后点 仍要运行',
    winSecurityDesc: 'Windows 端没有代码签名，所以会拦——不是软件有问题，可对照下方 sha256 自行校验文件完整性。',
    
    // 首次使用与更新合并
    usageGuideTitle: '使用与更新须知',
    afterInstall: '装好之后',
    afterInstallDesc: '首次打开会问你「连到哪一个烽火台」：连云端账号就是现在这个站点，和浏览器里同一个工作区；连本机整机版要先在这台机器上装过整机版服务。选过一次就记住了，之后直接进。',
    howToUpdate: '怎么更新',
    howToUpdateDesc: '客户端不会自动更新。有新版时，侧栏会出现一行「客户端有新版」提醒你；回到这一页重新下载，覆盖安装即可（macOS 拖进「应用程序」选替换，Windows 直接装在原位）。你的登录态和本地缓存都留着，装完还是同一个工作区。客户端只是外壳，网页功能本身一直是最新的，不更新客户端也不会少功能——更新带来的是壳自己的修复。',
    
    shaTitle: '校验值（sha256）',
    applianceCardTitle: '整机版与私有化一键部署',
    applianceCardDesc: '纯内网或私有服务器一键启动全套服务，完全掌控数据与密钥。',
    langZh: '中文',
    langEn: 'English',
  },
  en: {
    pageTitle: 'Desktop Client & Appliance',
    pageHint: 'Dedicated window, system tray resident, auto-start on boot · All features work identically in your browser',
    extensionBtn: 'Browser Extension',
    clientVer: 'Client Version',
    desktopShell: 'Desktop Shell',
    notPackaged: 'Not Packaged',
    downloadable: 'Available',
    none: 'None',
    serverVer: 'Server Version',
    webCore: 'Web & Core Engine',
    localServiceUpdate: 'Appliance Update',
    canOneClickUpdate: 'Update Ready',
    noUpdatePack: 'Latest Release',
    
    downloadTitle: 'Download Installers',
    recSub: (name: string) => `Recommended for your OS: ${name}`,
    selectSub: 'Select a package matching your system',
    recBadge: 'Recommended',
    archApple: 'Apple Silicon (M-series)',
    archIntel: 'Intel / x64',
    downloadBtn: 'Download',
    
    diffTitle: "Desktop vs Web: What's the Difference?",
    diffSub: 'Identical capabilities · Differences lie in window launch & local appliance connectivity',
    featuresTitle: 'Desktop Advantages',
    extras: [
      { t: 'Dedicated Window', d: 'Standalone app icon on dock / taskbar, never lost in cluttered browser tabs', iconType: 'window' as const },
      { t: 'Tray Resident', d: 'Closing the window minimizes to tray; background standby for instant recall', iconType: 'tray' as const },
      { t: 'Auto-Start', d: 'Launches silently in the background on system boot', iconType: 'bolt' as const },
      { t: 'Isolated Cache', d: 'Session kept in dedicated webview data dir; clearing browser cache will not affect it', iconType: 'storage' as const },
      { t: 'Auto-Update (v1.2.5+)', d: 'In-app notification on new release; upgrade in-place with one click', iconType: 'sync' as const },
    ],
    
    whichTitle: 'Which Tool for Which Task?',
    tableHeaders: ['要做的事', '网页版', '桌面客户端', '采集插件'],
    splitMatrix: [
      ['Topic generation, drafting, rewriting, cover image, publishing', '✓', '✓', '—'],
      ['Analytics dashboard, competitor tracking, battle reports', '✓', '✓', '—'],
      ['Dispatch AI agents, scheduled automation tasks', '✓', '✓', '—'],
      ['Sync private creator back-office data', '—', '—', '✓ Required'],
      ['Scrape WeChat Official Accounts & Channels', '—', '—', '✓ Required'],
      ['Scrape other public competitor platforms', '✓ Server Auto', '✓ Same as Web', '✓ Supplemental'],
      ['Dedicated window / Tray resident / Auto-start', '—', '✓', '—'],
      ['Connect to local Appliance server on this machine', 'Manual URL', '✓ Auto-detect & remember', '—'],
    ],
    extNoticePrefix: 'Note: ',
    extNoticeBold: '客户端替代不了插件',
    extNoticeMiddle: '. Scraping relies on active login sessions in your daily browser, whereas the desktop client is an isolated WebView. To automatically sync data, install the extension in your Chrome / Edge browser —— ',
    extNoticeLink: 'Install Extension',
    
    noManifestTitle: 'No downloadable packages available yet',
    noManifestSub: 'Download buttons will appear here once built',
    noManifestDesc: 'Desktop shells must be built on their respective target OS (Tauri does not support cross-compilation): Run `cd desktop && npm run build` on Mac for .dmg, or on Windows for .msi / .exe; then run `npm run pack:desktop` in root. See `desktop/README.md`.',
    
    installGuideTitle: 'Installation & Security Notes',
    macSecurityTitle: '🍎 macOS · 已签名并公证',
    macSecurityDesc: '拖进「应用程序」双击即可，没有任何安全提示。签名主体：厦门云磁数字科技有限公司，已通过 Apple 公证。',
    winSecurityTitle: '🪟 Windows · 会弹提示，按这三步',
    winStep1: '浏览器提示「不常下载」→ 点 保留',
    winStep2: '双击后蓝屏「Windows 已保护你的电脑」→ 点左下角 更多信息',
    winStep3: '展开后点 仍要运行',
    winSecurityDesc: 'Windows 端没有代码签名，所以会拦——不是软件有问题，可对照下方 sha256 自行校验文件完整性。',
    
    usageGuideTitle: 'Usage & Updates',
    afterInstall: '装好之后',
    afterInstallDesc: '首次打开会问你「连到哪一个烽火台」：连云端账号就是现在这个站点，和浏览器里同一个工作区；连本机整机版要先在这台机器上装过整机版服务。选过一次就记住了，之后直接进。',
    howToUpdate: '怎么更新',
    howToUpdateDesc: '客户端不会自动更新。有新版时，侧栏会出现一行「客户端有新版」提醒你；回到这一页重新下载，覆盖安装即可（macOS 拖进「应用程序」选替换，Windows 直接装在原位）。你的登录态和本地缓存都留着，装完还是同一个工作区。客户端只是外壳，网页功能本身一直是最新的，不更新客户端也不会少功能——更新带来的是壳自己的修复。',
    
    shaTitle: '校验值（sha256）',
    applianceCardTitle: 'Appliance & Private Self-Hosted',
    applianceCardDesc: 'Deploy full command center on your private server or local workstation with 100% data residency.',
    langZh: '中文',
    langEn: 'English',
  },
};

interface DesktopViewProps {
  manifest: DesktopManifest | null;
  recommended: DesktopBuild | null;
  localService: boolean;
  appliance: ApplianceManifest | null;
  canUpdate: boolean;
  serverVersion: string;
}

export function DesktopView({
  manifest,
  recommended,
  localService,
  appliance,
  canUpdate,
  serverVersion,
}: DesktopViewProps) {
  const [lang, setLang] = useState<Lang>('zh');

  useEffect(() => {
    // Read preference from URL or localStorage
    const params = new URLSearchParams(window.location.search);
    const urlLang = params.get('lang');
    if (urlLang === 'en' || urlLang === 'zh') {
      setLang(urlLang);
      return;
    }
    const saved = localStorage.getItem('beacon.lang');
    if (saved === 'en' || saved === 'zh') {
      setLang(saved);
    }
  }, []);

  const switchLang = (newLang: Lang) => {
    setLang(newLang);
    try {
      localStorage.setItem('beacon.lang', newLang);
      const url = new URL(window.location.href);
      url.searchParams.set('lang', newLang);
      window.history.replaceState({}, '', url.toString());
    } catch {}
  };

  const t = I18N[lang];
  const builds = manifest?.builds ?? [];
  const macBuilds = builds.filter((b) => b.os === 'mac');
  const winBuilds = builds.filter((b) => b.os === 'win');

  const osName = (os: 'mac' | 'win') => {
    if (lang === 'en') return os === 'mac' ? 'macOS' : 'Windows';
    return DESKTOP_OS_LABEL[os];
  };

  const archText = (arch: string) => {
    return arch === 'aarch64' ? t.archApple : t.archIntel;
  };

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 顶部标题与语言切换 */}
      <div className="row-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <HubHeader
          title={t.pageTitle}
          hint={t.pageHint}
          action={
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  background: 'var(--surface-2, rgba(127,127,127,0.12))',
                  padding: '3px 4px',
                  borderRadius: 20,
                  border: '1px solid var(--line, rgba(127,127,127,0.2))',
                }}
              >
                <button
                  type="button"
                  onClick={() => switchLang('zh')}
                  style={{
                    padding: '4px 10px',
                    fontSize: 12,
                    fontWeight: lang === 'zh' ? 600 : 400,
                    borderRadius: 16,
                    border: 0,
                    cursor: 'pointer',
                    background: lang === 'zh' ? 'var(--brand, #ff6a42)' : 'transparent',
                    color: lang === 'zh' ? '#fff' : 'inherit',
                    transition: 'all 0.18s ease',
                  }}
                >
                  中文
                </button>
                <button
                  type="button"
                  onClick={() => switchLang('en')}
                  style={{
                    padding: '4px 10px',
                    fontSize: 12,
                    fontWeight: lang === 'en' ? 600 : 400,
                    borderRadius: 16,
                    border: 0,
                    cursor: 'pointer',
                    background: lang === 'en' ? 'var(--brand, #ff6a42)' : 'transparent',
                    color: lang === 'en' ? '#fff' : 'inherit',
                    transition: 'all 0.18s ease',
                  }}
                >
                  English
                </button>
              </div>
              <Link href="/extension" className="btn btn-sm btn-ghost">
                <Icon.download size={13} /> {t.extensionBtn}
              </Link>
            </div>
          }
        />
      </div>

      {/* ════════════════════════════════════════════════════════════════════════
          【置顶第一优先级】核心下载区域 + 平台下载卡片 + 随下即看安装指引
         ════════════════════════════════════════════════════════════════════════ */}
      {!manifest ? (
        <Card title={t.noManifestTitle} sub={t.noManifestSub}>
          <p className="small muted" style={{ lineHeight: 1.9 }}>
            {t.noManifestDesc}
          </p>
        </Card>
      ) : (
        <Card
          title={t.downloadTitle}
          sub={recommended ? t.recSub(osName(recommended.os)) : t.selectSub}
          action={
            <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  borderRadius: 12,
                  fontSize: 12,
                  background: 'var(--brand-soft, rgba(255, 106, 66, 0.08))',
                  color: 'var(--brand, #ff6a42)',
                  fontWeight: 600,
                }}
              >
                {t.clientVer} v{manifest.version}
              </span>
              <span
                className="muted"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  borderRadius: 12,
                  fontSize: 12,
                  background: 'var(--surface-2, rgba(127,127,127,0.08))',
                }}
              >
                {t.serverVer} v{serverVersion}
              </span>
            </div>
          }
        >
          {/* 平台安装包下载卡片 Grid */}
          <div className="grid grid-2" style={{ gap: 12, marginTop: 4 }}>
            {[
              { os: 'mac' as const, list: macBuilds, IconComp: BrandIcon.mac },
              { os: 'win' as const, list: winBuilds, IconComp: BrandIcon.win },
            ].map(({ os, list, IconComp }) => {
              const isRec = recommended?.os === os;
              return (
                <div
                  key={os}
                  className="card"
                  style={{
                    padding: 16,
                    border: isRec ? '2px solid var(--brand, #ff6a42)' : undefined,
                    background: isRec ? 'var(--brand-soft, rgba(255, 106, 66, 0.03))' : undefined,
                  }}
                >
                  <div className="row-between" style={{ alignItems: 'center', marginBottom: 10 }}>
                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          display: 'grid',
                          placeItems: 'center',
                          background: isRec ? 'var(--brand, #ff6a42)' : 'var(--surface-2, rgba(127,127,127,0.12))',
                          color: isRec ? '#fff' : 'var(--text)',
                        }}
                      >
                        <IconComp size={18} />
                      </div>
                      <b style={{ fontSize: 15 }}>{osName(os)}</b>
                    </div>
                    {isRec && (
                      <span className="badge badge-brand">{t.recBadge}</span>
                    )}
                  </div>

                  {list.length === 0 ? (
                    <p className="small muted" style={{ lineHeight: 1.8 }}>
                      还没有 {DESKTOP_OS_LABEL[os]} 安装包。
                      {os === 'win'
                        ? 'Windows 包必须在 Windows 机器上构建，做好后会出现在这里。'
                        : 'macOS 包必须在 Mac 上构建，做好后会出现在这里。'}
                    </p>
                  ) : (
                    <div className="stack" style={{ gap: 8 }}>
                      {list.map((b) => (
                        <div
                          key={b.file}
                          className="row-between"
                          style={{
                            gap: 8,
                            flexWrap: 'wrap',
                            padding: '8px 10px',
                            background: 'var(--surface)',
                            borderRadius: 8,
                            border: '1px solid var(--line, rgba(127,127,127,0.12))',
                          }}
                        >
                          <span className="small">
                            <b>{b.os === 'mac' ? archText(b.arch) : b.ext.toUpperCase()}</b>
                            <span className="muted">　{b.sizeMB} MB</span>
                          </span>
                          <a className="btn btn-sm btn-primary" href={b.file} download>
                            <Icon.download size={13} /> {t.downloadBtn}
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 随下即看的安装与安全提示（紧凑双栏） */}
          <div className="grid grid-2" style={{ gap: 10, marginTop: 14 }}>
            <div className="card" style={{ padding: 12, background: 'var(--surface-2, rgba(127,127,127,0.04))' }}>
              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                <span style={{ color: 'var(--green, #10b981)' }}><BrandIcon.shieldCheck size={16} /></span>
                <b className="small">{t.macSecurityTitle}</b>
              </div>
              <p className="small muted" style={{ margin: '6px 0 0', lineHeight: 1.8 }}>
                {t.macSecurityDesc}
              </p>
            </div>
            <div className="card" style={{ padding: 12, background: 'var(--surface-2, rgba(127,127,127,0.04))' }}>
              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                <span style={{ color: 'var(--brand, #ff6a42)' }}><BrandIcon.shieldAlert size={16} /></span>
                <b className="small">{t.winSecurityTitle}</b>
              </div>
              <ol
                className="small muted"
                style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.8 }}
              >
                <li>{t.winStep1}</li>
                <li>{t.winStep2}</li>
                <li>{t.winStep3}</li>
              </ol>
              <p className="small muted" style={{ margin: '6px 0 0', lineHeight: 1.8 }}>
                {t.winSecurityDesc}
              </p>
            </div>
          </div>

          {/* 校验值 (sha256) 折叠 */}
          {builds.length > 0 && (
            <details className="small" style={{ marginTop: 12 }}>
              <summary className="muted" style={{ cursor: 'pointer', userSelect: 'none' }}>
                {t.shaTitle}
              </summary>
              <div className="stack" style={{ gap: 4, marginTop: 6, padding: '8px 12px', background: 'var(--surface-2, rgba(127,127,127,0.04))', borderRadius: 6 }}>
                {builds.map((b) => (
                  <div
                    key={b.file}
                    className="mono"
                    style={{ fontSize: 11, wordBreak: 'break-all' }}
                  >
                    {b.file.split('/').pop()}
                    <br />
                    <span className="muted">{b.sha256}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </Card>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          【往后放 & 深度合并】客户端和网页差异 + 场景选型对照表 (二合一)
         ════════════════════════════════════════════════════════════════════════ */}
      <Card title={t.diffTitle} sub={t.diffSub}>
        {/* 5大优势亮点（精致矢量图标网格） */}
        <div className="grid grid-3" style={{ gap: 10, marginBottom: 16 }}>
          {t.extras.map(({ t: title, d: desc, iconType }) => {
            const FeatIcon = BrandIcon[iconType];
            return (
              <div key={title} className="card" style={{ padding: 12, background: 'var(--surface-2, rgba(127,127,127,0.04))' }}>
                <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      display: 'grid',
                      placeItems: 'center',
                      background: 'var(--brand-soft, rgba(255, 106, 66, 0.1))',
                      color: 'var(--brand, #ff6a42)',
                      flexShrink: 0,
                    }}
                  >
                    <FeatIcon size={14} />
                  </div>
                  <b className="small">{title}</b>
                </div>
                <p className="small muted" style={{ margin: '4px 0 0', lineHeight: 1.6, fontSize: 12 }}>
                  {desc}
                </p>
              </div>
            );
          })}
        </div>

        <div className="divider" style={{ margin: '14px 0' }} />

        {/* 场景矩阵对比表 */}
        <b className="small">{t.whichTitle}</b>
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ minWidth: 190 }}>{t.tableHeaders[0]}</th>
                <th style={{ minWidth: 88 }}>{t.tableHeaders[1]}</th>
                <th style={{ minWidth: 96 }}>{t.tableHeaders[2]}</th>
                <th style={{ minWidth: 130 }}>{t.tableHeaders[3]}</th>
              </tr>
            </thead>
            <tbody>
              {t.splitMatrix.map((row) => (
                <tr key={row[0]}>
                  <td className="small">{row[0]}</td>
                  {row.slice(1).map((cell, i) => (
                    <td
                      key={i}
                      className="small"
                      style={{ color: cell === '—' ? 'var(--text-3)' : undefined }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 采集插件重点提示 */}
        <p className="small muted" style={{ margin: '12px 0 0', lineHeight: 1.9 }}>
          {t.extNoticePrefix}
          <b>{t.extNoticeBold}</b>
          {t.extNoticeMiddle}
          <Link href="/extension" style={{ color: 'var(--brand)', fontWeight: 600 }}>
            {t.extNoticeLink}
          </Link>
          。
        </p>
      </Card>

      {/* ════════════════════════════════════════════════════════════════════════
          【次要说明收纳】使用须知与更新 (装好之后 + 怎么更新)
         ════════════════════════════════════════════════════════════════════════ */}
      <Card title={t.usageGuideTitle}>
        <div className="grid grid-2" style={{ gap: 14 }}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span style={{ color: 'var(--brand, #ff6a42)' }}><BrandIcon.rocket size={16} /></span>
              <b className="small">{t.afterInstall}</b>
            </div>
            <p className="small muted" style={{ lineHeight: 1.8, margin: 0 }}>
              {t.afterInstallDesc}
            </p>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span style={{ color: 'var(--brand, #ff6a42)' }}><BrandIcon.packageUpdate size={16} /></span>
              <b className="small">{t.howToUpdate}</b>
            </div>
            <p className="small muted" style={{ lineHeight: 1.8, margin: 0 }}>
              {t.howToUpdateDesc}
            </p>
          </div>
        </div>
      </Card>

      {/* ════════════════════════════════════════════════════════════════════════
          整机版与私有化部署一键更新卡片
         ════════════════════════════════════════════════════════════════════════ */}
      {localService && (
        <ApplianceUpdateCard
          current={serverVersion}
          latest={appliance?.version ?? null}
          sizeMB={appliance?.sizeMB ?? null}
          notes={appliance?.notes ?? []}
          canUpdate={canUpdate}
        />
      )}
    </div>
  );
}

