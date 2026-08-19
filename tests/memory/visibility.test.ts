import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { relativeAge, memoryLine, recentlyLearnedMemories, buildMemoryContext, writeMemory } from '@/lib/memory/core';

// R7 记忆可见化。两半：
//   ① 注入 prompt 的记忆行带上「什么时候学到的 / 验证过几次」，并要求模型把引用说出来；
//   ② 周报里「烽火台这周记住了你的 N 件事」——代码算，不经 LLM。
//
// 最要紧的一条锁在最后：可见化指令**不许改变输出格式约定**。全站有一半 prompt 站点要求
// 严格 JSON（finePrompt 等），少了那句护栏，模型会在 JSON 前加一段「因为你上月…」把解析打挂。

const NOW = new Date('2026-07-22T00:00:00Z').getTime();
const ago = (days: number) => new Date(NOW - days * 86_400_000);

describe('relativeAge · 给模型可引用的时间说法', () => {
  it('按天数落到人话档位', () => {
    expect(relativeAge(ago(0), NOW)).toBe('今天');
    expect(relativeAge(ago(1), NOW)).toBe('昨天');
    expect(relativeAge(ago(3), NOW)).toBe('3天前');
    expect(relativeAge(ago(10), NOW)).toBe('上周');
    expect(relativeAge(ago(20), NOW)).toBe('上月');
    expect(relativeAge(ago(60), NOW)).toBe('2个月前');
    expect(relativeAge(ago(200), NOW)).toBe('更早');
  });
  it('未来时间（时钟漂移）不产生负数说法', () => {
    expect(relativeAge(new Date(NOW + 86_400_000), NOW)).toBe('今天');
  });
});

describe('memoryLine · 注入行格式', () => {
  it('带类型名与时间', () => {
    // 时间说法要相对**真实的现在**去造，不能拿固定 NOW 造日期再让 memoryLine 用真实时钟去读：
    // 那样这条用例只在 2026-07-22 前后能过，日历一走就变成「1个月前」（本条真踩到过）。
    const line = memoryLine('preference', '偏好清单体', new Date(Date.now() - 20 * 86_400_000), 1);
    expect(line).toContain('偏好记忆');
    expect(line).toContain('上月');
    expect(line).toContain('偏好清单体');
  });
  it('hitCount>1 才写验证次数（写「验证1次」既没信息量又像强证据）', () => {
    expect(memoryLine('preference', 'x', ago(1), 1)).not.toContain('验证');
    expect(memoryLine('preference', 'x', ago(1), 3)).toContain('已重复验证3次');
  });
});

describe('buildMemoryContext · 可见化指令', () => {
  let workspaceId = '';
  let accountId = '';

  beforeEach(async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'r7-ctx' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'ws' } });
    const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'a', platform: 'douyin' } });
    workspaceId = ws.id;
    accountId = acc.id;
  });

  it('无记忆 → 返回空串（不塞一段只有指令没有内容的废话进 prompt）', async () => {
    expect(await buildMemoryContext(workspaceId, accountId)).toBe('');
  });

  it('有记忆 → 带上「说明依据、让用户能核对来历」的引用要求', async () => {
    await writeMemory({ workspaceId, accountId, type: 'persona', content: '面向初入行人群' });
    const ctx = await buildMemoryContext(workspaceId, accountId);
    expect(ctx).toContain('面向初入行人群');
    // 断言的是**要求存在**，不是某个固定措辞。原来钉死「因为你」三个字，
    // 而那正是 2026-07-30 那次事故里被模型连同占位符一起抄出去的句式（见下面两条）。
    expect(ctx).toContain('核对');
  });

  // 🔒 真机 2026-07-30（MiniMax-Text-01）：说明里写「写成『因为你<时间><那条记忆讲的事实>…』」，
  // 模型把尖括号连同内容一起抄进了用户可见的推荐理由：
  //     「因为你<2023-09-15 · 家庭理财与保险避坑博主>，受众是…」6 条推荐里 3 条这样。
  // 而 memoryLine 给的时间是「上月」「本周」这类相对说法，库里没有任何年月日——那个日期是编的。
  // 一句「让用户能核对来历」的话配一个核对不了的假日期，比不写更糟。
  it('🔒 说明里不许出现占位符模板（模型会连尖括号一起抄给用户）', async () => {
    await writeMemory({ workspaceId, accountId, type: 'persona', content: 'x' });
    const ctx = await buildMemoryContext(workspaceId, accountId);
    // 记忆行本身可能含任何字符，只检查指令段（最后那几行说明）
    const instructions = ctx.split('\n').filter((l) => l.includes('不许') || l.includes('使用要求') || l.includes('复述'));
    for (const line of instructions) {
      expect(line, `指令里不该出现尖括号占位符：${line}`).not.toMatch(/<[^>]{2,}>/);
    }
    expect(ctx).toContain('不许出现尖括号占位符');
    expect(ctx).toContain('不许写具体日期');
  });

  // 🔒 第一版改法是「把模板换成例句」，实测更糟：模型把例句里那条虚构的
  // 「你上月那条清单体跑赢了基线」当成用户的真实数据抄进了推荐理由（该租户库里没有这条记忆）。
  // 教训：这段说明里**任何**长得像事实的句子都会被当素材抄走，所以一句可抄的假事实都不能给。
  it('🔒 说明里不许含任何可被当成用户事实抄走的示例句', async () => {
    await writeMemory({ workspaceId, accountId, type: 'persona', content: 'x' });
    const ctx = await buildMemoryContext(workspaceId, accountId);
    for (const bait of ['清单体', '跑赢了基线', '完播率']) {
      expect(ctx, `说明里不该出现可被抄走的假事实「${bait}」`).not.toContain(bait);
    }
    expect(ctx).toContain('不许照抄本说明里的任何字句');
  });

  it('🔒 明确禁止编造引用（编造的引用比不引用更糟）', async () => {
    await writeMemory({ workspaceId, accountId, type: 'persona', content: 'x' });
    expect(await buildMemoryContext(workspaceId, accountId)).toContain('不要');
  });

  it('🔒 保住输出格式约定 —— 否则要求返回 JSON 的站点会被这段指令打挂', async () => {
    await writeMemory({ workspaceId, accountId, type: 'persona', content: 'x' });
    expect(await buildMemoryContext(workspaceId, accountId)).toContain('不改变本次任务原有的输出格式');
  });

  // 真实模型实测（MiniMax-Text-01）：护栏句里只要出现「JSON」二字，连**没要求 JSON**的
  // 自然语言场景（创作工坊初稿、助手对话）都会被带得吐出裸 JSON——对照实验确认是这句话导致的。
  // 提一个格式名就等于给模型一个默认格式。这条断言防的就是有人「为了更明确」把它加回去。
  it('🔒 护栏句里不许出现任何具体格式名（提一个就等于给了默认格式）', async () => {
    await writeMemory({ workspaceId, accountId, type: 'persona', content: 'x' });
    const ctx = await buildMemoryContext(workspaceId, accountId);
    for (const word of ['JSON', 'json', 'YAML', 'Markdown', 'XML']) {
      expect(ctx, `记忆块不该提到「${word}」`).not.toContain(word);
    }
  });

  // 方括号是元信息（类型·时间·验证次数）。不说清楚，模型会把「偏好记忆」当事实的一部分念出来
  // （实测出现过「因为你今天有偏好记忆显示…」）。
  it('说明方括号是元信息，并要求别把类型名念进句子', async () => {
    await writeMemory({ workspaceId, accountId, type: 'persona', content: 'x' });
    const ctx = await buildMemoryContext(workspaceId, accountId);
    expect(ctx).toContain('元信息');
    expect(ctx).toContain('不要把');
  });

  it('记忆与当前事实冲突时要求以当前事实为准（记忆可能过时）', async () => {
    await writeMemory({ workspaceId, accountId, type: 'persona', content: 'x' });
    expect(await buildMemoryContext(workspaceId, accountId)).toContain('当前事实为准');
  });
});

