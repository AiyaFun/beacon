import { describe, it, expect } from 'vitest';
import { parsePublishUrl, resolvePlatformItemId, publicItemUrl } from '@/lib/publish/parse-url';
import { PLATFORMS } from '@/lib/constants';

// 发布链接解析（PRD §6 F7-1 AC①）。
//
// 这个文件的存在理由：platformItemId 是 lib/jobs/handlers.ts backfill_metrics 的**唯一入口**
// （where: { platformItemId: { not: null } }），而它拿到的 ID 会被直接送去平台 API 匹配作品。
// 所以本文件锁死的不是「能不能解析」，而是两件更要命的事：
//   1. 解析出的 ID 与 lib/adapters/competitor-real.ts 各适配器的 ID 口径**同源**（否则永远匹配不上）；
//   2. 认不出的时候**返回失败而不是猜一个 ID**（猜错会去拉别人的作品数据 → 一条以假乱真的脏数据）。

// 断言解析成功且 ID 正确的小助手
function expectId(raw: string, platform: string, id: string) {
  const r = parsePublishUrl(raw);
  expect(r, `应解析成功: ${raw}`).toMatchObject({ ok: true, platform, platformItemId: id });
}
function expectFail(raw: string, reason?: string) {
  const r = parsePublishUrl(raw);
  expect(r.ok, `应解析失败: ${raw}`).toBe(false);
  if (reason && !r.ok) expect(r.reason).toBe(reason);
  return r;
}

describe('抖音 · aweme_id（与 TikHubAdapter 的 it.aweme_id 同口径）', () => {
  it('作品详情页', () => {
    expectId('https://www.douyin.com/video/7065264218437717285', 'douyin', '7065264218437717285');
  });
  it('图文 note 页', () => {
    expectId('https://www.douyin.com/note/7123456789012345678', 'douyin', '7123456789012345678');
  });
  it('iesdouyin 分享页（带一堆 utm 参数）', () => {
    expectId(
      'https://www.iesdouyin.com/share/video/6883418578486349070/?region=CN&mid=123&u_code=0&titleType=title&utm_source=copy&utm_campaign=client_share',
      'douyin',
      '6883418578486349070',
    );
  });
  it('个人页作品浮层 modal_id', () => {
    expectId('https://www.douyin.com/user/MS4wLjABAAAAxyz?modal_id=7123456789012345678', 'douyin', '7123456789012345678');
  });
  it('播放器嵌入码 vid', () => {
    expectId('https://open.douyin.com/player/video?vid=7123456789012345678&autoplay=0', 'douyin', '7123456789012345678');
  });
  it('个人主页（无作品 ID）→ 失败，不能拿 sec_uid 当作品 ID', () => {
    expectFail('https://www.douyin.com/user/MS4wLjABAAAAxyz', 'no-item-id');
  });
});

describe('小红书 · note_id（与 TikHubAdapter 的 it.note_id 同口径）', () => {
  it('explore 页', () => {
    expectId('https://www.xiaohongshu.com/explore/66c31bc4000000001d03b63d', 'xiaohongshu', '66c31bc4000000001d03b63d');
  });
  it('explore 页带 xsec_token（登录态票据，不进 ID）', () => {
    expectId(
      'https://www.xiaohongshu.com/explore/66c31bc4000000001d03b63d?xsec_token=GBF7Fsgu9eGqN4a5BDROj3mRAw8BoUaaGF2b6fJzhLpeo%3D&xsec_source=pc_feed',
      'xiaohongshu',
      '66c31bc4000000001d03b63d',
    );
  });
  it('discovery/item 页', () => {
    expectId('https://www.xiaohongshu.com/discovery/item/65a1b2c3000000001e03a1b2', 'xiaohongshu', '65a1b2c3000000001e03a1b2');
  });
  it('user/profile/<uid>/<noteId>：uid 与 noteId 同为 24 位十六进制，必须取后者', () => {
    // 靠形态区分不了，只能靠位置。取错就是拿作者 ID 当作品 ID 去回流。
    expectId(
      'https://www.xiaohongshu.com/user/profile/5f3a1b2c000000000101aaaa/65a1b2c3000000001e03a1b2?xsec_token=ABC',
      'xiaohongshu',
      '65a1b2c3000000001e03a1b2',
    );
  });
  it('只有作者主页 → 失败，绝不把 uid 当 note_id', () => {
    const r = expectFail('https://www.xiaohongshu.com/user/profile/5f3a1b2c000000000101aaaa', 'no-item-id');
    if (!r.ok) expect(r.platform).toBe('xiaohongshu');
  });
});

