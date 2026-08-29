// 定时把所有配方跑一遍（2026-08-29）。
//
// 【它让「不用插件」成立】在此之前 browse_local 只能由 AI 一次点一个网址，
// 而插件那条路有每日定时采集。补上这一件，插件对采集就不再是必须的了。
//
// ── 三条只在「无人值守」这个前提下才成立的规矩 ──
//
// ① **绝不抢焦点。** 交互式那条路撞上登录墙会 bringToFront 把页面推到用户眼前；
//    定时跑不行——用户可能正在写东西，把标签抢到前台是纯粹的骚扰。
//    所以这里 waitForLoginSec 恒为 0：撞上登录墙就跳过，留给交互式那次去处理。
//
// ② **会有标签页闪现，这一点藏不住。** CDP 在用户真实的 Chrome 里开标签，
//    没有「后台标签」这种东西（那是扩展才有的能力）。所以：跑完立刻关、
//    一次只开一个、配方之间留间隔。界面上必须如实告诉用户会看到标签闪一下。
//
// ③ **needs_login 的直接跳过。** 它们已经通知过用户了；每轮再撞一次只会
//    刷新 lastFailAt、制造「一直在失败」的假象，而真实原因是他还没去登录。
import { prisma } from '../db';
import { can } from '../edition';
import { browseLocal, vetCdpUrl, isBrowserBusy } from '../browser/local';
import { learnFromSkeleton, recordScrapeResult, recipeUrl } from './recipe';

/** 一次扫描最多跑几个配方。**不是性能考虑**——是别把用户的浏览器占太久。 */
export const SWEEP_MAX_RECIPES = 20;
/** 配方之间的间隔（毫秒）。连着开标签会让浏览器明显卡一下。 */
const GAP_MS = 2000;

export type SweepResult = { scanned: number; ok: number; relearned: number; skipped: number };

export async function sweepLocalRecipes(): Promise<SweepResult> {
  const out: SweepResult = { scanned: 0, ok: 0, relearned: 0, skipped: 0 };
  // SaaS 上这条路不存在：服务端在机房，够不到任何人的浏览器
  if (!can('localBrowser')) return out;

  // 【有人正在用就整轮让位】用户当场点的动作不该跟定时任务抢他的浏览器；
  // 反正 6 小时后还有一轮，跳过一轮的代价远小于「标签一下子弹出好几个」。
  if (isBrowserBusy()) return out;

  const spaces = await prisma.workspace.findMany({
    where: { browserCdpUrl: { not: null } },
    select: { id: true, tenantId: true, browserCdpUrl: true },
  });

  for (const ws of spaces) {
    const vet = vetCdpUrl(ws.browserCdpUrl);
    if (!vet.ok) continue; // 配了个不合法的端点：跳过，不在这里报错刷屏

    const recipes = await prisma.scrapeRecipe.findMany({
      // needs_login 的不跑（规矩③）；learning 的也不跑——那是「还没学会」，
      // 该由用户当场点一次去学，无人值守时学出来的东西没人看着，风险更高
      where: { workspaceId: ws.id, status: { in: ['active', 'broken'] } },
      orderBy: { updatedAt: 'asc' },
      take: SWEEP_MAX_RECIPES,
      select: { id: true, name: true, origin: true, pathPattern: true, rules: true, status: true },
    });

    for (const r of recipes) {
      out.scanned += 1;
      let rules: { key: string; selectors: string[]; anchors: string[] }[] = [];
      try { rules = JSON.parse(r.rules); } catch { /* 坏数据当空 */ }
      const url = recipeUrl(r.origin, r.pathPattern);

      // waitForLoginSec = 0：规矩①，无人值守绝不抢焦点
      const page = await browseLocal(vet.url!, url, rules, 0);

      if (!page.ok) {
        // 【连不上浏览器：整个工作区直接停手】它跟配方好不好毫无关系。
        // 若照常记失败，这一轮里每个配方各记一次，约 3 轮（18 小时）后全部变成「抓不到了」——
        // 而它们一个都没坏。用户看到一屏红色会去查站点改版，方向完全错。
        // 而且既然连不上，后面的配方也一样连不上，继续跑纯属浪费。
        if (page.connectFailed) { out.skipped += recipes.length - out.scanned + 1; break; }
        // 登录墙：跳过，不计失败（计了会把好配方推去重学，而重学看到的还是登录页）
        if (page.needsLogin) { out.skipped += 1; }
        else await recordScrapeResult(r.id, ws.id, false);
        await sleep(GAP_MS);
        continue;
      }

      const got = page.values ? Object.keys(page.values).length : 0;
      const want = rules.length;

      if (got === 0) {
        // 一个字段都没取到 = 站点改版了。拿这次的骨架当场重学（这就是「进化」那一环）
        const learned = await learnFromSkeleton({ tenantId: ws.tenantId, recipeId: r.id, skeleton: page.skeleton });
        if (learned.ok) out.relearned += 1;
        await recordScrapeResult(r.id, ws.id, false);
      } else {
        // 【取到了就不重学，哪怕它此刻标着 broken】
        // 第一版写的是「status==='broken' 就重学」——但这次明明取到值了，
        // 说明它已经自己恢复了（站点改回去了、或上一版规则本来就还能用）。
        // 照那样写，一个恢复了的配方每轮都被重学一遍，白烧模型调用还可能越学越差。
        //
        // 【部分缺失也不算跑好】有些字段还在、有些没了，是最难发现的一种坏：
        // 页面照常出数，只是少了几列。按 got===want 判，连续几次不满就转 broken，
        // 下一轮自然会重学——这就是「除了卡住了要重新优化，其余时候不动」。
        await recordScrapeResult(r.id, ws.id, got === want);
        if (got === want) out.ok += 1;
      }
      await sleep(GAP_MS);
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
