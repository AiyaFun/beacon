import { NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';
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
    return json({ ok: false, error: INGEST_TOKEN_INVALID }, 401);
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

  // 【账号停采闸：这是第三条路】竞对采集两条路（lib/ingest/competitor.ts 与 lib/pipeline.ts）
  // 都挂了 isRemovalRequested，唯独**评论回传**这条没挂——而它存的是
  // 评论正文（ReaderComment）与读者提问，都挂在这个被申请移除的账号名下。
  //
  // 公开页承诺的是「收到申请即**先停止**对该账号的新增采集（不等核验完成）」。
  // 少挂这一条，那句承诺对评论这条链路就是假的：申请人看着「已受理」，
  // 我们仍在往他名下的作品上攒评论。
  //
  // 【为什么只拦 rival，不拦 own】移除申请页的名字就是「被监控账号移除申请」——
  // 它管的是「我们不要再监控某个账号」。scope='own' 是用户在读**自己**作品下的评论，
  // 不属于监控；把它一起拦掉只会在同名撞车时把用户自己的功能弄坏。
  if (p.scope !== 'own' && p.handle) {
    const { isRemovalRequested } = await import('@/lib/legal/removal');
    if (await isRemovalRequested(p.platform, p.handle)) {
      log.warn('评论回传被停采闸拦下', { platform: p.platform });
      return json({ ok: false, error: '这个账号已申请停止采集，我们不再收集它的数据。' }, 403);
    }
  }

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
  // B 站弹幕：同一条链路，source='danmaku'。同样一条失败不拖垮别的。
  let danmaku = 0;
  if (p.danmaku.length > 0) {
    try {
      const rd = await ingestReaderComments(ws.id, {
        scope: p.scope,
        platform: p.platform,
        author: p.handle || null,
        accountId: p.scope === 'own' ? (p.accountId ?? null) : null,
        workKey: commentWorkKey(p),
        workTitle: p.workTitle || null,
      }, p.danmaku, { source: 'danmaku' });
      danmaku = rd.stored;
    } catch (e) {
      log.error('弹幕入库失败', { workspaceId: ws.id, platform: p.platform, err: String(e) });
    }
  }

  log.info('评论采集入库', {
    workspaceId: ws.id, scope: p.scope, platform: p.platform, read: p.read,
    created: r.created, updated: r.updated, comments, danmaku,
  });
  return json({ ...r, comments, danmaku });
}
