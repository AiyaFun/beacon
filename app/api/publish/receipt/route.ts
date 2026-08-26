import { NextResponse } from 'next/server';
import { z } from 'zod';
import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';
import { applyTaskReceipt } from '@/lib/publish/plan';
import { log } from '@/lib/logger';

// 插件回执：这条发布任务走到哪一步了。
//
// ⚠️ 允许的状态里**没有**「插件说它已经发布了」这种自动判定：
//    published 只在插件真的拿到了作品链接时才报（用户点了发布、页面跳到了作品页）。
//    只是把内容填进后台，一律报 filled。这两件事在界面上是两个不同的词，
//    在这里就必须是两个不同的状态——合并了就会出现「显示已发布，其实没发」。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': `content-type, ${INGEST_TOKEN_HEADER}`,
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

const schema = z.object({
  taskId: z.string().min(1).max(64),
  status: z.enum(['filled', 'published', 'failed', 'skipped']),
  url: z.string().max(1000).optional(),
  error: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) return NextResponse.json({ ok: false, error: INGEST_TOKEN_INVALID }, { status: 401, headers: CORS });

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: '回执格式不对' }, { status: 400, headers: CORS });
  }

  const r = await applyTaskReceipt({
    workspaceId: ws.id,
    taskId: parsed.data.taskId,
    status: parsed.data.status,
    url: parsed.data.url ?? null,
    error: parsed.data.error ?? null,
  });
  if (!r.ok) return NextResponse.json(r, { status: 404, headers: CORS });
  log.info('发布任务回执', { taskId: parsed.data.taskId, status: parsed.data.status });
  return NextResponse.json({ ok: true, warnings: r.warnings }, { headers: CORS });
}
