import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { checkText, hasRedline } from '@/lib/compliance/engine';

// 敏感词 DFA 引擎。走真 SQLite：buildDfa/DfaNode 没导出，
// scan() 需要一个 DfaNode 实例，外部构造不出来 → 只能经 checkText 这条真实路径测。
// 这反而更接近生产：词库查询条件（tier/platform/tenant 的组合）本身就是要验的东西之一。

type W = { word: string; tier: string; action: string; platform?: string; tenantId?: string; suggestion?: string };

async function seed(words: W[]) {
  await prisma.sensitiveWord.deleteMany();
  await prisma.sensitiveWord.createMany({
    data: words.map((w) => ({
      word: w.word,
      tier: w.tier,
      action: w.action,
      platform: w.platform ?? null,
      tenantId: w.tenantId ?? null,
      suggestion: w.suggestion ?? null,
      category: 'test',
      version: 'test',
      enabled: true,
    })),
  });
}

beforeEach(async () => {
  await prisma.sensitiveWord.deleteMany();
});

describe('DFA · 基础命中', () => {
  it('命中 block 词 → riskLevel=block', async () => {
    await seed([{ word: '国家级', tier: 'legal', action: 'block' }]);
    const r = await checkText('我们是国家级品牌', 'douyin', null);
    expect(r.riskLevel).toBe('block');
    expect(r.hits.map((h) => h.word)).toEqual(['国家级']);
  });

  it('命中 warn 词 → riskLevel=warn', async () => {
    await seed([{ word: '最好', tier: 'legal', action: 'warn' }]);
    expect((await checkText('这是最好的选择', 'douyin', null)).riskLevel).toBe('warn');
  });

  it('未命中 → riskLevel=pass 且 hits 为空', async () => {
    await seed([{ word: '国家级', tier: 'legal', action: 'block' }]);
    const r = await checkText('今天天气不错', 'douyin', null);
    expect(r.riskLevel).toBe('pass');
    expect(r.hits).toEqual([]);
  });

  it('block 优先于 warn：同时命中时整体判 block', async () => {
    await seed([
      { word: '最好', tier: 'legal', action: 'warn' },
      { word: '国家级', tier: 'legal', action: 'block' },
    ]);
    expect((await checkText('最好的国家级产品', 'douyin', null)).riskLevel).toBe('block');
  });

  it('suggest 词也计入 hits 并使 riskLevel=warn', async () => {
    await seed([{ word: '保健品', tier: 'industry', action: 'suggest' }]);
    expect((await checkText('这款保健品', 'douyin', null)).riskLevel).toBe('warn');
  });

  it('start/end 偏移正确，可用于高亮', async () => {
    await seed([{ word: '国家级', tier: 'legal', action: 'block' }]);
    const [hit] = (await checkText('我们是国家级品牌', 'douyin', null)).hits;
    expect(hit.start).toBe(3);
    expect(hit.end).toBe(6);
    expect('我们是国家级品牌'.slice(hit.start, hit.end)).toBe('国家级');
  });

  it('suggestion 随命中返回，供 UI 给替换建议', async () => {
    await seed([{ word: '国家级', tier: 'legal', action: 'block', suggestion: '删除该表述' }]);
    expect((await checkText('国家级', 'douyin', null)).hits[0].suggestion).toBe('删除该表述');
  });

  it('同一词多处出现 → 多次命中', async () => {
    await seed([{ word: '最好', tier: 'legal', action: 'warn' }]);
    expect((await checkText('最好最好最好', 'douyin', null)).hits).toHaveLength(3);
  });

  it('空文本不抛且判 pass', async () => {
    await seed([{ word: '国家级', tier: 'legal', action: 'block' }]);
    expect((await checkText('', 'douyin', null)).riskLevel).toBe('pass');
  });

  it('空词库 → 一切 pass', async () => {
    await seed([]);
    expect((await checkText('国家级最好', 'douyin', null)).riskLevel).toBe('pass');
  });

  it('禁用的词不参与检测', async () => {
    await prisma.sensitiveWord.create({
      data: { word: '国家级', tier: 'legal', action: 'block', category: 'test', version: 'test', enabled: false },
    });
    expect((await checkText('国家级', 'douyin', null)).riskLevel).toBe('pass');
  });
});

