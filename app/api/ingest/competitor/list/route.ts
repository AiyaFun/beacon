import { NextResponse } from 'next/server';
import {
  INGEST_TOKEN_HEADER,
  workspaceByIngestToken,
  listSubscribedCompetitors,
} from '@/lib/ingest/competitor';

// 竞对监控 · 插件读取「本工作区订阅的竞对清单」（authorized 通道，方案三 方案①）。
// 供插件的每日提醒角标 + 竞对清单弹窗（一键打开并采集）用。
//
// 🔒 鉴权同 ../route.ts：x-beacon-ingest-token → Workspace.ingestToken。只读、只回本工作区订阅项。
//   在 middleware 的 PUBLIC_PATHS 里（/api/ingest/competitor 前缀已覆盖本子路径），插件无 cookie 也可调。
// CORS 全开（令牌头鉴权、无 cookie，无 CSRF 面），插件免 host 权限。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': `content-type, ${INGEST_TOKEN_HEADER}`,
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) return json({ ok: false, error: '采集令牌无效或已停用' }, 401);
  const competitors = await listSubscribedCompetitors(ws.id);
  return json({ ok: true, workspace: ws.name, competitors });
}
