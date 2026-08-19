import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WECHAT_COLLECT_RULES, wechatCollectRuleLines } from '@/lib/wechat-collect-rules';

// 「界面上写的规则」必须等于「代码里执行的规则」。
//
// 这条通道用的是用户自己的公众号后台登录态，非官方接口，踩线的后果由用户的号承担。所以我们把
// 节流规则明写在页面上（每次最多几页、同号多久一次、撞频控停多久）。一旦展示与执行对不上，
// 用户以为一天只采一次、实际点一次采一次，号被限了都不知道为什么——这类偏差没有任何报错会提示。
//
// 数字分散在三个文件里（网页 TS / 内容脚本 / service worker，后两者是插件里的纯 js，
// 没法 import TS 常量），所以只能靠这个测试把它们钉在一起：改一处不改另一处直接红。

const EXT = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const CONTENT = EXT('extension/content/wechat-competitor.js');
const SW = EXT('extension/sw.js');

// 从 `key: 12345,`（允许下划线分隔与尾随注释）里取数字
function num(src: string, key: string): number | null {
  const m = new RegExp(`\\b${key}\\s*:\\s*([\\d_]+)`).exec(src);
  return m ? Number(m[1].replace(/_/g, '')) : null;
}

describe('公众号采集节流规则 · 三处数字必须一致', () => {
  it.each(['maxPages', 'pageSize', 'recentDays', 'minGapMs', 'maxGapMs'] as const)(
    '内容脚本的 %s 与 lib/wechat-collect-rules.ts 相同',
    (key) => {
      expect(num(CONTENT, key)).toBe(WECHAT_COLLECT_RULES[key]);
    },
  );

  it.each(['perAccountCooldownHours', 'maxAccountsPerRun', 'betweenAccountsMs', 'rateLimitCooldownMinutes', 'fakeidCacheDays'] as const)(
    'service worker 的 %s 与 lib/wechat-collect-rules.ts 相同',
    (key) => {
      expect(num(SW, key)).toBe(WECHAT_COLLECT_RULES[key]);
    },
  );

  it('规则本身是保守的：间隔≥3 秒、每次不超过 2 页、同号至少隔半天', () => {
    expect(WECHAT_COLLECT_RULES.minGapMs).toBeGreaterThanOrEqual(3000);
    expect(WECHAT_COLLECT_RULES.maxGapMs).toBeGreaterThan(WECHAT_COLLECT_RULES.minGapMs);
    expect(WECHAT_COLLECT_RULES.maxPages).toBeLessThanOrEqual(2);
    expect(WECHAT_COLLECT_RULES.perAccountCooldownHours).toBeGreaterThanOrEqual(12);
    expect(WECHAT_COLLECT_RULES.rateLimitCooldownMinutes).toBeGreaterThanOrEqual(30);
  });

  it('展示文案覆盖每一条规则数字（页面上不能少说一条）', () => {
    const text = wechatCollectRuleLines().join('\n');
    for (const n of [
      WECHAT_COLLECT_RULES.recentDays,
      WECHAT_COLLECT_RULES.maxPages,
      WECHAT_COLLECT_RULES.perAccountCooldownHours,
      WECHAT_COLLECT_RULES.maxAccountsPerRun,
      WECHAT_COLLECT_RULES.rateLimitCooldownMinutes,
      WECHAT_COLLECT_RULES.fakeidCacheDays,
    ]) {
      expect(text).toContain(String(n));
    }
    expect(text).toContain('不取阅读量');
    expect(text).toContain('token 不上传');
  });

  it('单次上限不超过 ingest 的单批 50 条上限', () => {
    expect(WECHAT_COLLECT_RULES.maxPages * WECHAT_COLLECT_RULES.pageSize).toBeLessThanOrEqual(50);
  });
});