describe('B站 · bvid（与 BilibiliAdapter 的 v.bvid 同口径）', () => {
  it('视频页', () => {
    expectId('https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili', 'BV1xx411c7mD');
  });
  it('带分 P 与追踪参数', () => {
    expectId('https://www.bilibili.com/video/BV1GJ411x7h7?p=2&spm_id_from=333.1007&vd_source=abc', 'bilibili', 'BV1GJ411x7h7');
  });
  it('移动版', () => {
    expectId('https://m.bilibili.com/video/BV1GJ411x7h7', 'bilibili', 'BV1GJ411x7h7');
  });
  it('b23.tv 短链但 BV 明写在 path 里 → 无需跟随跳转即可解析', () => {
    expectId('https://b23.tv/BV1xx411c7mD', 'bilibili', 'BV1xx411c7mD');
  });
  it('av 号 → 失败。av→BV 需要 base58 码表，算错会得到「合法但属于别人」的 BV', () => {
    const r = expectFail('https://www.bilibili.com/video/av170001', 'no-item-id');
    if (!r.ok) expect(r.message).toContain('BV');
  });
});

describe('公众号 · 文章 URL（与 NewRankAdapter 的 a.url 同口径）', () => {
  it('/s/<token> 短 token 形态', () => {
    expectId(
      'https://mp.weixin.qq.com/s/AbCdEf123456_xyz',
      'wechat',
      'https://mp.weixin.qq.com/s/AbCdEf123456_xyz',
    );
  });
  it('/s/<token> 带 chksm/scene 等分享追踪参数 → 规范化时丢弃', () => {
    expectId(
      'https://mp.weixin.qq.com/s/AbCdEf123456_xyz?chksm=abcd1234&scene=126&sessionid=1700000000',
      'wechat',
      'https://mp.weixin.qq.com/s/AbCdEf123456_xyz',
    );
  });
  it('__biz 四件套形态 → 只保留定位所需的 4 个参数', () => {
    expectId(
      'https://mp.weixin.qq.com/s?__biz=MzA5MTUzOTQ5MQ%3D%3D&mid=2650123456&idx=1&sn=abc123def456&chksm=xyz&scene=27',
      'wechat',
      'https://mp.weixin.qq.com/s?__biz=MzA5MTUzOTQ5MQ==&mid=2650123456&idx=1&sn=abc123def456',
    );
  });
  it('__biz 四件套缺 sn → 定位不到唯一文章，失败而非硬凑', () => {
    expectFail('https://mp.weixin.qq.com/s?__biz=MzA5MTUzOTQ5MQ==&mid=2650123456&idx=1', 'no-item-id');
  });
});

