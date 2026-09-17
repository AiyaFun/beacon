import { prisma } from '../db';
import { platformName } from '../constants';
import { collectorKinds, collectorAgents, collectorAgentsFor } from './index';
import { competitorHomeUrl } from '@/lib/competitor-url';
import { selfCollectKindFor, selfProfileFallbackFor, competitorKindFor, SELF_PROFILE_PLATFORMS, SELF_BACKEND_PLATFORMS, RECIPE_PLATFORMS } from './kinds';
import { isReadAllowed, readAllowlistLabels } from './read-allowlist';

// ── 排浏览器任务前的三道闸：唯一实现 ────────────────────────────────────────
//
// 【为什么单独成文件】这三道闸原先只在 AI 工具（lib/agent/tools.ts 的
// dispatch_browser_task）里。对外调用面（/api/v1/browser-tasks，MCP 客户端走它）
// 也要排同样的任务——闸各写一份，两边迟早对不上，而对不上的那次一定发生在
// 宽的那一边（「验一道闸别用会被别的闸兜住的值」同一课）。所以收口到这里，
// 两个入口都只许 import 本文件（tests/browser-task/vet.test.ts 钉死这一点）。
//
// 三道闸：
//   ① 工作区里得真有插件（没有采集令牌 = 排了也没浏览器会领）——
//      **2026-09-03 起本机浏览器优先**：整机版/桌面端开了「浏览器操作」且 Chrome 此刻带端口跑着，
//      不管有没有插件都由本机 Chrome 当场去采（opts.localCdpUrl，判定权在调用方：SaaS 永远传不进来）；
//      没插件也没本机才是死路；
//   ② open_and_read 要工作区显式开过开关，且 URL 在白名单域里
//     （插件端还有一份硬编码清单，那份才是真正的防线——这里只是早失败早说清楚）；
//   ③ collect_competitor 的竞对必须已经在监控列表里
//     （不校验的话调用方可以拿任意 id 让插件去访问）。
//
// 另有一件不是「闸」而是「解析」的事也收在这里：collect_self_profile 说的「我的 X 账号」到底是
// 工作区里哪一条 CreatorAccount、它的 handle 是什么——插件和本机浏览器两条路都要用，
// 且用户明确要求「我们都有 X 账号的信息和插件的信息，应该要有所关联」，不能再反问他。
//
// 【调用方只说三个动词，这里按平台映射到内部 kind】（2026-09-15）模型/外部调用面说的仍是
// collect_self_profile / collect_competitor / open_and_read；「回填我的抖音」落到哪个 kind
// （后台 collect_self_backend、主页 collect_self_profile 还是配方 collect_self_recipe）、「采这个微博竞对」
// 走手写解析器还是配方（collect_competitor_recipe），由 kinds.ts 的三张平台表决定，调用方不用知道也不该知道。
//
// 【2026-09-16 起每个平台都有路，三条执行路都会做】用户原话「每一个平台都可以通过插件或者调用浏览器的方式
// 采集对应的数据或者竞对的数据」。此前后台回填与配方采集只有插件会做；现在桌面客户端与本机浏览器也会
// （在采集专用浏览器里注入同一份脚本），所以它们与主页类一样：本机就绪就标 local 当场跑；排队时按
// **谁会做这种活**（collectorAgentsFor）说清回执；没有会做的执行器时指路「更新插件或桌面客户端」。
// 抖音/小红书/B站多一条退路：没有会进后台的执行器时改采公开主页（只有公开数字，回执里说破）。

export type VetVerdict =
  | {
      ok: true;
      payload: Record<string, unknown>;
      /** 这批数据该记在谁名下（collect_self_profile / collect_self_backend 解析出来的账号）。没有就用调用方的当前账号 */
      accountId?: string;
      /** 非空 = 本机浏览器此刻可用：调用方应当**当场**用它跑，而不是排队（本机优先于插件） */
      local?: { cdpUrl: string };
      /** 排队时谁会来领：只影响回执措辞（「已排给插件」vs「已排给你的桌面客户端」） */
      executors?: 'plugin' | 'desktop' | 'both';
      /** 派是派了，但回执里要顺带提醒用户的一句（如公众号后台要先在插件设置里授权，服务端不知道授没授） */
      note?: string;
    }
  | { ok: false; error: string; summary: string };

