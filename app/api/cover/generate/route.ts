import { prisma } from '@/lib/db';
import { getSessionOrNull } from '@/lib/session';
import { can } from '@/lib/rbac';
import { log } from '@/lib/logger';
import { buildAccountContext } from '@/lib/account-context';
import { renderSkillTemplate } from '@/lib/skills/render';
import { personaPromptBlock } from '@/lib/persona';
import { safePersona } from '@/lib/studio/draft-core';
import { runCover, type CoverRunResult } from '@/lib/cover/run';
import { MAX_REFERENCE_IMAGES, MAX_REFERENCE_BYTES, COVER_EXTRA_HARD_MAX, MAX_COVER_IMAGES } from '@/lib/cover/rules';

// 封面工位的出口：POST JSON（参考图是浏览器压缩后的 data URL）→ SSE 进度 → 已打标的封面 data URL。
//
// 为什么是 Route Handler + SSE，不是 server action：
//   ① server action 请求体默认 1MB，而人像参考图压缩后也常在几百 KB 到 1MB——此前封面技能允许 8MB
//      走 action，>700KB 的人像照必 413，「主体保真」在生产极可能从未走通；
//   ② 出图 20–60 秒，生产走 nginx 反代，proxy_read_timeout 默认 60 秒；SSE 每 10 秒心跳，读超时永远不会触发，
//      而且能把「提炼文案 → 出图 → 打标」的进度推给用户（没有进度，用户会以为卡死）。
//
// 权限与归属：只认 session.accountId 名下的草稿；技能模板取内置 xhs-cover（tenantId=null）渲染后作抽标题指令，
// **不要求**先去技能中心安装（封面是草稿出成品的默认一步，不是可选插件）。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const HEARTBEAT_MS = 10_000;
// 库里没同步到内置封面技能时的兜底模板（生产要跑 sync-system-data --apply；这里不让封面因此整条失败）
const FALLBACK_TEMPLATE = [
  '从下面这篇内容里，提炼一张封面图要用的文案要素。',
  '标题：{{title}}',
  '{{context}}',
  '正文：',
  '{{content}}',
  '要求：主标题要抓眼、口语、有信息量或悬念；副标题作补充或点缀、可留空；再给一个配色倾向（可留空）。',
].join('\n');
// content-length 先挡：3 张 ≤1MB 的图 base64 后 ≈ 4.1MB，其余字段给 256KB 余量。可伪造，所以 run.ts 里按真实长度再判。
const MAX_BODY_BYTES = MAX_REFERENCE_IMAGES * Math.ceil((MAX_REFERENCE_BYTES * 4) / 3) + 256 * 1024;

type Body = {
  draftId?: string;
  specKey?: string;
  styleKey?: string;
  styleKeys?: string[];
  variants?: number;
  wechatSquareToo?: boolean;
  fontKey?: string;
  decors?: string[];
  extra?: string;
  textless?: boolean;
  mainTitle?: string;
  subTitle?: string;
  subjectImages?: string[];
  backgroundImages?: string[];
  subjectAssetIds?: string[];
  backgroundAssetIds?: string[];
  portraitConsent?: boolean;
};