describe('recentlyLearnedMemories · 周报「记住了你的 N 件事」', () => {
  let workspaceId = '';
  let accountId = '';

  beforeEach(async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'r7-learn' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'ws' } });
    const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'a', platform: 'douyin' } });
    workspaceId = ws.id;
    accountId = acc.id;
  });

  it('只取本周期内有变动的，老而未动的不混进来', async () => {
    const fresh = await writeMemory({ workspaceId, accountId, type: 'persona', content: '本周学到的' });
    const stale = await writeMemory({ workspaceId, accountId, type: 'persona', content: '很久以前学到的' });
    await prisma.memoryEntry.update({
      where: { id: stale.id },
      data: { updatedAt: ago(60), createdAt: ago(60) },
    });

    const r = await recentlyLearnedMemories(workspaceId, accountId, ago(7));
    expect(r.map((x) => x.content)).toEqual([fresh.content]);
  });

  it('重复验证过的排前面（比刚冒头的猜测更值得报）', async () => {
    await writeMemory({ workspaceId, accountId, type: 'persona', content: '只出现过一次' });
    await writeMemory({ workspaceId, accountId, type: 'preference', content: '被反复验证' });
    await writeMemory({ workspaceId, accountId, type: 'preference', content: '被反复验证' }); // hitCount→2

    const r = await recentlyLearnedMemories(workspaceId, accountId, ago(7));
    expect(r[0].content).toBe('被反复验证');
    expect(r[0].hitCount).toBe(2);
  });

  it('区分「本周新学到」与「老结论又被验证」', async () => {
    // confidence 必须 ≥0.5 才 active，否则会被下面那条「未生效的不报」的规则正当地滤掉
    const old = await writeMemory({ workspaceId, accountId, type: 'preference', content: '老结论', confidence: 0.6 });
    await prisma.memoryEntry.update({ where: { id: old.id }, data: { createdAt: ago(60) } });
    await writeMemory({ workspaceId, accountId, type: 'persona', content: '新结论' });

    const r = await recentlyLearnedMemories(workspaceId, accountId, ago(7));
    expect(r.find((x) => x.content === '老结论')?.isNew).toBe(false);
    expect(r.find((x) => x.content === '新结论')?.isNew).toBe(true);
  });

  it('未生效（只积累未验证）的记忆不报给用户 —— 那还不是「记住了」', async () => {
    await writeMemory({ workspaceId, accountId, type: 'preference', content: '置信度不够', confidence: 0.3 });
    const r = await recentlyLearnedMemories(workspaceId, accountId, ago(7));
    expect(r).toHaveLength(0);
  });

  it('take 上限生效', async () => {
    for (let i = 0; i < 6; i++) {
      await writeMemory({ workspaceId, accountId, type: 'persona', content: `结论${i}` });
    }
    expect(await recentlyLearnedMemories(workspaceId, accountId, ago(7), 3)).toHaveLength(3);
  });

  it('本周什么都没学到 → 空数组（周报据此说「宁可不记也不瞎记」）', async () => {
    expect(await recentlyLearnedMemories(workspaceId, accountId, ago(7))).toEqual([]);
  });
});
