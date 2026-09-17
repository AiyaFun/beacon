// 系统提示里的「你的账号与插件」一段（2026-09-03）。
//
// 【为什么要有这一段】用户说「抓取我的 X 账号」，模型此前只拿得到人设卡，不知道工作区里
// 绑了哪些账号、handle 是什么、插件装没装——于是要么反问「主页链接给我」，要么摊手。
// 用户原话：「我们都有 X 账号的信息和插件的信息，应该要有所关联」。
// 关联就是把这两样直接摆到它眼前，并告诉它该调哪个工具、怎么填参数。
import { prisma } from '../db';
import { platformName } from '../constants';
import { hasCollector, collectorKinds, collectorAgents } from '../browser-task';
import { SELF_PROFILE_PLATFORMS, SELF_BACKEND_PLATFORMS, RECIPE_PLATFORMS } from '../browser-task/kinds';
import { localBrowserState, LOCAL_BROWSER_WAKE_HINT } from '../browser-task/local-run';
import { fmtDate } from '../format';

export type AccountsContext = {
  accounts: { id: string; name: string; platform: string; handle: string | null; current: boolean }[];
  plugin: { installed: boolean; lastSeenAt: Date | null; kinds?: string[] };
  /** 谁会来领活：浏览器插件、桌面客户端，还是两者都有（2026-09-04）。
   *  不告诉模型的话，它只看到「采集插件：没装」，于是编出「需要插件、等你下次打开浏览器」——
   *  而用户登记的正是桌面客户端，它每分钟领一次活。真机撞到过。 */
  executors?: ('plugin' | 'desktop')[];
  /** off=没开 / ready=此刻能用（采集任务直接当场跑）/ offline=开了但 Chrome 没带端口跑着 */
  localBrowser: 'off' | 'ready' | 'offline';
};

export async function loadAccountsContext(ctx: { workspaceId: string; accountId: string | null }): Promise<AccountsContext> {
  const [rows, installed, token, local, caps, agents] = await Promise.all([
    prisma.creatorAccount.findMany({
      where: { workspaceId: ctx.workspaceId, status: 'active' },
      select: { id: true, name: true, platform: true, handle: true },
      orderBy: { createdAt: 'asc' },
    }),
    hasCollector(ctx.workspaceId),
    prisma.ingestToken.findFirst({
      where: { workspaceId: ctx.workspaceId, revokedAt: null, lastUsedAt: { not: null } },
      orderBy: { lastUsedAt: 'desc' },
      select: { lastUsedAt: true },
    }),
    localBrowserState(ctx.workspaceId).catch(() => ({ state: 'off' as const })),
    collectorKinds(ctx.workspaceId).catch(() => new Set<string>()),
    collectorAgents(ctx.workspaceId),
  ]);
  return {
    accounts: rows.map((r) => ({ ...r, current: r.id === ctx.accountId })),
    plugin: { installed, lastSeenAt: token?.lastUsedAt ?? null, kinds: Array.from(caps) },
    executors: Array.from(agents),
    localBrowser: local.state,
  };
}

