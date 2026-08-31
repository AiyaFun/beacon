import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';
import { MAX_SKELETON_CHARS } from '@/lib/ingest/parser-learn';
import { learnFromSkeleton, recordScrapeResult, parseOptions } from '@/lib/scrape/recipe';
import { isSiteRemovalRequested } from '@/lib/legal/removal';
import { saveScrapeRecord } from '@/lib/scrape/record';

// 任意站点采集配方的插件通道（与采集回传同一枚工作区令牌）：
//   GET  → 拉这个工作区的配方（插件按 origin 匹配当前页面）
//   POST → 三种用途，靠 kind 区分：
//          learn  = 上传脱敏骨架，服务端学出规则（配方还没学会、或坏了要重学时）
//          data   = 这次按配方抓到的值（落 ScrapeRecord）
//          result = 汇报这次抓取成没成（成功清零、连续失败到阈值转 broken）
//
// 🔒 隐私：骨架与 /api/ingest/parser 同一套——只有标签名、类名、属性名和文本的**形状**，
//    服务端收到后再脱敏一次。插件是本地代码用户能改，客户端传的一律不信。
//
// 【GET 只返回插件真正用得上的】fields 是用户自己写的人话标签，插件用不到——不传。
// options 传（就绪选择器 / 滚几屏 / 列表行容器）：不传的话插件那条路取不到列表，
// 同一条配方在两条路上产出的东西会不一样，而那种不一致极难排查。

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
    select: {
      id: true, name: true, origin: true, pathPattern: true,
      rules: true, options: true, status: true, version: true,
    },
  });

  return NextResponse.json({
    ok: true,
    recipes: rows.map((r) => ({
      id: r.id, name: r.name, origin: r.origin, pathPattern: r.pathPattern,
      status: r.status, version: r.version,
      options: parseOptions(r.options),
      // learning / broken 时 rules 可能是空的或过时的——插件据 status 决定是「照着抓」还是「去学」
      rules: (() => { try { return JSON.parse(r.rules); } catch { return []; } })(),
    })),
  }, { headers: CORS });
}

const schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('learn'), recipeId: z.string().min(1).max(40), skeleton: z.unknown() }),
  z.object({ kind: z.literal('result'), recipeId: z.string().min(1).max(40), ok: z.boolean() }),
  // data = 这次按配方抓到的值。
  //
  // 【为什么之前没有这一种】插件抓完只 POST `{kind:'result', ok:true}`——**values 连传都没传**，
  // 服务端也没有接收数据的通道。于是插件那条路的采集结果只活在浏览器里，
  // 用户在站里一个字都查不到，而界面上还显示「采集成功」。
  //
  // values 的形状由服务端的 sanitizeValues 说了算（key 必须是 f1..f12、单值 200 字符、
  // 整包有总上限）——插件是本地代码用户能改，客户端传的一律不信。
  z.object({
    kind: z.literal('data'),
    recipeId: z.string().min(1).max(40),
    url: z.string().max(500),
    values: z.record(z.string()),
    // 列表行。形状由服务端 sanitizeRows 说了算（每行过同一套 key 白名单与长度闸、上限 50 行）
    rows: z.array(z.record(z.string())).max(200).optional(),
    want: z.number().int().min(0).max(50).optional(),
  }),
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
    select: { id: true, tenantId: true, origin: true },
  });
  if (!owned) return NextResponse.json({ ok: false, error: '找不到这个配方' }, { status: 404, headers: CORS });

  // 【站点停采闸必须挂在这里，这是插件那条路唯一的咽喉】
  //
  // 插件把配方缓存在 chrome.storage.local 里**本地执行**，然后把结果 POST 回来。
  // 也就是说：站点权利人申请停采之后，CDP 那条路立刻停了（browseLocal 有闸），
  // 而插件**照着缓存继续抓**，服务端再照单全收——「停止抓取」这句承诺在这条路上没兑现。
  // GET 已经把 stopped 的配方排除掉了，插件下次刷新就会丢掉它；
  // 但在那之前的窗口期，只有这道闸能拦住数据落地。
  //
  // 三种 kind 全拦，不是只拦 data：
  //   · learn  —— 给一个不许抓的站学规则，等于为将来继续抓做准备
  //   · result —— 汇报本身无害，但它会把配方状态刷回 active，把 stopped 抹掉
  if (await isSiteRemovalRequested(owned.origin)) {
    return NextResponse.json(
      { ok: false, error: '这个站点的权利人已要求停止采集' },
      { status: 403, headers: CORS },
    );
  }

  if (parsed.data.kind === 'learn') {
    const r = await learnFromSkeleton({ tenantId: owned.tenantId, recipeId: owned.id, skeleton: parsed.data.skeleton });
    return NextResponse.json(r, { headers: CORS });
  }

  if (parsed.data.kind === 'data') {
    // 【网址要按配方的 origin 复验】插件传什么都不信：一枚令牌 + 一个别的站点的 url，
    // 就能把任意内容挂到这个配方名下。判据用 origin 全等，不用 startsWith
    //（`https://a.com` 会匹配上 `https://a.com.evil.net`）。
    let sameOrigin = false;
    try { sameOrigin = new URL(parsed.data.url).origin === owned.origin; } catch { sameOrigin = false; }
    if (!sameOrigin) {
      return NextResponse.json({ ok: false, error: '网址不属于这个配方的站点' }, { status: 400, headers: CORS });
    }
    const r = await saveScrapeRecord({
      tenantId: owned.tenantId, workspaceId: ws.id, recipeId: owned.id,
      url: parsed.data.url, values: parsed.data.values, rows: parsed.data.rows,
      want: parsed.data.want ?? 0, channel: 'plugin_home',
    });
    return NextResponse.json({ ok: true, ...r }, { headers: CORS });
  }

  const r = await recordScrapeResult(owned.id, ws.id, parsed.data.ok);
  return NextResponse.json({ ok: true, ...r }, { headers: CORS });
}
