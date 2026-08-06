import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { handleInbound } from '@/lib/bot/router';
import { ingestTopic } from '@/lib/bot/ingest';

// 入站 ChatOps：收录成选题候选（去重、绝不发布）、命令回执。

beforeEach(async () => {
  await prisma.tenant.deleteMany({}); // 级联清 workspace/account/topicIdea
  await prisma.hotItem.deleteMany({}); // HotItem 是全局表，不随租户级联，需单独清
  await prisma.competitorAccount.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: '测试租户', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: '默认工作区' } });
});

async function withAccount() {
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '测试号', platform: 'douyin', status: 'active' } });
}

describe('ingestTopic', () => {
  it('收录成 candidate 选题（挂到活跃账号）', async () => {
    await withAccount();
    const r = await ingestTopic('w1', '  一个很好的选题  ');
    expect(r.ok).toBe(true);
    expect(r.existed).toBe(false);
    const t = await prisma.topicIdea.findFirst({ where: { accountId: 'a1' } });
    expect(t?.title).toBe('一个很好的选题');
    expect(t?.state).toBe('candidate'); // 只进候选池，绝不发布
    expect(t?.sourceType).toBe('manual');
  });

  it('同名去重：第二次返回 existed，不重复建', async () => {
    await withAccount();
    await ingestTopic('w1', '重复选题');
    const r2 = await ingestTopic('w1', '重复选题');
    expect(r2.existed).toBe(true);
    expect(await prisma.topicIdea.count({ where: { accountId: 'a1' } })).toBe(1);
  });

  it('无账号 → 明确报错、不建选题', async () => {
    const r = await ingestTopic('w1', 'x');
    expect(r.ok).toBe(false);
    expect(await prisma.topicIdea.count()).toBe(0);
  });
});

describe('handleInbound', () => {
  it('/帮助 → 返回指令说明', async () => {
    const reply = await handleInbound('w1', '/帮助');
    expect(reply).toContain('可用指令');
  });

  it('普通文本 → 收录成选题并回执', async () => {
    await withAccount();
    const reply = await handleInbound('w1', '露营装备测评');
    expect(reply).toContain('已收录');
    expect(await prisma.topicIdea.count({ where: { accountId: 'a1' } })).toBe(1);
  });

  it('/选题 关键词 → 收录该关键词为标题', async () => {
    await withAccount();
    const reply = await handleInbound('w1', '/选题 秋季穿搭');
    expect(reply).toContain('精排');
    const t = await prisma.topicIdea.findFirst({ where: { accountId: 'a1' } });
    expect(t?.title).toBe('秋季穿搭');
    expect(t?.sourceRef).toBe('bot:feishu:/选题');
  });

  it('/热点 → 走命令路径返回热榜（不误落进收录）', async () => {
    await prisma.hotItem.create({ data: { source: 'weibo', rank: 1, title: '某热点事件', heat: 99 } });
    const reply = await handleInbound('w1', '/热点');
    expect(reply).toContain('当前热榜');
    expect(reply).toContain('某热点事件');
    expect(await prisma.topicIdea.count()).toBe(0); // 命令不产生收录
  });

  it('/热点 无数据 → 明确提示，不崩', async () => {
    const reply = await handleInbound('w1', '/热点');
    expect(reply).toContain('暂无热榜');
  });
});