export type VetArgs = {
  kind: string;
  competitorId?: string;
  platform?: string;
  url?: string;
  limit?: number;
};

export type VetOpts = {
  /** 调用方当前选中的账号。collect_self_profile 时同平台的话优先记在它名下 */
  preferAccountId?: string | null;
  /** 用户/模型点名的账号：id、handle 或名字（精确匹配）。同平台多个账号时靠它定 */
  accountRef?: string;
  /** 本机浏览器的调试端点（已过 vetCdpUrl）。SaaS 永远是 null——那里够不到用户的浏览器 */
  localCdpUrl?: string | null;
};

/** 排队时谁会来领（只影响回执措辞）。两处 ok 返回都要带上，漏一处回执就又叫回「插件」。 */
async function queuedExecutors(workspaceId: string): Promise<'plugin' | 'desktop' | 'both'> {
  const agents = await collectorAgents(workspaceId);
  return agents.has('desktop') && agents.has('plugin') ? 'both' : agents.has('desktop') ? 'desktop' : 'plugin';
}

/** 排队时谁会来领**这种活**（2026-09-16）：旧客户端只自报最初三种，回执不能把它说成会进后台。 */
async function queuedExecutorsFor(workspaceId: string, kind: string): Promise<'plugin' | 'desktop' | 'both'> {
  const agents = await collectorAgentsFor(workspaceId, kind);
  return agents.has('desktop') && agents.has('plugin') ? 'both' : agents.has('desktop') ? 'desktop' : 'plugin';
}

const clampLimit = (n: number | undefined) => Math.min(50, Math.max(1, Math.round(n || 20)));

/** 公众号后台是插件里的可选模块，且服务端不知道用户授没授权——派之前只能把这句预先说清（桌面客户端那条路不用授权） */
const WECHAT_BACKEND_NOTE = '公众号后台是插件里的可选模块：走插件的话用户要先在插件设置里对 mp.weixin.qq.com 授权，没授权插件会直接拒绝这条活（不重试）；走桌面客户端/本机浏览器不用授权，但要在采集浏览器里登录过公众号后台。';
/** 配方平台的回执提醒：第一次要先学规则；插件那条路要先授权站点 */
const recipeNote = (name: string) =>
  `${name}靠采集配方采：第一次打开会先把脱敏的页面结构交给模型学规则，学会后再采才有数据（学习那次会当场让模型直读页面兜底）；走插件的话用户要先在插件侧边栏对 ${name} 授权过一次，桌面客户端/本机浏览器不用授权。`;

