import { NextResponse } from 'next/server';
import { z } from 'zod';
import { log } from '@/lib/logger';
import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';
import { analyzeVideo, CHANNEL_BASIS } from '@/lib/video/analyze';

// 插件「一键拆解这条作品」的入口（authorized 通道，与竞对/自有/灵感并列的第四条）。
//
// 【它能做到什么、做不到什么——这条边界就是产品本身】
// 插件读的是**用户自己眼睛看得到的那一页**：标题、文案、封面图、公开指标。
// 作品页上的 <video> 基本都是 blob: 的 MSE 流，就算偶尔是直链也带防盗链——
// 插件拿不到视频文件，我们也**不去解、不去绕**（「不碰灰色」红线）。
// 更要紧的是：**自动下载竞对视频这件事本身就不做**，那是「视频要用户自行下载上传」
// 这条产品规矩的另一面。想要画面级拆解 → 用户自己下载 → 到资讯库上传。
//
// 所以这条通道的产出会诚实地标成「封面档 / 文案档」，报告顶部写明分析依据（CHANNEL_BASIS），
// 用户一眼能看出「这个结论没看视频」。静默地让它看起来像视频级结论，是这里最不能犯的错。
//
// 🔒 鉴权与 CORS 同 /api/ingest/inspiration：令牌头是唯一闸门，无凭证跨源没有 CSRF 面。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': `content-type, ${INGEST_TOKEN_HEADER}`,
};

// 封面图上限：一张 JPEG 封面正常 100–400KB。给到 3MB 已经很宽松，
// 再大基本是插件把原图或截屏整张塞进来了，那对拆解毫无增益，只是烧 token。
const MAX_COVER_BYTES = 3 * 1024 * 1024;

const payloadSchema = z.object({
  url: z.string().url().max(1000).optional().nullable(),
  title: z.string().max(300).optional(),
  text: z.string().max(20_000).optional(),
  author: z.string().max(80).optional().nullable(),
  /** data:image/...;base64,... —— 插件在页面里把已加载的封面转成 data URI 传来，不传外链 */
  coverDataUri: z.string().max(Math.ceil(MAX_COVER_BYTES * 1.4)).optional().nullable(),
  metrics: z.record(z.string(), z.number()).optional().nullable(),
  /**
   * 平台字幕轨的文字稿（插件在用户浏览器里取的）。
   * 这是这条通道最值钱的一块：方舟视频理解听不到音轨，而字幕轨是精确文本 + 精确时间戳——
   * 有它在，没有视频文件的封面档也能分析口播结构。
   * 服务端取不到（YouTube 的 timedtext 回 200 但 0 字节、B站字幕列表未登录恒空），只有浏览器有。
   */
  // ⚠️ 先截断再校验，**绝不因为字幕太长就把整趟拆解打回**。
  //
  // 2026-08-13 查出的错配：`extension/content/work.js` 那头对 transcript 没有任何 slice
  // （同文件对 title/text/author 的 300 / 20_000 / 80 都与本 schema 一一对齐，唯独漏了它）。
  // 于是一条 60 分钟的播客解析出 ~2500 条 event → 400 → 拆解**整个失败**，
  // 而不是降级成「没有字幕的封面档」——偏偏这条通道是拿到口播文本的唯一路径（服务端取不到）。
  // 长视频正是最需要字幕的那一类，等于在最该用的场景上必然失败。
  //
  // 截断在服务端做，已装的旧版插件当场就好。2000 条之后丢掉的是尾部字幕，
  // 分析质量略降；打回则是一个字都没有——两害相权很清楚。
  transcript: z
    .preprocess(
      (v) => (Array.isArray(v) ? v.slice(0, 2000) : v),
      z.array(z.object({ at: z.number(), text: z.string().max(500) })).max(2000),
    )
    .optional()
    .nullable(),
  /** 这是不是用户自己的作品——决定拆解视角（怎么改进 vs 怎么借鉴） */
  isSelf: z.boolean().optional(),
  note: z.string().max(500).optional(),
});

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) {
    log.warn('作品拆解鉴权失败');
    return json({ ok: false, error: INGEST_TOKEN_INVALID }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return json({ ok: false, error: `数据格式不合法：${parsed.error.issues[0]?.message ?? ''}` }, 400);
  }
  const p = parsed.data;

  // data URI 白名单：只收图片，且只收内联的。收 http(s) 外链等于让模型去替用户抓一张图，
  // 那既是我们不做的事，也会把一个 SSRF 面开在模型那一侧。
  const cover = p.coverDataUri?.trim() || null;
  if (cover && !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(cover)) {
    return json({ ok: false, error: '封面必须是内联的 data:image base64，不接受外链' }, 400);
  }

  const r = await analyzeVideo({
    workspaceId: ws.id,
    // 插件没有登录态，拿不到当前选中的账号；留空即工作区共享（与灵感箱同口径）
    accountId: null,
    mode: p.isSelf ? 'self' : 'rival',
    source: null, // 插件永远不提供视频文件——见文件头
    coverDataUri: cover,
    text: p.text ?? null,
    transcript: p.transcript ?? null,
    metrics: p.metrics ?? null,
    title: p.title,
    originUrl: p.url ?? null,
    rivalName: p.author ?? null,
    note: p.note,
  });

  if (!r.ok) {
    log.warn('作品拆解失败', { workspaceId: ws.id, error: r.error });
    return json(r, 400);
  }
  log.info('作品拆解入库', { workspaceId: ws.id, id: r.id, channel: r.channel });
  return json({
    ok: true,
    id: r.id,
    title: r.title,
    summary: r.summary,
    points: r.points,
    channel: r.channel,
    // 回执里就把「这次没看视频」说破，插件气泡直接展示，不用它自己拼一遍
    basis: CHANNEL_BASIS[r.channel],
  });
}
