import { prisma } from '../db';
import { platformName } from '../constants';
import { hasCollector } from './index';
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
//   ① 工作区里得真有插件（没有采集令牌 = 排了也没浏览器会领）；
//   ② open_and_read 要工作区显式开过开关，且 URL 在白名单域里
//     （插件端还有一份硬编码清单，那份才是真正的防线——这里只是早失败早说清楚）；
//   ③ collect_competitor 的竞对必须已经在监控列表里
//     （不校验的话调用方可以拿任意 id 让插件去访问）。

export type VetVerdict =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string; summary: string };

export type VetArgs = {
  kind: string;
  competitorId?: string;
  platform?: string;
  url?: string;
  limit?: number;
};

const clampLimit = (n: number | undefined) => Math.min(50, Math.max(1, Math.round(n || 20)));

export async function vetBrowserTaskArgs(workspaceId: string, args: VetArgs): Promise<VetVerdict> {
  // 没装插件就别排：那条活会一直 pending 到 48 小时后过期，而调用方已经说过「已排给插件」，
  // 用户等两天什么都没发生也没人告诉他为什么。当场说清、并指路，比排一个没人领的活有用
  if (!(await hasCollector(workspaceId))) {
    return {
      ok: false,
      error: '这个工作区还没有装采集插件（没有可用的采集令牌），派下去也没有浏览器会执行。请先到「采集助手」页装插件并填入采集令牌。',
      summary: '还没装采集插件',
    };
  }

  const kind = args.kind;

  // 「让浏览器去读一个网页」是唯一一个由服务端指定 URL 的动作，所以多两道闸：
  // ① 工作区必须显式打开过这个开关（**默认关**）；② URL 必须在白名单里。
  // 插件端另有一份硬编码的同款清单——那份才是真正的防线，这里只是早失败早说清楚
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

  // 竞对必须已经在订阅列表里：不校验的话调用方可以拿一个任意 id 让插件去访问
  if (kind === 'collect_competitor') {
    const watched = await prisma.watchlistItem.findFirst({
      where: { workspaceId, competitorId: args.competitorId ?? '' },
      select: { id: true },
    });
    if (!watched) {
      return { ok: false, error: '这个竞对不在你的监控列表里，先用 add_competitor 加进来', summary: '竞对未订阅' };
    }
  }

  const payload =
    kind === 'collect_competitor'
      ? { kind, competitorId: args.competitorId ?? '', limit: clampLimit(args.limit) }
      : kind === 'open_and_read'
        ? { kind, url: args.url ?? '', mode: 'article' as const }
        : { kind, platform: args.platform ?? '' };

  return { ok: true, payload };
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