export async function vetBrowserTaskArgs(workspaceId: string, args: VetArgs, opts: VetOpts = {}): Promise<VetVerdict> {
  // 内部 kind 也收：对外路由把 BROWSER_TASK_KINDS 整张表放行，调用方直接写 collect_self_backend /
  // collect_competitor_recipe 时，按同一条平台映射走，不另开一份闸（闸只有一份，同一课）
  const kind = args.kind === 'collect_self_backend'
    ? 'collect_self_profile'
    : args.kind === 'collect_competitor_recipe'
      ? 'collect_competitor'
      : args.kind;

  // 没装插件就别排：那条活会一直 pending 到 48 小时后过期，而调用方已经说过「已排给插件」，
  // 用户等两天什么都没发生也没人告诉他为什么。当场说清、并指路，比排一个没人领的活有用。
  // 【退路】整机版/桌面端配了本机浏览器时，改由它当场去采——用户的原话是
  // 「如果没有安装插件，客户端应该自己操作电脑的浏览器，自行去采集」。
  // 【本机优先，不是退路】（2026-09-03 改）原先本机浏览器只在「没装插件」时才走，结果装了插件的
  // 用户派「采我的 X」得到的是「已排给插件，等它下次醒来」——而他的 Chrome 就在眼前开着。
  // 排队的语义是「以后」，本机的语义是「现在」；两条都能走时没有理由选「以后」。
  // 调用方只在端点**此刻活着**时才传 localCdpUrl（localBrowserState），配了但没开着的照旧排队。
  const caps = await collectorKinds(workspaceId);
  const hasPlugin = caps.size > 0;
  const OLD_PLUGIN = (label: string) => `你装的采集插件版本旧了，还不会做「${label}」。到「采集助手」页更新插件（zip 装的重新加载一次即可），或者在桌面客户端顶部那条「允许这台客户端操作浏览器采集？」点「允许」（不装插件也能采）；整机版也可以直接用本机浏览器。`;
  // 创作者后台 / 配方采集：插件、桌面客户端、本机浏览器三条路都会做（2026-09-16），但都要 1.2.19 或更新的版本。
  // 在线的执行器里没有一个会做时，两条路都指——用户用哪个就更新哪个。
  const NEED_NEW_EXECUTOR = (label: string, extra = '') =>
    `「${label}」要 1.2.19 或更新的插件 / 桌面客户端（整机版可直接用本机浏览器）。`
    + `${hasPlugin ? '你现在在线的执行器里没有会做这件事的——' : '这个工作区还没有在线的采集执行器——'}`
    + `到「采集助手」页安装或更新插件（zip 装的重新加载一次即可），或把桌面客户端升到 1.2.19 并在它顶部那条「允许这台客户端操作浏览器采集？」点「允许」。${extra}`;
  let local: { cdpUrl: string } | undefined = opts.localCdpUrl ? { cdpUrl: opts.localCdpUrl } : undefined;
  if (!local && !hasPlugin) {
    return {
      ok: false,
      error: '这个工作区还没有装采集插件（没有可用的采集令牌），派下去也没有浏览器会执行。用桌面客户端的话，在它顶部那条「允许这台客户端操作浏览器采集？」点「允许」，不装插件也能采；网页版则到「采集助手」页装插件并填入采集令牌；整机版可在「设置 → 本机权限」开启「浏览器操作」（用本机浏览器采）。',
      summary: '还没装采集插件',
    };
  }

  // 「让浏览器去读一个网页」是唯一一个由服务端指定 URL 的动作，所以多两道闸：
  // ① 工作区必须显式打开过这个开关（**默认关**）；② URL 必须在白名单里。
  // 插件端另有一份硬编码的同款清单——那份才是真正的防线，这里只是早失败早说清楚。
  // 本机浏览器那条路也过这两道：读哪一页仍然是服务端/模型说了算，风险一样。
  if (kind === 'open_and_read') {
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { browserReadEnabled: true },
    });
    if (!ws?.browserReadEnabled) {
      return {
        ok: false,
        error: '这个团队还没有打开「让插件替我读网页」这个开关（默认是关的）。要用的话去「采集助手」页打开它。',
        summary: '读网页的开关没开',
      };
    }
    const url = args.url ?? '';
    if (!isReadAllowed(url)) {
      return {
        ok: false,
        error: `这个网址不在允许打开的站点清单里（只允许：${readAllowlistLabels().join('、')}）。别的网址用 clip_url 让服务端直接抓。`,
        summary: '网址不在白名单里',
      };
    }
  }

  if (!local && (kind === 'collect_competitor' || kind === 'open_and_read') && !caps.has(kind)) {
    return { ok: false, error: OLD_PLUGIN(kind === 'collect_competitor' ? '采竞对主页' : '读网页'), summary: '插件太旧' };
  }

  // 竞对必须已经在订阅列表里：不校验的话调用方可以拿一个任意 id 让插件去访问
  if (kind === 'collect_competitor') {
    const watched = await prisma.watchlistItem.findFirst({
      where: { workspaceId, competitorId: args.competitorId ?? '' },
      select: { id: true },
    });
    if (!watched) {
      return { ok: false, error: '这个竞对不在你的监控列表里，先用 add_competitor 加进来', summary: '竞对未订阅' };
    }
    // 【拼不出主页地址就别派】2026-09-04 审计查出：公众号/微博/快手/知乎/头条/百家号/视频号
    // 这些平台 competitorHomeUrl 返回 null，但这里照样放行。任务派下去后 executorTarget 也是 null，
    // 客户端每次都白拉起一次采集浏览器、报「这条任务没带目标地址（服务端太旧？）」，
    // 重试三次判死，通知里写「常见原因是目标平台没登录」——三条理由没有一条是真的。
    const comp = await prisma.competitorAccount.findUnique({
      where: { id: args.competitorId ?? '' },
      select: { platform: true, handle: true },
    });
    // 【配方平台：能力闸在主页地址闸之前】微博/快手/知乎/头条/百家号没有手写解析器，插件靠服务端学出的
    // 配方采（RECIPE_PLATFORMS 注释）。插件太旧时该说的是「更新插件并授权站点」，而不是「这个平台没有主页」；
    // 两道闸都没过时前一句才是用户能动手的那句。
    const recipe = comp ? competitorKindFor(comp.platform) === 'collect_competitor_recipe' : false;
    if (recipe && !local && !caps.has('collect_competitor_recipe')) {
      const name = platformName(comp!.platform) || comp!.platform;
      return {
        ok: false,
        error: NEED_NEW_EXECUTOR(
          `按配方采集${name}竞对`,
          `${RECIPE_PLATFORMS.map((p) => platformName(p) || p).join('/')}这些平台没有手写解析器，靠服务端学出的采集配方去采；走插件的话更新之后还要在插件侧边栏对 ${name} 这个站点授权一次（插件对这些站点是按需单站点授权），桌面客户端不用。`,
        ),
        summary: '执行器太旧',
      };
    }
    if (!comp || !competitorHomeUrl(comp.platform, comp.handle)) {
      const name = comp ? (platformName(comp.platform) || comp.platform) : '这个平台';
      return {
        ok: false,
        error: `${name}没有可以直接打开的公开主页地址，采集器打不开它，所以这个活派不出去。`
          + `${name}的竞对数据要走服务端数据源或手动导入（对标账号页有导入入口），不是浏览器采集这条路。`,
        summary: '这个平台没有可采的公开主页',
      };
    }
    if (recipe) {
      const name = platformName(comp!.platform) || comp!.platform;
      const payload = { kind: 'collect_competitor_recipe', competitorId: args.competitorId ?? '', limit: clampLimit(args.limit) };
      if (local) return { ok: true, payload, local, note: recipeNote(name) };
      return { ok: true, payload, executors: await queuedExecutorsFor(workspaceId, 'collect_competitor_recipe'), note: recipeNote(name) };
    }
  }

  // ── 回填自己的数据：把「我的 X 账号」落到具体的账号与 handle ──
  if (kind === 'collect_self_profile') {
    const platform = (args.platform ?? '').trim();
    const target = selfCollectKindFor(platform);
    if (!target) {
      const profiles = SELF_PROFILE_PLATFORMS.map((p) => platformName(p) || p).join('/');
      const backends = SELF_BACKEND_PLATFORMS.map((p) => platformName(p) || p).join('/');
      const recipes = RECIPE_PLATFORMS.map((p) => platformName(p) || p).join('/');
      return {
        ok: false,
        error: `「回填自己的数据」能派的平台：${backends}（创作者后台）、${profiles}（自己的公开主页）、${recipes}（按配方采自己的主页）。`
          + `${platform ? `${platformName(platform) || platform}` : '这个平台'}不在其中，没有服务端能派的自有回填路，如实告诉用户。`,
        summary: '这个平台没有可派的自有回填路',
      };
    }
    const pname = platformName(platform) || platform;

    if (target === 'collect_self_backend') {
      // 【创作者后台：三条路都会做（2026-09-16）】本机就绪当场进；否则派给自报会做 collect_self_backend 的执行器
      // （新插件 / 新桌面客户端）；抖音/小红书/B站没有会进后台的执行器时退到公开主页；视频号/公众号没有主页可退。
      const wechatNote = platform === 'wechat' ? WECHAT_BACKEND_NOTE : '';
      // handle 不是硬条件：后台页认的是登录态，页面自己会说出这是哪个号；没填 handle 的账号照样能回填
      const picked = await resolveSelfAccount(workspaceId, platform, { ...opts, requireHandle: false });
      if (!picked.ok) return { ok: false, error: picked.error, summary: picked.summary };
      const payload = { kind: 'collect_self_backend', platform, accountId: picked.account.id };
      if (local) return { ok: true, payload, accountId: picked.account.id, local, ...(wechatNote ? { note: wechatNote } : {}) };
      if (caps.has('collect_self_backend')) {
        return {
          ok: true,
          payload,
          accountId: picked.account.id,
          executors: await queuedExecutorsFor(workspaceId, 'collect_self_backend'),
          ...(wechatNote ? { note: wechatNote } : {}),
        };
      }
      // 退路：公开主页（只有公开数字）。要 handle——没填的话退不了，回到「更新执行器」那句
      if (selfProfileFallbackFor(platform) && caps.has('collect_self_profile') && picked.account.handle) {
        return {
          ok: true,
          payload: { kind: 'collect_self_profile', platform, accountId: picked.account.id, handle: picked.account.handle },
          accountId: picked.account.id,
          executors: await queuedExecutorsFor(workspaceId, 'collect_self_profile'),
          note: `你在线的执行器版本旧，进不了${pname}创作者后台，这次改采${pname}的公开主页——只有播放/点赞/评论这类公开数字，没有完播率、流量来源；把插件或桌面客户端升到 1.2.19 之后会自动走后台。`,
        };
      }
      return { ok: false, error: NEED_NEW_EXECUTOR(`回填${pname}创作者后台`, wechatNote), summary: '执行器太旧' };
    }

    if (target === 'collect_self_recipe') {
      // 配方平台的自己主页：与竞对同一份配方，只是落进自有作品。要 handle 拼主页地址
      const picked = await resolveSelfAccount(workspaceId, platform, opts);
      if (!picked.ok) return { ok: false, error: picked.error, summary: picked.summary };
      const payload = { kind: 'collect_self_recipe', platform, accountId: picked.account.id, handle: picked.account.handle };
      if (local) return { ok: true, payload, accountId: picked.account.id, local, note: recipeNote(pname) };
      if (!caps.has('collect_self_recipe')) {
        return { ok: false, error: NEED_NEW_EXECUTOR(`按配方回填${pname}主页`, `走插件的话还要先在插件侧边栏对 ${pname} 授权一次。`), summary: '执行器太旧' };
      }
      return { ok: true, payload, accountId: picked.account.id, executors: await queuedExecutorsFor(workspaceId, 'collect_self_recipe'), note: recipeNote(pname) };
    }

    if (!local && !caps.has('collect_self_profile')) {
      return { ok: false, error: OLD_PLUGIN('回填自己的主页'), summary: '插件太旧' };
    }
    const picked = await resolveSelfAccount(workspaceId, platform, opts);
    if (!picked.ok) return { ok: false, error: picked.error, summary: picked.summary };
    return {
      ok: true,
      payload: { kind: 'collect_self_profile', platform, accountId: picked.account.id, handle: picked.account.handle },
      accountId: picked.account.id,
      ...(local ? { local } : { executors: await queuedExecutorsFor(workspaceId, 'collect_self_profile') }),
    };
  }

  const payload =
    kind === 'collect_competitor'
      ? { kind, competitorId: args.competitorId ?? '', limit: clampLimit(args.limit) }
      : kind === 'open_and_read'
        ? { kind, url: args.url ?? '', mode: 'article' as const }
        : { kind, platform: args.platform ?? '' };

  if (local) return { ok: true, payload, local };
  return { ok: true, payload, executors: await queuedExecutors(workspaceId) };
}