// 视频号没有官方适配器，platformItemId 的唯一对齐对象是插件
// （extension/content/shipinhao.js）从创作者后台读到的同名字段。两边同口径是这里的全部意义。
describe('视频号 · 作品 export id（与插件 shipinhao.js 同口径）', () => {
  it('网页版分享链 ?eid=', () => {
    expectId(
      'https://channels.weixin.qq.com/web/pages/feed?eid=Ab1_Cd2-Ef3gH4iJ5kL6',
      'shipinhao',
      'Ab1_Cd2-Ef3gH4iJ5kL6',
    );
  });
  it('创作者后台详情页 ?objectId=（nonce 等其余参数丢弃）', () => {
    expectId(
      'https://channels.weixin.qq.com/platform/post/detail?objectId=Ab1_Cd2-Ef3gH4iJ5kL6&objectNonceId=xyz789',
      'shipinhao',
      'Ab1_Cd2-Ef3gH4iJ5kL6',
    );
  });
  it('canonical 统一成网页版分享链形态', () => {
    const r = parsePublishUrl('https://channels.weixin.qq.com/platform/post/detail?objectId=Ab1_Cd2-Ef3gH4iJ5kL6');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonicalUrl).toBe('https://channels.weixin.qq.com/web/pages/feed?eid=Ab1_Cd2-Ef3gH4iJ5kL6');
  });
  it('创作者后台首页/列表页没有作品 ID → 失败而非拿栏目名硬凑', () => {
    const r = expectFail('https://channels.weixin.qq.com/platform/post/list', 'no-item-id');
    if (!r.ok) expect(r.platform).toBe('shipinhao');
  });
  it('ID 形态不合法（太短）→ 失败', () => {
    expectFail('https://channels.weixin.qq.com/web/pages/feed?eid=abc', 'no-item-id');
  });
  // 同为 *.weixin.qq.com，但公众号与视频号是两个平台、两套 ID 口径，串台会把数据挂错平台
  it('不与公众号串台：mp.weixin.qq.com 仍是 wechat', () => {
    const r = parsePublishUrl('https://mp.weixin.qq.com/s/AbCdEf123456_xyz');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.platform).toBe('wechat');
  });
  it('平台不一致时不返回 ID（视频号链接挂到公众号记录上 = 脏数据）', () => {
    const r = resolvePlatformItemId('https://channels.weixin.qq.com/web/pages/feed?eid=Ab1_Cd2-Ef3gH4iJ5kL6', 'wechat');
    expect(r.platformItemId).toBeNull();
    expect(r.warning).toBeTruthy();
  });
});

describe('X · tweet id（与 TwitterApiAdapter 的 t.id 同口径）', () => {
  it('x.com', () => {
    expectId('https://x.com/elonmusk/status/1712345678901234567', 'x', '1712345678901234567');
  });
  it('twitter.com 旧域名', () => {
    expectId('https://twitter.com/jack/status/20', 'x', '20');
  });
  it('mobile.twitter.com', () => {
    expectId('https://mobile.twitter.com/someone/status/1712345678901234567', 'x', '1712345678901234567');
  });
  it('/i/web/status/ 形态', () => {
    expectId('https://x.com/i/web/status/1712345678901234567', 'x', '1712345678901234567');
  });
  it('带 /photo/1 与 ?s=20 参数', () => {
    expectId('https://x.com/someone/status/1712345678901234567/photo/1?s=20&t=abcdef', 'x', '1712345678901234567');
  });
  it('个人主页 → 失败', () => {
    expectFail('https://x.com/elonmusk', 'no-item-id');
  });
});

describe('YouTube · videoId（与 YouTubeAdapter 的 contentDetails.videoId 同口径）', () => {
  it('watch?v=', () => {
    expectId('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ');
  });
  it('watch 带播放列表与时间戳参数', () => {
    expectId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc&index=3&t=42s', 'youtube', 'dQw4w9WgXcQ');
  });
  it('youtu.be 短链：ID 明写在 path 里，无需网络请求', () => {
    expectId('https://youtu.be/dQw4w9WgXcQ?t=42', 'youtube', 'dQw4w9WgXcQ');
  });
  it('shorts', () => {
    expectId('https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ');
  });
  it('live', () => {
    expectId('https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', 'youtube', 'dQw4w9WgXcQ');
  });
  it('embed', () => {
    expectId('https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ');
  });
  it('m.youtube.com', () => {
    expectId('https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ');
  });
  it('频道页 → 失败，@handle 不是 videoId', () => {
    expectFail('https://www.youtube.com/@somechannel', 'no-item-id');
  });
});

describe('短链 · 诚实降级（不发网络请求跟随跳转）', () => {
  it.each([
    ['https://v.douyin.com/iRxNvHmA/', 'douyin'],
    ['http://xhslink.com/a/AbCdEf', 'xiaohongshu'],
    ['https://b23.tv/aBcDeFg', 'bilibili'],
    ['https://t.co/AbCdEf1234', 'x'],
  ])('%s → shortlink 失败 + 认出平台 + 教用户怎么办', (raw, platform) => {
    const r = parsePublishUrl(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('shortlink');
      expect(r.platform).toBe(platform); // 平台认得出，ID 认不出
      expect(r.message).toMatch(/完整链接/); // 必须给可读的中文出路
    }
  });
});

