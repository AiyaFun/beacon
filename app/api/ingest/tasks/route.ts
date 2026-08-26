import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER } from '@/lib/ingest/competitor';
import { resolveIngestToken } from '@/lib/ingest/token';
import { claimNextTask, completeTask } from '@/lib/browser-task';
import { parseJson } from '@/lib/json';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

// 浏览器任务领取 / 交付（插件 ↔ 服务端）。
//
// 🔒 鉴权：x-beacon-ingest-token，与其它 ingest 路由同一把钥匙。
//    领取者身份用 tokenId（按设备签发）——两台机器各有各的令牌，
//    排查「谁领走了这条活」时能落到具体设备上。老式工作区令牌没有 tokenId，
//    退回用 'legacy'：它是所有设备共用的一把，本来就分不出谁是谁。
//
// 【为什么 GET 一次只给一个】插件那边是串行的（开标签页 → 等加载 → 解析 → 关页），
// 一次给一批它也只能一个个做，反而让另一台机器领不到活。
//
// 【为什么没有「查全部任务」的 GET】插件不需要——它只关心「有没有我能干的活」。
// 用户要看全貌在运行中心（那里有登录态，权限口径也不同）。

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 领一个活。没有就 `{ ok: true, task: null }`——「没活」不是错误。 */
export async function GET(req: Request) {
  const auth = await resolveIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!auth) return json({ ok: false, error: INGEST_TOKEN_INVALID }, 401);

  const task = await claimNextTask(auth.workspace.id, auth.tokenId ?? 'legacy');
  return json({ ok: true, task });
}

/**
 * 交活。body: { taskId, ok, result?, error?, data? }
 *
 * `data` 是插件带回来的**内容本体**（目前只有 open_and_read 的页面文本）。
 * 与 result 分开：后者是「跑成没有」给人看的一句话，前者是给服务端接着处理的原料。
 */
export async function POST(req: Request) {
  const auth = await resolveIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!auth) return json({ ok: false, error: INGEST_TOKEN_INVALID }, 401);

  const body = parseJson<Record<string, unknown>>(await req.text(), {});
  const taskId = typeof body.taskId === 'string' ? body.taskId : '';
  if (!taskId) return json({ ok: false, error: '缺少 taskId' }, 400);

  // 带内容回来的（open_and_read）：先在服务端把正文存下并抽成摘要，
  // 再把摘要当作这次任务的 result。**顺序不能反**——先 completeTask 的话，
  // 等着这条活的 AI 执行会被叫醒，而那时正文还没落库，它拿到的是一句空回执
  let resultText = typeof body.result === 'string' ? body.result : undefined;
  if (body.ok === true && body.data && typeof body.data === 'object') {
    const task = await prisma.browserTask.findFirst({
      where: { id: taskId, workspaceId: auth.workspace.id },
      select: { kind: true },
    });
    if (task?.kind === 'open_and_read') {
      const { acceptReadResult } = await import('@/lib/browser-task/read-result');
      const accepted = await acceptReadResult(
        taskId,
        { workspaceId: auth.workspace.id, tenantId: auth.workspace.tenantId },
        body.data as Record<string, unknown>,
      );
      resultText = accepted.summary;
    }
  }

  const r = await completeTask(auth.workspace.id, taskId, {
    // 只认显式 true：漏传 ok 的旧版插件不该把一次失败记成成功
    ok: body.ok === true,
    result: resultText,
    error: typeof body.error === 'string' ? body.error : undefined,
  });
  return json(r, r.ok ? 200 : 409);
}
