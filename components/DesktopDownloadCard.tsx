'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

// 侧栏底部的「下载桌面客户端」卡（2026-08-27 用户指着侧栏那块空白要的入口）。
//
// 【为什么可关掉】这块位置常驻在每一页的视野里。已经装了客户端的人、或者压根不想装的人，
// 每天被同一张卡问候一次就是噪音——给一个 ×，关了就记住（localStorage，本机本浏览器）。
// 不做「装没装」的自动探测：客户端跳进来的是同一个站点、同源标记不可靠，
// 猜错的两种后果（该显示不显示 / 已装还劝装）都比让用户自己点一下 × 差。
//
// 【为什么不在没有安装包时渲染】清单为空 = 还没打过包，点进去是一个空页面。
// 服务端读不到清单就不传 href，这里直接不渲染。
export function DesktopDownloadCard({ version, platforms }: { version: string; platforms: string }) {
  const KEY = 'beacon.desktopCard.hidden';
  // 默认不渲染，挂载后再决定：服务端渲染时读不到 localStorage，
  // 直接渲染会让「已关掉」的人在每次首屏加载时又闪一下那张卡
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      setShow(localStorage.getItem(KEY) !== '1');
    } catch {
      setShow(true); // 存储不可用（隐私模式）时照常显示，只是关不掉
    }
  }, []);

  if (!show) return null;

  return (
    <div className="desktop-card">
      <Link href="/desktop" className="desktop-card-main">
        <span className="desktop-card-title">⬇ 下载桌面客户端</span>
        <span className="desktop-card-sub">{platforms} · v{version}</span>
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
