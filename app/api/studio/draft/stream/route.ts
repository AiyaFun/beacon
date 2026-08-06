import { getSessionOrNull } from '@/lib/session';
import { can } from '@/lib/rbac';
import { llmCompleteStream } from '@/lib/llm/gateway';
import { checkFactDrift } from '@/lib/humanize/factcheck';
import { resolveDraftTarget, loadDraftContext, buildDraftMessages, persistDraftVersion } from '@/lib/studio/draft-core';

// 初稿的**流式**出口：边写边显示，不再是转一分钟圈然后整篇蹦出来。
//
// 为什么是路由不是 server action：server action 只能返回一个完整结果，没有增量通道。
// 生成逻辑（定位草稿/上下文/prompt/落库）全部复用 lib/studio/draft-core，
// 与非流式的 actDraft 是同一套——两条路写出来的东西必须一致。
//
// 落库时机：**流读完之后**在服务端落（不是等前端回传）。前端断线/关页面时
// 已经生成的内容照样存得下来，用户回来还在——而且额度已经花了，不落库等于白烧。
//
// 深度模式不走这里：它是两段式（大纲 → 成稿），中间那段没有可展示的增量语义，
// 硬做流式只会让用户看着一份大纲以为是成稿。深度模式仍走 actDraft。
export const runtime = 'nodejs';

type Body = { draftId?: string | null; topicId?: string };

export async function POST(req: Request) {
  const s = await getSessionOrNull();
  if (!s) return json({ error: '请先登录' }, 401);
  if (!can(s.role, 'content.create')) return json({ error: '当前角色没有创作权限' }, 403);

  const body = (await req.json().catch(() => ({}))) as Body;

  const resolved = await resolveDraftTarget({
    accountId: s.accountId,
    draftId: body.draftId ?? null,
    topicId: body.topicId,
  });
  if (!resolved.ok) return json({ error: resolved.error }, 400);
  const target = resolved.target;
  const ctx = await loadDraftContext({ workspaceId: s.workspaceId, accountId: s.accountId, target });
  const { messages, temperature } = buildDraftMessages(target, ctx);

  let upstream: ReadableStream<string>;
  try {
    upstream = await llmCompleteStream(s.tenantId, 'generation', messages, { temperature });
  } catch (e) {
    // 配额/权限这类「设计内拒绝」要带原文回去（前端红字展示自救指引），不是 500
    const msg = (e as Error).message;
    return json({ error: msg }, msg.includes('配额') || msg.includes('quota') ? 429 : 500);
  }

  const encoder = new TextEncoder();
  const sse = new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let full = '';
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      // 先把 draftId 告诉前端：这条流可能刚**新建**了一份草稿，
      // 不先说的话前端在生成结束前不知道该刷新哪一份（没选中草稿时点生成就是这种情形）。
      send('meta', { draftId: target.draftId, title: target.topicTitle });

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          full += value;
          send('delta', value);
        }
      } catch (e) {
        send('error', { error: (e as Error).message || '生成中断' });
        controller.close();
        return;
      }

      const content = full.trim();
      if (!content) {
        send('error', { error: 'AI 没返回内容，请重试' });
        controller.close();
        return;
      }

      try {
        const { seq } = await persistDraftVersion({
          workspaceId: s.workspaceId,
          accountId: s.accountId,
          draftId: target.draftId,
          topicTitle: target.topicTitle,
          content,
        });
        // 与非流式同一道闸：多出来的数字如实告警，不假装模型很听话
        const drift = checkFactDrift(`${target.topicTitle} ${target.topicAngle} ${ctx.accountCtx.text}`, content);
        send('done', { draftId: target.draftId, seq, warning: drift.warning });
      } catch (e) {
        // 内容已经生成出来了（额度也花了），落库失败要如实说，别让用户以为存下了
        send('error', { error: `内容已生成但保存失败：${(e as Error).message}` });
      }
      controller.close();
    },
  });

  return new Response(sse, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 宿主机 nginx 反代默认会缓冲响应体，缓冲了就等于没有流式（用户仍然只看到转圈）
      'X-Accel-Buffering': 'no',
    },
  });
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
