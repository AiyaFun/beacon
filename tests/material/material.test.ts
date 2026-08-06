import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/db';
import { materialPromptBlock, type MaterialEntry } from '@/lib/material';

describe('素材库 (F3-5)', () => {
  let accountId: string;

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'material-test' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'ws' } });
    const account = await prisma.creatorAccount.create({
      data: { workspaceId: ws.id, name: 'test', platform: 'douyin' },
    });
    accountId = account.id;
  });

  afterAll(async () => {
    await prisma.material.deleteMany({ where: { accountId } });
    await prisma.creatorAccount.deleteMany({ where: { id: accountId } });
    await prisma.workspace.deleteMany({ where: { tenant: { name: 'material-test' } } });
    await prisma.tenant.deleteMany({ where: { name: 'material-test' } });
  });

  it('创建素材记录', async () => {
    const m = await prisma.material.create({
      data: {
        accountId,
        type: 'experience',
        content: '去年开始做副业，前三个月颗粒无收',
        tags: JSON.stringify(['创业', '副业']),
      },
    });
    expect(m.type).toBe('experience');
    expect(m.content).toContain('副业');
  });

  it('支持四种类型', async () => {
    const types = ['experience', 'case', 'opinion', 'catchphrase'];
    for (const type of types) {
      await prisma.material.create({
        data: { accountId, type, content: `测试-${type}`, tags: '[]' },
      });
    }
    const all = await prisma.material.findMany({ where: { accountId } });
    const foundTypes = new Set(all.map((m) => m.type));
    expect(foundTypes.size).toBe(4);
  });

  it('按类型过滤查询', async () => {
    const opinions = await prisma.material.findMany({
      where: { accountId, type: 'opinion' },
    });
    expect(opinions.length).toBeGreaterThanOrEqual(1);
    expect(opinions.every((m) => m.type === 'opinion')).toBe(true);
  });

  it('更新素材内容和标签', async () => {
    const m = await prisma.material.findFirst({ where: { accountId, type: 'experience' } });
    const updated = await prisma.material.update({
      where: { id: m!.id },
      data: { content: '更新后的内容', tags: JSON.stringify(['新标签']) },
    });
    expect(updated.content).toBe('更新后的内容');
    expect(JSON.parse(updated.tags)).toEqual(['新标签']);
  });

  it('删除素材', async () => {
    const m = await prisma.material.findFirst({ where: { accountId, type: 'catchphrase' } });
    await prisma.material.delete({ where: { id: m!.id } });
    const remaining = await prisma.material.findMany({ where: { accountId, type: 'catchphrase' } });
    expect(remaining.length).toBe(0);
  });

  describe('materialPromptBlock', () => {
    it('空素材返回空字符串', () => {
      expect(materialPromptBlock([])).toBe('');
    });

    it('有素材时生成格式化 prompt', () => {
      const materials: MaterialEntry[] = [
        { type: 'experience', content: '去年裸辞创业', tags: ['创业'] },
        { type: 'opinion', content: '短视频前3秒决定一切', tags: [] },
      ];
      const block = materialPromptBlock(materials);
      expect(block).toContain('【素材库】');
      expect(block).toContain('【经历】去年裸辞创业');
      expect(block).toContain('【观点】短视频前3秒决定一切');
      expect(block).toContain('[创业]');
    });

    it('长内容截断到 300 字', () => {
      const materials: MaterialEntry[] = [
        { type: 'case', content: '长'.repeat(500), tags: [] },
      ];
      const block = materialPromptBlock(materials);
      expect(block.length).toBeLessThan(500);
    });
  });
});
