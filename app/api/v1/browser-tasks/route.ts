import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveApiToken, apiEnabled } from '@/lib/api/token';
import { enqueueBrowserTask, BROWSER_TASK_KINDS, KIND_LABEL } from '@/lib/browser-task';
import { vetBrowserTaskArgs, resolveCompetitorRef } from '@/lib/browser-task/vet';
import { checkRateLimit, getClientIp, ipKey } from '@/lib/ratelimit';
import { can } from '@/lib/rbac';
import { disabledTools } from '@/lib/agent/tool-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── 对外调用面 v1：浏览器动词 ────────────────────────────────────────────────
//
// 让 MCP 客户端 / 脚本指挥**用户自己的**采集插件干白名单里的三件事：
// 采一个已订阅的竞对、回填自己的创作后台、打开白名单站点读正文。
//
// 【边界，与 lib/browser-task/kinds.ts 同一句话】能派的动作是一份写死的白名单，
// 这里**不是**「远程驱动浏览器」的接口——没有打开任意 URL、点击、填表、执行脚本的动词，
// 将来也不该有（一枚泄漏的令牌不该等于一台带着用户登录态的可遥控浏览器）。
// 三道闸（有没有插件 / 读网页开关+域白名单 / 竞对必须在监控列表）与 AI 工具共用
// lib/browser-task/vet.ts 的唯一实现——闸各写一份，宽的那份迟早出事。
//
// 【鉴权/形态闸】与 /api/v1/runs 完全同款：bck_ 令牌绑到成员、只有企业版有这条路。

const LIMIT = { limit: 60, windowMs: 60_000 };

function unauthorized() {
  return NextResponse.json({ ok: false, error: '令牌无效或已吊销' }, { status: 401 });
}

/**
 * POST /api/v1/browser-tasks —— 排一个浏览器任务。
 * body: { kind, competitor?, platform?, url?, limit? }
 *   - kind=collect_competitor：competitor 可以是监控列表里的 id、主页 handle 或名字（精确匹配）
 *   - kind=collect_self：platform（目前只有 wechat）
 *   - kind=open_and_read：url（必须在域白名单里，且工作区开过「让插件替我读网页」）
 */
export async function POST(req: Request) {
  if (!apiEnabled()) return NextResponse.json({ ok: false, error: 'Not Found' }, { status: 404 });

  const rl = await checkRateLimit(ipKey('api:v1', getClientIp(req.headers)), LIMIT);
  if (!rl.ok) return NextResponse.json({ ok: false, error: '调用过于频繁' }, { status: 429 });

  const auth = await resolveApiToken(req.headers.get('authorization'));
  if (!auth) return unauthorized();

  // 【角色闸：与网页/AI 那两条路同一个动作】派浏览器任务在 AI 工具表里标的是
  // `action: 'competitor.manage'`（lib/agent/tools.ts），executeCall 会按发起人的角色判一次；
  // 网页那条路也走 requireRole。而这条对外调用面此前**一道角色闸都没有**——
  // 同一件事，网页会被拦下、API 不会。
  //
  // 【今天够不够得着，不是挂不挂闸的理由】这条路由只在 appliance/private 形态存在，
  // 而那两个形态里 viewer 目前不可被授予（lib/rbac.ts assignableRoles）——
  // 所以今天大概率触发不了。但那是**两道无关约束恰好互相收口**的结果：
  // 哪天 assignableRoles 放开、或者存量库里留着一个切换形态之前建的 viewer，
  // 这个口子就开了，而那时没有任何东西会提醒我们。本项目的既有做法是「闸挂每一条路」。
  if (!can(auth.ctx.role, 'competitor.manage')) {
    return NextResponse.json(
      { ok: false, error: '这个令牌所属成员的角色没有派发采集任务的权限' },
      { status: 403 },
    );
  }

  // 工作区把这个能力关掉了就不派——与 AI 那条路同一判据（lib/agent/run.ts executeCall
  // 里的 offTools）。只在界面上关、而 API 照发，那个开关对外就是个摆设。
  const off = disabledTools(
    (await prisma.workspace.findUnique({
      where: { id: auth.ctx.workspaceId }, select: { agentToolConfig: true },
    }))?.agentToolConfig,
  );
  if (off.includes('dispatch_browser_task')) {
    return NextResponse.json(
      { ok: false, error: '这个工作区关闭了「派活给浏览器插件」' },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    kind?: unknown; competitor?: unknown; platform?: unknown; url?: unknown; limit?: unknown;
  };
  const kind = typeof body.kind === 'string' ? body.kind : '';
  if (!(BROWSER_TASK_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json(
      { ok: false, error: `kind 只能是：${BROWSER_TASK_KINDS.join(' / ')}（白名单动作，没有别的动词）` },
      { status: 400 },
    );
  }

  // 外部调用方手里通常没有内部 id——竞对指代先换成监控列表里的 competitorId
  let competitorId = '';
  if (kind === 'collect_competitor') {
    const resolved = await resolveCompetitorRef(
      auth.ctx.workspaceId,
      typeof body.competitor === 'string' ? body.competitor : '',
    );
    if (!resolved.ok) return NextResponse.json({ ok: false, error: resolved.error }, { status: 400 });
    competitorId = resolved.competitorId;
  }

  const vetted = await vetBrowserTaskArgs(auth.ctx.workspaceId, {
    kind,
    competitorId,
    platform: typeof body.platform === 'string' ? body.platform : '',
    url: typeof body.url === 'string' ? body.url : '',
    limit: typeof body.limit === 'number' ? body.limit : undefined,
  });
  if (!vetted.ok) return NextResponse.json({ ok: false, error: vetted.error }, { status: 400 });

  const r = await enqueueBrowserTask({
    workspaceId: auth.ctx.workspaceId,
    accountId: auth.ctx.accountId,
    payload: vetted.payload,
    origin: 'api',
    createdBy: auth.ctx.memberId,
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 400 });

  return NextResponse.json({
    ok: true,
    taskId: r.id,
    status: 'pending',
    // 调用方是个程序：把「接下来会发生什么」说全，它才能如实转告用户
    note: `已排队（${KIND_LABEL[kind as keyof typeof KIND_LABEL]}）。要有一台装了采集插件、令牌有效的浏览器在线才会被领走；48 小时无人执行自动作废。用 GET /api/v1/browser-tasks/${r.id} 看进度。`,
  });
}

/** GET /api/v1/browser-tasks —— 最近的浏览器任务。?limit= 默认 10。 */
export async function GET(req: Request) {
  if (!apiEnabled()) return NextResponse.json({ ok: false, error: 'Not Found' }, { status: 404 });

  const auth = await resolveApiToken(req.headers.get('authorization'));
  if (!auth) return unauthorized();

  const url = new URL(req.url);
  const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 10));

  const rows = await prisma.browserTask.findMany({
    where: { workspaceId: auth.ctx.workspaceId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, kind: true, status: true, origin: true, result: true, error: true, createdAt: true },
  });

  return NextResponse.json({
    ok: true,
    tasks: rows.map((t) => ({
      taskId: t.id,
      kind: t.kind,
      label: KIND_LABEL[t.kind as keyof typeof KIND_LABEL] ?? t.kind,
      status: t.status,
      origin: t.origin,
      result: t.result ? `${t.result.slice(0, 200)}${t.result.length > 200 ? '…' : ''}` : null,
      error: t.error,
      createdAt: t.createdAt.toISOString(),
    })),
  });
}