export type ResolvedSelfAccount =
  | { ok: true; account: { id: string; name: string; platform: string; handle: string } }
  | { ok: false; error: string; summary: string };

/**
 * 「我的 X 账号」是工作区里哪一条。
 *
 * 顺序：点名的（id / handle / 名字精确匹配）> 当前选中的账号（同平台才算）> 该平台唯一的一个。
 * 同平台有多个又没点名时**不猜**（多账号不替用户猜，同一课），把候选连名字一起列出来——
 * 但这句是给模型看的：系统提示里已经把账号清单给了它，它该自己点名，而不是回头问用户。
 * 没填 handle 的账号如实说「去账号页填 handle」：主页地址只能由 handle 拼出来——
 * 但那是主页类回填的事；创作者后台回填传 `requireHandle: false`（后台页认登录态，不靠 handle 拼地址），
 * 没 handle 就带空串回去，别拦。
 */
export async function resolveSelfAccount(
  workspaceId: string,
  platform: string,
  opts: Pick<VetOpts, 'preferAccountId' | 'accountRef'> & { requireHandle?: boolean } = {},
): Promise<ResolvedSelfAccount> {
  const rows = await prisma.creatorAccount.findMany({
    where: { workspaceId, platform, status: 'active' },
    select: { id: true, name: true, platform: true, handle: true },
    orderBy: { createdAt: 'asc' },
  });
  const pname = platformName(platform) || platform;
  if (rows.length === 0) {
    return {
      ok: false,
      // 这句是给模型看的：它自己就有 add_account，别再把用户支到页面上去（2026-09-09 真机：模型照抄了这句去回用户）
      error: `工作区里还没有 ${pname} 账号。直接用 add_account 工具加一条（platform=${platform}，handle=主页 ID），加好再派回填；用户也可以到「账号」页手动加。`,
      summary: `没有 ${pname} 账号`,
    };
  }

  const ref = (opts.accountRef ?? '').trim();
  let chosen: (typeof rows)[number] | undefined;
  if (ref) {
    const norm = (h: string | null | undefined) => String(h ?? '').replace(/^@/, '');
    const hits = rows.filter((r) => r.id === ref || r.name === ref || norm(r.handle) === norm(ref));
    if (hits.length === 1) chosen = hits[0];
    else if (hits.length > 1) {
      return { ok: false, error: `「${ref}」对上了 ${hits.length} 个 ${pname} 账号，用 id 点名：${hits.map((h) => `${h.name}（id: ${h.id}）`).join('；')}`, summary: '账号指代不唯一' };
    } else {
      return { ok: false, error: `${pname} 账号里没有叫「${ref}」的（按 id / handle / 名字精确匹配）。现有：${rows.map((r) => `${r.name}（id: ${r.id}）`).join('；')}`, summary: '没有这个账号' };
    }
  } else if (opts.preferAccountId && rows.some((r) => r.id === opts.preferAccountId)) {
    chosen = rows.find((r) => r.id === opts.preferAccountId);
  } else if (rows.length === 1) {
    chosen = rows[0];
  } else {
    return {
      ok: false,
      error: `工作区里有 ${rows.length} 个 ${pname} 账号，用 account 参数点名一个：${rows.map((r) => `${r.name}（id: ${r.id}${r.handle ? `，@${r.handle.replace(/^@/, '')}` : ''}）`).join('；')}`,
      summary: '同平台多个账号，要点名',
    };
  }

  const handle = (chosen!.handle ?? '').trim().replace(/^@/, '');
  if (!handle && opts.requireHandle !== false) {
    return {
      ok: false,
      error: `${pname} 账号「${chosen!.name}」还没填主页 handle，拼不出主页地址。到「账号」页给它填上（X 就是 @ 后面那串），再来派回填。`,
      summary: '账号没填 handle',
    };
  }
  return { ok: true, account: { id: chosen!.id, name: chosen!.name, platform: chosen!.platform, handle } };
}

