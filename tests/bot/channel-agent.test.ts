import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { at } from '../helpers/anchor';

// 「为渠道选一个智能体」（2026-09-01，参照 Accio 的渠道配置模型）：
// BotIntegration.agentTemplateId → 群里 @机器人 的对话以该智能体职责说明作身份。
// 这里钉三层：schema 两份都有列 / 身份真的进了 system 提示 / 越权模板绑不上。

const ROOT = process.cwd();

describe('渠道绑定智能体 · schema', () => {
  it('🔒 两份 schema 都有 agentTemplateId（漏 postgres 那份 = 本地绿生产炸）', () => {
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      // 不能用 indexOf('}')：secretsEnc 的注释里就有一个 `}`（加密 JSON 的示意），
      // 会把切片截在列声明之前——测试自己先被注释骗了（假绿清单第五形的镜像：假红）
      const seg = /model BotIntegration \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
      expect(seg, `${f} 的 BotIntegration 少了 agentTemplateId`).toContain('agentTemplateId');
    }
    // 生产迁移文件也在
    at(readFileSync(join(ROOT, 'prisma/postgres/46-bot-agent.sql'), 'utf8'), 'agentTemplateId');
  });
});

describe('渠道绑定智能体 · 身份注入', () => {
  it('🔒 绑了智能体：system 提示以它开场并带职责说明', async () => {
    const { botChat } = await import('@/lib/bot/chat');
    const { llmComplete } = await import('@/lib/llm/gateway');
    const { vi } = await import('vitest');
    // 桩掉网关，抓 system 消息
    const spy = vi.spyOn(await import('@/lib/llm/gateway'), 'llmComplete' as never);
    // 直接构造租户
    const t = await prisma.tenant.create({ data: { name: 'BA', plan: 'free' } });
    const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'W' } });
    let captured = '';
    (spy as ReturnType<typeof vi.spyOn>).mockImplementation(async (...args: unknown[]) => {
      const messages = args[2] as { role: string; content: string }[];
      captured = messages.find((m) => m.role === 'system')?.content ?? '';
      return { text: '好的', provider: 'x', model: 'x', mocked: false };
    });
    await botChat({
      workspaceId: w.id, accountId: null, accountName: null,
      question: '在吗', turns: [],
      agent: { name: '小红书日更三件套', persona: '要发小红书图文时派我' },
    });
    spy.mockRestore();
    expect(captured).toContain('小红书日更三件套');
    expect(captured, '职责说明没进身份行——绑了等于没绑').toContain('要发小红书图文时派我');
    expect(captured, '身份行必须开场（身份是口吻与边界，不是补充信息）')
      .toMatch(/^你是「烽火台」的智能体/);
  });

  it('不绑：保持通用运营助手的原开场（老用户行为一个字不变）', async () => {
    const { botChat } = await import('@/lib/bot/chat');
    const { vi } = await import('vitest');
    const spy = vi.spyOn(await import('@/lib/llm/gateway'), 'llmComplete' as never);
    const t = await prisma.tenant.create({ data: { name: 'BB', plan: 'free' } });
    const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'W' } });
    let captured = '';
    (spy as ReturnType<typeof vi.spyOn>).mockImplementation(async (...args: unknown[]) => {
      captured = (args[2] as { role: string; content: string }[]).find((m) => m.role === 'system')?.content ?? '';
      return { text: '好的', provider: 'x', model: 'x', mocked: false };
    });
    await botChat({ workspaceId: w.id, accountId: null, accountName: null, question: '在吗', turns: [] });
    spy.mockRestore();
    expect(captured).toContain('AI 运营助手');
    expect(captured).not.toContain('你是「烽火台」的智能体「');
  });
});

describe('渠道绑定智能体 · router 接线与越权', () => {
  it('🔒 router 的 cmdChat 真的把 ctx.integrationId 传下去了（两处调用点）', () => {
    const src = readFileSync(join(ROOT, 'lib/bot/router.ts'), 'utf8');
    // [^)]* 会被 firstArg(...) 的内层右括号截断——按整行匹配
    const calls = src.split('\n').filter((l) => l.includes('cmdChat(workspaceId'));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c, `调用点没带 integrationId：${c}——绑定永远查不到，功能对用户不存在`)
        .toContain('ctx.integrationId');
    }
  });

  it('🔒 actSaveBot 的 agentTemplateId 同样过租户闸（两条写入路必须同一道闸）', () => {
    const src = readFileSync(join(ROOT, 'app/(app)/settings/bot-actions.ts'), 'utf8');
    const fn = src.slice(at(src, 'export async function actSaveBot'), at(src, 'export async function actRevealBotSecrets'));
    const gate = fn.slice(at(fn, 'data.agentTemplateId !== undefined'), at(fn, 'const payload'));
    expect(gate, '保存路没圈租户——填别人的模板 id 就能绑进来').toContain('tenantId: s.tenantId');
    expect(gate).toContain('isBuiltin: true');
  });

  it('🔒 actSetBotAgent 拒绝别家租户的模板（不校验=拿别人的职责说明进自己群）', () => {
    const src = readFileSync(join(ROOT, 'app/(app)/settings/bot-actions.ts'), 'utf8');
    const fn = src.slice(at(src, 'export async function actSetBotAgent'), at(src, 'export async function actDeleteBot'));
    expect(fn).toContain("isBuiltin: true");
    expect(fn, '没按 tenantId 圈').toContain('tenantId: s.tenantId');
    expect(fn, '机器人本身没按 workspaceId 圈').toContain('workspaceId: s.workspaceId');
  });
});
