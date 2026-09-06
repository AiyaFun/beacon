import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { checkRateLimit, getClientIp, ipKey } from '@/lib/ratelimit';
import { isFunnelEvent, recordFunnelEvent } from '@/lib/growth/funnel';

// 漏斗事件上报（2026-09-05）。匿名访客也能报——所以它在 middleware 的 PUBLIC_PATHS 里。
//
// 自守卫三道：① 同 IP 每分钟 60 次（限流只用 IP 做 key，**不落库**）；② 事件名白名单；
// ③ 体积上限 2KB。响应永远 204/400/429，不回显任何东西。
// 不记 IP、不记 UA、不记 referer：见 lib/growth/funnel.ts 文件头。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIMIT = { limit: 60, windowMs: 60_000 };
const MAX_BODY = 2048;

export async function POST(req: Request) {
  const h = await headers();
  const rl = await checkRateLimit(ipKey('track', getClientIp(h)), LIMIT);
  if (!rl.ok) return new NextResponse(null, { status: 429 });

  const raw = await req.text().catch(() => '');
  if (!raw || raw.length > MAX_BODY) return new NextResponse(null, { status: 400 });
  let body: { name?: unknown; path?: unknown; meta?: unknown; visitorId?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (!isFunnelEvent(body.name)) return new NextResponse(null, { status: 400 });

  await recordFunnelEvent({
    name: body.name,
    path: typeof body.path === 'string' ? body.path : '',
    meta: typeof body.meta === 'string' ? body.meta : '',
    visitorId: typeof body.visitorId === 'string' ? body.visitorId : null,
  });
  return new NextResponse(null, { status: 204 });
}
