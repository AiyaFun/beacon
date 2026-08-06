import { describe, it, expect } from 'vitest';
import { platformOfLink, storablePlatform } from '@/lib/clip/platform';

// 资讯链接 → 平台 + 「服务器能不能直接抓」。
//
// 这张表不是可以试试看的事：小红书/抖音的正文靠 JS 渲染、微信对机房 IP 返回验证页，
// 服务端去抓**必然**失败。写死在表里是为了不让用户白等 10 秒再收到一句「解析失败」。

describe('platformOfLink · 认平台', () => {
  it.each([
    ['https://mp.weixin.qq.com/s/abc', '微信公众号', 'wechat'],
    ['https://www.xiaohongshu.com/explore/123', '小红书', 'xiaohongshu'],
    ['https://www.douyin.com/video/123', '抖音', 'douyin'],
    ['https://www.bilibili.com/video/BV1x', 'B站', 'bilibili'],
    ['https://x.com/someone/status/1', 'X', 'x'],
    ['https://www.youtube.com/watch?v=abc', 'YouTube', 'youtube'],
    ['https://www.tiktok.com/@a/video/7123456789012345678', 'TikTok', 'tiktok'],
    ['https://www.toutiao.com/article/123', '头条号', null],
    ['https://zhuanlan.zhihu.com/p/123', '知乎', null],
  ])('%s → %s', (url, name, key) => {
    const p = platformOfLink(url);
    expect(p.name).toBe(name);
    expect(p.key).toBe(key);
  });

  it('🔒 国内内容平台一律标为「服务器抓不到」，并给出可执行指引', () => {
    for (const u of [
      'https://mp.weixin.qq.com/s/x',
      'https://www.xiaohongshu.com/explore/1',
      'https://www.douyin.com/video/1',
      'https://x.com/a/status/1',
      'https://www.bilibili.com/video/BV1',
      'https://www.youtube.com/watch?v=1',
      'https://www.tiktok.com/@a/video/7123456789012345678',
    ]) {
      const p = platformOfLink(u);
      expect(p.canFetch).toBe(false);
      expect(p.hint && p.hint.length).toBeGreaterThan(10); // 必须告诉用户下一步做什么
    }
  });

  it('普通网页/资讯站默认可抓', () => {
    expect(platformOfLink('https://36kr.com/p/123').canFetch).toBe(true);
    expect(platformOfLink('https://example.com/post').canFetch).toBe(true);
    expect(platformOfLink('https://blog.someone.dev/a').canFetch).toBe(true);
  });

  it('URL 不合法也不抛（群里什么都可能发进来）', () => {
    expect(() => platformOfLink('随便一段话')).not.toThrow();
    expect(platformOfLink('随便一段话').canFetch).toBe(true);
  });

  it('storablePlatform 只回 PLATFORMS 里认的 key，其余为 null（不写脏平台值）', () => {
    expect(storablePlatform('https://mp.weixin.qq.com/s/x')).toBe('wechat');
    expect(storablePlatform('https://www.toutiao.com/a/1')).toBeNull();
    expect(storablePlatform('https://example.com/a')).toBeNull();
  });
});
