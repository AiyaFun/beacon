import { prisma } from '../db';
import { parseCompetitorUrl } from '../competitor-url';
import { crawlOneCompetitor } from '../pipeline';
import { PLATFORMS, platformName } from '../constants';
import { log } from '../logger';

// 入站收录原语（需求④）：把 bot 消息里的链接/文本落成内容引擎的输入。
// 红线：只收录进「候选池」，绝不自动发布；生成走既有管线时仍全程过合规。

// 收录目标账号：优先用本群绑定的账号（/账号 切换），否则退回工作区第一个活跃账号。
// 无账号则收录失败并提示。
//
// ⚠️ prefer 必须校验「确实属于这个工作区且在用」——它来自会话表，账号可能已被删或停用，
// 直接拿去建选题会写出一条谁也看不见的孤儿记录（/data 与选题页全按 accountId 过滤）。
export async function pickTargetAccount(
  workspaceId: string,
  prefer?: string | null,
): Promise<{ id: string; name: string } | null> {
  if (prefer) {
    const p = await prisma.creatorAccount.findFirst({
      where: { id: prefer, workspaceId, status: 'active' },
      select: { id: true, name: true },
    });
    if (p) return p;
  }
  const a = await prisma.creatorAccount.findFirst({
    where: { workspaceId, status: 'active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  return a;
}

// 从文本里抽第一个 URL
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s，。、）)]+/);
  return m ? m[0] : null;
}

// 收录成选题候选（sourceType=manual：bot 注入等价人工加选题，UI 已能显示 manual）。
// 去重：同账号同标题已存在则不重复建，返回 existed。
export async function ingestTopic(
  workspaceId: string,
  title: string,
  opts?: { angle?: string; sourceRef?: string; accountId?: string | null },
): Promise<{ ok: boolean; existed?: boolean; error?: string; accountName?: string }> {
  const acct = await pickTargetAccount(workspaceId, opts?.accountId);
  if (!acct) return { ok: false, error: '工作区还没有账号，先去烽火台建一个账号再收录' };

  const clean = title.trim().slice(0, 120);
  if (!clean) return { ok: false, error: '内容为空' };

  const dup = await prisma.topicIdea.findFirst({
    where: { accountId: acct.id, title: clean, state: { in: ['candidate', 'recommended'] } },
    select: { id: true },
  });
  if (dup) return { ok: true, existed: true, accountName: acct.name };

  await prisma.topicIdea.create({
    data: {
      accountId: acct.id,
      title: clean,
      angle: opts?.angle ?? '（bot 收录，待精排）',
      sourceType: 'manual',
      sourceRef: opts?.sourceRef ?? 'bot:feishu',
      state: 'candidate',
      mocked: false,
    },
  });
  return { ok: true, existed: false, accountName: acct.name };
}

// /采集 <竞对主页URL> → 解析平台+handle → 加入竞对监控（等价 actAddCompetitor，不走 session）。
export async function ingestCompetitor(
  workspaceId: string,
  url: string,
): Promise<{ ok: boolean; error?: string; name?: string; platform?: string; posts?: number; degraded?: boolean }> {
  const parsed = parseCompetitorUrl(url);
  if (!parsed) return { ok: false, error: '识别不出竞对主页链接（支持 B站空间/抖音用户/小红书用户页）' };
  if (!(parsed.platform in PLATFORMS)) return { ok: false, error: '平台不支持' };

  const competitor = await prisma.competitorAccount.upsert({
    where: { platform_handle: { platform: parsed.platform, handle: parsed.handle } },
    create: { platform: parsed.platform, handle: parsed.handle, name: parsed.handle },
    update: {},
  });
  await prisma.watchlistItem.upsert({
    where: { workspaceId_competitorId: { workspaceId, competitorId: competitor.id } },
    create: { workspaceId, competitorId: competitor.id },
    update: {},
  });

  let posts = 0;
  let degraded = false;
  try {
    const r = await crawlOneCompetitor(competitor.id, { workspaceId, channel: 'manual' });
    posts = r.posts;
    degraded = r.degraded;
  } catch (e) {
    degraded = true;
    log.warn('bot /采集 试采失败', { workspaceId, competitorId: competitor.id, err: e });
  }
  return { ok: true, name: competitor.name, platform: platformName(parsed.platform), posts, degraded };
}
