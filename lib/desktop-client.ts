// 「这个网页是不是跑在桌面客户端里」——只在浏览器里调用。
//
// 【为什么需要它】装了客户端的人，侧栏还天天挂一行「下载桌面客户端」，是纯噪音
// （用户原话：「已经下载了客户端，就不要显示这个下载桌面客户端的了」）。
// 顺带它还答出了第二个问题：知道客户端是哪一版，才能在有新版时提醒。
//
// 【三路识别，按可靠度排】
//  ① URL 标记 `?_client=desktop&_cv=1.2.1`——壳跳进站点时自己带上的，**唯一能给出版本号**的一路。
//     读到就存进 localStorage 并把参数从地址栏抹掉（history.replaceState），免得版本号跟着分享出去。
//  ② localStorage——①存下来的，之后每次打开都认得。
//  ③ window.__TAURI_INTERNALS__——Tauri 注入的引导对象。**给已经装了旧版客户端的人兜底**：
//     1.2.0 那版壳还不会带 ① 的标记，只有这一路能认出来。代价是拿不到版本号，
//     所以这一路只用来「别再劝他下载」，不拿来判断该不该提醒更新——
//     版本未知时提醒更新只能靠猜，猜错就是天天弹一个假的红点。

export const CLIENT_PARAM = '_client';
export const CLIENT_VER_PARAM = '_cv';
export const CLIENT_STORE_KEY = 'beacon.desktopClient';

export type DesktopClientInfo = {
  /** 客户端版本；③ 那一路认出来但拿不到版本时为 null */
  version: string | null;
};

/**
 * 认一次当前环境。不在客户端里返回 null。
 * 有副作用（写 localStorage、抹地址栏参数），所以只能在 useEffect 里调。
 */
export function detectDesktopClient(): DesktopClientInfo | null {
  if (typeof window === 'undefined') return null;

  // ① 壳刚跳进来，带着标记
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get(CLIENT_PARAM) === 'desktop') {
      const v = url.searchParams.get(CLIENT_VER_PARAM);
      const info: DesktopClientInfo = { version: v && /^\d+(\.\d+)*$/.test(v) ? v : null };
      try { window.localStorage.setItem(CLIENT_STORE_KEY, JSON.stringify(info)); } catch { /* 存不下就每次重认 */ }
      // 把标记从地址栏抹掉：它只是一次性的握手，留着会被复制粘贴分享出去
      url.searchParams.delete(CLIENT_PARAM);
      url.searchParams.delete(CLIENT_VER_PARAM);
      try { window.history.replaceState(null, '', url.toString()); } catch { /* 抹不掉也不影响功能 */ }
      return info;
    }
  } catch { /* URL 解析失败就走下一路 */ }

  // ② 认过一次就记住
  try {
    const raw = window.localStorage.getItem(CLIENT_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DesktopClientInfo;
      return { version: typeof parsed?.version === 'string' ? parsed.version : null };
    }
  } catch { /* 坏数据当没存过 */ }

  // ③ 旧版客户端兜底：认得出人，认不出版本
  const w = window as unknown as Record<string, unknown>;
  if (w.__TAURI_INTERNALS__ || w.__TAURI__) return { version: null };

  return null;
}
