import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeOfDir } from '../helpers/anchor';

const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 2026-09-04：用户装了 1.2.6 客户端、派了三次「采我的 X」，全停在「去登记客户端」——
// 登记入口藏在默认折叠的设置组里，他从头到尾不知道在哪。用户要的是 Claude Code 式的权限提示：
// 「允许这台客户端操作浏览器采集？」在需要的时候出现在眼前，点允许就一直有效。
describe('🔒 桌面壳的「允许浏览器操作」提示', () => {
  it('挂在每一页的外壳里，而不是只在设置页深处', () => {
    const shell = code('components/TenantShell.tsx');
    expect(shell, '外壳没挂权限提示').toMatch(/<DesktopBrowserUsePrompt\s*\/>/);
    expect(shell).toMatch(/import \{ DesktopBrowserUsePrompt \}/);
  });

  it('提示走的是与设置页那张卡同一条登记链路（签令牌 → invoke 交给壳），令牌不落页面存储', () => {
    const src = code('components/DesktopBrowserUsePrompt.tsx');
    expect(src).toMatch(/actIssueIngestToken\(false, \{ agent: 'desktop' \}\)/);
    expect(src).toMatch(/invoke\('register_executor'/);
    expect(src).toMatch(/invoke\('executor_status'/);
    // 令牌绝不进 localStorage/sessionStorage/cookie（只有推迟时间戳可以进 localStorage）
    const stores = [...src.matchAll(/localStorage\.setItem\(([^,]+),/g)].map((m) => m[1].trim());
    expect(stores, '往 localStorage 写了别的东西').toEqual(['SNOOZE_KEY']);
    expect(src).not.toMatch(/sessionStorage|document\.cookie/);
    // 只在桌面壳里出现：浏览器里渲染为空
    expect(src).toMatch(/__TAURI_INTERNALS__/);
    expect(src).toMatch(/if \(!inDesktop \|\| !status\) return null/);
  });

  it('已登记出错时把执行器的报错摆出来（Chrome 开着没带端口只有用户能处理）', () => {
    const src = code('components/DesktopBrowserUsePrompt.tsx');
    expect(src).toMatch(/status\.registered && status\.lastError/);
    expect(src).toMatch(/desktop-browser-use-error/);
  });

  it('派不出去时的指引说的是这条提示，不再让用户去找设置页那张卡', () => {
    const vet = codeOfDir('lib/browser-task', (f) => f === 'vet.ts');
    expect(vet.match(/允许这台客户端操作浏览器采集/g)?.length ?? 0, 'vet 两处指引都要指向权限提示').toBeGreaterThanOrEqual(2);
    expect(code('lib/agent/context-accounts.ts')).toMatch(/允许这台客户端操作浏览器采集/);
    // 提示文案与指引要一字不差，用户才对得上
    expect(code('components/DesktopBrowserUsePrompt.tsx')).toMatch(/允许这台客户端操作浏览器采集？/);
  });
});
