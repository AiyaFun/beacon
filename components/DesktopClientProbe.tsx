'use client';

import { useEffect } from 'react';
import { detectDesktopClient } from '@/lib/desktop-client';

/**
 * 接住桌面壳跳转时带来的一次性标记（`?_client=desktop&_cv=…`）。
 *
 * 【为什么必须挂在根布局，而不是只在侧栏卡片里认】
 * 卡片只在 (app) 里渲染。用户**没登录**时打开客户端，中间件会把他跳到 /login——
 * 那是 (public) 页，卡片不在，没人接这个标记；等他登录完跳回 /，query 早没了。
 * 结果就是「装了最新版客户端，却被永久提醒有新版」（版本认不出来 → 按旧版处理）。
 * 挂在根布局才能保证不管落到哪一页都接得住。
 *
 * 它只有副作用（写 localStorage、抹地址栏参数），不渲染任何东西。
 */
export function DesktopClientProbe() {
  useEffect(() => { detectDesktopClient(); }, []);
  return null;
}
