import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 解析健康度：让「插件悄悄降级」和「粉丝数悄悄采错」变成看得见的事 ──
//
// 这一层存在的理由是 2026-08-07 抖音那次：平台把 `data-e2e="user-fans"` 改名了，
// 插件**自修复成功**（退到文本锚点，数字一个不差），但没有任何人知道它降级了。
// 同一次降级换个页面结构，取出来的就会是旁边那个「关注数」——一个看着完全正常、
// 实际差三个数量级的数字。所以：**自修复必须配自曝光**。

const sent: { title: string; fingerprint: string; level: string; lines: string[] }[] = [];
vi.mock('@/lib/ops/alert', () => ({
  sendOpsAlert: async (p: { title: string; fingerprint: string; level: string; lines: string[] }) => {
    sent.push(p);
    return { sent: true };
  },
}));

const { checkFollowers, followersJumpRejected } = await import('@/lib/ingest/parser-health');

beforeEach(() => { sent.length = 0; });

describe('量级闸：会差一百倍的只有解析错误', () => {
  it('🔒 暴跌 100 倍一律拦（「关注 178 / 粉丝 328.3万」取错就是这个形状）', () => {
    expect(followersJumpRejected(3_283_000, 178)).toBe(true);
  });

  it('🔒 大号暴涨 100 倍也拦', () => {
    expect(followersJumpRejected(30_000, 30_238_000)).toBe(true); // 粉丝位读成了获赞位
  });

  it('小号暴涨不拦：50 → 6000（120 倍）对刚起步的号是真会发生的', () => {
    expect(followersJumpRejected(50, 6_000)).toBe(false);
  });

  it('正常波动不拦', () => {
    expect(followersJumpRejected(241_000, 243_500)).toBe(false);
    expect(followersJumpRejected(241_000, 230_000)).toBe(false); // 掉粉是真实信号
  });

  it('🔒 第一次采（库里是 0 / null）一律放行——设闸会让新档永远建不起来', () => {
    expect(followersJumpRejected(0, 3_283_000)).toBe(false);
    expect(followersJumpRejected(null, 3_283_000)).toBe(false);
  });
});

describe('量级突变 → 不覆盖 + 告警 + 台账留痕', () => {
  it('🔒 拒绝写入，库里的旧值保住', async () => {
    const r = await checkFollowers({
      platform: 'douyin', scope: 'rival', targetName: '某抖音号',
      via: 'text', prev: 3_283_000, next: 178,
    });
    expect(r.accept).toBe(false);
  });

  it('台账 note 里写清楚发生了什么（台账是给人看的）', async () => {
    const r = await checkFollowers({
      platform: 'douyin', scope: 'rival', targetName: '某抖音号',
      via: 'text', prev: 3_283_000, next: 178,
    });
    expect(r.note).toContain('328.3万');
    expect(r.note).toContain('178');
    expect(r.note).toContain('不覆盖');
  });

  it('告警里带上「读取来源」——那是判断该不该信这个数的关键线索', async () => {
    await checkFollowers({
      platform: 'douyin', scope: 'rival', targetName: '某抖音号',
      via: 'text', prev: 3_283_000, next: 178,
    });
    const jump = sent.find((s) => s.fingerprint.startsWith('followers-jump:'));
    expect(jump?.level).toBe('error');
    expect(jump?.lines.join('\n')).toContain('text');
  });
});

describe('降级告警：只在「比该有的差」时响', () => {
  it('🔒 抖音掉到文本兜底 → 告警（埋点失效的唯一早期信号）', async () => {
    await checkFollowers({ platform: 'douyin', scope: 'rival', targetName: 'A', via: 'text', prev: 100, next: 110 });
    expect(sent.some((s) => s.fingerprint === 'parser-degraded:douyin:text')).toBe(true);
  });

  it('🔒 B站/小红书/YouTube 本来就靠文本 → 不告警（一吵就会被关掉，然后真出事也没人看见）', async () => {
    for (const platform of ['bilibili', 'xiaohongshu', 'youtube']) {
      await checkFollowers({ platform, scope: 'rival', targetName: 'A', via: 'text', prev: 100, next: 110 });
    }
    expect(sent.filter((s) => s.fingerprint.startsWith('parser-degraded:'))).toHaveLength(0);
  });

  it('抖音埋点正常命中 → 不告警', async () => {
    await checkFollowers({ platform: 'douyin', scope: 'rival', targetName: 'A', via: 'e2e', prev: 100, next: 110 });
    expect(sent).toHaveLength(0);
  });

  it('TikTok 从 JSON 掉到埋点也算降级（JSON 是精确整数，埋点是页面上的缩写）', async () => {
    await checkFollowers({ platform: 'tiktok', scope: 'rival', targetName: 'A', via: 'e2e', prev: 100, next: 110 });
    expect(sent.some((s) => s.fingerprint === 'parser-degraded:tiktok:e2e')).toBe(true);
  });

  it('完全读不到（none）→ warn 级，且指纹与 text 分开（两件事不能互相吃掉冷却）', async () => {
    await checkFollowers({ platform: 'douyin', scope: 'rival', targetName: 'A', via: 'none', prev: 100, next: null });
    const a = sent.find((s) => s.fingerprint.startsWith('parser-degraded:'));
    expect(a?.fingerprint).toBe('parser-degraded:douyin:none');
    expect(a?.level).toBe('warn');
  });

  it('老版本插件不发 via → 不告警（没表态不等于降级）', async () => {
    await checkFollowers({ platform: 'douyin', scope: 'rival', targetName: 'A', via: null, prev: 100, next: 110 });
    expect(sent).toHaveLength(0);
  });

  it('降级但数字正常时仍然放行——兜底读出来的数也是数，不能因为"来源不够好"就丢掉', async () => {
    const r = await checkFollowers({ platform: 'douyin', scope: 'rival', targetName: 'A', via: 'text', prev: 100, next: 110 });
    expect(r.accept).toBe(true);
    expect(r.note).toContain('兜底');
  });
});

describe('🔒 旁路绝不连累主流程', () => {
  it('传进脏数据也不抛，一律放行', async () => {
    const r = await checkFollowers({
      platform: undefined as unknown as string, scope: 'rival', targetName: '',
      via: 'weird' as never, prev: NaN, next: NaN,
    });
    expect(r.accept).toBe(true);
  });
});
