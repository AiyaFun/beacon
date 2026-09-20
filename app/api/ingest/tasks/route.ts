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

/**
 * 这台服务端认得哪些**领活/交活之外**的动作。执行器领活时一并拿到。
 *
 * 【为什么必须有这个握手】用户是自己装的服务端 + 自己装的客户端，两边版本各走各的。
 * 新客户端撞上登录墙会 POST `action:'need_login'`——而**旧服务端不认识 action**，
 * 它只会看到「一次没带 ok 的交付」，于是把这条活判成失败、退避重排。
 * 本项目在「新 kind 派给旧插件」上栽过一模一样的跤（见 lib/browser-task/kinds.ts 顶部第 ① 条）：
 * 结论是**能力要自报，不要靠版本号猜**。这里是同一条规矩反过来用：服务端自报，客户端照做。
 */
const SERVER_SUPPORTS = ['need_login'] as const;

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
  if (!task) return json({ ok: true, task: null, supports: SERVER_SUPPORTS });
  const { executorTarget } = await import('@/lib/browser-task/local-run');
  const target = await executorTarget(task).catch(() => null);
  return json({ ok: true, task: { ...task, ...(target ? { target } : {}) }, supports: SERVER_SUPPORTS });
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

  // ── 中途求助：「我卡在登录页了」（2026-09-17）──────────────────────────────
  //
  // 【为什么要有中途这一说】此前这个接口只有「领活」和「交活」两个动作：执行器撞上登录墙时
  // 它其实**正停在那一页等人登录**（executor.rs 的 wait_for_login），但用户此刻多半在手机上，
  // 既不知道卡住了、也够不着那台机器。这条动作就是让它在等的过程中说一声，
  // 并把那一页拍给派活的人——国内平台登录基本都是扫码，手机扫一下就过了。
  //
  // 【它不改任务状态】任务仍是 claimed、租约照旧、执行器继续等。求助只是**旁路通知**：
  // 发不出去也不影响这次采集（requestLoginHelp 绝不抛）。
  //
  // 【截图不落库】转发给本人之后就丢掉——那是一张登录二维码，等于一把钥匙。
  if (body.action === 'need_login') {
    const cur = await prisma.browserTask.findFirst({
      where: { id: taskId, workspaceId: auth.workspace.id },
      select: { status: true, claimedBy: true, accountId: true, payload: true },
    });
    if (!cur) return json({ ok: false, error: '任务不存在' }, 404);
    const claimer = auth.tokenId ?? 'legacy';
    if (cur.status !== 'claimed') return json({ ok: false, error: `任务当前状态是 ${cur.status}，不能求助` }, 409);
    if (cur.claimedBy && cur.claimedBy !== claimer) return json({ ok: false, error: '这条活已被另一台执行器领走' }, 409);

    const { vetScreenshot } = await import('@/lib/ingest/parser-learn');
    const shot = vetScreenshot(body.screenshot);
    const { requestLoginHelp } = await import('@/lib/bot/login-help');
    const { decodeDataUrl } = await import('@/lib/bot/data-url');
    const image = decodeDataUrl(shot);
    const payload = parseJson<Record<string, unknown>>(cur.payload ?? '{}', {});
    const r = await requestLoginHelp({
      workspaceId: auth.workspace.id,
      taskId,
      platform: typeof body.platform === 'string' ? body.platform : (typeof payload.platform === 'string' ? payload.platform : null),
      url: typeof body.url === 'string' ? body.url : null,
      reason: typeof body.reason === 'string' ? body.reason : null,
      screenshot: image,
    });
    return json({ ok: true, delivered: r.delivered, note: r.note });
  }

  // 带内容回来的：先在服务端把正文存下并抽成摘要 / 把解析结果落库，
  // 再把摘要当作这次任务的 result。**顺序不能反**——先 completeTask 的话，
  // 等着这条活的 AI 执行会被叫醒，而那时正文还没落库，它拿到的是一句空回执
  let resultText = typeof body.result === 'string' ? body.result : undefined;
  let okFlag = body.ok === true; // 只认显式 true：漏传 ok 的旧版插件不该把一次失败记成成功
  let errorText = typeof body.error === 'string' ? body.error : undefined;
  const claimerId = auth.tokenId ?? 'legacy';

  // 【先验状态与持有者，再落库】（2026-09-04 审计）原先先 ingest 再 completeTask：被取代/取消/过期的任务
  // 回执虽被 409 拒掉，正文与指标却已经写进数据看板了——一条「作废」的活照样改了数据。
  {
    const cur = await prisma.browserTask.findFirst({ where: { id: taskId, workspaceId: auth.workspace.id }, select: { status: true, claimedBy: true } });
    if (!cur) return json({ ok: false, error: '任务不存在' }, 404);
    if (cur.status !== 'claimed') return json({ ok: false, error: `任务当前状态是 ${cur.status}，不能交付（结果未入库）` }, 409);
    if (cur.claimedBy && cur.claimedBy !== claimerId) return json({ ok: false, error: '这条活已被另一台执行器重新领走，这份迟到的结果不收（未入库）' }, 409);
  }
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
      // 读回空正文不算成功（2026-09-04 审计）：原先照样记 done、通知「跑完了」、等它的运行以 ok 醒来
      if (!accepted.stored) { okFlag = false; errorText = accepted.summary; }
    }
  }
  if (okFlag && body.parsed && typeof body.parsed === 'object') {
    const task = await prisma.browserTask.findFirst({
      where: { id: taskId, workspaceId: auth.workspace.id },
      select: { payload: true },
    });
    const payload = browserTaskPayloadSchema.safeParse(parseJson<unknown>(task?.payload ?? '{}', {}));
    if (payload.success && payload.data.kind !== 'open_and_read') {
      // 主页解析器产物 / 创作者后台读数 / 配方结局 / 页面直读——四种原料一个入口分发（2026-09-16）
      const { ingestExecutorResult } = await import('@/lib/browser-task/local-run');
      const r = await ingestExecutorResult({
        workspaceId: auth.workspace.id,
        payload: payload.data,
        parsed: body.parsed as Parameters<typeof ingestExecutorResult>[0]['parsed'],
        channel: 'desktop',
        via: '桌面客户端',
      });
      if (r.ok) resultText = r.summary;
      else { okFlag = false; errorText = r.error; }
    } else {
      okFlag = false; errorText = '这条任务不是采集类的，不该带 parsed 回来';
    }
  }

  // retriedAfter：新版桌面执行器冷启动第一次失败后原地重跑过，这是第一次的原因（服务端留档 + 据此判退避）
  const retriedAfter = typeof body.retriedAfter === 'string' && body.retriedAfter ? body.retriedAfter : undefined;
  const r = await completeTask(auth.workspace.id, taskId, { ok: okFlag, result: resultText, error: errorText, retriedAfter }, claimerId);
  return json(r, r.ok ? 200 : 409);
}
