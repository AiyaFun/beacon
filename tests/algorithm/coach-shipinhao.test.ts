import { describe, it, expect } from 'vitest';
import { diagnose } from '@/lib/algorithm/coach';
import type { Metrics } from '@/lib/json';

// 视频号诊断分支。第一信号 = 完播率 + 转发裂变。
//
// 这个文件锁的是「视频号不是抖音」：抖音看完播+评论，视频号看完播+**转发**——因为视频号的
// 推荐盘子由社交关系链驱动。若哪天有人把 case 'shipinhao' 合并回 case 'douyin'，
// 转发信号会静默消失，而用户看到的还是一份「像模像样」的诊断，这里就是拦住那次合并的地方。

const post = (m: Metrics): Metrics => m;

// 完播健康 + 转发充足
const healthy = [
  post({ views: 10000, likes: 300, comments: 20, shares: 200, completion: 0.5 }),
  post({ views: 12000, likes: 360, comments: 24, shares: 240, completion: 0.52 }),
  post({ views: 8000, likes: 240, comments: 16, shares: 160, completion: 0.48 }),
];
// 完播健康但几乎没人转发
const noShare = [
  post({ views: 10000, likes: 500, comments: 20, shares: 5, completion: 0.5 }),
  post({ views: 12000, likes: 600, comments: 24, shares: 6, completion: 0.52 }),
  post({ views: 8000, likes: 400, comments: 16, shares: 4, completion: 0.48 }),
];

const signals = (list: Metrics[]) => diagnose('shipinhao', list).map((d) => d.signal);
const find = (list: Metrics[], signal: string) => diagnose('shipinhao', list).find((d) => d.signal === signal);

describe('视频号诊断 · 第一信号是完播率 + 转发裂变', () => {
  it('两个信号都给出来了', () => {
    expect(signals(healthy)).toEqual(expect.arrayContaining(['完播率', '转发裂变率']));
  });

  it('转发率远低于点赞率 → 判 bad，且建议里点明「靠熟人关系链推开」', () => {
    const d = find(noShare, '转发裂变率');
    expect(d?.severity).toBe('bad');
    expect(d?.advice).toContain('转发');
  });

  it('转发结构健康 → 判 good，不无中生有报问题', () => {
    expect(find(healthy, '转发裂变率')?.severity).toBe('good');
  });

  it('完播低于健康线 → 判 bad', () => {
    const low = healthy.map((m) => ({ ...m, completion: 0.2 }));
    expect(find(low, '完播率')?.severity).toBe('bad');
  });

  it('没有完播数据 → 只出转发信号，不编一个完播结论', () => {
    const noCompletion = healthy.map(({ completion: _c, ...rest }) => rest);
    expect(signals(noCompletion)).not.toContain('完播率');
    expect(signals(noCompletion)).toContain('转发裂变率');
  });

  it('零样本 → 走「样本不足」而不是给结论（沿用全平台一致的退化形态）', () => {
    const d = diagnose('shipinhao', []);
    expect(d).toHaveLength(1);
    expect(d[0].signal).toBe('样本不足');
  });

  it('与抖音口径不同：抖音看评论互动，视频号看转发裂变', () => {
    expect(signals(noShare)).toContain('转发裂变率');
    expect(diagnose('douyin', noShare).map((d) => d.signal)).not.toContain('转发裂变率');
  });
});

// ── 后台数据（曝光量 / 流量来源分布）解锁的两条结论 ──
// 这两条此前只能出「这一项无法从播放数看出」的提醒；接了创作者后台才有数据可下结论。
// 锁的是：有数据就用数据、没数据就诚实说没数据，绝不用估算值冒充。
describe('创作者后台数据解锁的诊断分支', () => {
  const base = (extra: Metrics) =>
    Array.from({ length: 3 }, () => ({ views: 10000, likes: 300, comments: 20, shares: 50, collects: 120, ...extra }));

  describe('YouTube · CTR', () => {
    it('无曝光量 → 明说算不出来，并指出要从 Studio 回填', () => {
      const d = diagnose('youtube', base({})).find((x) => x.signal === 'CTR（缩略图标题包）');
      expect(d?.severity).toBe('warn');
      expect(d?.finding).toContain('暂无曝光量');
    });

    it('有曝光量 → 算出真实 CTR 并判档', () => {
      const low = diagnose('youtube', base({ impressions: 500000 })).find((x) => x.signal === 'CTR（缩略图标题包）');
      expect(low?.severity).toBe('bad'); // 10000/500000 = 2%
      expect(low?.finding).toContain('2.0%');

      const ok = diagnose('youtube', base({ impressions: 100000 })).find((x) => x.signal === 'CTR（缩略图标题包）');
      expect(ok?.severity).toBe('good'); // 10%
    });
  });

  describe('小红书 · 搜索流量占比', () => {
    it('无来源分布 → 退回提醒形态，并说明暂无数据', () => {
      const d = diagnose('xiaohongshu', base({})).find((x) => x.signal === '搜索关键词');
      expect(d?.severity).toBe('warn');
      expect(d?.finding).toContain('暂无数据');
      expect(diagnose('xiaohongshu', base({})).map((x) => x.signal)).not.toContain('搜索流量占比');
    });

    it('有来源分布 → 用真实占比下结论', () => {
      const low = diagnose('xiaohongshu', base({ sources: { 推荐: 0.85, 搜索: 0.1 } })).find(
        (x) => x.signal === '搜索流量占比',
      );
      expect(low?.severity).toBe('bad');
      expect(low?.finding).toContain('10.0%');

      const ok = diagnose('xiaohongshu', base({ sources: { 推荐: 0.4, 搜索: 0.45 } })).find(
        (x) => x.signal === '搜索流量占比',
      );
      expect(ok?.severity).toBe('good');
    });
  });

  it('🔒 只对有该项数据的样本求均值 —— 没接后台的样本不按 0 计', () => {
    // 3 条里只有 1 条有曝光量。若把另外 2 条按 0 计，均值会被系统性拉低，
    // 「大部分作品没接后台」就会看起来像「CTR 很差」——那是编出来的结论。
    const mixed: Metrics[] = [
      { views: 10000, impressions: 100000 }, // CTR 10%
      { views: 10000 },
      { views: 10000 },
    ];
    const d = diagnose('youtube', mixed).find((x) => x.signal === 'CTR（缩略图标题包）');
    expect(d?.severity).toBe('good');
    expect(d?.finding).toContain('10.0%');
  });
});
