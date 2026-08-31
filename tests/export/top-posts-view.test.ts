import { describe, it, expect } from 'vitest';
import { analyzePosts, filterPosts, sortPosts, ageHoursOf, inWindow } from '@/app/(app)/competitors/top-posts-view';

// 高热榜单的取数/筛选/排序（2026-08-30）。
//
// 抽出来之前这三段是 CompetitorTopPosts() 里的 useMemo（那个函数 1121 行），
// **一行覆盖都没有**——而这个项目在榜单口径上栽过不止一次：
// hotScore 让无播放量平台恒为 0、缺席被印成 0、率型列子串串台。

const NOW = new Date('2026-08-30T12:00:00Z').getTime();
const H = 3_600_000;
const post = (over: Record<string, unknown> = {}) => ({
  id: 'p1', title: '标题', metrics: JSON.stringify({ views: 1000, likes: 10 }),
  publishedAt: new Date(NOW - 2 * H), competitor: { name: '某账号' }, ...over,
});

describe('🔒 没有发布时间 ≠ 很久以前', () => {
  // ── 这条是修复的理由 ──
  // 原来是 `pubTime > 0 ? … : 9999`。9999 小时 ≈ 416 天，于是「没采到发布时间」
  // 被静默改写成「很久很久以前」，紧接着时间筛选拿它做判断：
  // 这条作品在 24h / 7d / 30d 三个窗口下**全部被滤掉**，只有「全部」看得见，
  // 而界面上没有任何东西解释这件事。
  //
  // 这是本项目「缺席不许当成一个确定值」那条口径的镜像（上次是印成 0）。
  it('拿不到就是 null，不是一个很大的数', () => {
    expect(ageHoursOf(null, NOW)).toBeNull();
    expect(ageHoursOf('', NOW)).toBeNull();
    expect(ageHoursOf('不是日期', NOW)).toBeNull();
    expect(ageHoursOf(new Date(NOW - 3 * H), NOW)).toBeCloseTo(3, 5);
  });

  it('9999 这个哨兵值不许再出现在任何一条路上', () => {
    const [p] = analyzePosts([post({ publishedAt: null })], {}, NOW);
    expect(p.ageHours, '缺席被印成了一个确定的数').toBeNull();
  });

  it('未知发布时间不进有界窗口，但「全部」里看得见', () => {
    expect(inWindow(null, 'all')).toBe(true);
    expect(inWindow(null, '24h')).toBe(false);
    expect(inWindow(null, '30d')).toBe(false);
  });

  it('边界：正好卡在窗口上算在窗内', () => {
    expect(inWindow(24, '24h')).toBe(true);
    expect(inWindow(24.1, '24h')).toBe(false);
    expect(inWindow(24 * 30, '30d')).toBe(true);
  });
});

describe('缺席不许当成 0（榜上那几个数）', () => {
  it('🔒 没有播放量时互动率是 null，不是 0', () => {
    const [p] = analyzePosts([post({ metrics: JSON.stringify({ likes: 100 }) })], {}, NOW);
    expect(p.rate, '没有播放量这个分母，互动率算不出来').toBeNull();
    expect(p.views).toBe(0);
  });

  it('🔒 按互动率排序时算不出来的排最后，不混进「互动率最低」', () => {
    // 【样本必须包含一条真实的 0%】`?? -1` 与 `?? 0` 只在这一种对局上才分得出来：
    // 「这条真的没人互动（0%）」应当排在「这条我们算不出来」**前面**。
    // 第一版拿 null 对 0.001 来验，两种写法结果一模一样——那是「样本不到门槛」
    // 这种假绿（本项目归档的第三种形状），变异验证当场抓到。
    const rows = [
      { views: 0, rate: null, growthDelta: 0, interaction: 0 },   // 算不出来
      { views: 100, rate: 0, growthDelta: 0, interaction: 0 },    // 真的 0%
      { views: 100, rate: 0.001, growthDelta: 0, interaction: 0 },
    ];
    expect(sortPosts(rows, 'engagement').map((r) => r.rate)).toEqual([0.001, 0, null]);
  });

  it('互动量每个平台都算得出（不像 hotScore 在无播放量平台恒为 0）', () => {
    const [p] = analyzePosts([post({ metrics: JSON.stringify({ likes: 5, comments: 3 }) })], {}, NOW);
    expect(p.interaction).toBeGreaterThan(0);
  });
});

