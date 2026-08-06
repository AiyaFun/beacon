'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// 弹层/覆盖层的统一出口。**必须 portal 到 body**，不能就地渲染。
//
// 【为什么】globals.css 里 `.card:hover` 会给卡片加 transform（translateY(-2px)）。
// 带 transform 的元素会成为后代 `position: fixed` 的包含块——于是卡片内部那个
// `inset: 0` 的"全屏"遮罩会缩成卡片那么大。实测：鼠标停在卡片上打开弹层，
// 遮罩只有 602×110px。这个 bug 只在**指针悬停在祖先卡片上**时出现，
// 本地随手点常常撞不到，用户却每次都是从卡片里的按钮点进来的，天天撞。
//
// 顺带统一了三件每个弹层都要做、又每次都有人忘的事：Esc 关闭、锁背景滚动、点遮罩关闭。

/** 覆盖层能否挂到 body 上（SSR 阶段没有 document）。挂载后即为 true，用户点开时不会有延迟。 */
export function usePortalReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}

export function Overlay({
  onClose,
  children,
  label,
  /** 关闭动作是否可用（提交中通常要挡住误关） */
  closable = true,
}: {
  onClose: () => void;
  children: React.ReactNode;
  label: string;
  closable?: boolean;
}) {
  const ready = usePortalReady();
  // onClose 多半是行内箭头函数，每次渲染都是新引用。放进依赖会让 effect 每渲染都重跑一遍，
  // 第二遍读到的 prev 已经是被自己改成的 'hidden'，卸载时就会把页面永久锁死在不可滚动。
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closableRef = useRef(closable);
  closableRef.current = closable;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closableRef.current) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, []);

  if (!ready) return null;

  return createPortal(
    <div
      className="overlay-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(e) => {
        if (e.target === e.currentTarget && closable) onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
