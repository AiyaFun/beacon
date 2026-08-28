import type { IconName } from '@/components/icons';
import { can, type Capability } from '@/lib/edition';
import { AGENT_ROLES } from '@/lib/agent/roles';

// ── 信息架构：侧栏就是这个产品的说明书 ──────────────────────────────────────
//
// 【分组按「工作流阶段」，不按「功能类型」】用户不是来找「一个工具」的，他是来走一遍
// 「看情报 → 定选题 → 做内容 → 看效果」这条环的。按阶段分组，侧栏从上到下读下来
// 就是一遍工作流；按类型分组（原来的「情报/选题/创作/资产/工具」）会让同一个阶段的
// 东西散在三处——2026-08-19 重排前的真实状态：
//   · 「工具」组塞了 11 项，从装插件到套餐计费到使用帮助，是个杂物抽屉；
//   · 复盘要看的三样（数据看板 / 爆款基因 / 平台算法教练）分在「资产」和「情报」两组；
//   · 剪藏进来的外部内容（内容资讯库）挂在「选题」组，但它是**情报输入**，不是选题动作。
//
// 【两处都要能找到一个板块】
// 侧栏 = 全站地图：分组 + 逐个板块列出，天天用的入口**一下到位**（用户 2026-08-19 拍板沿用这个效果）。
// 页面顶部 = 阶段页签（components/StageTabs.tsx）：你正在这一段里，还有哪些板块、下一段去哪儿。
// 两者服务不同的问题，不是同一份东西印两遍。
//
// 【三条硬规矩】
//   ① 一个阶段一组，组内 2–4 项（设置与支持是低频例外）。超了说明混进了别的阶段的东西。
//   ② **不许把板块藏起来**。藏 = 用户认为没这功能（插件竖条那次栽过）。
//      收进阶段页签不算藏：进到这个阶段，它的板块**全部**列在页面顶部，一眼数得清。
//   ③ **路径不改**。机器人推送、使用帮助、文档、插件、用户书签全都指着现在这些地址；
//      重排是把入口摆好，不是搬家。页签之间是真路由跳转，深链、后退、书签全都照旧。
export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  badge?: string;
  /**
   * 悬停提示。给「侧栏这一行的名字」与「点进去那一页的标题」不一致的入口用——
   * 任务台把 /settings 叫「定时任务」、把 /workflows 叫「智能体」，
   * 不写清楚的话用户点进去会以为点错了。工作台的 NAV 用不上它（那边两者本来就同名）。
   */
  hint?: string;
  /** 需要某项能力才显示。缺省=所有形态都显示。 */
  requires?: Capability;
  /**
   * 这一个入口在**页内**还覆盖了哪些 NAV 板块——首页本体就是那份报告、
   * 页顶标签一键切到那一页。对等守卫（tests/shell-modes.test.ts）据此放行：
   * 「板块到得了」才是要求，「侧栏必须单列一条」不是。
   *
   * 2026-08-26 加它的理由：任务台首页本体就是本周作战报告、技能页顶标签直通智能体，
   * 侧栏再单列「本周作战」「智能体」就是同一个东西列两遍——用户原话
   * 「导航栏里面很多都跟点进去内容都重复了」。删条目又会撞对等守卫，
   * 于是把「覆盖关系」显式写出来，而不是把守卫改松。
   */
  covers?: string[];
};
export type NavGroup = {
  /** 空串 = 不渲染分组标题（扁平一列，Doubao 式）。折叠组必须有标题——它就是点击目标 */
  title: string;
  /** 分组图标（阶段页签那一排用；侧栏按分组标题分块，不显示它） */
  icon: IconName;
  items: NavItem[];
  /** 一句话说明这一组是干什么的：阶段页签下面那行要用 */
  purpose: string;
  /** 侧栏里默认收起（只给低频的「设置与支持」用；标题始终可见，进到组内页面自动展开） */
  collapsed?: boolean;
  /**
   * 钉在侧栏**最底部**（在「最近」列表之下、账号区之上）。
   * 2026-08-26 用户要求「把设置也往下放」——设置是装一次就不动的东西，
   * 不该跟每天要点的板块抢上半屏。
   */
  pinBottom?: boolean;
};