describe('垃圾输入 · 绝不瞎猜 ID', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['随便写点什么', 'no-url'],
    ['12345678901234567', 'no-url'], // 光一串数字：像 aweme_id，但不知道是哪个平台的 → 不猜
    ['javascript:alert(1)', 'no-url'],
    ['ftp://www.douyin.com/video/7123456789012345678', 'no-url'], // 非 http(s)
    ['https://example.com/video/7123456789012345678', 'unknown-host'],
    ['https://douyin.com.evil.com/video/7123456789012345678', 'unknown-host'], // 域名后缀伪装
    ['https://not-youtube.com/watch?v=dQw4w9WgXcQ', 'unknown-host'],
  ])('%s → %s', (raw, reason) => {
    const r = parsePublishUrl(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });

  it('长度不对的 YouTube ID 不接受（11 位是定长）', () => {
    expectFail('https://www.youtube.com/watch?v=short', 'no-item-id');
    expectFail('https://www.youtube.com/watch?v=waaaaaaaaytoolong', 'no-item-id');
  });
  it('长度不对的 BV 不接受', () => {
    expectFail('https://www.bilibili.com/video/BV1xx', 'no-item-id');
  });
  it('非 24 位的小红书 ID 不接受', () => {
    expectFail('https://www.xiaohongshu.com/explore/66c31bc4', 'no-item-id');
  });
  it('抖音 ID 里混字母不接受', () => {
    expectFail('https://www.douyin.com/video/71234567890abcdef', 'no-item-id');
  });
});

describe('容错 · 用户实际会粘贴的东西', () => {
  it('抖音 App 分享口令里抠出链接', () => {
    expectId(
      '7.86 gJK:/ 复制打开抖音，看看【某某的作品】 https://www.douyin.com/video/7065264218437717285 复制此链接，打开Dou音搜索',
      'douyin',
      '7065264218437717285',
    );
  });
  it('无协议裸链（从地址栏拷的常见形态）', () => {
    expectId('www.douyin.com/video/7065264218437717285', 'douyin', '7065264218437717285');
  });
  it('前后空白', () => {
    expectId('  https://youtu.be/dQw4w9WgXcQ  ', 'youtube', 'dQw4w9WgXcQ');
  });
  it('大写域名', () => {
    expectId('HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ');
  });
});

describe('resolvePlatformItemId · 发布登记的平台一致性闸门', () => {
  it('平台一致 → 返回 ID，无告警', () => {
    const r = resolvePlatformItemId('https://www.douyin.com/video/7065264218437717285', 'douyin');
    expect(r).toEqual({ platformItemId: '7065264218437717285' });
  });

  it('平台不一致 → 丢弃 ID 并告警。把抖音 aweme_id 挂到小红书记录上，回流就会拿它去小红书匹配', () => {
    const r = resolvePlatformItemId('https://www.douyin.com/video/7065264218437717285', 'xiaohongshu');
    expect(r.platformItemId).toBeNull();
    expect(r.warning).toContain('不一致');
  });

  it('解析失败 → 不阻断（返回 null 而不是抛错），但必须告知「自动回流将不可用」', () => {
    const r = resolvePlatformItemId('https://v.douyin.com/iRxNvHmA/', 'douyin');
    expect(r.platformItemId).toBeNull();
    expect(r.warning).toContain('自动回流将不可用');
  });
});

