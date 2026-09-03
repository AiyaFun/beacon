import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import { hotSourceMode } from '@/lib/adapters/registry';
import { log } from '@/lib/logger';
import { schedulerKind } from '@/lib/jobs/queue';
import { isProd } from '@/lib/env';

export const dynamic = 'force-dynamic';

// 详情鉴权：配了 BEACON_HEALTH_TOKEN 就必须带对 token 才给组件详情，否则只回状态。
// 未配置时仅在明确的本地开发环境（!isProd() && NODE_ENV === 'development'）直接给详情；
// 生产态及任何环境错配/未明确状态下默认关闭（Fail-Safe 默认安全）——杜绝忘配 token 或环境错配导致内部状态泄露。
function canSeeDetail(req: NextRequest): boolean {
  const expected = process.env.BEACON_HEALTH_TOKEN;
  if (!expected) {
    return !isProd() && process.env.NODE_ENV === 'development';
  }

  // 只认请求头，不认 query（token 落进网关/CDN 访问日志就等于泄露）
  const raw = req.headers.get('x-beacon-health-token') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!raw) return false;
  const a = Buffer.from(raw);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 就绪/存活探针：DB 连通 + 数据源健康 + 队列模式。
// 探针（compose/k8s）只看状态码，公开响应因此只有 {status}；详情需 token。
export async function GET(req: NextRequest) {
  const checks: Record<string, unknown> = {};
  let healthy = true;

  // DB
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    checks.db = 'ok';
  } catch (e) {
    checks.db = `fail: ${(e as Error).message.slice(0, 80)}`;
    healthy = false;
  }

  // 定时到底谁在跑：bullmq(独立 worker) / local(web 进程内，整机版) / none(本机开发)。
  // 单看「队列类型」不够——local 与 inprocess 的队列实现是同一个，差别在有没有人到点敲门
  checks.queue = process.env.BEACON_QUEUE === 'bullmq' ? 'bullmq' : 'inprocess';
  checks.scheduler = schedulerKind();
  checks.llm = process.env.BEACON_DEFAULT_LLM_API_KEY ? 'configured' : 'mock';
  // 数据通道口径（'dailyhot' / '60s' / 'mock'），不参与 healthy 判定：源不可达会逐源回退 Mock，不算基础设施故障
  checks.hotSource = hotSourceMode();
  checks.env = process.env.BEACON_ENV ?? 'unknown';

  const status = healthy ? 'ok' : 'degraded';
  const code = healthy ? 200 : 503;

  // 探针每几秒打一次，健康时别刷屏；异常才是要被看见的信号
  if (healthy) log.debug('健康探针', { status });
  else log.error('健康探针不健康', { status, checks });

  const body = canSeeDetail(req)
    ? { status, checks, ts: new Date().toISOString() }
    : { status, ts: new Date().toISOString() };

  return NextResponse.json(body, { status: code });
}
