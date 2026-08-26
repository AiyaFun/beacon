import { NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';
import { inspirationPayloadSchema, ingestInspiration } from '@/lib/ingest/inspiration';

// 灵感收集箱 · 插件回传入口（authorized 通道，与竞对/自有回传并列的第三条）。
//
// 🔒 鉴权：x-beacon-ingest-token → Workspace.ingestToken（复用同一枚令牌）。
//   本路由在 middleware 的 PUBLIC_PATHS 里——插件 fetch 不带登录 cookie，令牌是唯一闸门。
//   这条通道的权限面是三条里最小的：只往调用方工作区自己的收集箱加一行，
//   不碰任何全局共享表（CompetitorAccount/CrawledPost/HotItem 都不写）。
//
// CORS 全开同另外两条：鉴权靠自定义 header 令牌而非 cookie，无凭证跨源没有 CSRF 面。

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
    log.warn('灵感收藏鉴权失败');
    return json({ ok: false, error: INGEST_TOKEN_INVALID }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }
  const parsed = inspirationPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return json({ ok: false, error: `数据格式不合法：${parsed.error.issues[0]?.message ?? ''}` }, 400);
  }

  const r = await ingestInspiration(ws.id, parsed.data);
  if (r.ok) {
    log.info('灵感收藏入库', { workspaceId: ws.id, duplicate: r.duplicate, total: r.total });
  }
  return json(r, r.ok ? 200 : 400);
}