describe('纯函数 · 零网络', () => {
  it('解析全程不碰 fetch（短链降级的前提就是这个）', () => {
    const original = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (() => {
      called++;
      throw new Error('parse-url 不应发起任何网络请求');
    }) as typeof fetch;
    try {
      for (const raw of [
        'https://v.douyin.com/iRxNvHmA/',
        'https://xhslink.com/a/AbCdEf',
        'https://b23.tv/aBcDeFg',
        'https://t.co/AbCdEf1234',
        'https://www.douyin.com/video/7065264218437717285',
        'https://mp.weixin.qq.com/s/AbCdEf123456_xyz',
      ]) {
        parsePublishUrl(raw);
      }
    } finally {
      globalThis.fetch = original;
    }
    expect(called).toBe(0);
  });

  it('同一输入恒等（无隐藏状态）', () => {
    const a = parsePublishUrl('https://www.bilibili.com/video/BV1xx411c7mD');
    const b = parsePublishUrl('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(a).toEqual(b);
  });
});

// publicItemUrl 是 parsePublishUrl 的逆运算。它存在的理由很实在：PublishRecord 里没有 url 列，
// 插件回填的 url 收下就丢了 —— 于是 /data 上的每条记录都只有一个标题，点不开、没法核对。
// 从 platformItemId 现算的好处是**存量记录立刻就有链接**，不用为历史数据补一列。
describe('publicItemUrl · platformItemId → 作品详情页链接', () => {
  const cases: [string, string][] = [
    ['douyin', 'https://www.douyin.com/video/7065264218437717285'],
    ['xiaohongshu', 'https://www.xiaohongshu.com/explore/65a1b2c3000000001e03a1b2'],
    ['bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD'],
    ['x', 'https://x.com/i/web/status/1712345678901234567'],
    ['youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['wechat', 'https://mp.weixin.qq.com/s/AbCdEf123456_xyz'],
    ['shipinhao', 'https://channels.weixin.qq.com/web/pages/feed?eid=Ab1_Cd2-Ef3gH4iJ5kL6'],
    // TikTok 的详情页地址要带作者名，而 publicItemUrl 手里只有 ID → 退到只由 ID 决定的
    // 嵌入播放页；parseTiktok 也认这个形态，两边才互逆。
    // ⚠️ 2026-08-13 之前这一行**根本不在**：`cases` 是手抄的 7 个平台，漏了 tiktok。
    //    于是「改坏 TIKTOK_ID、或把 publicItemUrl 的 tiktok 分支改回 @author/video/ 形态」
    //    这两种破坏都不会红，而用户在 /data 上点 TikTok 记录会得到 404。
    ['tiktok', 'https://www.tiktok.com/embed/v2/7123456789012345678'],
  ];

  // 手抄的清单会漏——这条把它钉死在 PLATFORMS 上：新加一个平台而不补往返用例，直接红。
  it('🔒 每个平台都在往返用例里（新增平台不许漏掉这条）', () => {
    const covered = new Set(cases.map(([p]) => p));
    for (const key of Object.keys(PLATFORMS)) {
      expect(covered.has(key), `平台 ${key} 没有 publicItemUrl 往返用例`).toBe(true);
    }
  });

  it('🔒 与 parsePublishUrl 互为逆运算（往返逐字符相同）', () => {
    for (const [platform, url] of cases) {
      const parsed = parsePublishUrl(url);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.platform).toBe(platform);
      // 解析出 ID → 再算回链接，必须回到原地；对不上就说明两边口径漂了
      expect(publicItemUrl(platform, parsed.platformItemId)).toBe(url);
    }
  });

  it('🔒 形态过不了校验就返回 null —— 不拼一个点开是 404 的链接出来', () => {
    expect(publicItemUrl('douyin', 'not-a-number')).toBeNull();
    expect(publicItemUrl('bilibili', 'BV1')).toBeNull();
    expect(publicItemUrl('xiaohongshu', 'zzz')).toBeNull();
    expect(publicItemUrl('youtube', 'tooshort')).toBeNull();
    // 公众号的 ID 就是 URL，但库里可能存着历史遗留的任意字符串，必须回过一遍解析
    expect(publicItemUrl('wechat', '随手记的一句话')).toBeNull();
    expect(publicItemUrl('wechat', 'https://mp.weixin.qq.com/s?__biz=A&mid=1')).toBeNull(); // 缺 idx/sn
    expect(publicItemUrl('nosuch', '123')).toBeNull();
    expect(publicItemUrl('douyin', null)).toBeNull();
    expect(publicItemUrl('douyin', '')).toBeNull();
  });

  it('公众号：追踪参数在入库前已被规范化掉，算回来的链接是干净的', () => {
    const raw = 'https://mp.weixin.qq.com/s?__biz=MzA5MTUzOTQ5MQ==&mid=2650123456&idx=1&sn=abc123&chksm=xyz';
    const parsed = parsePublishUrl(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const url = publicItemUrl('wechat', parsed.platformItemId)!;
    expect(url).not.toContain('chksm');
    expect(url).toContain('sn=abc123');
  });
});
