import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { storeLinks, storeVersion, storeIsBehind, compareVersion, CHROME_STORE_URL, BROWSER_CARDS } from '@/lib/downloads';

// 插件分发的两条通道：Chrome 商店版（稳、滞后）+ 自托管 zip（最新、手动加载）。
// 这里钉死的是「上架之后不许把任一条通道弄丢」——2026-07-30 上架前的旧行为是
// 「env 没配 → 显示商店审核中」，那个状态现在只能由显式 off 触发。

const KEY = 'BEACON_EXT_STORE_CHROME';
const VKEY = 'BEACON_EXT_STORE_CHROME_VERSION';

describe('插件分发通道', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved[KEY] = process.env[KEY];
    saved[VKEY] = process.env[VKEY];
    delete process.env[KEY];
    delete process.env[VKEY];
  });
  afterEach(() => {
    for (const k of [KEY, VKEY]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it('没配 env 也给出正式商店链接（上架后不该退回「审核中」）', () => {
    expect(storeLinks().chrome).toBe(CHROME_STORE_URL);
    expect(CHROME_STORE_URL).not.toContain('authuser'); // 私人会话参数不能进代码
    expect(CHROME_STORE_URL).not.toContain('?');
  });

  it('env 可覆盖链接（换 item id）', () => {
    process.env[KEY] = 'https://example.com/x';
    expect(storeLinks().chrome).toBe('https://example.com/x');
  });

  it('只有显式 off/none 才关掉商店入口', () => {
    process.env[KEY] = 'off';
    expect(storeLinks().chrome).toBe('');
    process.env[KEY] = 'none';
    expect(storeLinks().chrome).toBe('');
    process.env[KEY] = '   ';
    expect(storeLinks().chrome).toBe(CHROME_STORE_URL); // 空白 = 没配，不是关闭
  });

  it('商店版本未登记时不下结论（宁可不说，也不猜成「已是最新」）', () => {
    expect(storeVersion()).toBeNull();
    expect(storeIsBehind('0.7.0')).toBeNull();
  });

  it('商店版本登记后能判断落后 / 齐平', () => {
    process.env[VKEY] = '0.6.4';
    expect(storeIsBehind('0.7.0')).toBe(true);
    expect(storeIsBehind('0.6.4')).toBe(false);
    expect(storeIsBehind(null)).toBeNull(); // zip 没打包时同样不下结论
  });

  it('版本比较按数字段逐位比，不是字符串比', () => {
    expect(compareVersion('0.9.0', '0.10.0')).toBe(-1); // 字符串比会判反
    expect(compareVersion('1.0', '1.0.0')).toBe(0);
    expect(compareVersion('0.7.1', '0.7.0')).toBe(1);
  });

  it('只有 Chrome 一张卡走商店，其余不许标商店状态', () => {
    const storeCards = BROWSER_CARDS.filter((c) => c.install === 'store');
    expect(storeCards.map((c) => c.key)).toEqual(['chrome']);
  });
});
