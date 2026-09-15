'use client';

import { useCallback, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

// ── 输入法「组字中」的回车不是发送 ──────────────────────────────────────────
//
// 【这修的是什么】中文输入法打字时，回车有两种完全不同的意思：
//   · 组字中按回车 = 上屏（选中候选词，或把敲的英文字母原样输出）；
//   · 组字结束后按回车 = 发送。
// 只判 `e.key === 'Enter'` 的输入框会把前者也当成发送——用户想打一串英文，
// 按回车让字母上屏，任务就已经派出去了（2026-09-09 用户在首页实际踩到）。
//
// 【为什么要三条判据一起用】三种浏览器行为不一样，少一条就漏一种：
//   ① Chromium：上屏那次 keydown 的 `key` 是 'Process'、`keyCode` 是 229、
//      `isComposing` 是 true——前两条各自都拦得住；
//   ② WebKit（Safari 与 Mac 桌面壳的 WKWebView）：`compositionend` **先于** keydown 派发，
//      到 keydown 时 `isComposing` 已经是 false、`key` 就是 'Enter'、`keyCode` 就是 13。
//      ①的两条在这里全部失效，只能靠「刚刚是不是才结束组字」来认；
//   ③ 少数输入法组字期间不带 `isComposing`，只能靠 compositionstart 自己记状态。
//
// 【宽限期为什么是 50ms】②里 compositionend 与 keydown 属于同一次按键，间隔近似 0；
// 而人连按两下回车（先上屏、再发送）的间隔通常在 120ms 以上。50ms 盖得住同一次按键，
// 又不会吞掉「上屏之后马上回车发送」这个正常操作。

/** compositionend 之后多久之内的回车仍算「上屏」，不算发送。 */
export const COMPOSITION_GRACE_MS = 50;

export type ImeState = {
  /** compositionstart 到 compositionend 之间 */
  composing: boolean;
  /** 最近一次 compositionend 的时刻（毫秒时间戳）。
   *  从未组过字时是 -Infinity 而不是 0：0 会让「现在 - 0 < 宽限期」在小时间戳下成立，
   *  把一次本该发送的回车吞掉（真实浏览器里 Date.now() 很大所以不会发生，但别把正确性寄托在这上面）。 */
  endedAt: number;
};

type KeyLike = {
  key?: string;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};

/**
 * 这一次按键是不是输入法组字造成的（纯函数，便于单测）。
 *
 * `now` 只为测试可注入；生产调用不传，用当前时刻。
 */
export function isComposingKey(e: KeyLike, state: ImeState, now: number = Date.now()): boolean {
  // ① Chromium：上屏键被标成 Process / 229 / isComposing
  if (e.nativeEvent?.isComposing) return true;
  if (e.nativeEvent?.keyCode === 229) return true;
  if (e.key === 'Process') return true;
  // ③ 组字过程中（compositionend 还没来）
  if (state.composing) return true;
  // ② WebKit：compositionend 刚刚才发生，紧跟着的这次回车是同一次按键
  return now - state.endedAt < COMPOSITION_GRACE_MS;
}

/**
 * 给「回车即发送」的输入框用：把 `composition` 展开到元素上，在 onKeyDown 里先问 `isComposing(e)`。
 *
 * ```tsx
 * const ime = useImeGuard();
 * <textarea {...ime.composition} onKeyDown={(e) => {
 *   if (e.key !== 'Enter' || ime.isComposing(e)) return;
 *   ...
 * }} />
 * ```
 */
export function useImeGuard() {
  const state = useRef<ImeState>({ composing: false, endedAt: -Infinity });

  const onCompositionStart = useCallback(() => {
    state.current.composing = true;
  }, []);

  const onCompositionEnd = useCallback(() => {
    state.current.composing = false;
    state.current.endedAt = Date.now();
  }, []);

  const isComposing = useCallback((e: ReactKeyboardEvent) => isComposingKey(e as KeyLike, state.current), []);

  return { composition: { onCompositionStart, onCompositionEnd }, isComposing };
}
