import type { NavGroup } from '@/lib/nav';
import { AGENT_ROLES } from '@/lib/agent/roles';

// ── 两种外壳：同一套功能，两种进入方式 ─────────────────────────────────────
//
// 【为什么并存而不是二选一】这两种布局服务的是**同一个人的两种状态**：
//   · 工作台（workbench）＝ 现有布局。我知道自己要干什么，直奔那个板块。
//     侧栏逐个列出，一下到位（用户 2026-08-19 拍板的效果，别回退）。
//   · 任务台（taskdeck）＝ 我只想说一句话让它干活，剩下的别烦我。
//     侧栏只留「发起 / 复用 / 回看」三件事，主区留给任务本身。
//
// 【硬规矩：路径一个都不改】任务台不新建任何路由，它指的全是工作台里已有的页面。
// 换壳不是搬家——机器人推送、使用帮助、插件、用户书签指的地址全部照旧，
// 两种模式下深链、后退、书签的行为完全一致。新建 /agents /plugins 这类
// 「任务台专属页」会立刻制造第二套真相源，也会被 nav-layout 的孤儿页用例判红。
//
// 【这个文件不许 import 'next/headers'】它被**客户端组件** ShellSwitch 引用
//（要拿 SHELL_COOKIE 和 SHELL_LABEL）。一旦顶部出现 next/headers，客户端打包就直接
// 编译失败——tsc 一声不吭，只有真机打开页面才会看到 Build Error。
// 读 cookie 的那半边在 lib/shell-server.ts，两边各自只被该用它的那一侧引用。
//
// 【任务台确实少了很多入口，为什么不算「藏功能」】
// 「藏」的定义是**用户不知情**（插件竖条那次栽的就是这个）。这里三条都不成立：
//   ① 模式是用户自己选的，不是默认；② 切换器常驻顶栏，一键切回；
//   ③ 任务台侧栏底部写明「切回工作台看全部板块」。
// 这是刻意的取舍，不是遗漏——但正因如此，**默认必须是 workbench**。

export type ShellMode = 'workbench' | 'taskdeck';

export const SHELL_COOKIE = 'beacon_shell';
export const DEFAULT_SHELL: ShellMode = 'workbench';

export function isShellMode(v: string | undefined): v is ShellMode {
  return v === 'workbench' || v === 'taskdeck';
}

export const SHELL_LABEL: Record<ShellMode, string> = {
  workbench: '工作台',
  taskdeck: '任务台',
};

// 切换器上的悬停说明。**两种模式功能完全对等**，所以这两句话说的必须是「按什么排」，
// 不是「有什么功能」。旧文案写的是「一句话派活，功能收进智能体与技能」——那是上一版
// 「任务台只留 9 个入口」时的实话，现在留着就成了一句劝退用户的谎话。
// 【2026-08-21 补上首页形态】任务台的首页第一眼改成了派活输入框（工作台仍是今日概览）。
// 这是两种外壳之间**用户一眼就能看到的最大差别**，切换器上却只字不提，就成了
// 「文案与实际行为对不上」的又一例：用户切过去发现首页整个变了，而没人预告过。
// 路由级功能仍然完全对等（守卫照旧钉着），差的只是首页怎么排。
export const SHELL_HINT: Record<ShellMode, string> = {
  workbench: '按做内容的阶段排：看情报 → 定选题 → 做内容 → 看效果，首页是今日概览',
  taskdeck: '按「你要什么」排：首页第一眼就是派活输入框，找料 / 做一条 / 看结果点开即得',
};

// ── 任务台的侧栏 ───────────────────────────────────────────────────────────
//
// 【2026-08-20 推翻了上一版最重要的一条取舍】上一版任务台只列 9 个入口，热点、竞对、
// 内容资讯库、选题、工坊、数据…… 全都不在侧栏里，理由写的是「模式是用户自选的，
// 顶栏能一键切回工作台，所以不算藏」。用户当场否掉：**换个壳不该少一半功能**。
// 那条理由的错误在于——用户选的是「我喜欢这种排法」，不是「我愿意放弃一半板块」，
// 而「想用某个板块就得先切回另一种布局」本身就是这个模式不成立的证据。
//
// 【现在两种模式功能完全对等，差的只是「按什么排」】
//   · 工作台：按**阶段**排（我在做内容的哪一步），名字是板块名。
//   · 任务台：按**我要什么**排（发起 / 复用 / 找料 / 做一条 / 看结果 / 装备），
//     名字是动词短语，点进去是哪一页写在 hint 里。
// 覆盖是硬要求：`tests/shell-modes.test.ts` 逐条核对 NAV 里的每个 href 都在这儿出现，
// 少一个就红。**加新板块时两张表要一起加**。
//
// 【极简感靠折叠，不靠删】天天用的两组（干活 / 班底）默认展开，其余默认收起——
// 分组标题始终可见、点一下就开、进到组里的页面自动展开（NavList 已有这套机制）。
// 「藏」的定义是**用户不知情**；标题在眼前、一下点得开，不是藏。
//
// 【href 全部来自 NAV】用例逐条核对，指到不存在的页面会红。锚点不算新路由
//（同一页同一份数据，只是落到具体那张卡片上），但那个 id 必须真的存在。
// ── 任务台侧栏：刻意**不照搬**工作台的阶段结构 ──────────────────────────────
//
// 2026-08-25 重排。此前 TASK_NAV 是工作台 NAV 的**换名版**：同样 7 组、同样一批页面，
// 只是把「看情报/定选题/做内容/看效果」改叫「找料/做一条/看结果」。用户的原话是
// 「太多了，又跟工作台很类似」——一针见血：换个壳不该是把同一套阶段导航重贴一遍标签。
//
// 工作台的模型是「按做事阶段浏览工具」（每个阶段一组，逐个板块摊开）。
// 任务台的灵魂是「说一句话让它做 + 打开就看今天做什么」——**工具是兜底，不是主导航**。
// 所以这里收成四组：
//   · 干活（展开）  —— 今天该做什么 / 说一句话派活 / 看它做到哪了。这就是任务台的全部日常。
//   · 班底（展开）  —— 能重复用的干活单位（智能体/技能/能力）。
//   · 更多工具（折叠）—— 找料/挑题/写/查/发/看结果/接插件，**全塞进一个抽屉**，要用具体工具才翻开。
//   · 设置（折叠）  —— 装一次不再动的。
//
// 所有工作台页面仍然**一个不少地可达**（tests/shell-modes.test.ts 的对等守卫钉死），
// 只是从「7 个阶段组」收成「一个工具抽屉」。折叠数从 5 降到 2——那条守卫也一起改了
// （极简感靠折叠这条没变，只是折叠得更狠）。
export const TASK_NAV: NavGroup[] = [
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
      { href: '/members', label: '成员与权限', icon: 'users' },
      { href: '/billing', label: '套餐与计费', icon: 'sparkles', requires: 'payment' },
      { href: '/settings/account', label: '账号与安全', icon: 'shield' },
      { href: '/help', label: '使用帮助', icon: 'help' },
      { href: '/feedback', label: '问题反馈', icon: 'chat' },
    ],
  },
];

