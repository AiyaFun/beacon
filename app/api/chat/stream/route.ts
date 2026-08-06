import { getSessionOrNull } from '@/lib/session';
import { prisma } from '@/lib/db';
import { readPersona, personaPromptBlock } from '@/lib/persona';
import { buildMemoryContext } from '@/lib/memory/core';
import { llmCompleteStream } from '@/lib/llm/gateway';
import { can } from '@/lib/rbac';
import type { ChatMessage } from '@/lib/llm/types';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const s = await getSessionOrNull();
  if (!s) return new Response('Unauthorized', { status: 401 });
  if (!can(s.role, 'content.create')) return new Response('Forbidden', { status: 403 });

  const body = await req.json() as { question: string; history: { role: string; content: string }[] };
  const q = (body.question ?? '').trim();
  if (!q) return new Response('Empty question', { status: 400 });

  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  const persona = readPersona(account?.personaCard ?? '{}');
  const memoryBlock = await buildMemoryContext(s.workspaceId, s.accountId);

  const system = [
    '你是「烽火台」内容创作 SaaS 里的 AI 运营助手。',
    '你服务于一位内容创作者，帮他做选题、写文案、优化运营与变现。',
    '回答要具体、可落地、说人话，紧扣下面这个账号的人设与历史记忆，别给放之四海皆准的空话。',
    '',
    personaPromptBlock(persona),
    memoryBlock ? '\n' + memoryBlock : '',
    '',
    '输出用中文，条理清晰，必要时用短列表；控制在合理长度，别啰嗦。',
  ].join('\n');

  const trimmed = (body.history ?? []).slice(-10).map(
    (t): ChatMessage => ({ role: t.role as 'user' | 'assistant', content: t.content }),
  );

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...trimmed,
    { role: 'user', content: q },
  ];

  try {
    const stream = await llmCompleteStream(s.tenantId, 'chat', messages, { temperature: 0.7 });
    const encoder = new TextEncoder();
    const sseStream = new ReadableStream({
      async start(controller) {
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          }
        } catch {
          controller.close();
        }
      },
    });

    return new Response(sseStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('配额') || msg.includes('quota')) {
      return new Response(JSON.stringify({ error: msg }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