// ── 2026-08-26 单壳化：工作台已删（用户拍板），这份就是唯一导航 ────────────────
// 历史：曾有 workbench（按阶段排）/ taskdeck（按「我要什么」排）两套壳、两张表、
// 一套对等守卫。多轮页面合并后两张表内容几乎重合，用户点破「好像都一样」并拍板删工作台。
// TASK_NAV 在 lib/shell.ts 里 re-export 指回这份——存量 import 不用改。
export const NAV: NavGroup[] = [
  {
    // 2026-08-26 扁平化（用户原话「把干活去掉，更多工具去掉」「导航栏里面很多都跟点进去内容都重复了」）：
    // 主入口不再套分组标题（title: '' → 不渲染组头），照 Doubao 工作那样一列到底。
    //
    // 【删掉的三条都是「同一个东西列两遍」】
    //   · 本周作战 /battle —— 任务台首页本体**就是**这份报告（page.tsx 的 taskdeck 分支）；
    //   · 智能体 /workflows —— 技能·连接器页顶标签一键就到（components/RoleTabs.tsx）；
    //   · 能力 /extension#abilities —— 同上，且 /extension 本身在「设置·采集插件」里。
    // 删条目会撞对等守卫（NAV 每个板块任务台都要到得了），所以改用 covers 把
    // 「页内覆盖了谁」显式写出来——要求是**板块到得了**，不是「侧栏必须单列一条」。
    title: '',
    icon: 'chat',
    purpose: '每天就这四件事：看今天做什么、说一句话派活、管好班底、回看跑过的',
    items: [
      { href: '/', label: '今天', icon: 'home', hint: '本周作战报告 · 今天该做什么，每条后面就是起稿入口', covers: ['/battle'] },
      { href: '/assistant', label: '新任务', icon: 'chat', hint: 'AI 助手 · 说一句话让它去做' },
      // 「班底」→「技能 · 连接器」（用户指定）：与 Doubao「技能·连接器·伙伴」同一说法。
      // 页顶 RoleTabs 切技能/智能体/能力，所以它 covers 掉 /workflows。
      { href: '/skills', label: '技能 · 连接器', icon: 'sparkles', hint: `${AGENT_ROLES.skill.name} / ${AGENT_ROLES.agent.name} / ${AGENT_ROLES.ability.name} · 能重复用的干活单位，页顶标签互切；定时任务也在这里`, covers: ['/workflows'] },
      { href: '/runs', label: '任务记录', icon: 'clock', hint: '运行中心 · 所有跑过和在等你处理的' },
    ],
  },
  {
    // 内容板块：这些是**真页面**（写稿、看数据），不是技能，收在一个抽屉里按做事顺序排。
    // 名字从「更多工具」改成「内容板块」——它们就是这个产品的板块，不是"工具箱杂物"。
    title: '内容板块',
    icon: 'archive',
    purpose: '找料 → 挑题 → 写 → 查 → 发 → 看结果，按做事顺序排',
    collapsed: true,
    items: [
      // 2026-08-26 情报三合一：三条收成一条，页顶标签互切（components/IntelTabs.tsx）
      { href: '/hotlists', label: '看情报', icon: 'radar', hint: '看热点 / 看同行 / 我存的资料 · 页顶标签互切', covers: ['/competitors', '/library'] },

      { href: '/topics', label: '挑选题', icon: 'bulb', hint: '选题引擎 · 候选与六维评分；灵感箱、找角度在页内标签' },
      // 2026-08-26 做内容四合一：四条收成一条，页顶标签互切（components/MakeTabs.tsx）
      { href: '/studio', label: '做内容', icon: 'pen', hint: '写稿 / 配图 / 查红线 / 发出去 · 页顶标签互切', covers: ['/images', '/compliance', '/publish'] },
      { href: '/data', label: '看效果', icon: 'chart', hint: '数据看板 / 爆款基因 / 平台算法教练 · 页内三标签' },
      { href: '/persona', label: '记忆与素材', icon: 'user', hint: '记忆与人设 / 我的素材 · 喂给 AI 的那部分，页顶标签互切', covers: ['/material'] },
    ],
  },
  {
    title: '设置',
    icon: 'settings',
    purpose: '装一次就不用再动的：接入、插件、推送、团队、账单、帮助',
    collapsed: true,
    pinBottom: true,
    items: [
      { href: '/settings/keys', label: '接入与密钥', icon: 'cpu' },
      { href: '/settings', label: '运行设置', icon: 'settings' },
      { href: '/notifications', label: '消息渠道', icon: 'chat', hint: '推送与机器人 · 推什么、什么时候推' },
      { href: '/extension', label: '采集插件', icon: 'download', hint: '采集助手 · 装到浏览器里的那个扩展' },
      { href: '/desktop', label: '桌面客户端', icon: 'download', hint: 'Mac / Windows 客户端 · 独立窗口、托盘常驻、开机自启' },
      { href: '/members', label: '成员与权限', icon: 'users' },
      { href: '/billing', label: '套餐与计费', icon: 'sparkles', requires: 'payment' },
      { href: '/settings/account', label: '账号与安全', icon: 'shield' },
      { href: '/help', label: '使用帮助', icon: 'help' },
      { href: '/feedback', label: '问题反馈', icon: 'chat' },
    ],
  },
];