describe('DFA · 分平台差异', () => {
  it('platform 级词只在对应平台命中', async () => {
    await seed([{ word: '微信搜索', tier: 'platform', action: 'block', platform: 'douyin' }]);
    expect((await checkText('微信搜索关注我', 'douyin', null)).riskLevel).toBe('block');
    expect((await checkText('微信搜索关注我', 'bilibili', null)).riskLevel).toBe('pass');
  });

  it('legal 级词跨所有平台命中', async () => {
    await seed([{ word: '国家级', tier: 'legal', action: 'block' }]);
    for (const p of ['douyin', 'xiaohongshu', 'bilibili', 'wechat', 'youtube', 'x']) {
      expect((await checkText('国家级', p, null)).riskLevel).toBe('block');
    }
  });

  it('industry 级词跨所有平台命中', async () => {
    await seed([{ word: '包治百病', tier: 'industry', action: 'block' }]);
    expect((await checkText('包治百病', 'douyin', null)).riskLevel).toBe('block');
    expect((await checkText('包治百病', 'wechat', null)).riskLevel).toBe('block');
  });

  it('platform 命中时带回 platform 字段', async () => {
    await seed([{ word: '导流词', tier: 'platform', action: 'warn', platform: 'douyin' }]);
    expect((await checkText('导流词', 'douyin', null)).hits[0].platform).toBe('douyin');
  });
});

describe('DFA · 租户自定义词（L4）', () => {
  it('custom 词只对本租户生效', async () => {
    await seed([{ word: '内部代号', tier: 'custom', action: 'block', tenantId: 't-1' }]);
    expect((await checkText('内部代号', 'douyin', 't-1')).riskLevel).toBe('block');
    expect((await checkText('内部代号', 'douyin', 't-2')).riskLevel).toBe('pass');
  });

  it('tenantId 为 null（系统级检测）时不加载任何 custom 词', async () => {
    await seed([{ word: '内部代号', tier: 'custom', action: 'block', tenantId: 't-1' }]);
    expect((await checkText('内部代号', 'douyin', null)).riskLevel).toBe('pass');
  });

  it('custom 与 legal 叠加生效', async () => {
    await seed([
      { word: '国家级', tier: 'legal', action: 'block' },
      { word: '内部代号', tier: 'custom', action: 'warn', tenantId: 't-1' },
    ]);
    const r = await checkText('国家级内部代号', 'douyin', 't-1');
    expect(r.hits).toHaveLength(2);
  });
});

// ── 重叠词：compliance agent 实测发现的真 bug（跨 tier 子串冲突）──
// scan 从每个下标重新起跳，所以**任意子串**关系都会重复命中，不限于前缀。
// 「带单」是「老师带单」的后缀，只测 startsWith 的冲突检查器会漏掉。
describe('DFA · 重叠词与子串（跨 tier 冲突的既有行为）', () => {
  it('前缀关系：长短词都会命中', async () => {
    await seed([
      { word: '最好', tier: 'legal', action: 'warn' },
      { word: '最好的', tier: 'legal', action: 'block' },
    ]);
    const words = (await checkText('这是最好的', 'douyin', null)).hits.map((h) => h.word);
    expect(words).toContain('最好');
    expect(words).toContain('最好的');
  });

  it('后缀关系：短词内嵌在长词里也会命中 —— 正是漏网的那类', async () => {
    await seed([
      { word: '老师带单', tier: 'legal', action: 'block' },
      { word: '带单', tier: 'industry', action: 'warn' },
    ]);
    const words = (await checkText('老师带单', 'wechat', null)).hits.map((h) => h.word);
    // 一次输入两条命中，UI 上会显示重复告警 → 词库运营需保证不存在互为子串的词
    expect(words).toEqual(expect.arrayContaining(['老师带单', '带单']));
    expect(words).toHaveLength(2);
  });

  it('中缀关系同样重复命中', async () => {
    await seed([
      { word: '虚构原价', tier: 'legal', action: 'block' },
      { word: '原价', tier: 'industry', action: 'warn' },
    ]);
    expect((await checkText('虚构原价促销', 'douyin', null)).hits).toHaveLength(2);
  });

  it('无子串关系的词库 → 每词各命中一次，无重复', async () => {
    await seed([
      { word: '国家级', tier: 'legal', action: 'block' },
      { word: '包治百病', tier: 'industry', action: 'block' },
    ]);
    expect((await checkText('国家级包治百病', 'douyin', null)).hits).toHaveLength(2);
  });
});

