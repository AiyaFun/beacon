import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';
import { MAX_SKELETON_CHARS } from '@/lib/ingest/parser-learn';
import { learnFromSkeleton, recordScrapeResult } from '@/lib/scrape/recipe';

// 任意站点采集配方的插件通道（与采集回传同一枚工作区令牌）：
//   GET  → 拉这个工作区的配方（插件按 origin 匹配当前页面）
//   POST → 两种用途，靠 kind 区分：
//          learn  = 上传脱敏骨架，服务端学出规则（配方还没学会、或坏了要重学时）
//          result = 汇报这次按配方抓的结果（成功清零、连续失败到阈值转 broken）
//
// 🔒 隐私：骨架与 /api/ingest/parser 同一套——只有标签名、类名、属性名和文本的**形状**，
//    服务端收到后再脱敏一次。插件是本地代码用户能改，客户端传的一律不信。
//
// 【为什么 GET 不返回 rules 之外的东西】配方里的 fields 是用户自己写的人话标签，
// 插件用不到（它只按 rules 取数）。少传一样就少一处能泄出去的东西。

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

  const rows = await prisma.scrapeRecipe.findMany({
    where: { workspaceId: ws.id, status: { in: ['learning', 'active', 'broken'] } },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: { id: true, name: true, origin: true, pathPattern: true, rules: true, status: true, version: true },
  });

  return NextResponse.json({
    ok: true,
    recipes: rows.map((r) => ({
      id: r.id, name: r.name, origin: r.origin, pathPattern: r.pathPattern,
      status: r.status, version: r.version,
      // learning / broken 时 rules 可能是空的或过时的——插件据 status 决定是「照着抓」还是「去学」
      rules: (() => { try { return JSON.parse(r.rules); } catch { return []; } })(),
    })),
  }, { headers: CORS });
}

const schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('learn'), recipeId: z.string().min(1).max(40), skeleton: z.unknown() }),
  z.object({ kind: z.literal('result'), recipeId: z.string().min(1).max(40), ok: z.boolean() }),
]);

export async function POST(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) return NextResponse.json({ ok: false, error: INGEST_TOKEN_INVALID }, { status: 401, headers: CORS });

  const raw = await req.text();
  // 与 /api/ingest/parser 同一个理由：超大请求体在生产会被 WAF 拦成「200 + HTML 错误页」，
  // 插件收到的是一次看不懂的假成功。自己先明确拒绝。
  if (raw.length > MAX_SKELETON_CHARS * 3 + 8_000) {
    return NextResponse.json({ ok: false, error: '结构样本太大' }, { status: 413, headers: CORS });
  }
  let body: unknown;
  try { body = JSON.parse(raw || '{}'); }
  catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400, headers: CORS }); }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: '格式不对' }, { status: 400, headers: CORS });

  // 配方必须属于这枚令牌的工作区——不然任何一枚令牌都能拿别人的 recipeId 去写
  const owned = await prisma.scrapeRecipe.findFirst({
    where: { id: parsed.data.recipeId, workspaceId: ws.id },
    select: { id: true, tenantId: true },
  });
  if (!owned) return NextResponse.json({ ok: false, error: '找不到这个配方' }, { status: 404, headers: CORS });

  if (parsed.data.kind === 'learn') {
    const r = await learnFromSkeleton({ tenantId: owned.tenantId, recipeId: owned.id, skeleton: parsed.data.skeleton });
    return NextResponse.json(r, { headers: CORS });
  }

  const r = await recordScrapeResult(owned.id, ws.id, parsed.data.ok);
  return NextResponse.json({ ok: true, ...r }, { headers: CORS });
}
