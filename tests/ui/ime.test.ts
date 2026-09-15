import { describe, it, expect } from 'vitest';
import { isComposingKey, COMPOSITION_GRACE_MS, type ImeState } from '@/lib/ime';

// 输入法组字期间的回车不能被当成「发送」。
// 三条判据对应三种真实浏览器行为，**每条都单独立一个用例**：
// 删掉其中任何一条，这里必须有用例变红（否则这份守卫就是假绿）。

const idle: ImeState = { composing: false, endedAt: -Infinity };

describe('isComposingKey', () => {
  it('普通回车（没在组字）照常发送', () => {
    expect(isComposingKey({ key: 'Enter', nativeEvent: { isComposing: false, keyCode: 13 } }, idle, 1_000_000)).toBe(false);
  });

  it('① Chromium：上屏那次带 isComposing=true', () => {
    expect(isComposingKey({ key: 'Enter', nativeEvent: { isComposing: true, keyCode: 13 } }, idle, 1_000_000)).toBe(true);
  });

  it('① Chromium 老引擎：keyCode 229', () => {
    expect(isComposingKey({ key: 'Enter', nativeEvent: { keyCode: 229 } }, idle, 1_000_000)).toBe(true);
  });

  // 单独立判据：不借 229、也不借 isComposing，否则删掉这一条也不会变红（假绿）
  it('① Chromium：key 被标成 Process', () => {
    expect(isComposingKey({ key: 'Process', nativeEvent: { isComposing: false, keyCode: 13 } }, idle, 1_000_000)).toBe(true);
  });

  it('③ 组字进行中（compositionend 还没来）', () => {
    expect(isComposingKey({ key: 'Enter', nativeEvent: { isComposing: false, keyCode: 13 } }, { composing: true, endedAt: -Infinity }, 1_000_000)).toBe(true);
  });

  // ② WebKit（Safari / Mac 桌面壳的 WKWebView）：compositionend 先于 keydown，
  // 到 keydown 时三个字段全都长得像一次普通回车——这一条是本次线上缺陷的真身。
  it('② WebKit：compositionend 刚发生，紧跟的回车算上屏不算发送', () => {
    const justEnded: ImeState = { composing: false, endedAt: 1_000_000 };
    expect(isComposingKey({ key: 'Enter', nativeEvent: { isComposing: false, keyCode: 13 } }, justEnded, 1_000_000 + 1)).toBe(true);
  });

  it('② 宽限期一过就恢复成发送：上屏之后再按一次回车要真的派活', () => {
    const justEnded: ImeState = { composing: false, endedAt: 1_000_000 };
    const after = 1_000_000 + COMPOSITION_GRACE_MS;
    expect(isComposingKey({ key: 'Enter', nativeEvent: { isComposing: false, keyCode: 13 } }, justEnded, after)).toBe(false);
  });

  it('宽限期短于人连按两次回车的间隔（120ms）', () => {
    expect(COMPOSITION_GRACE_MS).toBeLessThan(120);
  });

  it('从没组过字时不受宽限期影响（小时间戳下也不能把回车吞掉）', () => {
    expect(isComposingKey({ key: 'Enter', nativeEvent: { isComposing: false, keyCode: 13 } }, idle, 10)).toBe(false);
  });
});
