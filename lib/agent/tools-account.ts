import { prisma } from '../db';
import { toJson } from '../json';
import { PLATFORMS, platformName } from '../constants';
import { parseCompetitorUrl } from '../competitor-url';
import { emptyPersona } from '../persona';
import type { AgentTool } from './tool-types';
import { str } from './tool-types';

// ── 自有账号类工具（2026-09-09）──────────────────────────────────────────────
//
// 【为什么要有这一组】用户说「帮我采集 X 的账号」，模型查到工作区里没有 X 账号，
// 然后回了一句「抱歉，我没有添加自有账号的工具，需要你自己去账号页加」。
// 用户的原话：「我希望每一次对话都可以驱动软件上的每次运行，比如直接帮我添加账号」。
// 页面上能做的事，对话里就该能做——这一组先把「自己的账号」这块补齐。
//
// 【口径与 /persona 页的账号管理、开场向导完全一致】
//   · 新增：与 onboarding 的 claimOwnAccount 同一套判断——当前账号还是注册占位行（没 handle）
//     就地升级，同平台同 handle 已存在就复用（幂等），否则新建。**不猜平台**：认不出就报错。
//   · 修改：只改名字 / handle / 平台，归属由 ToolContext 定，模型传来的账号只是「点名」，
//     用 id / handle / 名字精确匹配，对上多条就让它用 id 点名，绝不挑一个凑数。
//   · 这里**不做**归档 / 合并 / 彻底删除：那三样不可逆或影响面大，仍留在页面上由人点。
//
// 【切换当前账号的 cookie 这里不管】工具可能在 worker 里跑，没有请求上下文。
// 新建后把 id 报给用户，顶栏切换器随时能切。

const DEFAULT_ACCOUNT_NAME = '我的账号'; // 与 lib/auth.ts 注册占位行、onboarding 同名

const CONTENT_PLATFORM_KEYS = Object.keys(PLATFORMS);

type AccountRow = { id: string; name: string; platform: string; handle: string | null };

const select = { id: true, name: true, platform: true, handle: true } as const;

const norm = (h: string | null | undefined) => String(h ?? '').trim().replace(/^@/, '');

function describe(a: AccountRow, currentId?: string): string {
  return `${platformName(a.platform) || a.platform}「${a.name}」${a.handle ? `（handle：${norm(a.handle)}）` : '（没填 handle）'}${a.id === currentId ? ' ← 当前' : ''}（id: ${a.id}）`;
}

/** 认平台：接受平台 key（douyin/x/…）或中文名（抖音/小红书/…）。认不出返回 null，绝不猜。 */
function resolvePlatform(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (CONTENT_PLATFORM_KEYS.includes(s)) return s;
  const byName = Object.values(PLATFORMS).find((p) => p.name.toLowerCase() === s);
  return byName ? byName.key : null;
}

/** 按 id / handle / 名字精确匹配点名一条账号；对上多条或零条都如实报，不挑。 */
async function pickAccount(workspaceId: string, ref: string): Promise<{ ok: true; row: AccountRow } | { ok: false; error: string; summary: string }> {
  const rows = await prisma.creatorAccount.findMany({ where: { workspaceId, status: 'active' }, select, orderBy: { createdAt: 'asc' } });
  const hits = rows.filter((r) => r.id === ref || r.name === ref || (r.handle && norm(r.handle) === norm(ref)));
  if (hits.length === 1) return { ok: true, row: hits[0] };
  if (hits.length > 1) {
    return { ok: false, error: `「${ref}」对上了 ${hits.length} 个账号，用 id 点名：${hits.map((h) => describe(h)).join('；')}`, summary: '账号指代不唯一' };
  }
  return {
    ok: false,
    error: rows.length ? `没有叫「${ref}」的账号（按 id / handle / 名字精确匹配）。现有：${rows.map((r) => describe(r)).join('；')}` : '工作区里还没有账号',
    summary: '没有这个账号',
  };
}

const listAccounts: AgentTool = {
  name: 'list_accounts',
  label: '查自己的账号',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_accounts',
    description: '列出这个工作区里用户自己的创作者账号（平台、名字、handle、哪条是当前）。加账号或改账号之后想确认结果就调它。',
    parameters: { type: 'object', properties: {} },
  },
  async run(ctx) {
    const rows = await prisma.creatorAccount.findMany({ where: { workspaceId: ctx.workspaceId, status: 'active' }, select, orderBy: { createdAt: 'asc' } });
    return {
      ok: true,
      data: rows.map((r) => ({ ...r, current: r.id === ctx.accountId })),
      summary: rows.length ? rows.map((r) => describe(r, ctx.accountId)).join('；') : '工作区里还没有账号',
    };
  },
};

