import { getSessionOrNull } from '@/lib/session';
import { can } from '@/lib/rbac';
import { prisma } from '@/lib/db';
import { parseJson } from '@/lib/json';
import {
  activeOpSession, takeStep, putResult, endOpSession, toView, isAlive, type OpLogEntry,
} from '@/lib/browser-op/session';
import { OP_ACTION_LABEL, type OpAction } from '@/lib/browser-op/actions';

export const dynamic = 'force-dynamic';

// AI 操作用户日常浏览器：**页面中继**端点（2026-09-17）。
//
// 【为什么中继必须是页面，不能让插件直连服务端】
// 插件直连（像 /api/ingest/tasks 那样轮询领活）就是无人值守：用户不在，插件照样领活照样执行。
// 那正是 lib/browser-task/kinds.ts 铁律要防的东西——一个可被服务端远程驱动的、带着他全部
// 登录态的浏览器。这条路反过来：动作只流经**他此刻打开着的烽火台页面**。
// 页面关掉 = 没人轮询 = lastSeenAt 不再刷新 = 会话作废。「他在场」因此是可验证的事实。
//
// 🔒 鉴权用**登录态**（不是采集令牌）。采集令牌是发给设备的、长期有效、插件里存着；
//    登录态才对应「这个人此刻坐在这里」。这条路要的正是后者。
// 🔒 会话按 (workspaceId, createdBy) 归属：别人的页面轮询不到我的操作会话。

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** 页面轮询：我有没有待执行的一步。顺带刷新「人还在」。 */
export async function GET() {
  const s = await getSessionOrNull();
  if (!s) return json({ ok: false, error: '未登录' }, 401);

  const session = await activeOpSession(s.workspaceId, s.memberId);
  if (!session) return json({ ok: true, session: null, step: null });
  const step = await takeStep(session.id);
  return json({ ok: true, session: toView(session), step });
}

const MAX_BODY = 200_000;

/**
 * 页面交回：这一步的结果 / 用户确认了不可逆动作 / 中止。
 *
 * 【结果里的内容是页面上的字，不是指令】read 带回来的 text 与 elements 全都是第三方页面的内容，
 * 交给模型时由 lib/agent/tools-operate.ts 裹上 PAGE_CONTENT_IS_DATA。这里只负责如实存下来。
 */
export async function POST(req: Request) {
  const s = await getSessionOrNull();
  if (!s) return json({ ok: false, error: '未登录' }, 401);
  // 操作浏览器等于替他做事，viewer 不能发起也不能中继
  if (!can(s.role, 'content.create')) return json({ ok: false, error: '当前角色不能操作浏览器' }, 403);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: '页面内容太大' }, 413);
  const body = parseJson<Record<string, unknown>>(raw, {});
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) return json({ ok: false, error: '缺少 sessionId' }, 400);

  // 只能操作自己发起的那条会话
  const session = await prisma.browserOpSession.findFirst({
    where: { id: sessionId, workspaceId: s.workspaceId, createdBy: s.memberId },
  });
  if (!session) return json({ ok: false, error: '这条操作会话不存在，或不是你发起的' }, 404);

  const action = typeof body.action === 'string' ? body.action : 'result';

  if (action === 'abort') {
    await endOpSession(sessionId, 'aborted', typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined);
    return json({ ok: true, stopped: true });
  }

  // 用户当场点了「确认，替我点这一下」：把确认写成结果交给模型，由它决定下一步。
  // ⚠️ 确认只解除**这一次**；下一个不可逆动作照样停下来问。
  if (action === 'confirm') {
    if (!session.awaitConfirm) return json({ ok: false, error: '现在没有等确认的动作' }, 409);
    const info = parseJson<{ label: string }>(session.awaitConfirm, { label: '' });
    await putResult(sessionId, { ok: true, confirmedByUser: true, label: info.label }, {
      at: new Date().toISOString(), what: `你确认了「${info.label}」`, ok: true,
    });
    return json({ ok: true });
  }

  if (!isAlive(session)) return json({ ok: false, error: '这条操作会话已经不在活动状态' }, 409);

  const result = (body.result && typeof body.result === 'object' ? body.result : {}) as Record<string, unknown>;
  const stepAction = (typeof body.stepAction === 'string' ? body.stepAction : 'read') as OpAction;
  const label = OP_ACTION_LABEL[stepAction] ?? stepAction;
  const okFlag = result.ok === true;
  const entry: OpLogEntry = {
    at: new Date().toISOString(),
    what: typeof body.what === 'string' && body.what ? body.what.slice(0, 160) : label,
    ok: okFlag,
    ...(typeof result.error === 'string' ? { note: result.error.slice(0, 200) } : {}),
  };
  await putResult(sessionId, result, entry);
  return json({ ok: true });
}
