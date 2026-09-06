'use client';

// 浏览器侧的漏斗上报（2026-09-05）。
//
// visitorId 是这台浏览器里随机生成的匿名串，存 localStorage；它不是身份，换浏览器就断。
// 上报用 fetch keepalive（点下载时页面可能马上跳走，普通 fetch 会被取消）。
// 任何失败都吞掉：统计不能影响页面。

const KEY = 'beacon.visitor';

export function visitorId(): string | null {
  try {
    let v = localStorage.getItem(KEY);
    if (!v) {
      v = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      localStorage.setItem(KEY, v);
    }
    return v;
  } catch {
    return null;
  }
}

export function track(name: string, meta = ''): void {
  try {
    const body = JSON.stringify({ name, meta, path: location.pathname, visitorId: visitorId() });
    void fetch('/api/track', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => undefined);
  } catch {
    /* 统计不能影响页面 */
  }
}
