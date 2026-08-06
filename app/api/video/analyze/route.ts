import { getSessionOrNull } from '@/lib/session';
import { can } from '@/lib/rbac';
import { log } from '@/lib/logger';
import { analyzeVideo, checkVideoUrl, type VideoMode } from '@/lib/video/analyze';
import { inlineSource, MAX_INLINE_VIDEO_BYTES, type VideoSource } from '@/lib/llm/ark';

// 视频拆解的出口。**SSE 而不是普通 JSON**，原因是纯运维层面的：
//
// 视频推理是分钟级的，而生产走 nginx 反代，proxy_read_timeout 默认 60 秒——
// 一个安静等待 90 秒的普通 POST 会被 nginx 掐成 504，用户看到的是「网络错误」，
// 而这时方舟那边的钱**已经花掉了**。SSE 每 10 秒发一次心跳，读超时永远不会触发。
//
// 为什么不进任务队列：文件是 base64 内联的，25MB 的视频进 payload 就是 ~33MB，
// 塞进 Redis 是拿队列的内存换一个用户本来就在等的结果。用户点了「分析」就在屏幕前等着，
// 同步 + 进度条才是这里更简单的形态。
//
// ⚠️ 落库在**服务端流读完时**发生，不等前端确认——与初稿流式同一条口径：
// 用户关页面/断网时分析已经花过钱了，不落库等于白烧。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const HEARTBEAT_MS = 10_000;

export async function POST(req: Request) {
  const s = await getSessionOrNull();
  if (!s) return json({ error: '请先登录' }, 401);
  if (!can(s.role, 'content.create')) return json({ error: '当前角色没有创作权限' }, 403);

  let parsed: ParsedInput | { error: string };
  try {
    parsed = await parseInput(req);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  if ('error' in parsed) return json({ error: parsed.error }, 400);
  const input = parsed;

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // 客户端已断开：分析仍会跑完并落库，只是没人收这条进度
        }
      };

      // 心跳：nginx 只要还在收字节就不会判读超时
      timer = setInterval(() => send('ping', { t: 'alive' }), HEARTBEAT_MS);

      send('start', {
        channel: 'video',
        hint:
          input.source.kind === 'inline'
            ? `已收到 ${(input.source.bytes / 1024 / 1024).toFixed(1)}MB，正在送去分析（视频推理通常要 2–5 分钟）`
            : '正在让方舟取这条链接并分析（通常要 2–5 分钟）',
      });

      try {
        const r = await analyzeVideo({
          workspaceId: s.workspaceId,
          accountId: s.accountId,
          mode: input.mode,
          source: input.source,
          title: input.title,
          originUrl: input.originUrl,
          rivalName: input.rivalName,
          note: input.note,
          fps: input.fps,
        });
        send(r.ok ? 'done' : 'failed', r);
        if (r.ok) log.info('视频拆解完成', { workspaceId: s.workspaceId, id: r.id, channel: r.channel });
      } catch (e) {
        const msg = (e as Error).message;
        log.warn('视频拆解异常', { workspaceId: s.workspaceId, error: msg });
        // 配额这类「设计内拒绝」原文回去，前端红字展示自救指引
        send('failed', { ok: false, error: msg.slice(0, 300) });
      } finally {
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx 不缓冲，心跳才真的按时到达
    },
  });
}

type ParsedInput = {
  source: VideoSource;
  mode: VideoMode;
  title?: string;
  note?: string;
  originUrl?: string | null;
  rivalName?: string | null;
  fps?: number;
};

/**
 * 两种输入：multipart（本地文件）与 JSON（公网直链）。
 *
 * ⚠️ 大小闸必须在 **读 body 之前**就靠 content-length 挡一道：等 formData() 把 300MB
 * 读进内存再说「太大了」，那 300MB 已经在进程里了。content-length 可以伪造，所以
 * 读完之后还要按真实字节数再判一次（inlineSource 里那道）。
 */
async function parseInput(req: Request): Promise<ParsedInput | { error: string }> {
  const ctype = req.headers.get('content-type') ?? '';

  if (ctype.includes('multipart/form-data')) {
    const declared = Number(req.headers.get('content-length') ?? 0);
    // 留 2MB 余量给 multipart 的边界与其它字段
    if (declared && declared > MAX_INLINE_VIDEO_BYTES + 2 * 1024 * 1024) {
      return { error: `视频超过 ${MAX_INLINE_VIDEO_BYTES / 1024 / 1024}MB 上限，先压一下再传。` };
    }
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return { error: '没有收到视频文件' };
    const built = inlineSource(new Uint8Array(await file.arrayBuffer()), file.type);
    if (!built.ok) return { error: built.error };
    return {
      source: built.source,
      mode: str(form.get('mode')) === 'self' ? 'self' : 'rival',
      title: str(form.get('title')) || file.name.replace(/\.[^.]+$/, ''),
      note: str(form.get('note')),
      originUrl: str(form.get('originUrl')) || null,
      rivalName: str(form.get('rivalName')) || null,
      fps: num(form.get('fps')),
    };
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const url = String(body.url ?? '').trim();
  if (!url) return { error: '请提供视频直链，或上传本地文件' };
  const check = checkVideoUrl(url);
  if (!check.ok) return { error: check.error };
  return {
    source: { kind: 'url', url },
    mode: body.mode === 'self' ? 'self' : 'rival',
    title: String(body.title ?? '').slice(0, 200) || undefined,
    note: String(body.note ?? '').slice(0, 500) || undefined,
    originUrl: body.originUrl ? String(body.originUrl).slice(0, 500) : null,
    rivalName: body.rivalName ? String(body.rivalName).slice(0, 80) : null,
    fps: typeof body.fps === 'number' ? body.fps : undefined,
  };
}

const str = (v: FormDataEntryValue | null): string => (typeof v === 'string' ? v.trim().slice(0, 500) : '');
const num = (v: FormDataEntryValue | null): number | undefined => {
  const n = Number(typeof v === 'string' ? v : NaN);
  return Number.isFinite(n) ? n : undefined;
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