/** 渲染成给模型看的一段。纯函数，方便测。 */
export function renderAccountsContext(c: AccountsContext): string {
  const line = (a: AccountsContext['accounts'][number]) =>
    `${platformName(a.platform) || a.platform}「${a.name}」${a.handle ? `（handle：${a.handle.replace(/^@/, '')}）` : '（没填 handle）'}${a.current ? ' ← 当前' : ''}`;
  const acct = c.accounts.length
    ? c.accounts.map((a) => `- ${line(a)}`).join('\n')
    : '- （工作区里还没有账号）';
  // 在线执行器（插件 + 桌面客户端的并集）自报的能力里缺哪一项，就说破那一项做不了：模型据此在派之前就能如实
  // 告诉用户去更新，而不是派了被拒再回头解释。缺 collect_self_profile = 不会回填自己的主页；
  // 缺 collect_self_backend = 不会回填创作者后台；缺 collect_competitor_recipe = 不会按配方采（微博等五平台）。
  const missing = c.plugin.installed && c.plugin.kinds
    ? [
        ...(!c.plugin.kinds.includes('collect_self_profile') ? ['不会回填自己的主页'] : []),
        ...(!c.plugin.kinds.includes('collect_self_backend') ? ['不会回填创作者后台'] : []),
        ...(!c.plugin.kinds.includes('collect_competitor_recipe') ? ['不会按配方采微博/快手/知乎/头条号/百家号'] : []),
      ]
    : [];
  const oldPlugin = missing.length > 0;
  const hasDesktop = c.executors?.includes('desktop');
  const hasPluginAgent = c.executors?.includes('plugin');
  // 【必须说清「谁来领、等多久」】只写「采集插件：没装」的话，模型会自己编出
  // 「需要浏览器插件，等你下次打开浏览器」——而用户登记的是桌面客户端，它每分钟领一次活。
  // 2026-09-04 真机撞到：用户没插件、有客户端，模型照样让他去开浏览器等插件。
  // 版本旧了那句：三条路都会做后台/配方（2026-09-16），所以一律指路「更新插件或桌面客户端到 1.2.19」
  const oldNote = oldPlugin ? `；**在线的执行器版本旧了，${missing.join('、')}**（派了会被拒或退到公开主页；如实告诉用户把插件或桌面客户端升到 1.2.19——客户端升完在它顶部那条「允许这台客户端操作浏览器采集？」点「允许」；整机版可直接用本机浏览器）` : '';
  const plugin = hasDesktop && hasPluginAgent
    ? `桌面客户端（几秒内领走）与浏览器插件都在${oldNote}`
    : hasDesktop
      ? `**桌面客户端已登记为采集执行器**（几秒内领走，通常一两分钟内跑完；用户这里没有浏览器插件，别提插件、别让他去开浏览器）${oldNote}`
      : c.plugin.installed
        ? `浏览器插件已连接${c.plugin.lastSeenAt ? `（最近活跃 ${fmtDate(c.plugin.lastSeenAt)}）` : '（还没回传过数据）'}${oldNote}`
        : '没有任何采集执行器（既没装插件，也没把桌面客户端登记为执行器）——采集任务派不出去，如实告诉用户去登记，别说成「已排队等浏览器」';
  const local = c.localBrowser === 'ready'
    ? '就绪（采集任务会直接用它当场跑完并返回结果，不排队）'
    : c.localBrowser === 'offline'
      ? `已开启但此刻没在跑（Chrome 没带调试端口开着；这次只能排给插件。告诉用户${LOCAL_BROWSER_WAKE_HINT}就能当场采）`
      : '未开启';
  const selfProfile = SELF_PROFILE_PLATFORMS.map((p) => platformName(p) || p).join('/');
  const selfBackend = SELF_BACKEND_PLATFORMS.map((p) => platformName(p) || p).join('/');
  const recipe = RECIPE_PLATFORMS.map((p) => platformName(p) || p).join('/');
  return [
    '【你的账号与插件】',
    acct,
    `采集执行器：${plugin}；本机浏览器：${local}`,
    '怎么用这些信息：',
    `- 用户说「采/抓取/回填我的 X 账号」这类话，指的就是上面对应平台的那条账号，**直接**调 dispatch_browser_task(kind=collect_self_profile, platform=<平台>, wait_for_result=true)，`
      + '不要再问他要主页链接、也不要问采哪个；同平台有多个账号时用 account 参数点名（用户没点名就按「当前」那条）。',
    '- 走哪条路（本机浏览器 / 桌面客户端 / 插件）由系统按上面的状态自动定，**不要问用户选**；本机就绪时工具直接返回结果，拿到就接着答。'
      + '想让用户看进度时用文字说明，不要把工具调用写成 JSON 块给他看。',
    `- 能派的自有回填（**每个平台都有路**，插件 / 桌面客户端 / 本机浏览器三条执行路都会做）：${selfBackend} 进创作者后台读数（完播率、流量来源只有后台有；公众号走插件要先在插件设置里对 mp.weixin.qq.com 授权一次，走桌面客户端不用）；${selfProfile} 采自己的公开主页（要有 handle；抖音/小红书/B站没有会进后台的执行器时才退到这条，只有公开数字）；${recipe} 按采集配方采自己的主页（要有 handle；第一次会先学规则）。都用同一个 kind=collect_self_profile 派，系统按平台与在线执行器自动分路。`,
    `- 竞对：${recipe} 按采集配方采（第一次先学规则；走插件要先在插件侧边栏对该站点授权过一次，桌面客户端/本机浏览器不用），其余平台走主页解析器；公众号/视频号没有公开主页，竞对数据只能走数据源或导入。照常用 kind=collect_competitor 派。`,
    '- 解析器/配方读不到时，桌面客户端/本机浏览器会把页面上可见的文字与链接带回，由模型直接从页面内容里读出作品与数字再入库（回执里会标「模型直读」，每个数字都核对过在页面上原样出现）。别因为「解析器没认出」就断言采不了。',
    // 页面上能做的，对话里也要能做：加账号 / 补 handle 都有工具，别把用户支去页面（2026-09-09）
    '- 用户说的平台上还没有他的账号：直接用 add_account 加（给主页链接，或 platform + handle），加好接着派，不要让他自己去页面加。',
    '- 账号没填 handle 时，问他主页 ID 或链接，拿到就用 update_account 补上，不要编一个。',
  ].join('\n');
}

export async function accountsContextBlock(ctx: { workspaceId: string; accountId: string | null }): Promise<string> {
  try {
    return renderAccountsContext(await loadAccountsContext(ctx));
  } catch {
    return ''; // 这一段拿不到不该让整次执行起不来
  }
}
