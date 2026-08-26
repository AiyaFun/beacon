import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { hasImage, messageText, type ChatMessage } from '@/lib/llm/types';

// 对话里传参考图。
//
// 【补的是什么】出图工位与封面工位早就能传参考图，唯独**对话不行**——
// 而对话恰恰是用户最想说「你看看这张」的地方。做成中枢之后这个缺口更明显：
// 用户对着助手说「这张封面行不行」，助手连图都收不到。
//
// 【三件容易出错的事，各钉一条】
//   ① 没配视觉模型时要说清楚是**没配**，而不是含糊地说「我看不懂」——用户要做的事完全不同；
//   ② 带图那一条不能走流式：多数兼容端点不支持图片流式输入，硬走的结果是
//      「一个字都不出来」还不报错；
//   ③ 图**不进对话历史**：历史每轮都整段重发，图带进去第三轮就是几 MB，
//      而生产的 WAF 对超大请求体会回一个假的 HTTP 200。

const h = vi.hoisted(() => ({
  vision: { ok: true, text: '这张图的主体是一杯咖啡', model: 'v' } as Record<string, unknown>,
  visionCalls: [] as ChatMessage[][],
  streamCalls: 0,
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmVision: async (_t: unknown, messages: ChatMessage[]) => {
    h.visionCalls.push(messages);
    return h.vision;
  },
  llmCompleteStream: async () => {
    h.streamCalls++;
    return new ReadableStream({ start(c) { c.enqueue('好的'); c.close(); } });
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const h2 = vi.hoisted(() => ({ session: null as unknown }));
vi.mock('@/lib/session', () => ({ getSessionOrNull: async () => h2.session }));

const { POST } = await import('@/app/api/chat/stream/route');

const PIC = 'data:image/png;base64,iVBORw0KGgo=';

const ask = (body: unknown) =>
  POST(new Request('http://x/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

async function readSse(res: Response): Promise<string> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(5).trim()) as string)
    .join('');
}

beforeEach(async () => {
  h.vision = { ok: true, text: '这张图的主体是一杯咖啡', model: 'v' };
  h.visionCalls = [];
  h.streamCalls = 0;

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'xiaohongshu', personaCard: '{}' },
  });
  h2.session = {
    tenantId: tenant.id, workspaceId: ws.id, accountId: account.id,
    memberId: 'm', memberName: '张三', role: 'owner', plan: 'personal',
  };
});

describe('带图的问题走视觉模型', () => {
  it('传了图 → 走 llmVision，且不走流式', async () => {
    const res = await ask({ question: '这张图能当封面吗', history: [], images: [PIC] });
    expect(await readSse(res)).toContain('咖啡');
    expect(h.visionCalls.length).toBe(1);
    // 多数兼容端点不支持图片的流式输入，硬走的结果是一个字都不出来还不报错
    expect(h.streamCalls, '带图不该走流式').toBe(0);
  });

  it('图作为 image_url 片段进消息，文字与图在同一条 user 消息里', async () => {
    await ask({ question: '看看这个', history: [], images: [PIC] });
    const msgs = h.visionCalls[0];
    const last = msgs[msgs.length - 1];
    expect(hasImage([last])).toBe(true);
    expect(messageText(last.content)).toContain('看看这个');
  });

  it('只发图不打字也能问（「这张图怎么样」是很自然的问法）', async () => {
    const res = await ask({ question: '', history: [], images: [PIC] });
    expect(res.status).toBe(200);
    expect(messageText(h.visionCalls[0].at(-1)!.content), '要替用户补一句默认的问法').toBeTruthy();
  });

  it('没图时照旧走流式，一点没变', async () => {
    await ask({ question: '帮我想个选题', history: [] });
    expect(h.streamCalls).toBe(1);
    expect(h.visionCalls.length).toBe(0);
  });

  it('什么都没有时打回', async () => {
    const res = await ask({ question: '   ', history: [] });
    expect(res.status).toBe(400);
  });
});

describe('没配视觉模型时说清楚是「没配」', () => {
  it('回一句能照着做的话，而不是含糊地说看不懂', async () => {
    h.vision = { ok: false, reason: 'not_configured', error: 'x' };
    const text = await readSse(await ask({ question: '看看', history: [], images: [PIC] }));
    // 「我看不懂这张图」与「这台机器没配能看图的模型」，用户要做的事完全不同
    expect(text).toContain('没有配置');
    expect(text).toContain('接入与密钥');
  });

  it('真的调用失败时如实说失败，不冒充成「没配置」', async () => {
    h.vision = { ok: false, reason: 'failed', error: '上游 502' };
    const text = await readSse(await ask({ question: '看看', history: [], images: [PIC] }));
    expect(text).toContain('502');
  });
});

describe('输入面收窄', () => {
  it('只收 data: 内联图，**不接受 http(s) 地址**', async () => {
    // 收 URL 等于让服务端去拉一个用户给的地址——一条新的 SSRF 面，
    // 而客户端本来就已经把图读进内存了
    await ask({ question: '看看', history: [], images: ['https://evil.example.com/x.png'] });
    expect(h.visionCalls.length, '不该有任何一张图被收下').toBe(0);
    expect(h.streamCalls, '没有有效图片就该退回普通对话').toBe(1);
  });

  it('最多 3 张（超大请求体会被 WAF 回一个假的 200）', async () => {
    await ask({ question: '看看', history: [], images: [PIC, PIC, PIC, PIC, PIC] });
    const last = h.visionCalls[0].at(-1)!;
    const parts = Array.isArray(last.content) ? last.content : [];
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(3);
  });
});

describe('图不进对话历史', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

  it('两个对话入口都在发完之后把图清空', () => {
    // 历史每一轮都会整段重发给模型。图带进历史，第三轮的请求体就是几 MB——
    // 而那正是 WAF 回假 200 的量级
    for (const p of ['app/(app)/assistant/Chat.tsx', 'components/GlobalAIAssistant.tsx']) {
      const src = read(p);
      expect(src, `${p} 没有在发送后清空待发图片`).toMatch(/setPics\(\[\]\)/);
    }
  });

  it('客户端压缩复用同一份，不另写第二套', () => {
    for (const p of ['app/(app)/assistant/Chat.tsx', 'components/GlobalAIAssistant.tsx']) {
      expect(read(p)).toMatch(/prepareReferenceImage/);
    }
  });
});
