import { NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';
import { commentQuestionsSchema, ingestCommentQuestions } from '@/lib/ingest/comment-questions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': `content-type, ${INGEST_TOKEN_HEADER}`,
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) {
    log.warn('评论提问鉴权失败');
    return json({ ok: false, error: '采集令牌无效或已停用——请在 设置页 重新生成并填入插件' }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }

  const parsed = commentQuestionsSchema.safeParse(body);
  if (!parsed.success) {
    return json({ ok: false, error: `数据格式不合法：${parsed.error.issues[0]?.message ?? ''}` }, 400);
  }

  const r = await ingestCommentQuestions(ws.id, parsed.data);
  if (r.ok) {
    log.info('评论提问入库', {
      workspaceId: ws.id, scope: parsed.data.scope,
      platform: parsed.data.platform, read: parsed.data.read,
      created: r.created, updated: r.updated,
    });
  }
  return json(r, r.ok ? 200 : 400);
}
