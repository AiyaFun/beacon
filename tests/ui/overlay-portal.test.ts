import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// 「全屏弹层被关进卡片里」的源码级守卫。
//
// 【为什么必须是源码级】globals.css 的 `.card:hover` 会给卡片加 `transform: translateY(-2px)`，
// 而带 transform 的元素是后代 `position: fixed` 的**包含块**——就地渲染的 `inset: 0` 遮罩
// 会缩成卡片那么大。这个缺陷有三个性质，合起来使它必须靠静态检查兜住：
//   ① **只在指针悬停于祖先卡片时出现**。本地随手点常常撞不到；
//   ② 而用户**永远**是从卡片里的按钮点进来的，指针必然停在卡片上——他每次都撞；
//   ③ 计费页那张「当前生效套餐」卡带 `.card-selected-gradient`，transform 是**常驻**的，
//      连悬停都不需要，扫码支付层 100% 缩在卡片里。
// 2026-08-07 体检时 Checkout / RefundButton 两处都还是就地渲染，正好长在**付款**这条路上。
// 渲染态测试证不了这件事（jsdom 不做布局、量不出包含块），所以判据取源码。
//
// 规矩：任何 `position: fixed` + `inset: 0` 的遮罩一律走 components/Overlay.tsx
//（内部 createPortal 到 body，顺带统一 Esc 关闭 / 点遮罩关闭 / 锁背景滚动）。

// 允许就地渲染的例外。加进来必须写清楚**为什么它不是弹层**。
const ALLOW = new Map<string, string>([
  // 透明点击捕获层，不是弹层：下拉本体是 position:absolute，靠铃铛按钮定位，
  // portal 出去反而会失去定位基准。它没有内容，缩了也不影响任何东西。
  ['components/NotificationBell.tsx', '通知下拉的点击捕获层（下拉本体是 absolute，不能 portal）'],
]);

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

// 行内 style 对象里同时出现 `position: 'fixed'` 与 `inset: 0` ⇒ 一个全屏遮罩。
// 只认行内样式：走 CSS 类的（.overlay-scrim）本来就是 Overlay 自己。
function hasInlineFullscreenScrim(src: string): boolean {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return /position:\s*'fixed'/.test(noComments) && /inset:\s*0\b/.test(noComments);
}

describe('全屏弹层一律 portal 到 body（不许被 .card 的 transform 关进卡片）', () => {
  const root = process.cwd();
  const files = [...tsxFiles(join(root, 'app')), ...tsxFiles(join(root, 'components'))];

  it('扫到了源码（守卫本身没有因为路径写错而空跑）', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('🔒 没有任何组件就地渲染 position:fixed + inset:0 的遮罩', () => {
    const offenders = files
      .map((f) => relative(root, f))
      .filter((rel) => !ALLOW.has(rel))
      .filter((rel) => hasInlineFullscreenScrim(readFileSync(join(root, rel), 'utf8')));

    expect(
      offenders,
      `这些组件就地渲染了全屏遮罩，请改用 components/Overlay.tsx：\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('🔒 计费页的两个弹层用的是 Overlay（付款/退款这条路不许再踩）', () => {
    for (const f of ['app/(app)/billing/Checkout.tsx', 'app/(app)/billing/RefundButton.tsx']) {
      const src = readFileSync(join(root, f), 'utf8');
      expect(src, `${f} 必须从 components/Overlay 引入 Overlay`).toContain("from '@/components/Overlay'");
      expect(src, `${f} 必须用 <Overlay> 包住弹层`).toContain('<Overlay');
    }
  });

  it('例外清单里的每一项都写了理由（不许无声地加白名单）', () => {
    for (const [file, reason] of ALLOW) {
      expect(reason.length, `${file} 的例外理由太短`).toBeGreaterThan(10);
    }
  });
});
