import { describe, it, expect } from 'vitest';
import { parseCompetitorUrl, competitorHomeUrl } from '@/lib/competitor-url';

// 加竞对「粘链接自动识别」的解析器。纯函数，客户端表单与服务端共用。

describe('parseCompetitorUrl · 识别主流平台主页链接', () => {
  const cases: Array<[string, string, string]> = [
    ['https://space.bilibili.com/598464467', 'bilibili', '598464467'],
    ['https://space.bilibili.com/598464467/video', 'bilibili', '598464467'], // 带子路径
    ['space.bilibili.com/123', 'bilibili', '123'], // 不带协议
    ['https://m.bilibili.com/space/456', 'bilibili', '456'], // 移动端
    ['https://www.douyin.com/user/MS4wLjABAAAA-abc_123', 'douyin', 'MS4wLjABAAAA-abc_123'],
    ['https://www.douyin.com/user/MS4wLjABAAAA?from=search', 'douyin', 'MS4wLjABAAAA'], // 带 query
    ['https://www.xiaohongshu.com/user/profile/5ff0a1b2000000000101abcd', 'xiaohongshu', '5ff0a1b2000000000101abcd'],
    ['https://www.youtube.com/@MrBeast', 'youtube', '@MrBeast'],
    ['https://www.youtube.com/channel/UCabc123', 'youtube', 'UCabc123'],
    ['https://youtube.com/c/somechannel', 'youtube', 'somechannel'],
    ['https://x.com/elonmusk', 'x', 'elonmusk'],
    ['https://twitter.com/jack', 'x', 'jack'],
    ['https://x.com/@handleform', 'x', 'handleform'], // 容忍 @ 前缀
    ['https://www.tiktok.com/@mrbeast', 'tiktok', 'mrbeast'], // 存不带 @ 的 unique_id
    ['https://www.tiktok.com/@mrbeast/video/7123456789012345678', 'tiktok', 'mrbeast'], // 作品页也认得出主人
  ];
  for (const [url, platform, handle] of cases) {
    it(`${url} → ${platform}/${handle}`, () => {
      expect(parseCompetitorUrl(url)).toEqual({ platform, handle });
    });
  }
});

describe('parseCompetitorUrl · 拒绝无法离线识别的输入', () => {
  const rejects = [
    '', '   ',
    'https://v.douyin.com/abcXYZ/', // 抖音短链（需跟随重定向）
    'https://xhslink.com/abcd', // 小红书短链
    'https://b23.tv/xxxx', // B站短链
    'https://x.com/home', // 站内功能页非用户名
    'https://x.com/search', // 保留字
    'https://www.douyin.com/discover', // 非用户页
    'https://space.bilibili.com/', // 缺 mid
    'https://weibo.com/u/123', // 未支持平台
    '不是链接',
  ];
  for (const url of rejects) {
    it(`拒绝：${JSON.stringify(url)}`, () => {
      expect(parseCompetitorUrl(url)).toBeNull();
    });
  }
});

describe('competitorHomeUrl · 与解析互为逆运算', () => {
  it('三平台 handle → URL → 解析回原 handle', () => {
    for (const [platform, handle] of [
      ['bilibili', '598464467'],
      ['douyin', 'MS4wLjABAAAA-x'],
      ['xiaohongshu', '5ff0a1b2000000000101abcd'],
      ['x', 'elonmusk'],
      ['youtube', '@MrBeast'],
      ['tiktok', 'mrbeast'],
    ] as const) {
      const url = competitorHomeUrl(platform, handle)!;
      expect(parseCompetitorUrl(url)).toEqual({ platform, handle });
    }
  });
  it('YouTube 频道ID 也能拼 URL', () => {
    expect(competitorHomeUrl('youtube', 'UCX6OQ3DkcsbYNE6H8uQQuVA')).toBe(
      'https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA',
    );
  });
  it('不可拼 URL 的平台返回 null', () => {
    expect(competitorHomeUrl('wechat', 'x')).toBeNull(); // 公众号无公开主页，插件采不了
  });
});
