import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { toJson } from '@/lib/json';
import { emptyPersona } from '@/lib/persona';
import { PLATFORMS } from '@/lib/constants';
import { INGEST_TOKEN_HEADER, workspaceByIngestToken } from '@/lib/ingest/competitor';

// 自有账号清单 · 插件读取「本工作区有哪些创作账号」（authorized 通道，只读）。
//
// 存在的理由：回填的归属此前是**猜**出来的（按平台取第一个活跃账号，见 lib/ingest/own-post.ts）。
// 一个工作区经营两个抖音号时这必然错一半，而挂错账号的后果不是「显示得不对」，
// 是数据看板上彻底看不见 + 污染另一个号的基线与学习信号（2026-07-25 真机事故）。
// 所以插件里要能**绑定**一个账号，回填时带 accountId 上来——这个端点就是那份可选清单。
//
// 🔒 鉴权同其余 ingest 路由：x-beacon-ingest-token → Workspace.ingestToken，只回本工作区的账号。
//   在 middleware 的 PUBLIC_PATHS 里（/api/ingest/self 前缀已覆盖本子路径）。
// 🔒 只回**选账号必需的字段**：id / 名称 / 平台 / handle / 状态。
//   人设卡、风格指纹这些是工作区的核心资产，插件用不到，就不从这条免 cookie 的通道出去。
// CORS 全开同其余 ingest 路由：令牌头鉴权、无 cookie，无 CSRF 面。

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

export async function GET(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) return json({ ok: false, error: '采集令牌无效或已停用' }, 401);

  const accounts = await prisma.creatorAccount.findMany({
    where: { workspaceId: ws.id },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, platform: true, handle: true, status: true },
  });

  return json({ ok: true, workspace: ws.name, accounts });
}

// ── 建号（插件里就地补一个账号）──
//
// 【为什么开这个口子】回填时最常见的死路是「工作区里还没有『X』账号」：
// 用户站在自己的主页上、数据就在眼前，却被要求切回网页去建号、再回来重点一次。
// 这里让插件一键补上并立刻回填。
//
// ⚠️ 这是采集令牌**唯一一处能创建工作区实体**的地方，与其余只写数据的通道不同。
//    产品上已明确接受这个取舍（用户 2026-07-27 决策：以最少操作为准）。记下它的边界：
//    · 网页里建号要 persona.edit（owner/admin/editor），而设置页的令牌卡没有角色门——
//      也就是说拿到令牌的 viewer 可以经此建号。这是已知且被接受的权限扩大。
//    · 因此口子只开到「建一个空账号」：不能改名、不能删、不能动别人的号，
//      人设卡与风格指纹都种成空白模板（与 app/(app)/actions.ts actCreateAccount 同一份种子）。
//    · 同名同平台**不重复建**，返回既有的那个——插件里点两下不该出现两个一样的号。
//    · 总数封顶，防脚本跑飞把工作区刷满。
//    · 每次建号都记日志，事后查得到。
const MAX_ACCOUNTS = 30;

const createSchema = z.object({
  name: z.string().trim().min(1, '账号名称不能为空').max(60),
  platform: z.string().refine((p) => p in PLATFORMS, { message: '未知平台' }),
  handle: z.string().trim().max(128).optional(),
});

export async function POST(req: Request) {
  const ws = await workspaceByIngestToken(req.headers.get(INGEST_TOKEN_HEADER));
  if (!ws) return json({ ok: false, error: '采集令牌无效或已停用' }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return json({ ok: false, error: `数据格式不合法：${parsed.error.issues[0]?.message ?? ''}` }, 400);
  }
  const { name, platform, handle } = parsed.data;

  // 同名同平台已存在 → 直接返回它（幂等）。用户在插件里连点两下不该建出两个一样的号。
  const existing = await prisma.creatorAccount.findFirst({
    where: { workspaceId: ws.id, platform, name },
    select: { id: true, name: true, platform: true, handle: true, status: true },
  });
  if (existing) return json({ ok: true, account: existing, existed: true });

  const total = await prisma.creatorAccount.count({ where: { workspaceId: ws.id } });
  if (total >= MAX_ACCOUNTS) {
    return json({ ok: false, error: `这个工作区的创作账号已达上限（${MAX_ACCOUNTS} 个），请先到烽火台里清理` }, 400);
  }

  const account = await prisma.creatorAccount.create({
    data: {
      workspaceId: ws.id,
      name,
      platform,
      handle: handle || null,
      // 与网页建号同一份种子：少了它，账号带着 '{}' 人设进系统，
      // 人设相关的读取处处要额外兜底，推荐质量也跟着打折。
      personaCard: toJson(emptyPersona()),
      styleFingerprint: toJson({ voice: [], format: [], topic: [] }),
    },
    select: { id: true, name: true, platform: true, handle: true, status: true },
  });
  log.info('插件建号', { workspaceId: ws.id, accountId: account.id, platform });

  return json({ ok: true, account, existed: false });
}
