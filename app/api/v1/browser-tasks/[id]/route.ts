import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveApiToken, apiEnabled } from '@/lib/api/token';
import { KIND_LABEL, MAX_READ_TEXT_CHARS } from '@/lib/browser-task';
import { parseJson } from '@/lib/json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/v1/browser-tasks/<id> —— 看一个浏览器任务走到哪了、拿回了什么。
//
// 状态：pending=等插件来领（要有装了插件的浏览器在线）| claimed=某个浏览器正在做
// | done | failed | expired（48h 无人执行，不算失败）| cancelled。
//
// open_and_read 跑完后这里会带上读回的内容：结构化摘要 + 正文节选。
// 正文**只给前 6000 字**（与 AI 执行器给模型看的截断口径一致）——一次列出 6 万字
// 对轮询接口既慢又贵，要全文的话去烽火台资讯库看（回执里说了存哪了）。

const READ_TEXT_PREVIEW_CHARS = 6_000;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!apiEnabled()) return NextResponse.json({ ok: false, error: 'Not Found' }, { status: 404 });

  const auth = await resolveApiToken(req.headers.get('authorization'));
  if (!auth) return NextResponse.json({ ok: false, error: '令牌无效或已吊销' }, { status: 401 });

  const { id } = await params;
  // workspaceId 一起查——拿到任意 taskId 也读不到别的工作区的任务
  const t = await prisma.browserTask.findFirst({
    where: { id, workspaceId: auth.ctx.workspaceId },
    select: {
      id: true, kind: true, status: true, origin: true, result: true, error: true,
      resultData: true, createdAt: true, updatedAt: true, expiresAt: true,
    },
  });
  if (!t) return NextResponse.json({ ok: false, error: '任务不存在或不属于这个工作区' }, { status: 404 });

  // open_and_read 的内容本体：摘要全给，正文给节选
  let read: Record<string, unknown> | undefined;
  if (t.kind === 'open_and_read' && t.status === 'done' && t.resultData) {
    const data = parseJson<{
      url?: string; finalUrl?: string; title?: string; text?: string; truncated?: boolean;
      extract?: { summary?: string; points?: string[] } | null;
    }>(t.resultData, {});
    const text = typeof data.text === 'string' ? data.text : '';
    read = {
      url: data.finalUrl || data.url || '',
      title: data.title || '',
      summary: data.extract?.summary ?? null,
      points: data.extract?.points ?? [],
      textPreview: text.slice(0, READ_TEXT_PREVIEW_CHARS),
      textChars: text.length,
      // 两层截断都要如实说：插件回传时截过一次（MAX_READ_TEXT_CHARS），这里预览又截一次
      textTruncated: Boolean(data.truncated) || text.length > READ_TEXT_PREVIEW_CHARS,
      note: text.length > READ_TEXT_PREVIEW_CHARS
        ? `正文共 ${text.length} 字（插件端上限 ${MAX_READ_TEXT_CHARS}），此处只给前 ${READ_TEXT_PREVIEW_CHARS} 字。`
        : undefined,
    };
  }

  return NextResponse.json({
    ok: true,
    taskId: t.id,
    kind: t.kind,
    label: KIND_LABEL[t.kind as keyof typeof KIND_LABEL] ?? t.kind,
    status: t.status,
    origin: t.origin,
    result: t.result ?? null,
    error: t.error ?? null,
    ...(t.status === 'pending'
      ? { waitingFor: '等一台装了采集插件、令牌有效的浏览器在线来领走它（到期时间见 expiresAt）' }
      : {}),
    ...(read ? { read } : {}),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    expiresAt: t.expiresAt.toISOString(),
  });
}
