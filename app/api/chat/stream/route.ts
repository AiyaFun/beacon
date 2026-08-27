import { getSessionOrNull } from '@/lib/session';
import { prisma } from '@/lib/db';
import { readPersona, personaPromptBlock } from '@/lib/persona';
import { buildMemoryContext } from '@/lib/memory/core';
import { llmCompleteStream, llmVision } from '@/lib/llm/gateway';
import { can } from '@/lib/rbac';
import type { ChatMessage, ContentPart } from '@/lib/llm/types';

export const runtime = 'nodejs';

/**
 * 一次最多带几张图。
 *
 * 【为什么是 3】每张内联图都要整段进请求体与模型上下文，四五张就是几 MB——
 * 生产的 WAF 对超过 client_body_buffer_size 的请求体会回一个**假的 HTTP 200 + HTML 错误页**
 *（视频拆解上传曾因此在生产一直是坏的）。3 张既够用又留足余量。
 */
const MAX_IMAGES = 3;

/** 把一段整文本包成与流式接口一模一样的 SSE 形状——前端不用为「带图」写第二套解析。 */
function sse(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(text)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } },
  );
}

export async function POST(req: Request) {
  const s = await getSessionOrNull();
  if (!s) return new Response('Unauthorized', { status: 401 });
  if (!can(s.role, 'content.create')) return new Response('Forbidden', { status: 403 });

  const body = await req.json() as {
    question: string;
    history: { role: string; content: string }[];
    /** 用户贴/传的参考图（data: URI，客户端已经压过）。最多几张见 MAX_IMAGES */
    images?: string[];
    /**
     * 用户在输入框下选的模型（ModelProvider.id / 'platform' / 'auto'）。
     *
     * 不做白名单校验是安全的，因为**归属校验在网关里**：resolveWithSource 只在
     * 「按 tenantId 查出来的那批 provider」里找这个 id，填别人租户的 id 落空后
     * 按原有次序继续（不报错，也拿不到别人的 Key）。'auto' 同理——找不到就是原行为。
     */
    modelId?: string;
  };
  const q = (body.question ?? '').trim();
  const images = (body.images ?? [])
    // 只收 data: 内联图。**不接受 http(s) 地址**：那等于让服务端去拉一个用户给的 URL，
    // 是一条新的 SSRF 面，而客户端本来就已经把图读进内存了
    .filter((u) => typeof u === 'string' && u.startsWith('data:image/'))
    .slice(0, MAX_IMAGES);
  // 只有图没有字也算数：「这张图怎么样」是很自然的问法
  if (!q && images.length === 0) return new Response('Empty question', { status: 400 });

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
    '',
    // 【防编造纪律，2026-08-26 真机抓到】对话侧没有工具，模型看不到用户系统里的
    // 实时数据（选题池/草稿/竞对/数据看板）。不写这条的话，用户问「给我今天的选题」，
    // 模型会**编**出一套带假依据的清单（真机原文：「[事实记忆·上月·已重复验证2次]」），
    // 看上去像查过库——这比答不出更糟。
    '【重要】你在这个对话里**没有任何工具**，看不到他系统里的实时数据（今天的选题推荐、草稿、竞对动态、数据指标都看不到）。',
    '他问到这些时：如实说你在对话模式下查不到，请他点上方「让它去做」或直接说「帮我去查/去执行」，那边能真的查库和操作。',
    '**绝不许编造**他系统里的具体数据、条目或「记忆依据」。上面记忆块里没有的，就是你不知道的。',
  ].join('\n');

  const trimmed = (body.history ?? []).slice(-10).map(
    (t): ChatMessage => ({ role: t.role as 'user' | 'assistant', content: t.content }),
  );

  // 带图的那一条走多模态形状：文字 + 每张图各一个 image_url 片段
  const userContent: string | ContentPart[] = images.length
    ? [
        { type: 'text' as const, text: q || '看看这张图，结合我的账号说说能怎么用。' },
        ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      ]
    : q;

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...trimmed,
    { role: 'user', content: userContent },
  ];

  // 【带图时走视觉模型，且不流式】流式接口在多数兼容端点上不支持图片输入；
  // 硬走流式的结果是「一个字都不出来」还不报错。带图就整段返回，
  // 再包装成同一个 SSE 形状——前端那侧一行都不用改。
  if (images.length > 0) {
    const r = await llmVision(s.tenantId, messages, { temperature: 0.5 });
    const text = r.ok
      ? r.text
      : r.reason === 'not_configured'
        // 说清楚是「没配」而不是「看不懂这张图」——用户要做的事完全不同
        ? '这台实例还没有配置能看图的模型，所以我看不到你发的图片。让管理员在「接入与密钥」里配一个视觉模型就可以了。'
        : `看图时出了点问题：${r.error}`;
    return sse(text);
  }

  try {
    const stream = await llmCompleteStream(s.tenantId, 'chat', messages, {
      temperature: 0.7,
      // 'auto' 不是真 id，透传下去只会落空——语义上等同不传，这里直接不传更清楚
      providerId: body.modelId && body.modelId !== 'auto' ? body.modelId : undefined,
    });
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
