import { NextResponse } from 'next/server';
import { resolveApiToken, apiEnabled } from '@/lib/api/token';
import { getAgentRunView, cancelAgentRun } from '@/lib/agent/run';
import { siteUrl } from '@/lib/site-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/v1/runs/<id> —— 看一次执行走到哪了。
//
// 调用方（脚本 / MCP 客户端）拿到 runId 之后靠轮询它看进度：
// running（在跑）→ awaiting_confirm（**停下来等人在网页上点确认**）
// → waiting_browser（等浏览器插件）→ done / failed / cancelled。
//
// awaiting_confirm 要在返回里说清楚「去哪儿点」——调用方是个程序，
// 它不知道这台机器的网页在哪，而卡在这里不动是最容易被当成「挂了」的状态。

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!apiEnabled()) return NextResponse.json({ ok: false, error: 'Not Found' }, { status: 404 });

  const auth = await resolveApiToken(req.headers.get('authorization'));
  if (!auth) return NextResponse.json({ ok: false, error: '令牌无效或已吊销' }, { status: 401 });

  const { id } = await params;
  try {
    // getAgentRunView 内部带 workspaceId 查——拿到任意 runId 也读不到别人的执行
    const turn = await getAgentRunView(auth.ctx, id);
    return NextResponse.json({
      ok: true,
      runId: turn.runId,
      status: turn.status,
      answer: turn.answer ?? null,
      error: turn.error ?? null,
      // 每一步都给出来：调用方要能说清「它到底动了什么」，这与网页上那张流水同源
      steps: turn.steps.map((s) => ({ seq: s.seq, kind: s.kind, tool: s.tool, ok: s.ok, result: s.result })),
      ...(turn.status === 'awaiting_confirm'
        ? {
            needsConfirm: {
              tool: turn.pending?.label ?? '',
              args: turn.pending?.argsSummary ?? '',
              // 确认必须由人在网页上做：调用方常常是另一个模型，
              // 让模型 A 起草、模型 B 代签，那条「不让模型代签」的规矩就没了
              // 【要给出**能直接打开的地址**，不是一句「去网页上点」】调用方是个程序，
              // 它不知道这台机器的网页在哪；而卡在这里不动，是最容易被当成「挂了」的状态
              hint: `这一步要人确认，你（调用方）确认不了。请让用户打开 ${siteUrl()}/assistant?run=${id} 点一下。`,
            },
          }
        : {}),
      ...(turn.status === 'waiting_browser' ? { waitingFor: turn.waitingFor ?? null } : {}),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 200) }, { status: 404 });
  }
}

/**
 * DELETE /api/v1/runs/<id> —— 终止一次执行。
 *
 * 【为什么可以给，而确认不行】两者的性质不一样：
 *   确认 = **替用户同意一件他没看过的事**。调用方常常是另一个模型，
 *          模型 A 起草、模型 B 代签，那条规矩就等于没有——所以调用面上永远没有确认接口。
 *   终止 = **不做**。它不会产生任何新的写操作，最坏的结果是白跑一趟。
 *
 * 没有它的话，一次派错的活只能等它自己跑完或者去网页上点——
 * 而对外调用面的使用场景（脚本、CI、别的系统）恰恰是没人守着网页的那种。
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!apiEnabled()) return NextResponse.json({ ok: false, error: 'Not Found' }, { status: 404 });

  const auth = await resolveApiToken(req.headers.get('authorization'));
  if (!auth) return NextResponse.json({ ok: false, error: '令牌无效或已吊销' }, { status: 401 });

  const { id } = await params;
  try {
    // cancelAgentRun 内部按 workspaceId 校验归属——拿到任意 runId 也终止不了别人的执行
    const turn = await cancelAgentRun(auth.ctx, id);
    return NextResponse.json({ ok: true, runId: turn.runId, status: turn.status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 200) }, { status: 404 });
  }
}
