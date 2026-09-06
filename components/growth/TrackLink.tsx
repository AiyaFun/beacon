'use client';

import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { track } from './track';

/**
 * 点击时先记一笔漏斗事件再照常跳转的 <a>。下载按钮、商店链接都用它。
 * keepalive 保证页面马上离开也能送出去；跳转本身不等上报结果。
 */
export function TrackLink({
  event,
  meta = '',
  children,
  ...rest
}: { event: string; meta?: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...rest}
      onClick={(e) => {
        track(event, meta);
        rest.onClick?.(e);
      }}
    >
      {children}
    </a>
  );
}
