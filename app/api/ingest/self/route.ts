import { NextResponse } from 'next/server';
import { log } from '@/lib/logger';
import { INGEST_TOKEN_INVALID, INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';
import { ownPostIngestSchema, ingestOwnPostData } from '@/lib/ingest/own-post';
import { ownAccountIngestSchema, ingestOwnAccountData, resolveDefaultAccountId } from '@/lib/ingest/own-account';

// 自有作品数据 · 插件回传入口（authorized 通道，与竞对回传并行）。
//
// 🔒 鉴权：x-beacon-ingest-token → Workspace.ingestToken（同竞对回传，复用同一令牌）。
//   本路由在 middleware 的 PUBLIC_PATHS 里——插件 fetch 不带登录 cookie，令牌是唯一闸门。
//   令牌只授权「向本工作区回填自有作品表现数据」这一件事（守卫在 lib/ingest/own-post.ts）。
//
// CORS 全开同竞对入口：鉴权靠自定义 header 令牌而非 cookie，无凭证跨源没有 CSRF 面。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': `content-type, ${INGEST_TOKEN_HEADER}`,
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

// GET = 插件「测试连接」握手：令牌有效则回工作区名
export async function GET(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) return json({ ok: false, error: INGEST_TOKEN_INVALID }, 401);
  return json({ ok: true, workspace: ws.name });
}

export async function POST(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) {
    log.warn('自有作品回传鉴权失败');
    return json({ ok: false, error: INGEST_TOKEN_INVALID }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }
  // 一个端点收两类自有数据：作品级（posts）与账号级（dailyStats/audience）。
  // 语义完全一致（「我本人登录态下读的我自己的数据」），故不新开端点——拆开只会多一套
  // 令牌与 CORS 配置。插件可以只发其中一块，也可以一次发全。
  const b = (body ?? {}) as Record<string, unknown>;
  const hasPosts = Array.isArray(b.posts) && b.posts.length > 0;
  const hasAccount = b.dailyStats !== undefined || b.audience !== undefined;
  if (!hasPosts && !hasAccount) {
    return json({ ok: false, error: '数据格式不合法：posts / dailyStats / audience 至少要有一块' }, 400);
  }

  let posts: { updated: number; created: number; skipped: number } | null = null;
  let targetAccount: { id: string; name: string } | undefined;
  if (hasPosts) {
    const parsed = ownPostIngestSchema.safeParse(body);
    if (!parsed.success) {
      return json({ ok: false, error: `数据格式不合法：${parsed.error.issues[0]?.message ?? ''}` }, 400);
    }
    const r = await ingestOwnPostData(ws.id, parsed.data);
    if (!r.ok) return json(r, r.code === 'no_account' ? 404 : 400);
    posts = { updated: r.updated, created: r.created, skipped: r.skipped };
    // 数据记在谁名下要如实回给插件：看板按 accountId 过滤，挂错号就等于看不见
    if (r.targetAccount) targetAccount = r.targetAccount;
    log.info('自有作品回传入库', { workspaceId: ws.id, platform: parsed.data.platform, ...posts });
  }

  let account: { dailyStats: number; audience: boolean } | null = null;
  if (hasAccount) {
    const parsed = ownAccountIngestSchema.safeParse(body);
    if (!parsed.success) {
      return json({ ok: false, error: `数据格式不合法：${parsed.error.issues[0]?.message ?? ''}` }, 400);
    }
    const accountId = await resolveDefaultAccountId(ws.id, parsed.data.accountId);
    if (!accountId) {
      return json({
        ok: false,
        error: parsed.data.accountId
          ? '插件里绑定的账号不在这个工作区（可能已被删除）——请到插件里重新选择要回填的账号'
          : '工作区还没有创作账号，无法回填',
        code: 'no_account',
      }, 404);
    }
    account = await ingestOwnAccountData(accountId, parsed.data);
    log.info('自有账号数据回传入库', { workspaceId: ws.id, platform: parsed.data.platform, ...account });
  }

  // 兼容既有插件版本：只发 posts 时返回形状与此前完全一致（updated/created/skipped 在顶层）
  return json({ ok: true, ...(posts ?? {}), ...(account ? { account } : {}), ...(targetAccount ? { targetAccount } : {}) });
}
