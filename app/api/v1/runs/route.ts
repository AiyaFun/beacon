import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveApiToken, apiEnabled } from '@/lib/api/token';
import { startAgentRun } from '@/lib/agent/run';
import { checkRateLimit, getClientIp, ipKey } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── 对外调用面 v1：让别的程序驱动这台烽火台 ────────────────────────────────
//
// 【它补的是最初那句需求】「像 OpenClaw 一样部署到 Mac mini 上直接调用使用」——
// 在此之前，让烽火台干活的唯一入口是网页。一个脚本、一个系统定时任务、
// 或者 Claude 这样的 MCP 客户端，都够不着它。
//
// 【鉴权】`Authorization: Bearer bck_…`。这枚令牌**绑到具体成员**，
// 执行的每一步按那个人的角色跑 RBAC——被降权或移出团队，令牌立刻跟着失效。
//
// 【形态闸】只有企业版（appliance / private）有这条路。SaaS 的边界是公网，
// 多开一条「拿到一串字符就能代人操作」的通道要配套做速率、审计、异常检测一整套，
// 而这条能力的动机本来就是本机部署。
//
// 【它刻意不做什么：确认】写操作仍然会停在 awaiting_confirm，而**这里没有确认接口**。
// 调用方通常是另一个模型（MCP 客户端），让模型 A 起草、模型 B 代签，
// 「睡着时花钱的合约不让模型代签」那条规矩就形同虚设。
// 要确认，去网页上点——那一下点击是人做的。

const LIMIT = { limit: 60, windowMs: 60_000 };

function unauthorized() {
  return NextResponse.json({ ok: false, error: '令牌无效或已吊销' }, { status: 401 });
}

/** POST /api/v1/runs —— 让它去做一件事。body: { goal: string } */
export async function POST(req: Request) {
  if (!apiEnabled()) return NextResponse.json({ ok: false, error: 'Not Found' }, { status: 404 });

  const rl = await checkRateLimit(ipKey('api:v1', getClientIp(req.headers)), LIMIT);
  if (!rl.ok) return NextResponse.json({ ok: false, error: '调用过于频繁' }, { status: 429 });

  const auth = await resolveApiToken(req.headers.get('authorization'));
  if (!auth) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as { goal?: unknown };
  const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
  if (!goal) return NextResponse.json({ ok: false, error: '要说清楚让它做什么（goal）' }, { status: 400 });

  try {
    // 执行是后台跑的：这里拿到的是「已经开始了」，调用方靠轮询 GET 看进度。
    // 这与网页那边是同一条路——**不为 API 另开一套执行逻辑**，否则两边的
    // 确认闸、配额闸、审计迟早各走各的
    const turn = await startAgentRun(auth.ctx, goal);
    return NextResponse.json({ ok: true, runId: turn.runId, status: turn.status });
  } catch (e) {
    // 配额用完、角色没权限这类「按设计拒绝」的错误，message 本身就是给人看的指引
    return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 300) }, { status: 400 });
  }
}

/** GET /api/v1/runs —— 最近的运行。?limit= 默认 10。 */
export async function GET(req: Request) {
  if (!apiEnabled()) return NextResponse.json({ ok: false, error: 'Not Found' }, { status: 404 });

  const auth = await resolveApiToken(req.headers.get('authorization'));
  if (!auth) return unauthorized();

  const url = new URL(req.url);
  const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 10));

  const rows = await prisma.agentRun.findMany({
    where: { workspaceId: auth.ctx.workspaceId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, goal: true, status: true, answer: true, error: true, createdAt: true },
  });

  return NextResponse.json({
    ok: true,
    runs: rows.map((r) => ({
      runId: r.id,
      goal: r.goal,
      status: r.status,
      // 列表里不给完整答案：一次列 30 条会把响应撑得很大，而调用方要细节时会去查单条
      answer: r.answer ? `${r.answer.slice(0, 200)}${r.answer.length > 200 ? '…' : ''}` : null,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
