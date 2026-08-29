'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { can } from '@/lib/edition';
import { browseLocal, vetCdpUrl } from '@/lib/browser/local';
import { learnFromSkeleton, recordScrapeResult, markNeedsLogin, recipeUrl } from '@/lib/scrape/recipe';

// 采集配方的界面动作（2026-08-29 补）。
//
// 【为什么补】前一批只做了 AI 工具和插件接口，**界面上一个入口都没有**——
// 用户看不到有哪些配方、哪个坏了、哪个在等他登录，也没法手动跑一次。
// 这是这个会话里第三次「加了能力没做界面」，已记进记忆当检查项。

export type RecipeActResult = { ok: boolean; error?: string; detail?: string };

/** 立刻用本机浏览器跑一次。撞上登录墙会把页面推到前台等他登（这是当场点的，人就在跟前）。 */
export async function actRunRecipeNow(recipeId: string): Promise<RecipeActResult> {
  const s = await getSession();
  try {
    if (!can('localBrowser')) return { ok: false, error: '这个版本不提供本机浏览器驱动' };
    requireRole(s, 'content.create');

    const ws = await prisma.workspace.findUnique({
      where: { id: s.workspaceId }, select: { browserCdpUrl: true },
    });
    const vet = vetCdpUrl(ws?.browserCdpUrl);
    if (!vet.ok) return { ok: false, error: `${vet.error}。请先在设置里填浏览器调试端点` };

    const r = await prisma.scrapeRecipe.findFirst({
      where: { id: recipeId, workspaceId: s.workspaceId },
      select: { id: true, tenantId: true, origin: true, pathPattern: true, rules: true },
    });
    if (!r) return { ok: false, error: '找不到这个配方' };
    let rules: { key: string; selectors: string[]; anchors: string[] }[] = [];
    try { rules = JSON.parse(r.rules); } catch { /* 坏数据当空 */ }

    const url = recipeUrl(r.origin, r.pathPattern);
    // 90 秒：这是用户当场点的，人就在键盘前，值得等他登一次
    const page = await browseLocal(vet.url!, url, rules, 90);

    if (!page.ok) {
      // 连不上浏览器 ≠ 配方坏了。记失败会把好配方一步步推向「抓不到了」，
      // 而真实原因只是 Chrome 没带调试端口开着
      if (page.connectFailed) return { ok: false, error: page.error };
      if (page.needsLogin) {
        await markNeedsLogin(r.id, s.workspaceId, r.origin);
        revalidatePath('/skills');
        return { ok: false, error: page.error };
      }
      await recordScrapeResult(r.id, s.workspaceId, false);
      revalidatePath('/skills');
      return { ok: false, error: page.error };
    }

    const got = page.values ? Object.keys(page.values).length : 0;
    if (got === 0) {
      const learned = await learnFromSkeleton({ tenantId: r.tenantId, recipeId: r.id, skeleton: page.skeleton });
      await recordScrapeResult(r.id, s.workspaceId, false);
      revalidatePath('/skills');
      return learned.ok
        ? { ok: true, detail: `这次没取到值，已重新学会 ${learned.learned} 个字段，再跑一次试试` }
        : { ok: false, error: `没取到值，也没学出可用规则：${learned.error}` };
    }

    await recordScrapeResult(r.id, s.workspaceId, got === rules.length);
    revalidatePath('/skills');
    const pairs = Object.entries(page.values ?? {}).map(([k, v]) => `${k}=${v}`).join('，');
    return {
      ok: true,
      detail: got === rules.length ? `取到 ${got} 个字段：${pairs}` : `只取到 ${got}/${rules.length} 个：${pairs}`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '跑不起来' };
  }
}

export async function actDeleteRecipe(recipeId: string): Promise<RecipeActResult> {
  const s = await getSession();
  try {
    requireRole(s, 'content.create');
    // 按 workspaceId 圈定：跨工作区删不掉（删除不可逆，RLS 之外再加一道）
    const r = await prisma.scrapeRecipe.deleteMany({ where: { id: recipeId, workspaceId: s.workspaceId } });
    if (r.count === 0) return { ok: false, error: '找不到这个配方' };
    revalidatePath('/skills');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '删除失败' };
  }
}
