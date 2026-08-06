import { NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import {
  INGEST_TOKEN_HEADER,
  ingestPayloadSchema,
  ingestCompetitorData,
  workspaceByIngestToken,
} from '@/lib/ingest/competitor';

// 竞对监控 · 插件回传入口（authorized 通道，方案三）。
//
// 🔒 鉴权：x-beacon-ingest-token → Workspace.ingestToken（settings 页生成的随机令牌）。
//   本路由在 middleware 的 PUBLIC_PATHS 里——插件的 fetch 不带登录 cookie，拦了就是 307 跳
//   /login，插件永远拿不到 JSON。放行不等于不设防：令牌是唯一闸门，未带/无效一律 401；
//   令牌只授权「向本工作区已订阅的竞对补充公开数据」这一件事（守卫在 lib/ingest/competitor.ts）。
//
// CORS 全开（Allow-Origin *）是刻意的：鉴权靠自定义 header 里的令牌而非 cookie，
// 无凭证的跨源放开没有 CSRF 面；这样浏览器插件不需要申请任何 host 权限即可回传。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': `content-type, ${INGEST_TOKEN_HEADER}`,
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

// GET = 插件设置页的「测试连接」握手：令牌有效则回工作区名
export async function GET(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) return json({ ok: false, error: '采集令牌无效或已停用' }, 401);
  return json({ ok: true, workspace: ws.name });
}

export async function POST(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) {
    log.warn('插件回传鉴权失败');
    return json({ ok: false, error: '采集令牌无效或已停用——请在 设置页 重新生成并填入插件' }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }
  const parsed = ingestPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return json({ ok: false, error: `数据格式不合法：${parsed.error.issues[0]?.message ?? ''}` }, 400);
  }

  const r = await ingestCompetitorData(ws.id, parsed.data);
  if (!r.ok) return json(r, r.code === 'not_found' ? 404 : 403);
  log.info('插件回传入库', { workspaceId: ws.id, platform: parsed.data.platform, handle: parsed.data.handle, posts: r.posts });
  return json(r);
}
