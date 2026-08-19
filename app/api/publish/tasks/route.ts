import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseJson } from '@/lib/json';
import { INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';
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

export async function GET(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) return NextResponse.json({ ok: false, error: '采集令牌无效或已停用' }, { status: 401, headers: CORS });

  const url = new URL(req.url);
  const platform = url.searchParams.get('platform');

  const tasks = await prisma.publishTask.findMany({
    where: {
      plan: { workspaceId: ws.id, status: 'open' },
      channel: 'extension',
      status: { in: ['ready', 'filled'] },
      ...(platform ? { platform } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });

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