const addAccount: AgentTool = {
  name: 'add_account',
  label: '添加自己的账号',
  action: 'persona.edit',
  write: true,
  def: {
    name: 'add_account',
    description:
      '把用户自己在某个平台的账号登记进来（不是对标账号，对标用 add_competitor）。给主页链接或「平台 + handle」都行。' +
      '注册时的占位账号（没 handle 的「我的账号」）会被就地升级成这条；同平台同 handle 已存在则直接复用，不会建重。' +
      '登记好之后就能派 collect_self_profile 回填它的数据。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '用户主页链接（有它就不用再填 platform/handle）' },
        platform: { type: 'string', description: '平台 key 或中文名：douyin/xiaohongshu/wechat/bilibili/shipinhao/x/youtube/tiktok/weibo/zhihu/toutiao/baijiahao/kuaishou' },
        handle: { type: 'string', description: '该平台的主页 ID / 用户名（不带 @）。X、YouTube、TikTok 必填；没有 handle 采不了自己的数据' },
        name: { type: 'string', description: '显示名（可选，缺省「平台 @handle」）' },
      },
    },
  },
  async run(ctx, args) {
    const url = str(args.url);
    let platform: string | null = null;
    let handle = norm(str(args.handle));
    if (url) {
      const parsed = parseCompetitorUrl(url);
      // 认不出就报错，绝不猜：猜错平台/handle 会把数据回流到别人的号上
      if (!parsed) return { ok: false, error: '这个链接认不出是哪个平台的哪个账号，改用 platform + handle 传', summary: '链接无法识别，没有添加' };
      platform = parsed.platform;
      handle = handle || parsed.handle;
    } else {
      platform = resolvePlatform(str(args.platform));
      if (!platform) {
        return { ok: false, error: `平台认不出（收到「${str(args.platform) || '空'}」）。可用：${CONTENT_PLATFORM_KEYS.join('/')}`, summary: '平台无法识别，没有添加' };
      }
    }
    const nameArg = str(args.name);
    const label = nameArg || (handle ? `${platformName(platform)} @${handle}` : `${platformName(platform)}账号`);

    // ① 同平台同 handle 已存在 → 复用（幂等，重复说一遍不会建重）
    if (handle) {
      const existing = await prisma.creatorAccount.findFirst({ where: { workspaceId: ctx.workspaceId, platform, handle, status: 'active' }, select });
      if (existing) {
        return { ok: true, data: { accountId: existing.id, platform, handle, reused: true }, summary: `已经有这条账号了，直接用：${describe(existing, ctx.accountId)}` };
      }
    }

    // ② 当前账号还是注册占位行（没 handle）→ 就地升级，与开场向导同一口径
    const cur = ctx.accountId ? await prisma.creatorAccount.findFirst({ where: { id: ctx.accountId, workspaceId: ctx.workspaceId, status: 'active' }, select }) : null;
    if (cur && !cur.handle && (cur.platform === 'multi' || cur.platform === platform)) {
      const row = await prisma.creatorAccount.update({
        where: { id: cur.id },
        data: { platform, handle: handle || null, ...(nameArg || cur.name === DEFAULT_ACCOUNT_NAME ? { name: label } : {}) },
        select,
      });
      return { ok: true, data: { accountId: row.id, platform, handle: row.handle, upgraded: true }, summary: `把占位账号升级成了：${describe(row, ctx.accountId)}` };
    }

    // ③ 新建
    const row = await prisma.creatorAccount.create({
      data: {
        workspaceId: ctx.workspaceId,
        name: label,
        platform,
        handle: handle || null,
        personaCard: toJson(emptyPersona()),
        styleFingerprint: toJson({ voice: [], format: [], topic: [] }),
      },
      select,
    });
    return {
      ok: true,
      data: { accountId: row.id, platform, handle: row.handle, created: true },
      summary: `已添加：${describe(row)}。${handle ? '' : '还没填 handle，采不了它自己的数据；知道主页 ID 后用 update_account 补上。'}要以它为当前账号的话，顶栏账号切换器里选它。`,
    };
  },
};

const updateAccount: AgentTool = {
  name: 'update_account',
  label: '修改自己的账号',
  action: 'persona.edit',
  write: true,
  def: {
    name: 'update_account',
    description: '改用户自己某条账号的名字、handle 或平台。用 account 点名（id / handle / 名字精确匹配；不传就是当前账号）。只传要改的字段。',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: '要改哪条：id / handle / 名字（不传 = 当前账号）' },
        name: { type: 'string', description: '新名字' },
        handle: { type: 'string', description: '新 handle（不带 @）' },
        platform: { type: 'string', description: '新平台 key 或中文名' },
      },
    },
  },
  async run(ctx, args) {
    const ref = str(args.account);
    let target: AccountRow | null;
    if (ref) {
      const picked = await pickAccount(ctx.workspaceId, ref);
      if (!picked.ok) return picked;
      target = picked.row;
    } else {
      target = await prisma.creatorAccount.findFirst({ where: { id: ctx.accountId, workspaceId: ctx.workspaceId, status: 'active' }, select });
      if (!target) return { ok: false, error: '当前账号不存在，用 account 点名一条', summary: '没有当前账号' };
    }

    const data: { name?: string; handle?: string | null; platform?: string } = {};
    const name = str(args.name);
    if (name) data.name = name;
    if (typeof args.handle === 'string') data.handle = norm(args.handle) || null;
    const platformArg = str(args.platform);
    if (platformArg) {
      const p = resolvePlatform(platformArg);
      if (!p) return { ok: false, error: `平台认不出（收到「${platformArg}」）。可用：${CONTENT_PLATFORM_KEYS.join('/')}`, summary: '平台无法识别，没有修改' };
      data.platform = p;
    }
    if (Object.keys(data).length === 0) return { ok: false, error: '没说要改什么：name / handle / platform 至少传一个', summary: '没有要改的字段' };

    const row = await prisma.creatorAccount.update({ where: { id: target.id }, data, select });
    return { ok: true, data: row, summary: `已修改：${describe(row, ctx.accountId)}` };
  },
};

export const ACCOUNT_TOOLS: AgentTool[] = [listAccounts, addAccount, updateAccount];