// ── 误报炸弹：这些是 compliance agent 从原词库删掉的词，必须保持 0 命中 ──
describe('DFA · 误报回归（词库定级原则的锁）', () => {
  it('「特效」不该是 block：短视频产品里「加了特效」必炸', async () => {
    await seed([{ word: '国家级', tier: 'legal', action: 'block' }]); // 现词库中「特效」已不在
    expect((await checkText('这个视频我加了特效，大家看看效果怎么样。', 'douyin', null)).riskLevel).toBe('pass');
  });

  it('「第一」不该是 block：「第一天/第一步」全中', async () => {
    await seed([{ word: '国家级', tier: 'legal', action: 'block' }]);
    expect((await checkText('今天是我做up主的第一天，也是最重要的一天。', 'bilibili', null)).riskLevel).toBe('pass');
    expect((await checkText('我最大的收获是学会了拒绝，第一步永远最难。', 'wechat', null)).riskLevel).toBe('pass');
  });

  it('《广告法》第九条明列的三个词才配 block，扩展口径词只 warn（不触发导出硬闸）', async () => {
    // legal+block 会触发 hasRedline 的禁止导出硬闸，误伤代价远大于漏报
    await seed([
      { word: '国家级', tier: 'legal', action: 'block' },
      { word: '最高级', tier: 'legal', action: 'block' },
      { word: '最佳', tier: 'legal', action: 'block' },
      { word: '最好', tier: 'legal', action: 'warn' }, // 执法扩展口径 + 大量正常中文用法
      { word: '唯一', tier: 'legal', action: 'warn' },
    ]);
    expect(await hasRedline('这是最好的唯一选择')).toBe(false); // warn 词不触发红线
    expect(await hasRedline('国家级产品')).toBe(true);
  });
});

describe('DFA · hasRedline 导出硬闸', () => {
  it('只有 legal+block 触发红线', async () => {
    await seed([
      { word: '国家级', tier: 'legal', action: 'block' },
      { word: '包治百病', tier: 'industry', action: 'block' }, // industry 即使 block 也不算红线
      { word: '最好', tier: 'legal', action: 'warn' },
    ]);
    expect(await hasRedline('国家级')).toBe(true);
    expect(await hasRedline('包治百病')).toBe(false);
    expect(await hasRedline('最好')).toBe(false);
  });

  it('红线不分平台（不接受 platform 参数，全局判定）', async () => {
    await seed([{ word: '国家级', tier: 'legal', action: 'block' }]);
    expect(await hasRedline('国家级')).toBe(true);
  });

  it('干净文本 → false', async () => {
    await seed([{ word: '国家级', tier: 'legal', action: 'block' }]);
    expect(await hasRedline('今天天气不错')).toBe(false);
  });

  it('空文本 → false', async () => {
    await seed([{ word: '国家级', tier: 'legal', action: 'block' }]);
    expect(await hasRedline('')).toBe(false);
  });
});
