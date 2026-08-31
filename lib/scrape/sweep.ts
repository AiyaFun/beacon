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
import {
  learnFromSkeleton, recordScrapeResult, recipeUrl, parseOptions, markRateLimited, noticeStaleRecipes,
} from './recipe';
import { saveScrapeRecord } from './record';

/** 一次扫描最多跑几个配方。**不是性能考虑**——是别把用户的浏览器占太久。 */
export const SWEEP_MAX_RECIPES = 20;
/** 配方之间的间隔（毫秒）。连着开标签会让浏览器明显卡一下。 */
const GAP_MS = 2000;

/**
 * **同一个站点**两次访问之间的最小间隔（毫秒）。
 *
 * 【为什么 GAP_MS 不够】那是「配方之间」的间隔，与站点无关。一个用户在同一个站点上
 * 建了 10 个配方（很常见：热榜页、作者页、话题页…），一轮就是 20 秒内打它 10 次——
 * 从站点那边看，这是一个明显的自动化特征，而代价是**用户自己的账号**被风控。
 * 既有的公众号采集那条路早就按站点节流了（同一个号 12 小时内只采一次），
 * 这里补上同一条纪律。
 *
 * 【为什么带抖动】固定 30 秒是一个比随机更明显的机器特征。抖动不是为了「躲」——
 * 我们不做规避；是为了不主动制造一个规律性的指纹。
 */
export const ORIGIN_MIN_GAP_MS = 30_000;
const ORIGIN_JITTER_MS = 8_000;

/**
 * 每个 origin 上一次被访问的时刻。**进程内**即可：整机版就一个进程
 *（与 browserBusy 同一条理由，上数据库锁是把单进程问题做成分布式问题）。
 * 进程重启后清空——那意味着重启后第一轮可能稍快，代价远小于引入一张表。
 */
const originLastHit = new Map<string, number>();

/** 距离这个站点上次被访问还差多久（毫秒）。够久了就是 0。 */
export function originWaitMs(origin: string, now: number, jitter = 0): number {
  const last = originLastHit.get(origin);
  if (last === undefined) return 0;
  const need = ORIGIN_MIN_GAP_MS + jitter;
  const waited = now - last;
  return waited >= need ? 0 : need - waited;
}

/** 记一次访问。测试要能重置，所以导出。 */
export function markOriginHit(origin: string, now = Date.now()): void {
  originLastHit.set(origin, now);
}

/** 只给测试用：清空节流状态。 */
export function resetOriginThrottle(): void {
  originLastHit.clear();
}

export type SweepResult = {
  scanned: number; ok: number; relearned: number; skipped: number; saved: number;
  /** 久未成功、已提醒的配方数 */
  stale: number;
};

