import { NextResponse } from 'next/server';
import { z } from 'zod';
import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';
import { recordParserIncident, activeRulePack, MAX_SKELETON_CHARS } from '@/lib/ingest/parser-learn';
import { log } from '@/lib/logger';

// 采集自学习的插件通道（authorized，与采集回传同一枚工作区令牌）：
//   GET  → 拉当前生效的解析规则包（插件本地缓存，解析失败时按它兜底）
//   POST → 上报「这个字段采不到」+ **脱敏后的页面结构骨架**
//
// 🔒 隐私：骨架里只有标签名、类名、属性**名**和文本的**形状**（数字→NUM、长中文→CJK）。
//    服务端收到后还会再脱敏一次（lib/ingest/parser-learn.ts sanitizeSkeleton）——
//    插件是本地代码，用户能改，所以客户端上传的东西一律不信。
//    这条链路已写进隐私政策（网页版 + 插件商店版两份）。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': `content-type, ${INGEST_TOKEN_HEADER}`,
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) return NextResponse.json({ ok: false, error: INGEST_TOKEN_INVALID }, { status: 401, headers: CORS });
  const pack = await activeRulePack();
  return NextResponse.json({ ok: true, ...pack }, { headers: CORS });
}

const schema = z.object({
  platform: z.string().min(1).max(30),
  scope: z.enum(['rival', 'self']),
  field: z.string().min(1).max(40),
  note: z.string().max(300).optional(),
  // 骨架结构由服务端再脱敏，这里只把「别塞一个 10MB 的东西进来」这条挡住
  skeleton: z.unknown().optional(),
});

export async function POST(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) return NextResponse.json({ ok: false, error: INGEST_TOKEN_INVALID }, { status: 401, headers: CORS });

  const raw = await req.text();
  if (raw.length > MAX_SKELETON_CHARS * 3) {
    // 超大请求体在生产会被 WAF 缓冲区拦成「200 + HTML 错误页」（踩过的坑），
    // 与其让插件收到一个看不懂的 200，不如自己先明确拒绝。
    return NextResponse.json({ ok: false, error: '结构样本太大' }, { status: 413, headers: CORS });
  }
  const parsed = schema.safeParse(JSON.parse(raw || '{}'));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: '样本格式不对' }, { status: 400, headers: CORS });
  }

  const r = await recordParserIncident({
    workspaceId: ws.id,
    platform: parsed.data.platform,
    scope: parsed.data.scope,
    field: parsed.data.field,
    skeleton: parsed.data.skeleton,
    note: parsed.data.note,
  });
  log.info('解析失效样本入库', { platform: parsed.data.platform, field: parsed.data.field, created: r.created });
  return NextResponse.json({ ok: true, incidentId: r.id, first: r.created }, { headers: CORS });
}
