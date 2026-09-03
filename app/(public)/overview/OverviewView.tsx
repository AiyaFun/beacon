'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';

export type Lang = 'zh' | 'en';

const OVERVIEW_I18N = {
  zh: {
    brandName: '烽火台 Beacon',
    brandTagline: '跨平台内容作战室',
    navAppliance: '🖥️ 整机版',
    navWindows: '🪟 Windows',
    navMac: '🍎 macOS',
    navSaaS: '🌐 云端 SaaS',
    navExtension: '🧩 采集插件',
    navMatrix: '📊 矩阵对比',
    launchApp: '进入工作台',
    heroBadge: '全端覆盖 · 数据主权 · AI 赋能',
    heroTitle: '整个项目生态：整机、Win、Mac 与全域内容作战',
    heroDesc: '集「整机私有化部署、Windows/macOS 双端桌面壳、云端 SaaS 作战室、浏览器采集扩展」于一体。从热点捕获、竞对监控、12 专家会诊，到文稿工作坊与跨平台一键分发，提供全生命周期内容武器库。',
    ctaGetDesktop: '下载桌面客户端',
    ctaDeployAppliance: '部署整机私有化',
    ctaTryWeb: '在线快速体验 →',

    // Ecosystem Cards
    ecosystemTitle: '四大端型协同运作',
    ecosystemSub: '按需选择运行形态，数据与控制权完全由您决定',

    applianceTitle: '🖥️ 整机版 (Appliance / Self-Hosted)',
    applianceBadge: '数据 100% 本地留存',
    applianceDesc: '私有化及单机运行方案。在您自己的服务器或局域网机器上运行，敏感数据与模型 Key 零泄漏。',
    appliancePoints: [
      '完全数据主权：作品草稿、人设、竞对与 Key 全在本地 SQLite/Postgres',
      '本机浏览器驱动：内置 Playwright 自动化引擎，直接调用本机浏览器深度采集',
      'MCP Server 与本地执行：支持与 Claude / Cursor / OpenClaw 等本地 Agent 互通',
      '一键增量更新：`update.sh` / `update.ps1` 校验 SHA256 无感升级，绝不动已有配置',
    ],

    winTitle: '🪟 Windows 客户端',
    winBadge: '轻量 Tauri 原生壳',
    winDesc: '专为 Windows 10 / 11 优化的桌面壳，独立 WebView 缓存，不被杂乱标签页淹没。',
    winPoints: [
      '系统托盘常驻：点关闭最小化至托盘，后台常驻待命，秒级唤醒',
      '开机自启支持：随系统后台静默启动，无需每次翻找快捷方式',
      '双模式自动探测：优先探测本机整机版（localhost:3070），探不到无缝切换云端',
      '清晰安装引导：提供 SmartScreen 三步指引与 SHA256 校验保障安全',
    ],

    macTitle: '🍎 macOS 客户端',
    macBadge: '已签名公证 · 双架构原生',
    macDesc: '针对 Apple Silicon (M 系列) 与 Intel x64 原生编译，享受丝滑系统级体验。',
    macPoints: [
      '官方签名与公证：通过 Apple Developer ID 签名与 Gatekeeper 公证，双击直接运行',
      '全架构覆盖：提供 M1-M4 (aarch64) 与 Intel (x64) 独立架构构建包',
      '独立本地数据域：独立的 WebView 数据隔离，清理 Safari/Chrome 缓存不丢登录态',
      '原生菜单栏集成：适配 macOS 状态栏与 Dock 操作习惯',
    ],

    saasTitle: '🌐 云端 SaaS 与 🧩 采集插件',
    saasBadge: '开箱即用 · 浏览器伴侣',
    saasDesc: '免运维云端作战室，搭配 Chrome/Edge 扩展实现创作者后台数据双向回流。',
    saasPoints: [
      '全网热点聚合：覆盖微博、抖音、B站、知乎、百度等 8+ 平台实时热榜',
      '12 人设选题智囊团：多维度专家视角诊断选题爆款潜质与风险',
      '四级敏感词合规检测：违禁词库与多平台审核规则预检，附带 AIGC 防伪标识',
      '创作者数据回填与分发：插件读取后台播放/阅读数据，辅助一键填表发布',
    ],

    // Quick start commands
    installGuideTitle: '🖥️ 整机版一键极速部署',
    installGuideSub: '一条命令，在你的 Mac / Linux / Windows 机器上拉起全套作战室',
    shTitle: 'macOS / Linux 一键安装',
    psTitle: 'Windows (PowerShell) 一键安装',

    // Matrix
    matrixTitle: '各端能力与分工全景对比',
    matrixSub: '清晰透明的技术选型与能力边界',
    thTask: '功能模块 / 核心能力',
    thAppliance: '整机版 (私有化)',
    thDesktop: '桌面客户端 (Win/Mac)',
    thSaaS: '云端 SaaS (Web)',
    thExt: '采集插件 (Extension)',
    matrixRows: [
      ['热点聚合、AI 选题、改稿、配图、发布', '✓ 本地运行', '✓ 完整支持', '✓ 完整支持', '—'],
      ['数据看板、竞对监控、周度作战报告', '✓ 本地库', '✓ 完整支持', '✓ 完整支持', '—'],
      ['调度 AI 智能体、定时自动化工作流', '✓ 本地队列', '✓ 完整支持', '✓ 完整支持', '—'],
      ['自有后台经营数据回填 (公众号/小红书等)', '—', '—', '—', '✓ 只能靠它'],
      ['公众号/视频号竞对深度采集', '—', '—', '—', '✓ 只能靠它'],
      ['其他主流平台公开竞对自动采', '✓ 本机驱动', '✓ 同左/同云端', '✓ 云端自动', '✓ 可补采'],
      ['独立桌面窗口 / 系统托盘 / 开机自启', '—', '✓ 原生支持', '—', '—'],
      ['MCP 本地协议 / 本地终端命令执行', '✓ 原生支持', '—', '—', '—'],
      ['数据存储位置', '用户本地机器', '依赖所连服务端', '云端租户隔离', '浏览器本地存储'],
      ['网络需求', '支持纯内网/离线', '连通目标服务即可', '需公网网络', '需访问对应平台'],
    ],

    // Security & Compliance
    secTitle: '安全、合规与隐私底线',
    sec1Title: '🛡️ 严格租户隔离与凭据加密',
    sec1Desc: '所有模型 Key (BYOK) 与三方凭证均采用 AES-256-GCM 强加密存储，内存解密即用即弃，绝不回传与落盘。',
    sec2Title: '🔒 脱敏采集骨架上报',
    sec2Desc: '插件采集与配方学习严格遵循脱敏协议，文字脱敏为 CJK/NUM，不上传 Cookie、不采集个人账号 ID。',
    sec3Title: '✨ 国家 AIGC 标识规范',
    sec3Desc: 'AI 生成封面图与插图严格遵循 GB 45438-2025 规范，注入隐式元数据标识与显式防伪标记。',

    footerCopy: '© 2026 烽火台 (Beacon). 跨平台内容创作与作战指挥中心.',
  },
  en: {
    brandName: 'Beacon',
    brandTagline: 'Cross-Platform Command Center',
    navAppliance: '🖥️ Appliance',
    navWindows: '🪟 Windows',
    navMac: '🍎 macOS',
    navSaaS: '🌐 Cloud SaaS',
    navExtension: '🧩 Extension',
    navMatrix: '📊 Matrix',
    launchApp: 'Open Dashboard',
    heroBadge: 'All Platforms · Data Sovereignty · AI Powered',
    heroTitle: 'Entire Ecosystem: Appliance, Windows, Mac & Full-Spectrum Content Command',
    heroDesc: 'An all-in-one suite combining Self-hosted Appliance, Windows & macOS Desktop clients, Cloud SaaS, and Browser Extension. From trending radar, competitor surveillance, and 12-expert AI panel to copy workshop and cross-platform publishing.',
    ctaGetDesktop: 'Download Desktop App',
    ctaDeployAppliance: 'Deploy Appliance',
    ctaTryWeb: 'Try Web SaaS →',

    // Ecosystem Cards
    ecosystemTitle: 'Four Coordinated Deployment Forms',
    ecosystemSub: 'Choose the form that matches your operational and privacy requirements',

    applianceTitle: '🖥️ Appliance (Self-Hosted / Private)',
    applianceBadge: '100% Data Sovereignty',
    applianceDesc: 'Private and local deployment solution. Runs entirely on your own server or workstation with zero cloud data leaks.',
    appliancePoints: [
      'Complete Data Sovereignty: Drafts, personas, competitor data, and keys remain in local SQLite/Postgres',
      'Local Browser Automation: Built-in Playwright engine drives your local browser for deep data extraction',
      'MCP Server & Local Execution: Native Model Context Protocol server for Claude, Cursor, and OpenClaw agents',
      'One-Click Incremental Updates: `update.sh` / `update.ps1` with SHA256 integrity verification, preserving configurations',
    ],

    winTitle: '🪟 Windows Desktop Client',
    winBadge: 'Lightweight Tauri Shell',
    winDesc: 'Optimized for Windows 10 & 11 with standalone WebView cache, isolated from cluttered browser tabs.',
    winPoints: [
      'System Tray Resident: Closing minimizes to tray; background standby for instant wake-up',
      'Auto-Start on Boot: Silent background launch with system startup, no manual shortcut hunting',
      'Dual Mode Auto-Probe: Prioritizes local Appliance (`localhost:3070`); seamlessly falls back to Cloud SaaS',
      'Clear Installation Guide: 3-step SmartScreen bypass instructions and SHA256 checksums',
    ],

    macTitle: '🍎 macOS Desktop Client',
    macBadge: 'Signed & Notarized · Universal',
    macDesc: 'Natively compiled for Apple Silicon (M1-M4) and Intel x64 architectures for fluid macOS experience.',
    macPoints: [
      'Signed & Notarized: Certified with Apple Developer ID and Apple Gatekeeper notarization; runs directly',
      'Full Architecture Support: Standalone optimized builds for Apple Silicon (aarch64) and Intel (x64)',
      'Isolated Local Data: Dedicated WebView storage; clearing Safari/Chrome cache won’t log you out',
      'Native Menu Bar Integration: Tailored to macOS dock, menu bar, and keyboard shortcuts',
    ],

    saasTitle: '🌐 Cloud SaaS & 🧩 Browser Extension',
    saasBadge: 'Zero Ops · Browser Companion',
    saasDesc: 'Zero-maintenance cloud command center paired with Chrome/Edge extension for bidirectional creator data sync.',
    saasPoints: [
      'Trending Aggregation: Real-time radar covering Weibo, Douyin, Bilibili, Zhihu, Baidu, and YouTube',
      '12-Persona Topic Advisory: Multi-perspective AI experts evaluate viral potential and platform compliance',
      '4-Tier Compliance Filter: Prohibited keywords scan and platform guidelines check with AIGC provenance tags',
      'Creator Data Backfill & Publishing: Extension reads back-office metrics and auto-fills publishing forms',
    ],

    // Quick start commands
    installGuideTitle: '🖥️ Instant Appliance Deployment',
    installGuideSub: 'One command to spin up the entire command center on your Mac, Linux, or Windows machine',
    shTitle: 'macOS / Linux One-Line Install',
    psTitle: 'Windows (PowerShell) One-Line Install',

    // Matrix
    matrixTitle: 'Feature & Responsibility Comparison Matrix',
    matrixSub: 'Clear technical boundaries and capability breakdown across all form factors',
    thTask: 'Module / Capability',
    thAppliance: 'Appliance (Self-Hosted)',
    thDesktop: 'Desktop Client (Win/Mac)',
    thSaaS: 'Cloud SaaS (Web)',
    thExt: 'Extension',
    matrixRows: [
      ['Topic Generation, Drafting, Rewriting, AI Cover, Publishing', '✓ Local Execution', '✓ Fully Supported', '✓ Fully Supported', '—'],
      ['Analytics Dashboard, Competitor Monitoring, Reports', '✓ Local Database', '✓ Fully Supported', '✓ Fully Supported', '—'],
      ['Dispatch AI Agents, Scheduled Workflows', '✓ Local Queue', '✓ Fully Supported', '✓ Fully Supported', '—'],
      ['Private Creator Back-Office Data Sync', '—', '—', '—', '✓ Required'],
      ['WeChat Official Accounts & Channels Scraping', '—', '—', '—', '✓ Required'],
      ['Other Mainstream Platform Competitor Scraping', '✓ Local Driver', '✓ Same as Web/Local', '✓ Server Auto', '✓ Supplemental'],
      ['Standalone Window / System Tray / Auto-Start', '—', '✓ Native Supported', '—', '—'],
      ['MCP Local Protocol / Shell Command Execution', '✓ Native Supported', '—', '—', '—'],
      ['Data Storage Location', 'Local Host / VPC', 'Depends on Server', 'Cloud Tenant Isolated', 'Browser Local Storage'],
      ['Network Requirements', 'Full Offline / LAN', 'Connect to Server', 'Internet Required', 'Access Platform Pages'],
    ],

    // Security & Compliance
    secTitle: 'Security, Compliance & Privacy Guardrails',
    sec1Title: '🛡️ Strict Tenant Isolation & Key Encryption',
    sec1Desc: 'All LLM Keys (BYOK) and tokens are encrypted with AES-256-GCM. Decrypted in memory only during invocation.',
    sec2Title: '🔒 Redacted Extraction Skeleton',
    sec2Desc: 'Scraping obeys redaction protocols: text becomes CJK/NUM. No user IDs or sensitive cookies uploaded.',
    sec3Title: '✨ Certified AIGC Provenance Markers',
    sec3Desc: 'AI cover images strictly adhere to GB 45438-2025 standards with embedded XMP metadata and watermarks.',

    footerCopy: '© 2026 Beacon. Cross-Platform Content Creation & Operations Command Center.',
  },
};

