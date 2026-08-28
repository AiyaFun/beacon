'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { detectDesktopClient, type DesktopClientInfo } from '@/lib/desktop-client';
import { compareVersion } from '@/lib/version';

// 侧栏底部的「下载桌面客户端」入口。
//
// 【为什么做得很轻】它常驻在每一页的视野里，是个**顺手提一句**的入口，不是号召行动的按钮。
// 第一版用了品牌色底 + 加粗标题，在侧栏里比「今天」「新任务」这些天天点的主入口还抢眼
// （用户原话「不要那么突兀」）。现在向「查看全部 →」那一行的调性看齐：无底色、次要文字色，
// 鼠标移上去才微微亮一下。
//
// 【为什么可关掉】已经装了的人、或压根不想装的人，每天被同一行问候一次就是噪音。
// 给一个 ×，关了就记住（localStorage，本机本浏览器）。× 平时不显示，悬停才出现——
// 一个常驻入口旁边永远杵着个关闭键，本身就是种打扰。
//
// 【为什么不在没有安装包时渲染】清单为空 = 还没打过包，点进去是空页面。
// 服务端读不到清单就不传 props，这里直接不渲染。
//
// 【一个位置，三种状态】(2026-08-28 用户提的两件事，其实是同一个槽位)
//   ① 不在客户端里            → 「下载桌面客户端 · macOS」（原样）
//   ② 在客户端里、已是最新    → **什么都不显示**（装都装了还劝下载纯属噪音）
//   ③ 在客户端里、版本落后    → 「客户端有新版 v1.3.0 · 去更新」
// ③ 只在**确知**客户端版本时才出现（靠壳跳转时带的标记）。用 Tauri 全局对象兜底认出来的
// 老客户端拿不到版本号，那种情况只做 ②——版本未知就提醒更新等于猜，猜错天天弹假红点。
//
// 【桌面壳没有自动更新】Tauri updater 插件没装。所以「去更新」= 回下载页重新下、覆盖安装，
// 文案不能写成「点一下就更新好了」。整机版服务那套一键增量更新是另一回事（那是服务端）。

/** 这台机器是什么系统。识别不出来返回 null——不猜，宁可不显示那一小行。 */
function detectOs(): 'mac' | 'win' | null {
  if (typeof navigator === 'undefined') return null;
  // userAgentData 是新标准且不受 UA 精简影响，优先用；取不到再退回 UA 字符串
  const p = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? navigator.userAgent;
  const s = p.toLowerCase();
  if (/mac|darwin/.test(s)) return 'mac';
  if (/win/.test(s)) return 'win';
  return null; // Linux、手机、以及认不出的一律不标系统
}

const OS_LABEL = { mac: 'macOS', win: 'Windows' } as const;

export function DesktopDownloadCard({ version, platforms }: { version: string; platforms: string }) {
  const KEY = 'beacon.desktopCard.hidden';
  // 默认不渲染，挂载后再决定：服务端渲染时读不到 localStorage 也测不了系统，
  // 直接渲染会让「已关掉」的人每次首屏又闪一下，也会先显示错的系统名再跳变
  const [show, setShow] = useState(false);
  const [os, setOs] = useState<'mac' | 'win' | null>(null);
  const [client, setClient] = useState<DesktopClientInfo | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setOs(detectOs());
    setClient(detectDesktopClient());
    setMounted(true);
    try {
      setShow(localStorage.getItem(KEY) !== '1');
    } catch {
      setShow(true); // 存储不可用（隐私模式）时照常显示，只是关不掉
    }
  }, []);

  if (!mounted) return null;

  // 已经在客户端里跑：只可能是「什么都不显示」或「提醒更新」，绝不再劝下载
  if (client) {
    // 版本未知 = 这个客户端老到还不会上报版本（会上报的那版起，跳转时一定带 _cv），
    // 所以「认得出人却拿不到版本」本身就证明它落后于第一个会上报的版本 → 按有新版处理。
    // 这条推断很重要：现存的 1.2.0 客户端全部走这一路，否则他们永远不知道有更新。
    const stale = client.version === null || compareVersion(client.version, version) < 0;
    if (!stale) return null; // ② 已是最新
    // ③ 有新版。这一条不给 ×：它是有时效的通知，不是常驻入口，更新完自己就消失了
    return (
      <div className="desktop-card">
        <Link href="/desktop" className="desktop-card-main" title={client.version ? `当前 v${client.version}，最新 v${version}` : `最新 v${version}`}>
          <span className="desktop-card-title">客户端有新版 v{version}</span>
          <span className="desktop-card-sub">去下载覆盖安装</span>
        </Link>
      </div>
    );
  }

  if (!show) return null;

  // 认出系统就只说这一个（「macOS」），认不出就退回服务端给的全集（「macOS · Windows」）
  const label = os ? OS_LABEL[os] : platforms;

  return (
    <div className="desktop-card">
      <Link href="/desktop" className="desktop-card-main" title={`桌面客户端 v${version}`}>
        <span className="desktop-card-title">下载桌面客户端</span>
        <span className="desktop-card-sub">{label}</span>
      </Link>
      <button
        type="button"
        className="desktop-card-close"
        aria-label="不再显示"
        title="不再显示"
        onClick={() => {
          try { localStorage.setItem(KEY, '1'); } catch { /* 关不掉就只是关不掉，不报错 */ }
          setShow(false);
        }}
      >
        ×
      </button>
    </div>
  );
}