/**
 * 按当前部署形态过滤出可见导航。
 *
 * 必须由**服务端**算好再传给侧栏 —— Sidebar 是客户端组件，读不到 process.env.BEACON_EDITION。
 * 想走 NEXT_PUBLIC_ 的话就出现了第二个形态真相源，而两个源迟早会不一致
 * （典型后果：客户机器上侧栏藏了入口，端点却还活着）。
 */
export function visibleNav(): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((it) => !it.requires || can(it.requires)) }))
    .filter((g) => g.items.length > 0);
}

/**
 * 当前路径应该点亮哪一条导航——**最长前缀胜出**，且只点亮一条。
 *
 * 为什么不能直接 `pathname.startsWith(item.href)`：`/settings` 与 `/settings/keys`
 * 同时在导航里，打开接入与密钥时两条会一起高亮，用户根本看不出自己在哪一页。
 * 这个函数是纯的，用例直接测它（tests/nav-layout.test.ts）。
 */
export function activeHref(nav: NavGroup[], pathname: string): string | null {
  let best: string | null = null;
  for (const g of nav) {
    for (const it of g.items) {
      const hit = it.href === '/' ? pathname === '/' : pathname === it.href || pathname.startsWith(it.href + '/');
      if (hit && (best === null || it.href.length > best.length)) best = it.href;
    }
  }
  return best;
}

/**
 * 这份导航「到得了的板块」全集 = 每个入口自身 + 它页内覆盖的（covers）。
 *
 * 各处守卫（对等/孤儿页/运行中心去哪儿/四类职能落地页）判「这个板块还找得到吗」
 * 必须统一走它，否则每加一次页内合并就得挨个放松一条守卫——那才是真的把网捅漏。
 * 判据仍然很硬：covers 是**声明**，声明了就得真做到（页顶标签真能切过去、首页真渲染那份报告）。
 */
export function reachableRoutes(nav: NavGroup[]): Set<string> {
  const out = new Set<string>();
  for (const g of nav) {
    for (const it of g.items) {
      out.add(it.href.split('#')[0]);
      for (const c of it.covers ?? []) out.add(c.split('#')[0]);
    }
  }
  return out;
}

