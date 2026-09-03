import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER } from '@/lib/ingest/competitor';
import { resolveIngestToken, INGEST_KINDS_HEADER, parseKindsHeader } from '@/lib/ingest/token';
import { claimNextTask, completeTask } from '@/lib/browser-task';
import { browserTaskPayloadSchema } from '@/lib/browser-task/kinds';
import { parseJson } from '@/lib/json';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

// 浏览器任务领取 / 交付（插件 ↔ 服务端；2026-09-03 起桌面客户端执行器也走这里）。
//
// 🔒 鉴权：x-beacon-ingest-token，与其它 ingest 路由同一把钥匙。
//    领取者身份用 tokenId（按设备签发）——两台机器各有各的令牌，
//    排查「谁领走了这条活」时能落到具体设备上。老式工作区令牌没有 tokenId，
//    退回用 'legacy'：它是所有设备共用的一把，本来就分不出谁是谁。
//
// 【能力自报】执行器在领活时用 x-beacon-ingest-kinds 报它会做哪些 kind；服务端记在令牌上，
//    并且**只把它会做的活给它**。没报的按老版插件（最初三种）。2026-09-03 真机：新 kind 派给
//    旧插件，它领了回「不认识」，重试三次判死，AI 执行挂着等了半天。
//
// 【为什么 GET 一次只给一个】插件那边是串行的（开标签页 → 等加载 → 解析 → 关页），
// 一次给一批它也只能一个个做，反而让另一台机器领不到活。
//
// 【target】采主页类任务的回应里附带要打开的地址与平台：桌面执行器只管「开页 → 注入解析器 →
// 交回解析结果」，平台地址怎么拼只在服务端有一份。旧插件不看这个字段，无影响。

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 领一个活。没有就 `{ ok: true, task: null }`——「没活」不是错误。 */
export async function GET(req: Request) {
  const kindsHeader = req.headers.get(INGEST_KINDS_HEADER);
  const auth = await resolveIngestToken(req.headers.get(INGEST_TOKEN_HEADER), { kinds: kindsHeader });
  if (!auth) return json({ ok: false, error: INGEST_TOKEN_INVALID }, 401);

  const task = await claimNextTask(auth.workspace.id, auth.tokenId ?? 'legacy', parseKindsHeader(kindsHeader));
  if (!task) return json({ ok: true, task: null });
  const { executorTarget } = await import('@/lib/browser-task/local-run');
  const target = await executorTarget(task).catch(() => null);
  return json({ ok: true, task: { ...task, ...(target ? { target } : {}) } });
}

/**
 * 交活。body: { taskId, ok, result?, error?, data?, parsed? }
 *
 * `data` 是插件带回来的**内容本体**（目前只有 open_and_read 的页面文本）。
 * `parsed` 是桌面执行器带回来的**解析器产物**（采主页类任务）：服务端在这里落库并写回执——
 * 落库那份代码与本机浏览器那条路共用（lib/browser-task/local-run.ts ingestParsedPage）。
 * 与 result 分开：后者是「跑成没有」给人看的一句话，前者是给服务端接着处理的原料。
 */
export async function POST(req: Request) {
  const auth = await resolveIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!auth) return json({ ok: false, error: INGEST_TOKEN_INVALID }, 401);

  const body = parseJson<Record<string, unknown>>(await req.text(), {});
  const taskId = typeof body.taskId === 'string' ? body.taskId : '';
  if (!taskId) return json({ ok: false, error: '缺少 taskId' }, 400);

  // 带内容回来的：先在服务端把正文存下并抽成摘要 / 把解析结果落库，
  // 再把摘要当作这次任务的 result。**顺序不能反**——先 completeTask 的话，
  // 等着这条活的 AI 执行会被叫醒，而那时正文还没落库，它拿到的是一句空回执
  let resultText = typeof body.result === 'string' ? body.result : undefined;
  let okFlag = body.ok === true; // 只认显式 true：漏传 ok 的旧版插件不该把一次失败记成成功
  let errorText = typeof body.error === 'string' ? body.error : undefined;
  if (okFlag && body.data && typeof body.data === 'object') {
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
  if (okFlag && body.parsed && typeof body.parsed === 'object') {
    const task = await prisma.browserTask.findFirst({
      where: { id: taskId, workspaceId: auth.workspace.id },
      select: { payload: true },
    });
    const payload = browserTaskPayloadSchema.safeParse(parseJson<unknown>(task?.payload ?? '{}', {}));
    if (payload.success && (payload.data.kind === 'collect_self_profile' || payload.data.kind === 'collect_competitor')) {
      const { ingestParsedPage } = await import('@/lib/browser-task/local-run');
      const r = await ingestParsedPage({
        workspaceId: auth.workspace.id,
        payload: payload.data,
        parsed: body.parsed as Parameters<typeof ingestParsedPage>[0]['parsed'],
        channel: 'desktop',
        via: '桌面客户端',
      });
      if (r.ok) resultText = r.summary;
      else { okFlag = false; errorText = r.error; }
    } else {
      okFlag = false; errorText = '这条任务不是采主页类的，不该带 parsed 回来';
    }
  }

  const r = await completeTask(auth.workspace.id, taskId, { ok: okFlag, result: resultText, error: errorText });
  return json(r, r.ok ? 200 : 409);
}