describe('节流是真在代码里执行的，不只是写在页面上', () => {
  it('内容脚本每次请求之间真的 sleep 了随机间隔', () => {
    expect(CONTENT).toMatch(/await sleep\(gap\(\)\)/);
    expect(CONTENT).toMatch(/Math\.random\(\)/); // 固定间隔是一条太整齐的机器指纹
  });

  it('内容脚本有时间截断（翻到更早的就停），不会一路翻到底', () => {
    expect(CONTENT).toMatch(/recentDays \* 86400/);
    expect(CONTENT).toMatch(/reachedOld/);
  });

  it('service worker 有同号冷却与频控熔断两道闸', () => {
    expect(SW).toMatch(/function wechatGate/);
    expect(SW).toMatch(/markWechatRateLimited/);
    expect(SW).toMatch(/blockedUntil/);
  });

  // 冷却只保护「你自己那个公众号后台账号」的频率预算。别人用他自己的号和 IP 采集
  // 不消耗你的额度，拦你什么也没保护到——2026-07-29 曾错误地按服务端 lastCrawledAt 也拦，
  // 当天改回。这条测试就是防止再被「顺手优化」回去。
  it('同号冷却只看本机记录，不因别人采过而拦人', () => {
    expect(SW).toMatch(/const last = Number\(t\.perAccount\[name\] \|\| 0\)/);
    expect(SW).not.toMatch(/lastServerCrawlAt/);
    expect(SW).not.toMatch(/Math\.max\(mine, server\)/);
  });

  it('展示文案点明「别人采过不拦你」（这是用户会直接问的那个问题）', () => {
    expect(wechatCollectRuleLines().join('\n')).toContain('别人采过不拦你');
  });

  it('批量采集对公众号有每轮上限，且超出的会被报出来而不是悄悄丢掉', () => {
    expect(SW).toMatch(/slice\(0, WECHAT_RULES\.maxAccountsPerRun\)/);
    expect(SW).toMatch(/wechatSkipped/);
  });

  // 真机 2026-07-29：站在已登录的后台页面上点采集，等满 60 秒报「一直没有响应」。
  // 真因是 Chrome 不往「插件更新前就打开的页面」补注入内容脚本，sendMessage 永远找不到接收方。
  it('页面里没有内容脚本时会补注入，且超时文案直接说清要按 F5', () => {
    expect(SW).toMatch(/chrome\.scripting\.executeScript/);
    expect(SW).toMatch(/content\/wechat-competitor\.js/);
    expect(SW).toMatch(/F5/);
  });

  // 0.8.2 起 manifest 里有了 host_permissions（为「读评论提问」在页内侧栏可用而加，
  // 那个入口拿不到 activeTab）。但**公众号后台补注入这条路仍然一个 host 权限都不许用**——
  // 后台是登录态的非公开页面，给它常驻主机权限与「只在你点的时候读一次」的承诺是两回事。
  // 所以这条用例从「host_permissions 必须为空」改成「里面不许出现任何创作者后台域名」。
  it('补注入需要 scripting 权限；host 权限里不许出现任何创作者后台域名', () => {
    const manifest = JSON.parse(EXT('extension/manifest.json')) as {
      permissions: string[];
      host_permissions?: string[];
    };
    expect(manifest.permissions).toContain('scripting');
    expect(manifest.permissions).toContain('activeTab');

    const hosts = manifest.host_permissions ?? [];
    const BACKENDS = ['mp.weixin.qq.com', 'channels.weixin.qq.com', 'creator.douyin.com', 'creator.xiaohongshu.com', 'member.bilibili.com'];
    for (const b of BACKENDS) {
      expect(hosts.some((h) => h.includes(b))).toBe(false);
    }
    // 且只覆盖公开作品页所在的那几个站点，不许悄悄扩到 <all_urls>
    const ALLOWED = ['www.bilibili.com', 'www.douyin.com', 'www.xiaohongshu.com', 'x.com', 'twitter.com', 'www.youtube.com', 'www.tiktok.com'];
    for (const h of hosts) {
      expect(ALLOWED.some((a) => h.includes(a))).toBe(true);
    }
  });

  it('内容脚本防重复注入（补注入时不能挂上第二个监听器抢同一个 sendResponse）', () => {
    expect(CONTENT).toMatch(/if \(globalThis\.__beaconWechatCompetitor\) return;/);
  });
});
