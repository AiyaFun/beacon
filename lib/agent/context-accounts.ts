// 系统提示里的「你的账号与插件」一段（2026-09-03）。
//
// 【为什么要有这一段】用户说「抓取我的 X 账号」，模型此前只拿得到人设卡，不知道工作区里
// 绑了哪些账号、handle 是什么、插件装没装——于是要么反问「主页链接给我」，要么摊手。
// 用户原话：「我们都有 X 账号的信息和插件的信息，应该要有所关联」。
// 关联就是把这两样直接摆到它眼前，并告诉它该调哪个工具、怎么填参数。
import { prisma } from '../db';
import { platformName } from '../constants';
import { hasCollector, collectorKinds } from '../browser-task';
import { SELF_PROFILE_PLATFORMS } from '../browser-task/kinds';
import { localBrowserState, LOCAL_BROWSER_WAKE_HINT } from '../browser-task/local-run';
import { fmtDate } from '../format';

export type AccountsContext = {
  accounts: { id: string; name: string; platform: string; handle: string | null; current: boolean }[];
  plugin: { installed: boolean; lastSeenAt: Date | null; kinds?: string[] };
  /** off=没开 / ready=此刻能用（采集任务直接当场跑）/ offline=开了但 Chrome 没带端口跑着 */
  localBrowser: 'off' | 'ready' | 'offline';
};

export async function loadAccountsContext(ctx: { workspaceId: string; accountId: string | null }): Promise<AccountsContext> {
  const [rows, installed, token, local, caps] = await Promise.all([
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
  ]);
  return {
    accounts: rows.map((r) => ({ ...r, current: r.id === ctx.accountId })),
    plugin: { installed, lastSeenAt: token?.lastUsedAt ?? null, kinds: Array.from(caps) },
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
  const oldPlugin = c.plugin.installed && c.plugin.kinds && !c.plugin.kinds.includes('collect_self_profile');
  const plugin = c.plugin.installed
    ? `已连接${c.plugin.lastSeenAt ? `（最近活跃 ${fmtDate(c.plugin.lastSeenAt)}）` : '（还没回传过数据）'}${oldPlugin ? '；**版本旧了，不会回填自己的主页**（派了会被拒，如实告诉用户去更新插件，或在桌面客户端顶部那条「允许这台客户端操作浏览器采集？」点「允许」）' : ''}`
    : '没装';
  const local = c.localBrowser === 'ready'
    ? '就绪（采集任务会直接用它当场跑完并返回结果，不排队）'
    : c.localBrowser === 'offline'
      ? `已开启但此刻没在跑（Chrome 没带调试端口开着；这次只能排给插件。告诉用户${LOCAL_BROWSER_WAKE_HINT}就能当场采）`
      : '未开启';
  const selfProfile = SELF_PROFILE_PLATFORMS.map((p) => platformName(p) || p).join('/');
  return [
    '【你的账号与插件】',
    acct,
    `采集插件：${plugin}；本机浏览器：${local}`,
    '怎么用这些信息：',
    `- 用户说「采/抓取/回填我的 X 账号」这类话，指的就是上面对应平台的那条账号，**直接**调 dispatch_browser_task(kind=collect_self_profile, platform=<平台>, wait_for_result=true)，`
      + '不要再问他要主页链接、也不要问采哪个；同平台有多个账号时用 account 参数点名（用户没点名就按「当前」那条）。',
    '- 走哪条路（本机浏览器还是插件）由系统按上面的状态自动定，**不要问用户选**；本机就绪时工具直接返回结果，拿到就接着答。'
      + '想让用户看进度时用文字说明，不要把工具调用写成 JSON 块给他看。',
    `- 能派的自有回填只有：${selfProfile}（自己的主页，要有 handle）。别的平台（含公众号）如实说要在创作者后台页点插件侧栏手动回填，公众号连那条路都没有了。`,
    '- 账号没填 handle 时，告诉他去「账号」页填上，不要编一个。',
  ].join('\n');
}

export async function accountsContextBlock(ctx: { workspaceId: string; accountId: string | null }): Promise<string> {
  try {
    return renderAccountsContext(await loadAccountsContext(ctx));
  } catch {
    return ''; // 这一段拿不到不该让整次执行起不来
  }
}