export function OverviewView() {
  const [lang, setLang] = useState<Lang>('zh');

  useEffect(() => {
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

  const t = OVERVIEW_I18N[lang];

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0d1420)', color: 'var(--ink, #eaf1f9)', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif' }}>
      {/* Sticky Top Header */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          backdropFilter: 'blur(12px)',
          background: 'rgba(13, 20, 32, 0.88)',
          borderBottom: '1px solid var(--line, rgba(255, 255, 255, 0.1))',
          padding: '12px 24px',
        }}
      >
        <div style={{ maxWidth: 1280, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #ff6a42, #e54d24)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, color: '#fff', fontWeight: 800 }}>
              🔥
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: '-0.01em' }}>{t.brandName}</div>
              <div style={{ fontSize: 11, opacity: 0.7 }}>{t.brandTagline}</div>
            </div>
          </div>

          <nav style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 13, flexWrap: 'wrap' }}>
            <a href="#appliance" style={{ color: 'inherit', textDecoration: 'none', opacity: 0.85 }}>{t.navAppliance}</a>
            <a href="#windows" style={{ color: 'inherit', textDecoration: 'none', opacity: 0.85 }}>{t.navWindows}</a>
            <a href="#mac" style={{ color: 'inherit', textDecoration: 'none', opacity: 0.85 }}>{t.navMac}</a>
            <a href="#saas" style={{ color: 'inherit', textDecoration: 'none', opacity: 0.85 }}>{t.navSaaS}</a>
            <a href="#matrix" style={{ color: 'inherit', textDecoration: 'none', opacity: 0.85 }}>{t.navMatrix}</a>
          </nav>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Language Switcher */}
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                background: 'rgba(255, 255, 255, 0.08)',
                padding: '3px 4px',
                borderRadius: 20,
                border: '1px solid rgba(255, 255, 255, 0.15)',
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
                  background: lang === 'zh' ? '#ff6a42' : 'transparent',
                  color: lang === 'zh' ? '#fff' : 'rgba(255,255,255,0.7)',
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
                  background: lang === 'en' ? '#ff6a42' : 'transparent',
                  color: lang === 'en' ? '#fff' : 'rgba(255,255,255,0.7)',
                  transition: 'all 0.18s ease',
                }}
              >
                English
              </button>
            </div>

            <Link
              href="/login"
              style={{
                background: '#ff6a42',
                color: '#fff',
                padding: '6px 14px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              {t.launchApp}
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section style={{ maxWidth: 1160, margin: '0 auto', padding: '64px 20px 48px', textAlign: 'center' }}>
        <div style={{ display: 'inline-block', padding: '4px 14px', borderRadius: 20, background: 'rgba(255, 106, 66, 0.15)', color: '#ff6a42', fontSize: 12, fontWeight: 600, marginBottom: 18, border: '1px solid rgba(255, 106, 66, 0.3)' }}>
          {t.heroBadge}
        </div>
        <h1 style={{ fontSize: 'clamp(28px, 4.5vw, 48px)', fontWeight: 800, lineHeight: 1.25, margin: '0 0 20px', letterSpacing: '-0.02em' }}>
          {t.heroTitle}
        </h1>
        <p style={{ maxWidth: 840, margin: '0 auto 32px', fontSize: 16, lineHeight: 1.8, opacity: 0.82 }}>
          {t.heroDesc}
        </p>

        <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link
            href="/desktop"
            style={{
              background: '#ff6a42',
              color: '#fff',
              padding: '12px 24px',
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 600,
              textDecoration: 'none',
              boxShadow: '0 4px 18px rgba(255, 106, 66, 0.35)',
            }}
          >
            {t.ctaGetDesktop}
          </Link>
          <a
            href="#appliance"
            style={{
              background: 'rgba(255, 255, 255, 0.08)',
              color: '#fff',
              padding: '12px 22px',
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 600,
              textDecoration: 'none',
              border: '1px solid rgba(255, 255, 255, 0.15)',
            }}
          >
            {t.ctaDeployAppliance}
          </a>
          <Link
            href="/hotlists"
            style={{
              color: '#5aa9ff',
              padding: '12px 18px',
              fontSize: 15,
              fontWeight: 600,
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {t.ctaTryWeb}
          </Link>
        </div>
      </section>

      {/* 4 Form Factors */}
      <section style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px 60px' }}>
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <h2 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 8px' }}>{t.ecosystemTitle}</h2>
          <p style={{ opacity: 0.7, fontSize: 14, margin: 0 }}>{t.ecosystemSub}</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
          {/* Appliance Card */}
          <div id="appliance" style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: 16, padding: 24, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{t.applianceTitle}</span>
              <span style={{ fontSize: 11, background: 'rgba(52, 211, 153, 0.15)', color: '#34d399', padding: '2px 8px', borderRadius: 12 }}>{t.applianceBadge}</span>
            </div>
            <p style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.6, marginBottom: 16 }}>{t.applianceDesc}</p>
            <ul style={{ paddingLeft: 18, margin: 0, fontSize: 13, lineHeight: 1.8, opacity: 0.9, flex: 1 }}>
              {t.appliancePoints.map((pt, i) => <li key={i} style={{ marginBottom: 6 }}>{pt}</li>)}
            </ul>
          </div>

          {/* Windows Card */}
          <div id="windows" style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: 16, padding: 24, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{t.winTitle}</span>
              <span style={{ fontSize: 11, background: 'rgba(90, 169, 255, 0.15)', color: '#5aa9ff', padding: '2px 8px', borderRadius: 12 }}>{t.winBadge}</span>
            </div>
            <p style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.6, marginBottom: 16 }}>{t.winDesc}</p>
            <ul style={{ paddingLeft: 18, margin: 0, fontSize: 13, lineHeight: 1.8, opacity: 0.9, flex: 1 }}>
              {t.winPoints.map((pt, i) => <li key={i} style={{ marginBottom: 6 }}>{pt}</li>)}
            </ul>
          </div>

          {/* Mac Card */}
          <div id="mac" style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: 16, padding: 24, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{t.macTitle}</span>
              <span style={{ fontSize: 11, background: 'rgba(167, 139, 250, 0.15)', color: '#a78bfa', padding: '2px 8px', borderRadius: 12 }}>{t.macBadge}</span>
            </div>
            <p style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.6, marginBottom: 16 }}>{t.macDesc}</p>
            <ul style={{ paddingLeft: 18, margin: 0, fontSize: 13, lineHeight: 1.8, opacity: 0.9, flex: 1 }}>
              {t.macPoints.map((pt, i) => <li key={i} style={{ marginBottom: 6 }}>{pt}</li>)}
            </ul>
          </div>

          {/* SaaS & Ext Card */}
          <div id="saas" style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: 16, padding: 24, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{t.saasTitle}</span>
              <span style={{ fontSize: 11, background: 'rgba(244, 183, 64, 0.15)', color: '#f4b740', padding: '2px 8px', borderRadius: 12 }}>{t.saasBadge}</span>
            </div>
            <p style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.6, marginBottom: 16 }}>{t.saasDesc}</p>
            <ul style={{ paddingLeft: 18, margin: 0, fontSize: 13, lineHeight: 1.8, opacity: 0.9, flex: 1 }}>
              {t.saasPoints.map((pt, i) => <li key={i} style={{ marginBottom: 6 }}>{pt}</li>)}
            </ul>
          </div>
        </div>
      </section>

      {/* Appliance Quick Install Block */}
      <section style={{ maxWidth: 1160, margin: '0 auto', padding: '0 20px 60px' }}>
        <div style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: 16, padding: 32 }}>
          <h3 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px' }}>{t.installGuideTitle}</h3>
          <p style={{ opacity: 0.7, fontSize: 13, margin: '0 0 20px' }}>{t.installGuideSub}</p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
            <div>
              <b style={{ fontSize: 13, color: '#34d399' }}>{t.shTitle}</b>
              <pre style={{ background: '#0a0f18', padding: '14px 16px', borderRadius: 10, fontSize: 12, overflowX: 'auto', border: '1px solid rgba(255,255,255,0.06)', marginTop: 8 }}>
                <code>bash deploy/appliance/install.sh</code>
              </pre>
            </div>
            <div>
              <b style={{ fontSize: 13, color: '#5aa9ff' }}>{t.psTitle}</b>
              <pre style={{ background: '#0a0f18', padding: '14px 16px', borderRadius: 10, fontSize: 12, overflowX: 'auto', border: '1px solid rgba(255,255,255,0.06)', marginTop: 8 }}>
                <code>powershell -ExecutionPolicy Bypass -File deploy\appliance\install.ps1</code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* Comparison Matrix */}
      <section id="matrix" style={{ maxWidth: 1200, margin: '0 auto', padding: '0 20px 60px' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h2 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 6px' }}>{t.matrixTitle}</h2>
          <p style={{ opacity: 0.7, fontSize: 13, margin: 0 }}>{t.matrixSub}</p>
        </div>

        <div style={{ overflowX: 'auto', background: 'rgba(255, 255, 255, 0.02)', borderRadius: 16, border: '1px solid rgba(255, 255, 255, 0.08)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)', background: 'rgba(255, 255, 255, 0.03)' }}>
                <th style={{ padding: '14px 18px', minWidth: 220 }}>{t.thTask}</th>
                <th style={{ padding: '14px 14px', minWidth: 140 }}>{t.thAppliance}</th>
                <th style={{ padding: '14px 14px', minWidth: 150 }}>{t.thDesktop}</th>
                <th style={{ padding: '14px 14px', minWidth: 130 }}>{t.thSaaS}</th>
                <th style={{ padding: '14px 14px', minWidth: 120 }}>{t.thExt}</th>
              </tr>
            </thead>
            <tbody>
              {t.matrixRows.map((row, idx) => (
                <tr key={idx} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}>
                  <td style={{ padding: '12px 18px', fontWeight: 600 }}>{row[0]}</td>
                  <td style={{ padding: '12px 14px', opacity: 0.9 }}>{row[1]}</td>
                  <td style={{ padding: '12px 14px', opacity: 0.9 }}>{row[2]}</td>
                  <td style={{ padding: '12px 14px', opacity: 0.9 }}>{row[3]}</td>
                  <td style={{ padding: '12px 14px', opacity: 0.9 }}>{row[4]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Security & Compliance */}
      <section style={{ maxWidth: 1160, margin: '0 auto', padding: '0 20px 80px' }}>
        <h3 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 20px', textAlign: 'center' }}>{t.secTitle}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
          <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: 20, borderRadius: 12, border: '1px solid rgba(255, 255, 255, 0.06)' }}>
            <b style={{ fontSize: 14, color: '#34d399' }}>{t.sec1Title}</b>
            <p style={{ fontSize: 12, opacity: 0.75, margin: '8px 0 0', lineHeight: 1.7 }}>{t.sec1Desc}</p>
          </div>
          <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: 20, borderRadius: 12, border: '1px solid rgba(255, 255, 255, 0.06)' }}>
            <b style={{ fontSize: 14, color: '#5aa9ff' }}>{t.sec2Title}</b>
            <p style={{ fontSize: 12, opacity: 0.75, margin: '8px 0 0', lineHeight: 1.7 }}>{t.sec2Desc}</p>
          </div>
          <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: 20, borderRadius: 12, border: '1px solid rgba(255, 255, 255, 0.06)' }}>
            <b style={{ fontSize: 14, color: '#ff6a42' }}>{t.sec3Title}</b>
            <p style={{ fontSize: 12, opacity: 0.75, margin: '8px 0 0', lineHeight: 1.7 }}>{t.sec3Desc}</p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: '1px solid rgba(255, 255, 255, 0.08)', padding: '28px 20px', textAlign: 'center', fontSize: 12, opacity: 0.6 }}>
        {t.footerCopy}
      </footer>
    </div>
  );
}
