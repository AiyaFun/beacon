import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { writeBotSecrets } from '@/lib/bot';
import { startProgressCard, __resetProgressThrottle } from '@/lib/bot/progress';

// 起卡是异步旁路：任务在它执行前已经跑完时不许再发一张「跑完了」卡——终态回执（echoRunToChat）已经说过了。
beforeEach(async () => {
  __resetProgressThrottle();
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '号', platform: 'douyin', status: 'active' } });
  await prisma.botIntegration.create({ data: { id: 'bi1', workspaceId: 'w1', provider: 'feishu', label: 'B', inboundKey: 'cli_app', secretsEnc: writeBotSecrets({ appSecret: 'sec' }), pushEvents: '[]' } });
  vi.stubGlobal('fetch', async () => { throw new Error('不该发请求'); });
});
afterEach(() => vi.unstubAllGlobals());

it.each(['done', 'failed', 'cancelled'])('已是 %s → 不起卡、不发请求', async (status) => {
  await prisma.agentRun.create({ data: { id: `r-${status}`, workspaceId: 'w1', accountId: 'a1', memberId: 'm1', goal: 'x', status, messages: '[]', botChatRef: 'feishu:bi1:oc_1' } });
  expect(await startProgressCard(`r-${status}`)).toBe(false);
});