/** 这一组里有没有当前页。 */
export function groupHasActive(group: NavGroup, pathname: string): boolean {
  return activeHref([group], pathname) !== null;
}

/** 当前页属于哪个阶段（不属于任何阶段就 null，比如装机向导 /setup）。 */
export function groupOf(nav: NavGroup[], pathname: string): NavGroup | null {
  return nav.find((g) => groupHasActive(g, pathname)) ?? null;
}

/**
 * 点侧栏那一行阶段落到哪一页 = 这个阶段的第一个**可见**板块。
 *
 * 不写死成常量：企业版会把「套餐与计费」过滤掉，写死的落地页可能正好是被过滤掉的那个，
 * 点进去撞 404 / 能力闸。
 */
export function stageHref(group: NavGroup): string {
  return group.items[0]?.href ?? '/';
}

// ── 「我要做某件事，该去哪儿」路标表（使用帮助页用）───────────────────────────
//
// 只写 what + href：**「组 → 项」那半句由 NAV 现算**（navPathLabel）。
// 此前帮助页里手写着「工具 → 下载采集助手」这种字符串，导航一改就成了指向不存在的分组，
// 而这种错不会红、也不会 404——用户照着找不到，只会以为功能没了。
/**
 * 被 covers 的页面的显示名。
 *
 * 【为什么需要这张小表】nextSteps() 的按钮字与 navPathLabel() 都从 NAV 取 label；
 * 页内合并后 /publish /compliance 等不再单列，但「写完 → 查红线 → 发出去」这条环的
 * 终点还指着它们——没有名字按钮就消失，最值钱的一条链路当场断掉。
 * 名字集中在这一张表（不散回各页），守卫钉住「每个被 covers 的 href 都有名字」。
 */
export const COVERED_PAGE_NAMES: Record<string, string> = {
  '/battle': '本周作战',
  '/competitors': '看同行',
  '/library': '我存的资料',
  '/workflows': '智能体',
  '/images': '配图',
  '/compliance': '查红线',
  '/publish': '发出去',
  '/material': '我的素材',
};

export type HelpRoute = { what: string; href: string };

export const HELP_ROUTES: HelpRoute[] = [
  { what: '装插件采公开数据', href: '/extension' },
  { what: '生成采集令牌', href: '/settings/keys' },
  { what: '配飞书机器人', href: '/notifications' },
  { what: '看有什么在跑 / 什么在等我处理', href: '/runs' },
  // 2026-08-19 这批新东西：不进这张表，用户在帮助页搜不到，等于功能不存在
  { what: '让一串步骤自己跑完（智能体 / 工作流模板）', href: '/skills' },
  { what: '让智能体每天定时自己跑', href: '/skills' },
  { what: '管 AI 能替我动哪些能力（关掉某项）', href: '/extension' },
  { what: '让 AI 直接替我做事（问一句 → 让它去做）', href: '/assistant' },
  { what: '找回一次停在「等你确认」的 AI 执行', href: '/runs' },
  { what: '让 AI 自己挑技能来改稿（不用手动进工坊）', href: '/skills' },
  { what: '看今天该做什么选题', href: '/topics' },
  { what: '存下刷到的灵感 / 从评论挖问题', href: '/topics' },
  { what: '给一条选题找差异化角度', href: '/topics' },
  { what: '自己起稿 / 粘一版旧稿来打磨', href: '/studio' },
  { what: '要几张图（不绑草稿、不上字）', href: '/images' },
  { what: '发之前查一遍平台红线', href: '/compliance' },
  { what: '写完了要发出去', href: '/publish' },
  { what: '看发出去之后跑得怎么样', href: '/data' },
  { what: '看效果：数据表现 / 什么跑得动 / 平台怎么想', href: '/data' },
  { what: '优化记忆 / 看学习建议', href: '/persona' },
  { what: '让 AI 写得像我自己写的', href: '/material' },
  { what: '问题反馈 / 意见交流', href: '/feedback' },
  { what: '查看隐私与数据安全声明', href: '/settings/account' },
];