/**
 * 把外部调用方给的「竞对指代」换成监控列表里的 competitorId。
 *
 * MCP 客户端（另一个模型）手里通常没有内部 id，只有「学习博主小王」这样的名字或
 * 主页 handle。规矩照旧两条：
 * - **精确匹配，不做模糊/大小写归一**——handle 是不透明 ID，转小写撞过 YouTube 的坑；
 * - **多个同名不替调用方猜**（多账号不替用户猜同一课），把候选列出来让它带上 id 重来。
 */
export async function resolveCompetitorRef(
  workspaceId: string,
  ref: string,
): Promise<{ ok: true; competitorId: string } | { ok: false; error: string }> {
  const wanted = ref.trim();
  if (!wanted) return { ok: false, error: '要说清楚采哪个竞对（competitor：监控列表里的 id、主页 handle 或名字）' };

  const items = await prisma.watchlistItem.findMany({
    where: { workspaceId },
    select: { competitorId: true, competitor: { select: { platform: true, handle: true, name: true } } },
  });

  if (items.some((i) => i.competitorId === wanted)) return { ok: true, competitorId: wanted };

  const matches = items.filter((i) => i.competitor.handle === wanted || i.competitor.name === wanted);
  if (matches.length === 1) return { ok: true, competitorId: matches[0].competitorId };
  if (matches.length > 1) {
    const list = matches
      .slice(0, 5)
      .map((m) => `${platformName(m.competitor.platform) || m.competitor.platform} 的 ${m.competitor.name}（id: ${m.competitorId}）`)
      .join('；');
    return { ok: false, error: `「${wanted}」在监控列表里有 ${matches.length} 个：${list}。带上 id 再来一次。` };
  }
  return {
    ok: false,
    error: `监控列表里没有「${wanted}」（按 id / 主页 handle / 名字精确匹配）。先在烽火台「竞对监控」里订阅它。`,
  };
}