export async function POST(req: Request) {
  const s = await getSessionOrNull();
  if (!s) return json({ error: '请先登录' }, 401);
  if (!can(s.role, 'content.create')) return json({ error: '当前角色没有创作权限' }, 403);

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared && declared > MAX_BODY_BYTES) {
    return json({ error: `参考图太大：单张请控制在 ${MAX_REFERENCE_BYTES / 1024 / 1024}MB 以内（页面会自动压缩，换张小点的试试）` }, 413);
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== 'object') return json({ error: '请求格式不对' }, 400);
  const draftId = String(body.draftId ?? '').trim();
  if (!draftId) return json({ error: '缺少草稿' }, 400);

  const draft = await prisma.draft.findFirst({
    where: { id: draftId, accountId: s.accountId },
    include: { versions: { orderBy: { seq: 'desc' }, take: 1 } },
  });
  if (!draft) return json({ error: '草稿不存在' }, 404);

  const mainTitle = String(body.mainTitle ?? '').trim();
  const content = draft.versions[0]?.content?.trim() ?? '';
  // 没手填大字就要从正文抽；正文也没有 → 说清楚该怎么办，而不是让抽取跑一趟空转
  if (!mainTitle && !content) {
    return json({ error: '这份草稿还没有正文：先写一版，或直接填一个封面大字再生成' }, 400);
  }

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // 客户端已断开：生成仍会跑完并记账（钱已经花了），只是没人收这条进度
        }
      };
      timer = setInterval(() => send('ping', { t: 'alive' }), HEARTBEAT_MS);
      send('start', { hint: mainTitle ? '正在准备出图…' : '正在从正文提炼封面文案…' });

      try {
        // 抽标题的指令 = 内置封面技能的模板渲染（技能=提示词模板的不变式，对图像技能同样成立）
        let instruction: string | undefined;
        if (!mainTitle) {
          const builtin = await prisma.contentSkill.findFirst({
            where: { slug: 'xhs-cover', tenantId: null, enabled: true },
            select: { promptTemplate: true },
          });
          const tpl = builtin?.promptTemplate ?? FALLBACK_TEMPLATE;
          const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
          const ctx = await buildAccountContext({
            workspaceId: s.workspaceId,
            accountId: s.accountId,
            account,
            platform: draft.platform,
            blocks: ['fingerprint', 'catchphrase'],
            maxChars: 1500,
          });
          instruction = renderSkillTemplate(tpl, {
            content,
            title: draft.title,
            persona: personaPromptBlock(safePersona(account?.personaCard)),
            context: ctx.text,
            brief: '',
          });
        }

        const r: CoverRunResult = await runCover({
          tenantId: s.tenantId,
          workspaceId: s.workspaceId,
          accountId: s.accountId,
          draftId: draft.id,
          platform: draft.platform,
          specKey: str(body.specKey),
          styleKey: str(body.styleKey),
          styleKeys: Array.isArray(body.styleKeys)
            ? body.styleKeys.filter((x): x is string => typeof x === 'string').slice(0, MAX_COVER_IMAGES)
            : undefined,
          variants: typeof body.variants === 'number' ? body.variants : undefined,
          wechatSquareToo: body.wechatSquareToo === true,
          fontKey: str(body.fontKey),
          decors: Array.isArray(body.decors) ? body.decors.filter((d): d is string => typeof d === 'string').slice(0, 8) : undefined,
          extra: String(body.extra ?? '').slice(0, COVER_EXTRA_HARD_MAX),
          textless: body.textless === true,
          meta: mainTitle ? { mainTitle, subTitle: String(body.subTitle ?? '') } : undefined,
          instruction,
          fallbackTitle: draft.title,
          subjectImages: Array.isArray(body.subjectImages) ? body.subjectImages : undefined,
          backgroundImages: Array.isArray(body.backgroundImages) ? body.backgroundImages : undefined,
          subjectAssetIds: Array.isArray(body.subjectAssetIds) ? body.subjectAssetIds.filter((x): x is string => typeof x === 'string') : undefined,
          backgroundAssetIds: Array.isArray(body.backgroundAssetIds) ? body.backgroundAssetIds.filter((x): x is string => typeof x === 'string') : undefined,
          portraitConsent: body.portraitConsent === true,
          onProgress: (step, message) => send('progress', { step, message }),
        });

        if (r.ok) {
          send('done', {
            ok: true,
            images: r.images,
            meta: r.meta,
            metaFromUser: r.metaFromUser,
            spec: { key: r.spec.key, label: r.spec.label, aspect: r.spec.aspect, fileStem: r.spec.fileStem },
            styleKey: r.styleKey,
            mocked: r.mocked,
            riskLevel: r.riskLevel,
            hits: r.hits,
            model: r.model,
            source: r.source,
            warning: r.warning,
            draftId: draft.id,
          });
          log.info('封面生成完成', { workspaceId: s.workspaceId, draftId: draft.id, spec: r.spec.key, style: r.styleKey, n: r.images.length });
        } else {
          send('failed', { ok: false, error: r.error, reason: r.reason });
        }
      } catch (e) {
        const msg = (e as Error).message;
        log.warn('封面生成异常', { workspaceId: s.workspaceId, error: msg });
        send('failed', { ok: false, error: msg.slice(0, 300) });
      } finally {
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx 不缓冲，心跳才真的按时到达
    },
  });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : undefined);

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
