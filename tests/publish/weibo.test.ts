import { describe, it, expect } from 'vitest';
import { composeWeiboText, weiboAuthorizeUrl, weiboRedirectUri, WEIBO_MAX_CHARS } from '@/lib/publish/weibo';
import { PUBLISH_CAPS, capOf, channelOf } from '@/lib/publish/capability';
import { PLATFORMS } from '@/lib/constants';

// 微博接口直发。这一组守的是**微博自己定的三条规则**：
// 正文 ≤140 字、单图、正文里必须带一条应用安全域名下的链接。
// 前两条我们照做，第三条我们只能如实传达——回链由用户自己填，不塞我们的域名进去。

describe('正文整形：截断与回链', () => {
  it('回链一定在，且整条不超过上限', () => {
    const long = '啊'.repeat(300);
    const out = composeWeiboText(long, 'https://example.com/a');
    expect(out.endsWith('https://example.com/a')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(WEIBO_MAX_CHARS);
  });

  it('短文本不动它，只在末尾接回链', () => {
    const out = composeWeiboText('今天写了点东西', 'https://example.com/a');
    expect(out).toBe('今天写了点东西 https://example.com/a');
  });

  it('截断要留省略号，不许在句中硬切还装作完整', () => {
    const out = composeWeiboText('啊'.repeat(200), 'https://example.com/a');
    expect(out).toContain('…');
  });

  it('没有回链时不硬编一个出来（该由上层拦下，不是这里偷偷补）', () => {
    expect(composeWeiboText('正文', '')).toBe('正文');
  });
});

describe('授权链接', () => {
  it('回调地址走站点根地址，且 scope 只要发博文这一项', () => {
    const url = weiboAuthorizeUrl('APPKEY', 'st4te');
    expect(url).toContain('client_id=APPKEY');
    expect(url).toContain('state=st4te');
    expect(url).toContain('scope=statuses_update');
    expect(decodeURIComponent(url)).toContain(weiboRedirectUri());
    expect(weiboRedirectUri()).toMatch(/\/api\/auth\/weibo\/callback$/);
  });
});

describe('能力矩阵：加平台不许漏判断', () => {
  it('PLATFORMS 里的每个平台都在 PUBLISH_CAPS 里有一行', () => {
    for (const key of Object.keys(PLATFORMS)) {
      expect(Object.keys(PUBLISH_CAPS), `${key} 没有发布通道判断`).toContain(key);
    }
  });

  it('走接口的就这两家：公众号与微博（其余大陆平台的接口个人拿不到）', () => {
    const api = Object.keys(PUBLISH_CAPS).filter((p) => channelOf(p) === 'api');
    expect(api.sort()).toEqual(['wechat', 'weibo']);
  });

  it('每条通道都说得出「为什么是这条」，走不通的不许留空', () => {
    for (const key of Object.keys(PLATFORMS)) {
      expect(capOf(key).why.length, `${key} 没写通道理由`).toBeGreaterThan(10);
    }
  });

  it('微博那一行必须写明三条硬限制，否则用户会以为能发长文', () => {
    const why = capOf('weibo').why;
    expect(why).toContain('140');
    expect(why).toMatch(/单张|一张/);
    expect(why).toContain('安全域名');
  });

  it('插件填表的平台，填充脚本里必须真有选择器（不许承诺一个填不进去的通道）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'extension/content/publish-fill.js'),
      'utf8',
    );
    for (const [key, cap] of Object.entries(PUBLISH_CAPS)) {
      if (cap.channel !== 'extension') continue;
      expect(src, `${key} 标成了插件通道，但 publish-fill.js 里没有它的选择器`).toMatch(
        new RegExp(`^\\s{4}${key}: \\{`, 'm'),
      );
    }
  });
});
