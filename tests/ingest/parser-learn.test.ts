import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import {
  textShape,
  sanitizeSkeleton,
  serializeSkeleton,
  recordParserIncident,
  proposeSelectors,
  activateRule,
  rollbackRule,
  activeRulePack,
  recordHitRate,
  MAX_SKELETON_CHARS,
} from '@/lib/ingest/parser-learn';

// 采集自学习。两组要钉死的东西：
//   ① **脱敏**：上传的骨架里绝不能出现正文、昵称、链接、ID——这是隐私政策里写死的承诺；
//   ② **不许自动上线**：模型给的选择器只能是候选，且 Mock 模型下一条都不许产出。

let workspaceId: string;

beforeEach(async () => {
  await prisma.parserRule.deleteMany();
  await prisma.parserIncident.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'free' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  workspaceId = ws.id;
});

describe('脱敏', () => {
  it('数字变 NUM，长中文变 CJK，「粉丝」这类短标签词保留（它本身就是锚点）', () => {
    expect(textShape('328.3万')).toBe('NUM万');
    expect(textShape('张三的美食日记')).toBe('CJK');
    expect(textShape('粉丝')).toBe('粉丝');
    expect(textShape('获赞 1234')).toBe('获赞 NUM');
  });

  it('骨架只留属性名，且不留 href / src / alt（值里可能带用户 ID、昵称、图片地址）', () => {
    const node = sanitizeSkeleton({
      tag: 'div',
      cls: ['user-info'],
      attrs: ['data-e2e', 'href', 'src', 'alt', 'aria-label'],
      text: '粉丝 328.3万',
    });
    expect(node?.attrs).toEqual(['data-e2e', 'aria-label']);
    expect(node?.shape).toBe('粉丝 NUM万');
  });

  it('骨架里不会混进原始文本（哪怕客户端硬塞）', () => {
    const node = sanitizeSkeleton({ tag: 'p', text: '这是一段用户写的正文内容，包含隐私信息' });
    const json = serializeSkeleton(node);
    expect(json).not.toContain('正文');
    expect(json).not.toContain('隐私');
    expect(json).toContain('CJK');
  });

  it('深度与体积都封顶（整页 DOM 既喂不进模型，也不该上传）', () => {
    // 造一条 20 层深的链
    let deep: Record<string, unknown> = { tag: 'span', text: '1' };
    for (let i = 0; i < 20; i++) deep = { tag: 'div', children: [deep] };
    const json = serializeSkeleton(sanitizeSkeleton(deep));
    expect(json.length).toBeLessThanOrEqual(MAX_SKELETON_CHARS);
    // 8 层以后不再往下收
    expect(json.split('children').length - 1).toBeLessThanOrEqual(9);
  });

  it('非法标签名一律丢弃（防止把脚本片段当节点收进来）', () => {
    expect(sanitizeSkeleton({ tag: '<script>' })).toBeNull();
    expect(sanitizeSkeleton({ tag: '' })).toBeNull();
    expect(sanitizeSkeleton('不是对象')).toBeNull();
  });
});

describe('事件合并', () => {
  it('同平台同字段合并成一条并累加次数（一次改版会在几百个用户那里同时发生）', async () => {
    const a = await recordParserIncident({ workspaceId, platform: 'douyin', scope: 'rival', field: 'followers' });
    const b = await recordParserIncident({ workspaceId, platform: 'douyin', scope: 'rival', field: 'followers' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    const row = await prisma.parserIncident.findUnique({ where: { id: a.id } });
    expect(row?.samples).toBe(2);
  });

  it('不同字段各记一条', async () => {
    await recordParserIncident({ workspaceId, platform: 'douyin', scope: 'rival', field: 'followers' });
    await recordParserIncident({ workspaceId, platform: 'douyin', scope: 'rival', field: 'views' });
    expect(await prisma.parserIncident.count()).toBe(2);
  });

  it('先到的骨架不被后面的覆盖（覆盖没有收益，只是反复写大字段）', async () => {
    const first = await recordParserIncident({
      workspaceId, platform: 'xiaohongshu', scope: 'rival', field: 'followers',
      skeleton: { tag: 'div', cls: ['first'] },
    });
    await recordParserIncident({
      workspaceId, platform: 'xiaohongshu', scope: 'rival', field: 'followers',
      skeleton: { tag: 'div', cls: ['second'] },
    });
    const row = await prisma.parserIncident.findUnique({ where: { id: first.id } });
    expect(row?.skeleton).toContain('first');
    expect(row?.skeleton).not.toContain('second');
  });
});

describe('候选规则不许自动上线', () => {
  it('Mock 模型下一条候选都不产出（它会编出看着很像的选择器）', async () => {
    const inc = await recordParserIncident({
      workspaceId, platform: 'douyin', scope: 'rival', field: 'followers',
      skeleton: { tag: 'div', cls: ['user-info'], attrs: ['data-e2e'] },
    });
    const r = await proposeSelectors(inc.id, null);
    expect(r.ok).toBe(false);
    expect(await prisma.parserRule.count()).toBe(0);
  });

  it('没有骨架的事件诊断不了（拒绝比瞎猜好）', async () => {
    const inc = await recordParserIncident({ workspaceId, platform: 'douyin', scope: 'rival', field: 'views' });
    const r = await proposeSelectors(inc.id, null);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('样本');
  });
});

describe('下发与回滚', () => {
  async function mkRule(version: number, status = 'candidate', selectors = [`.v${version}`]) {
    return prisma.parserRule.create({
      data: {
        platform: 'douyin', field: 'followers', version, status,
        selectors: JSON.stringify(selectors), anchors: '[]', source: 'manual',
      },
    });
  }

  it('采纳新版会把旧的 active 退休（同一字段只能有一版生效）', async () => {
    const v1 = await mkRule(1, 'active');
    const v2 = await mkRule(2);
    await activateRule(v2.id, 'admin-1');

    const rows = await prisma.parserRule.findMany({ orderBy: { version: 'asc' } });
    expect(rows[0].status).toBe('retired');
    expect(rows[1].status).toBe('active');
    expect(rows[1].reviewedBy).toBe('admin-1');
    expect(v1.status).toBe('active'); // 采纳前确实是生效状态
  });

  it('回滚把当前退掉并点亮上一版', async () => {
    await mkRule(1, 'retired');
    const v2 = await mkRule(2, 'active');
    const r = await rollbackRule('douyin', 'followers', 'admin-1');
    expect(r.ok).toBe(true);

    const rows = await prisma.parserRule.findMany({ orderBy: { version: 'asc' } });
    expect(rows[0].status).toBe('active');
    expect(rows[1].status).toBe('retired');
    expect(v2.version).toBe(2);
  });

  it('规则包只给生效中的那一版', async () => {
    await mkRule(1, 'retired');
    await mkRule(2, 'active', ['.now']);
    await mkRule(3, 'candidate', ['.not-yet']);

    const pack = await activeRulePack();
    expect(pack.rules).toHaveLength(1);
    expect(pack.rules[0].selectors).toEqual(['.now']);
    expect(pack.version).not.toBe('0');
  });

  it('命中率只记不判，且非法值不写（没验证过 ≠ 0）', async () => {
    const rule = await mkRule(1);
    await recordHitRate(rule.id, 1.5);
    expect((await prisma.parserRule.findUnique({ where: { id: rule.id } }))!.hitRate).toBeNull();
    await recordHitRate(rule.id, 0.82);
    expect((await prisma.parserRule.findUnique({ where: { id: rule.id } }))!.hitRate).toBeCloseTo(0.82);
  });
});
