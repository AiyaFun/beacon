import { describe, it, expect } from 'vitest';
import {
  isChunkLoadError,
  shouldReloadForChunkError,
  RELOAD_COOLDOWN_MS,
} from '@/lib/chunk-error';

describe('isChunkLoadError', () => {
  it('认得线上真实报的那条（2026-07-23 事故原文）', () => {
    const real = new Error(
      'Loading chunk 5515 failed.\n(error: https://beacon.iyunci.cn/_next/static/chunks/5515-dbe5cef2e63e9c5d.js)',
    );
    expect(isChunkLoadError(real)).toBe(true);
  });

  it('认得带路径段的 chunk 名（app/(public)/layout 这种）', () => {
    expect(
      isChunkLoadError(new Error('Loading chunk app/layout-8a891483a4920de1 failed.')),
    ).toBe(true);
  });

  it('webpack 标了 name=ChunkLoadError 时，即使 message 不匹配也认', () => {
    const err = Object.assign(new Error('随便什么文案'), { name: 'ChunkLoadError' });
    expect(isChunkLoadError(err)).toBe(true);
  });

  it('认得 CSS 分片与各浏览器动态 import 的说法', () => {
    expect(isChunkLoadError(new Error('Loading CSS chunk 42 failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /x.js'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
  });

  it('接受字符串入参（window.onerror 拿不到 error 对象时只有 message）', () => {
    expect(isChunkLoadError('Loading chunk 12 failed.')).toBe(true);
  });

  it('不把业务错误误判成分片失败——否则会把真问题刷掉，用户永远看不到原因', () => {
    expect(isChunkLoadError(new Error('额度已用尽，请升级套餐或配置自有 Key'))).toBe(false);
    expect(isChunkLoadError(new Error('权限不足：需要管理员角色'))).toBe(false);
    expect(isChunkLoadError(new Error('数据库连接失败'))).toBe(false);
    // 只是碰巧提到 chunk / 加载失败，但不是分片加载失败
    expect(isChunkLoadError(new Error('上传的 chunk 校验不通过'))).toBe(false);
    expect(isChunkLoadError(new Error('图片加载失败'))).toBe(false);
  });

  it('空值与畸形对象一律不认，不能因此触发刷新', () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError('')).toBe(false);
    expect(isChunkLoadError({})).toBe(false);
    expect(isChunkLoadError({ message: 123 })).toBe(false);
  });
});

describe('shouldReloadForChunkError（防无限刷新）', () => {
  const now = 1_800_000_000_000;

  it('从没刷过 → 刷', () => {
    expect(shouldReloadForChunkError(now, null)).toBe(true);
    expect(shouldReloadForChunkError(now, '')).toBe(true);
  });

  it('刚刷过 → 不刷（这是防死循环的关键：刷完仍失败就该露出错误卡片）', () => {
    expect(shouldReloadForChunkError(now, String(now - 1_000))).toBe(false);
    expect(shouldReloadForChunkError(now, String(now))).toBe(false);
  });

  it('冷却边界：正好等于冷却时间不刷，超过才刷', () => {
    expect(shouldReloadForChunkError(now, String(now - RELOAD_COOLDOWN_MS))).toBe(false);
    expect(shouldReloadForChunkError(now, String(now - RELOAD_COOLDOWN_MS - 1))).toBe(true);
  });

  it('隔了很久的再次失败视为新事故，允许再自愈一次', () => {
    expect(shouldReloadForChunkError(now, String(now - 3_600_000))).toBe(true);
  });

  it('脏值当作没刷过——宁可多刷一次，也不要卡死在错误页', () => {
    expect(shouldReloadForChunkError(now, 'abc')).toBe(true);
    expect(shouldReloadForChunkError(now, 'NaN')).toBe(true);
  });
});
