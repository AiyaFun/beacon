import { NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';
import { commentQuestionsSchema, ingestCommentQuestions, commentWorkKey } from '@/lib/ingest/comment-questions';
import { ingestReaderComments } from '@/lib/ingest/reader-comments';

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

  const p = parsed.data;
  const r = await ingestCommentQuestions(ws.id, p);
  if (!r.ok) return json(r, 400);

  // 读者原声与提问是两条链路，**分别入库**（不是一条链路的两个字段）：
  // 提问进灵感箱参与选题，正文只进 ReaderComment 供阅读与统计。
  // 一条失败不该拖垮另一条——提问已经入库了，正文这边炸了就少存一批，不回滚、不报 400。
  let comments = 0;
  try {
    const rc = await ingestReaderComments(ws.id, {
      scope: p.scope,
      platform: p.platform,
      author: p.handle || null,
      accountId: p.scope === 'own' ? (p.accountId ?? null) : null,
      workKey: commentWorkKey(p),
      workTitle: p.workTitle || null,
    }, p.comments);
    comments = rc.stored;
  } catch (e) {
    log.error('读者原声入库失败', { workspaceId: ws.id, platform: p.platform, err: String(e) });
  }

  log.info('评论采集入库', {
    workspaceId: ws.id, scope: p.scope, platform: p.platform, read: p.read,
    created: r.created, updated: r.updated, comments,
  });
  return json({ ...r, comments });
}
