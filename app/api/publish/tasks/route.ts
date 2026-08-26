import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseJson } from '@/lib/json';
import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER } from '@/lib/ingest/competitor';
import { resolveIngestToken } from '@/lib/ingest/token';
import { channelOf } from '@/lib/publish/capability';
import type { PlanTaskExtra } from '@/lib/publish/plan';

// 插件拉「待填充的发布任务」（authorized 通道，与采集回传复用同一枚工作区令牌）。
//
// 🔒 这条路由在 middleware 的 PUBLIC_PATHS 里——插件的 fetch 不带登录 cookie，令牌是唯一闸门。
//    令牌只授权「读本工作区待发布任务 + 回执」这两件事，读不到任何别的租户数据。
//
// ⚠️ 只回 channel='extension' 的任务。公众号那条走服务端官方接口，插件不该看到它的内容；
//    manual 的任务插件也帮不上忙，回给它只会让插件在不该注入的页面上乱动。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': `content-type, ${INGEST_TOKEN_HEADER}`,
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * 领了多久算数。**比浏览器任务的 15 分钟长得多**，因为这一步是「人在环里」的：
 * 用户要看一眼填得对不对再点发布。按机器的节奏计时会把他正在看的那条抢走。
 */
const PUBLISH_LEASE_MS = 30 * 60_000;

export async function GET(req: Request) {
  const auth = await resolveIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!auth) return NextResponse.json({ ok: false, error: INGEST_TOKEN_INVALID }, { status: 401, headers: CORS });
  const ws = auth.workspace;
  // 领取者身份：按设备签发的令牌 id。老式工作区令牌没有 tokenId，统一记成 legacy
  const claimer = auth.tokenId ?? 'legacy';

  const url = new URL(req.url);
  const platform = url.searchParams.get('platform');
  const now = new Date();

  // 【为什么这条 GET 会写库】这个队列曾经是无锁广播：任何持令牌的执行体 GET 一次
  // 就看到全部待办。用户既装了插件、又在 Mac mini 上跑着本机执行体时，
  // 同一篇稿子会被**各填一遍**；要是还开了「代点发布」，那就是发两次。
  //
  // 领活本来就是一个有副作用的动作（BrowserTask 那侧的 /api/ingest/tasks 也是 GET+领取）。
  // 做成 GET 是为了**不用改插件**——插件已经发布出去了，协议一变旧版本就全废。
  const tasks = await prisma.publishTask.findMany({
    where: {
      plan: { workspaceId: ws.id, status: 'open' },
      channel: 'extension',
      status: { in: ['ready', 'filled'] },
      ...(platform ? { platform } : {}),
      // 别人还在做的不给：租约没到期且不是自己领的，就当它不存在
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }, { claimedBy: claimer }],
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });

  // 把这一批租给它。**不用乐观锁**：两个执行体同时拿到同一条时，
  // 后写的那个赢——代价只是「填了两遍」，与租约要防的「各填一遍还各点一次发布」
  // 不是一个量级；而为这点边角情况引入逐条 updateMany 会让这条路慢好几倍。
  if (tasks.length > 0) {
    await prisma.publishTask.updateMany({
      where: { id: { in: tasks.map((t) => t.id) } },
      data: { claimedBy: claimer, leaseUntil: new Date(now.getTime() + PUBLISH_LEASE_MS) },
    });
  }

  return NextResponse.json(
    {
      ok: true,
      tasks: tasks
        // 双保险：channel 存的是建计划那一刻的判定，能力矩阵后来改了的话以现在的为准
        .filter((t) => channelOf(t.platform) === 'extension')
        .map((t) => {
          const extra = parseJson<PlanTaskExtra>(t.extra, {});
          return {
            id: t.id,
            platform: t.platform,
            status: t.status,
            title: t.title,
            content: t.content,
            tags: extra.tags ?? [],
            topics: extra.topics ?? [],
            firstComment: extra.firstComment ?? '',
          };
        }),
    },
    { headers: CORS },
  );
}