/** 这个地址在侧栏的哪儿：「组 → 项」。找不到返回 null（用例会拦下这种情况）。 */
export function navPathLabel(href: string): string | null {
  for (const g of NAV) {
    const it = g.items.find((x) => x.href === href);
    if (it) return `${g.title} → ${it.label}`;
  }
  // 被 covers 的页不单列，但用户问「配图在哪」时答案是真实的三段路：
  // 「做内容 → 做内容 → 配图」读着重复，所以组名与入口同名时只印两段
  for (const g of NAV) {
    const it = g.items.find((x) => x.covers?.includes(href));
    if (it) {
      const leaf = COVERED_PAGE_NAMES[href] ?? href;
      const head = g.title === it.label ? it.label : `${g.title} → ${it.label}`;
      return `${head} → ${leaf}`;
    }
  }
  return null;
}

// ── 「这一步之后去哪儿」：把工作流链路显式接起来 ─────────────────────────────
//
// 【为什么要有】重排之前，页面之间基本是断的：数据看板不指向爆款基因（它俩就在一组里），
// 爆款基因看完不知道该拿它去哪儿用，算法教练给完建议也不接创作工坊。
// 侧栏解决的是「东西在哪」，这张表解决的是「做完这件事接着做什么」——
// 后者才是用户走完一整圈的原因。
//
// 只写 href + why：**按钮上的字从 NAV 取**（nextSteps），改了导航名字这里不会变成谎话。
export const NEXT_STEPS: Record<string, { href: string; why: string }[]> = {
  '/hotlists': [{ href: '/topics', why: '把在榜话题变成你自己的选题候选' }],
  '/competitors': [
    { href: '/topics', why: '同行跑起来的题，换个角度做成你的' },
    { href: '/data', why: '看这个平台今天吃什么（看效果页的「平台怎么想」标签）' },
  ],
  '/library': [{ href: '/topics', why: '存下来的资料拿去挑今天写什么' }],
  '/topics': [{ href: '/studio', why: '选定了就去起稿' }],
  // 人设是所有推荐的地基——建完/改完人设，下一步就是让推荐按新人设跑一轮
  '/persona': [{ href: '/topics', why: '人设变了，推荐会跟着变——去看今天该写哪条' }],
  '/studio': [
    { href: '/compliance', why: '发之前过一遍平台红线' },
    { href: '/publish', why: '写完了就排发布任务' },
  ],
  '/images': [{ href: '/studio', why: '图配好了回去接着写' }],
  '/compliance': [{ href: '/publish', why: '过了红线就去发' }],
  '/publish': [{ href: '/data', why: '贴上作品链接，数据才会自动回流' }],
  // 「看效果」三合一后，/data 页内已含基因/算法两个标签，next-step 不再指向自己，
  // 而是接下一步：按数据里跑得动的形状去挑下一条选题。
  '/data': [{ href: '/topics', why: '按数据里跑得动的形状去挑下一条选题' }],
};

export type NextStep = { href: string; label: string; why: string };

/** 这一页做完之后该去哪儿。按钮上的字取自 NAV，找不到的条目直接跳过（用例会拦）。 */
export function nextSteps(href: string): NextStep[] {
  return (NEXT_STEPS[href] ?? []).flatMap((s) => {
    for (const g of NAV) {
      const it = g.items.find((x) => x.href === s.href);
      if (it) return [{ href: s.href, label: it.label, why: s.why }];
    }
    // 被 covers 的页（/publish /compliance…）不单列但仍是合法去处——名字从补充表取。
    // 没有这一句，「写完 → 查红线 → 发出去」的按钮会在四合一后静默消失
    const covered = COVERED_PAGE_NAMES[s.href];
    if (covered) return [{ href: s.href, label: covered, why: s.why }];
    return [];
  });
}