export async function sweepLocalRecipes(): Promise<SweepResult> {
  const out: SweepResult = { scanned: 0, ok: 0, relearned: 0, skipped: 0, saved: 0, stale: 0 };
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
      // needs_login / rate_limited 都不跑（规矩③）：它们已经通知过用户了，
      // 每轮再撞一次只会刷新 lastFailAt、制造「一直在失败」的假象。
      // learning 的也不跑——那是「还没学会」，无人值守时学出来的东西没人看着
      where: { workspaceId: ws.id, status: { in: ['active', 'broken'] } },
      orderBy: { updatedAt: 'asc' },
      take: SWEEP_MAX_RECIPES,
      select: { id: true, name: true, origin: true, pathPattern: true, rules: true, status: true, options: true },
    });

    for (const r of recipes) {
      out.scanned += 1;
      let rules: { key: string; selectors: string[]; anchors: string[] }[] = [];
      try { rules = JSON.parse(r.rules); } catch { /* 坏数据当空 */ }
      const url = recipeUrl(r.origin, r.pathPattern);

      // 【同一个站点要等够】见 ORIGIN_MIN_GAP_MS：一个用户在同一站点建 10 个配方很常见，
      // 不按站点节流就是 20 秒内打它 10 次，而代价是他自己的账号被风控。
      const wait = originWaitMs(r.origin, Date.now(), Math.floor(jitterFor(r.id) * ORIGIN_JITTER_MS));
      if (wait > 0) await sleep(wait);
      markOriginHit(r.origin);

      // waitForLoginSec = 0：规矩①，无人值守绝不抢焦点
      const page = await browseLocal(vet.url!, url, rules, 0, parseOptions(r.options));

      if (!page.ok) {
        // 【连不上浏览器：整个工作区直接停手】它跟配方好不好毫无关系。
        // 若照常记失败，这一轮里每个配方各记一次，约 3 轮（18 小时）后全部变成「抓不到了」——
        // 而它们一个都没坏。用户看到一屏红色会去查站点改版，方向完全错。
        // 而且既然连不上，后面的配方也一样连不上，继续跑纯属浪费。
        if (page.connectFailed) { out.skipped += recipes.length - out.scanned + 1; break; }
        // 登录墙 / 验证码：跳过，不计失败。
        // 计了会把好配方推去重学，而重学时看到的还是登录页或验证码页——
        // 于是学出一堆「请登录」「请输入验证码」的规则，两个错叠在一起看不出源头。
        if (page.needsLogin) { out.skipped += 1; }
        else if (page.rateLimited) {
          out.skipped += 1;
          await markRateLimited(r.id, ws.id, r.origin);
        } else await recordScrapeResult(r.id, ws.id, false);
        await sleep(GAP_MS);
        continue;
      }

      const got = page.values ? Object.keys(page.values).length : 0;
      const rowCount = page.rows?.length ?? 0;
      const want = rules.length;

      // 【有行就算抓到了】列表页常常没有任何页面级标量（没有「总数」这种东西），
      // 只看 got 会把一次满载的采集判成失败，然后拿去重学——越学越差。
      if (got === 0 && rowCount === 0) {
        // 一个字段都没取到 = 站点改版了。拿这次的骨架当场重学（这就是「进化」那一环）
        const learned = await learnFromSkeleton({
          tenantId: ws.tenantId, recipeId: r.id, skeleton: page.skeleton, jsonHints: page.jsonHints,
        });
        if (learned.ok) out.relearned += 1;
        await recordScrapeResult(r.id, ws.id, false);
      } else {
        // 【先落库，再判好坏】这两件事顺序不能反：判好坏那一步可能把配方标成 broken，
        // 但**这次确实抓到东西了**，数据该留下。在补上这一句之前，values 在这里被丢掉，
        // 于是「每 6 小时跑一遍」实际上只是配方健康检查，一个字都没存。
        const rec = await saveScrapeRecord({
          tenantId: ws.tenantId, workspaceId: ws.id, recipeId: r.id,
          url, values: page.values, rows: page.rows, want, channel: 'server',
        });
        if (rec.saved) out.saved += 1;

        // 【取到了就不重学，哪怕它此刻标着 broken】
        // 第一版写的是「status==='broken' 就重学」——但这次明明取到值了，
        // 说明它已经自己恢复了（站点改回去了、或上一版规则本来就还能用）。
        // 照那样写，一个恢复了的配方每轮都被重学一遍，白烧模型调用还可能越学越差。
        //
        // 【部分缺失也不算跑好】有些字段还在、有些没了，是最难发现的一种坏：
        // 页面照常出数，只是少了几列。按 got===want 判，连续几次不满就转 broken，
        // 下一轮自然会重学——这就是「除了卡住了要重新优化，其余时候不动」。
        // 部分字段缺失仍不算跑好（页面照常出数、只是少了几列，是最难发现的坏）；
        // 但纯列表页往往一个页面级标量都没有（没有「总数」这种东西），所以有行就算跑好。
        //
        // ⚠️ **已知不足，写在这儿别当它不存在**：有行就算好，意味着一个本来出 50 行、
        // 现在只出 1 行的配方仍然判「好」。要认出这种退化得有个基线（本库在指标那边有
        // 「暴跌 100 倍一律拦」的量级闸），这里暂时没有。写成 `got + rowCount > 0`
        // 是**死逻辑**（rowCount>0 时恒真），读起来像在判什么，其实什么都没判——
        // 与其留一个假装在检查的表达式，不如老实写 true 并把缺口标出来。
        const fine = rowCount > 0 ? true : got === want;
        await recordScrapeResult(r.id, ws.id, fine);
        if (fine) out.ok += 1;
      }
      await sleep(GAP_MS);
    }

    // 【一轮跑完再看时间维度】久未成功的提醒一次。放在这里而不是每个配方跑完就判：
    // 这一轮里刚成功的那些已经把 lastOkAt 刷新了，先跑完再看才不会误报。
    out.stale += await noticeStaleRecipes(ws.id).catch(() => 0);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 由配方 id 推出一个稳定的 0..1 抖动系数。
 *
 * 【为什么不用 Math.random()】同一个配方每轮抖动都不一样的话，两个配方偶尔会撞在一起、
 * 偶尔又隔很远，节流效果时好时坏且**复现不了**——排查这种问题极其痛苦。
 * 按 id 取一个稳定值：每个配方有自己固定的错峰位置，整体依然是散开的。
 */
export function jitterFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}