describe('筛选与增长', () => {
  it('搜索同时匹配标题与账号名，且不分大小写', () => {
    const rows = analyzePosts([
      post({ id: 'a', title: 'Hello World' }),
      post({ id: 'b', title: '别的', competitor: { name: 'ABC频道' } }),
    ], {}, NOW);
    expect(filterPosts(rows, 'all', 'hello').map((p) => p.id)).toEqual(['a']);
    expect(filterPosts(rows, 'all', 'abc').map((p) => p.id)).toEqual(['b']);
    expect(filterPosts(rows, 'all', '  ').map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('标题前的【xx】角标去掉（榜上一整列都是它，没有信息量）', () => {
    const [p] = analyzePosts([post({ title: '【独家】真正的标题' })], {}, NOW);
    expect(p.cleanTitle).toBe('真正的标题');
  });

  it('增长取最后两次快照之差；不足两次就是 0', () => {
    const snaps = { p1: [{ metrics: '{"views":100}' }, { metrics: '{"views":180}' }] };
    expect(analyzePosts([post()], snaps, NOW)[0].growthDelta).toBe(80);
    expect(analyzePosts([post()], { p1: [{ metrics: '{"views":100}' }] }, NOW)[0].growthDelta).toBe(0);
    expect(analyzePosts([post()], {}, NOW)[0].growthDelta).toBe(0);
  });

  it('排序不改原数组（改了会让上游的 memo 结果被就地打乱）', () => {
    const rows = [{ views: 1, rate: null, growthDelta: 0, interaction: 1 },
                  { views: 9, rate: null, growthDelta: 0, interaction: 9 }];
    sortPosts(rows, 'views');
    expect(rows[0].views).toBe(1);
  });
});

// ── 被静默滤掉的，界面上要说破（2026-08-30 补完）────────────────────────────
//
// 改掉 9999 哨兵只解决了一半：作品仍然进不了有界时间窗（这是对的——不知道是不是
// 这段时间发的，就不该替用户断言它是），但**用户切一下时间窗发现少了几条，
// 界面上没有任何东西解释**，他只会以为数据丢了。
// 组件那边加了一句「另有 N 条没采到发布时间」，这里守它算得对。
describe('🔒 说破：多少条因为没有发布时间而不在此窗内', () => {
  const undated = (posts: { ageHours: number | null }[], range: 'all' | '24h' | '7d' | '30d') =>
    (range === 'all' ? 0 : posts.filter((p) => p.ageHours === null).length);

  it('选了时间窗才数，「全部」时永远是 0（那时它们本来就看得见）', () => {
    const rows = [{ ageHours: null }, { ageHours: null }, { ageHours: 5 }];
    expect(undated(rows, 'all')).toBe(0);
    expect(undated(rows, '24h')).toBe(2);
    expect(undated(rows, '30d')).toBe(2);
  });

  it('数的是「没采到发布时间」的，不是「被时间窗滤掉」的总数', () => {
    // 一条 500 小时前发的作品在 24h 窗下也被滤掉，但那不需要解释——
    // 用户选的就是近 24 小时。要解释的只有「我们不知道」这一类。
    const rows = [{ ageHours: null }, { ageHours: 500 }];
    expect(undated(rows, '24h'), '把正常过滤掉的也算进来了').toBe(1);
  });

  it('组件里真的接上了（写了没接等于没做）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'app/(app)/competitors/CompetitorTopPosts.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).toContain('const undatedHidden = useMemo(');
    expect(src, '算了但没渲染出来').toContain('{undatedHidden > 0 && (');
    expect(src, '「全部」时不该提示').toContain("timeRange === 'all' ? 0 :");
  });
});
