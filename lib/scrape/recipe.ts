// 任意站点采集配方：学一次、按配方抓、抓不到再进化（2026-08-29）。
//
// 用户的原话：「驱动浏览器一次抓取，然后自我学习，直到下次无法抓取后再次进化学习。」
//
// ── 为什么不另造学习链路 ──
// 骨架上传 → 模型推断 → **机器验证** 这条链已经在 lib/ingest/parser-learn.ts 上跑了几个月。
// 自己再写一套验证，等于把「模型指到旁边那个数字」的老事故重演一遍
// （抖音「关注 178 / 粉丝 328.3万」三个数字挨着，模型抓错过）。所以这里复用
// verifyAgainstSkeleton：**模型提的规则必须逐 token 对得上骨架才准落库**。
//
// ── 为什么需要合规闸，而且不能只写在文档里 ──
// 已有的采集合规是**按平台预先审过**的（五条通道分级、robots、去标识化）。
// 任意站点没法预审——所以判据必须是机器闸：
//   ① robots.txt 说不许就不采（真去读，不是写在说明里）
//   ② 敏感行业域名一律不采（政务/医疗/金融/未成年人）
//   ③ 只取**已渲染的公开 DOM**，绝不碰登录态接口（这条是既有红线，配方形态天然满足：
//      配方里存的是选择器与文本锚点，没有「调接口」这种东西）
import { prisma } from '../db';
import { llmComplete } from '../llm/gateway';
import { notify } from '../notify';
import { isSiteRemovalRequested } from '../legal/removal';
import {
  verifyAgainstSkeleton, sanitizeSkeleton, serializeSkeleton, selectorTokens, MAX_SKELETON_CHARS,
} from '../ingest/parser-learn';

/**
 * 一条 JSON 路径是不是真的在这次捕获里见过。
 * 带 `*` 的把通配位换成「一段非点字符」再比——仍然是在真实材料上比，不是放行。
 */
export function pathSeenInHints(hints: string, path: string): boolean {
  const p = String(path ?? '').trim();
  if (!p || p.length > 200) return false;
  if (!p.includes('*')) return hints.includes(`${p} =`);
  const re = new RegExp(
    `^${p.split('*').map((x) => x.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')).join('[^.]+')} =`,
    'm',
  );
  return re.test(hints);
}

/** 一个选择器是不是由骨架里真实出现过的 token 组成。与规则同一条判据。 */
export function selectorSeenInSkeleton(skeleton: string, selector: string): boolean {
  const tokens = selectorTokens(selector);
  return tokens.length > 0 && tokens.every((t) => skeleton.includes(t));
}

/** 连续抓不到几次算坏掉、要重新学。1 次就重学太敏感（网络抖动也算），3 次是经验值。 */
export const RECIPE_BROKEN_AT = 3;

/**
 * 一个工作区最多几个配方。
 *
 * 【为什么必须有上限】create_recipe 是 AI 能调的工具——模型误解一句话就可能连建十几个，
 * 而每一个都会进定时扫描、每轮都在用户浏览器里开一次标签。这个项目别处
 * （定时计划 MAX_SCHEDULES、技能）都有上限，这里漏了。
 * 50 是「正常用不到、失控时拦得住」的量级。
 */
export const MAX_RECIPES_PER_WORKSPACE = 50;

export type RecipeField = { key: string; label: string };
export type RecipeRule = {
  key: string;
  selectors: string[];
  anchors: string[];
  /** 从被动捕获的 JSON 响应里取值的路径（CDP 路专有；插件端会自然退回选择器与锚点） */
  jsonPaths?: string[];
};

/**
 * 配方的页面级选项，存 ScrapeRecipe.options（JSON）。
 * 【为什么是一个 JSON 列而不是三个列】这三样都只会跟着配方整读整写，从不单独查询；
 * 而它们还会继续长（分页、字符集、视口…）。每加一样开一次迁移不划算。
 */
export type RecipeOptions = {
  /** 等到它出现才算就绪。没有它就只能固定等 1500ms，慢一点就抓到骨架屏 */
  readySelector?: string;
  /** 往下滚几屏（0=不滚）。列表页首屏之外的内容只能靠它 */
  scrollScreens?: number;
  /** 列表的行容器。⚠️ 行边界判错 = 跨条目串数，所以必须显式指定，绝不由代码猜 */
  rowSelector?: string;
};

/** 读配方选项。坏数据一律当空——一个写坏的选项不该让整个配方跑不了。 */
export function parseOptions(raw: string | null | undefined): RecipeOptions {
  try {
    const o = JSON.parse(String(raw ?? '{}')) as RecipeOptions;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    return {
      readySelector: typeof o.readySelector === 'string' ? o.readySelector.slice(0, 200) : undefined,
      scrollScreens: Number.isFinite(o.scrollScreens) ? Math.min(Math.max(Number(o.scrollScreens), 0), 15) : undefined,
      rowSelector: typeof o.rowSelector === 'string' ? o.rowSelector.slice(0, 200) : undefined,
    };
  } catch { return {}; }
}

// ── 合规闸 ────────────────────────────────────────────────────────────
//
// 【为什么是后缀匹配而不是包含匹配】写成 includes('gov.cn') 会把 'notgov.cn.evil.com'
// 也算进来（误杀），也会漏掉真正的子域。按 host 的点分段从右往左比才准。
const BLOCKED_SUFFIXES = [
  'gov.cn', 'mil.cn', 'gov', // 政务军事
  'edu.cn',                   // 教育（多含未成年人信息）
];
/** 这些词出现在 host 里就不采：医疗与金融的个人信息敏感度最高，且多受专门法约束。 */
const BLOCKED_HOST_WORDS = ['bank', 'hospital', '12306', 'medical', 'yiyuan', 'insurance'];

export function complianceCheck(origin: string): { ok: boolean; reason?: string } {
  let host = '';
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: '只支持 http/https 网址' };
    host = u.hostname.toLowerCase();
  } catch {
    return { ok: false, reason: '网址格式不对' };
  }
  const parts = host.split('.');
  for (const suf of BLOCKED_SUFFIXES) {
    const segs = suf.split('.');
    if (parts.length >= segs.length && parts.slice(-segs.length).join('.') === suf) {
      return { ok: false, reason: `${suf} 域名属于不采集的范围（政务／教育／军事）` };
    }
  }
  if (BLOCKED_HOST_WORDS.some((w) => host.includes(w))) {
    return { ok: false, reason: '这类站点（医疗／金融／票务）的个人信息敏感度过高，不做采集' };
  }
  return { ok: true };
}

/**
 * 真去读一次 robots.txt。
 *
 * 【为什么必须真读】「我们尊重 robots」如果只写在隐私政策里而代码不读，
 * 那就是一句空承诺——这个项目在别处已经栽过一次（评论「两人以上才留存」是空承诺）。
 * 读不到（超时/404）按**允许**处理：没有 robots 文件本来就等于没有限制，
 * 但网络故障不该把用户的正常采集永久卡死。
 */
export async function robotsAllows(origin: string, path = '/'): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(new URL('/robots.txt', origin).toString(), {
      signal: AbortSignal.timeout(5000),
      headers: { 'user-agent': 'BeaconBot' },
    });
    if (!res.ok) return { ok: true };
    const txt = (await res.text()).slice(0, 50_000);
    // 只看 User-agent: * 这一段。不做完整 robots 语法实现——覆盖不了的部分宁可放行，
    // 也不要因为解析器自己写错而误拦用户的正常采集
    const lines = txt.split('\n').map((l) => l.trim());
    let inStar = false;
    for (const line of lines) {
      const m = /^user-agent:\s*(.+)$/i.exec(line);
      if (m) { inStar = m[1].trim() === '*'; continue; }
      if (!inStar) continue;
      const d = /^disallow:\s*(.*)$/i.exec(line);
      if (d && d[1].trim() && path.startsWith(d[1].trim())) {
        return { ok: false, reason: `站点的 robots.txt 声明不允许抓取 ${d[1].trim()}` };
      }
    }
    return { ok: true };
  } catch {
    return { ok: true }; // 读不到就按没有限制处理，但不放松上面两道闸
  }
}

/**
 * 建一个配方前的完整检查。**三道闸都过才算能建。**
 *
 * 第三道是 2026-08-29 补的欠账：站点权利人可以要求「别再抓我的站」，
 * 而在补上之前，任意站点的内容被存进库，**他没有任何办法让我们停下来**。
 * 与账号级停采同一条纪律：pending 也先停——宁可少采几天，也不在核验期间继续采。
 */
export async function vetOrigin(origin: string, path = '/'): Promise<{ ok: boolean; reason?: string }> {
  const c = complianceCheck(origin);
  if (!c.ok) return c;
  if (await isSiteRemovalRequested(origin)) return { ok: false, reason: SITE_STOPPED_REASON };
  return robotsAllows(origin, path);
}

/** 停采的说法收成一处：三个调用点要说同一句话，否则用户会以为是三种不同的错。 */
export const SITE_STOPPED_REASON =
  '这个站点的权利人已经要求停止采集，我们不再抓取它。（如果你就是站点权利人、想撤回这个申请，'
  + '请到「数据移除申请」页说明。）';

/**
 * 由配方拼出要打开的网址。
 *
 * 【为什么必须收成一处】2026-08-29 发现同一个表达式散在三处，而且**其中一处漏了处理通配符**——
 * 导出给用户的独立脚本里，网址直接带着字面量 `*`，跑起来必然打不开。
 * 那份脚本是用户拿走自己用的东西，错在那里我们既看不见也修不了。
 *
 * 【为什么在第一个 * 处截断，而不是只削尾部】pathPattern 的语义是**前缀**
 * （插件那端也是按 startsWith 匹配的）。中间的 `*` 不是「匹配任意」的意思，
 * 它只是用户写宽了——截到那儿正好等于他想表达的前缀。
 * 只削尾部的话，`/x/*​/y` 会拼出一个带 `*` 的非法地址。
 */
export function recipeUrl(origin: string, pathPattern: string | null | undefined): string {
  const p = String(pathPattern ?? '');
  const star = p.indexOf('*');
  return `${origin}${star >= 0 ? p.slice(0, star) : p}`;
}

// ── 学习 ──────────────────────────────────────────────────────────────

type LearnInput = {
  tenantId: string;
  recipeId: string;
  /** 插件传上来的原始骨架（服务端会再脱敏一次——客户端上传的一律不信） */
  skeleton: unknown;
  /**
   * 被动捕获到的 JSON 响应摘要（只有路径名 + 值的形状）。只有 CDP 那条路有。
   * 【为什么值得给模型】同一份数据在响应里是稳定的结构（`data.items.0.title`），
   * 改版时比 DOM 稳一个数量级，而列表在那儿天然就是数组。
   */
  jsonHints?: string;
};

/**
 * 从一份页面骨架学出取数规则。
 *
 * 模型只被允许提**候选**；能不能落库由 verifyAgainstSkeleton 说了算。
 * 一个字段一条规则都没验过就不写进去——宁可这个字段空着，也不要写一条会抓到隔壁数字的规则。
 */
export async function learnFromSkeleton(input: LearnInput): Promise<{ ok: boolean; learned: number; error?: string }> {
  const recipe = await prisma.scrapeRecipe.findFirst({
    where: { id: input.recipeId, tenantId: input.tenantId },
    select: { id: true, name: true, origin: true, fields: true, version: true },
  });
  if (!recipe) return { ok: false, learned: 0, error: '找不到这个配方' };

  // 客户端传什么都先脱敏一次再用
  const skeleton = serializeSkeleton(sanitizeSkeleton(input.skeleton)).slice(0, MAX_SKELETON_CHARS);
  if (!skeleton) return { ok: false, learned: 0, error: '页面骨架是空的' };

  let fields: RecipeField[] = [];
  try { fields = JSON.parse(recipe.fields) as RecipeField[]; } catch { /* 坏配置当空 */ }
  if (fields.length === 0) return { ok: false, learned: 0, error: '这个配方没说要抓什么字段' };

  const prompt = [
    '下面是一个网页的结构骨架（已脱敏：数字变成 NUM、中文变成 CJK，只保留标签、类名、',
    'role/data-testid 与文本形状）。请为每个字段给出能取到它的规则。',
    '',
    `站点：${recipe.origin}`,
    `要抓的字段：${fields.map((f) => `${f.key}(${f.label})`).join('、')}`,
    '',
    '骨架：',
    skeleton,
    ...(input.jsonHints ? [
      '',
      '这个页面自己请求到的 JSON 响应（路径 = 值的形状）：',
      input.jsonHints,
    ] : []),
    '',
    '只输出 JSON：',
    '{"rules":[{"key":"字段key","selectors":["css选择器"],"anchors":["紧挨着它的固定文字"],'
      + '"jsonPaths":["JSON里的路径"]}],'
      + '"options":{"readySelector":"等它出现就算加载好了","rowSelector":"列表里一行的容器","scrollScreens":0}}',
    '',
    '几条要求：',
    '· 选择器、锚点、JSON 路径都必须**确实出现在上面给的材料里**，不要凭经验编。',
    '· 类名看起来像随机哈希（如 css-1x2y3z、_3aBcD）时，优先用 [role=…] 或 [data-testid=…]，',
    '  它们在改版后活得久得多。',
    '· 页面是列表时给 rowSelector（**一行**的容器，不是整个列表的容器）；不是列表就不要给。',
    '· 首屏就能看全的页面 scrollScreens 给 0；要往下滚才有更多内容的，给一个 1..15 的数。',
  ].join('\n');

  let proposed: RecipeRule[] = [];
  let proposedOptions: RecipeOptions | null = null;
  try {
    const r = await llmComplete(input.tenantId, 'agent', [{ role: 'user', content: prompt }], { json: true, temperature: 0.2 });
    if (r.mocked) return { ok: false, learned: 0, error: '示例模型学不出真规则，请先配好模型渠道' };
    const j = JSON.parse((r.text ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '')) as {
      rules?: RecipeRule[]; options?: RecipeOptions;
    };
    proposed = Array.isArray(j?.rules) ? j.rules : [];
    proposedOptions = j?.options ?? null;
  } catch {
    return { ok: false, learned: 0, error: '模型没给出可用的规则' };
  }

  // 【机器闸】模型说了不算，逐 token 对骨架
  const verified: RecipeRule[] = [];
  for (const f of fields) {
    const p = proposed.find((x) => x?.key === f.key);
    if (!p) continue;
    const v = verifyAgainstSkeleton(
      skeleton,
      Array.isArray(p.selectors) ? p.selectors.map(String) : [],
      Array.isArray(p.anchors) ? p.anchors.map(String) : [],
    );
    // 【JSON 路径同样要逐字对上真实捕获】不验的话模型可以编一条谁也对不上的路径，
    // 而它看起来完全合法——与「模型指到旁边那个数字」是同一类错，只是换了个介质。
    // 带 `*` 的路径把通配位换成「一段非点字符」再比，仍然是在真实材料上比。
    const jsonPaths = (Array.isArray(p.jsonPaths) ? p.jsonPaths.map(String) : [])
      .filter((path) => pathSeenInHints(input.jsonHints ?? '', path))
      .slice(0, 4);
    if (v.pass || jsonPaths.length > 0) {
      verified.push({
        key: f.key, selectors: v.selectors, anchors: v.anchors,
        ...(jsonPaths.length ? { jsonPaths } : {}),
      });
    }
  }

  if (verified.length === 0) {
    return { ok: false, learned: 0, error: '模型给的规则一条都没通过校验，这一版不落库' };
  }

  // 【选项也过一道闸】readySelector / rowSelector 是要拿去 querySelector 的，
  // 模型编一个不存在的选择器不会报错——只会让每次抓取都等满超时、或者一行都取不到。
  // 判据与规则同源：token 必须出现在骨架里。
  const opts = parseOptions(JSON.stringify(proposedOptions ?? {}));
  const keptOpts: RecipeOptions = {
    ...(opts.readySelector && selectorSeenInSkeleton(skeleton, opts.readySelector)
      ? { readySelector: opts.readySelector } : {}),
    ...(opts.rowSelector && selectorSeenInSkeleton(skeleton, opts.rowSelector)
      ? { rowSelector: opts.rowSelector } : {}),
    ...(opts.scrollScreens ? { scrollScreens: opts.scrollScreens } : {}),
  };

  await prisma.scrapeRecipe.update({
    where: { id: recipe.id },
    data: {
      rules: JSON.stringify(verified),
      options: JSON.stringify(keptOpts),
      status: 'active',
      failCount: 0,
      version: { increment: 1 },
    },
  });
  return { ok: true, learned: verified.length };
}

/**
 * 遇到登录墙：**跳过、标记、通知一次**。
 *
 * 【为什么不算失败】它不是「配方坏了」——规则可能好好的，只是这个浏览器没登录。
 * 计进 failCount 会把一个完好的配方推去重学，而重学时看到的还是登录页，
 * 于是学出一堆「请登录」的规则存进去。两个错叠在一起，排查时完全看不出源头。
 *
 * 【为什么只通知一次】挂了定时的话每天都会撞上同一个登录墙。每次都通知就是每日刷屏，
 * 用户三天后就不看通知了——那比不通知更糟。靠 refId 去重（notify 的 once 选项，见那里的说明），
 * 且只在**状态从别的值变成 needs_login 的那一次**发。
 */
export async function markNeedsLogin(
  recipeId: string,
  workspaceId: string,
  origin: string,
): Promise<{ notified: boolean }> {
  const cur = await prisma.scrapeRecipe.findFirst({
    where: { id: recipeId, workspaceId },
    select: { status: true, name: true },
  });
  if (!cur) return { notified: false };

  const first = cur.status !== 'needs_login';
  await prisma.scrapeRecipe.update({
    where: { id: recipeId },
    // failCount 刻意**不动**：这不是失败，别把好配方推去重学
    data: { status: 'needs_login', lastFailAt: new Date() },
  });

  if (first) {
    await notify({
      workspaceId,
      kind: 'system',
      refId: `recipe-login:${recipeId}`,
      title: `「${cur.name}」需要你先登录一次`,
      body: `采集 ${origin} 时遇到登录页。请在那台电脑的 Chrome 里登录一次，之后会自动接着采。`,
      link: '/skills',
    });
  }
  return { notified: first };
}

/**
 * 撞上验证码 / 风控页：**跳过、标记、只通知一次**——与登录墙同一套处置。
 *
 * 【为什么不算失败】和登录墙同一条理由：配方可能好好的，只是这一次站点没让我们看。
 * 计进 failCount 会把完好的配方推去重学，而重学时学习器看到的是一张验证码页，
 * 于是学出一堆「请输入验证码」的规则——两个错叠在一起，排查时完全看不出源头。
 *
 * 【为什么和 needs_login 分成两个状态】处置一样，但**给用户的下一步完全不同**：
 * 登录墙要他去登录，风控要他等一会儿或把频率调低。合成一个状态就必然给错建议，
 * 而给错建议会让他反复去做一件没用的事。
 */
export async function markRateLimited(
  recipeId: string,
  workspaceId: string,
  origin: string,
): Promise<{ notified: boolean }> {
  const cur = await prisma.scrapeRecipe.findFirst({
    where: { id: recipeId, workspaceId },
    select: { status: true, name: true },
  });
  if (!cur) return { notified: false };

  const first = cur.status !== 'rate_limited';
  await prisma.scrapeRecipe.update({
    where: { id: recipeId },
    // failCount 刻意**不动**：这不是失败
    data: { status: 'rate_limited', lastFailAt: new Date() },
  });

  if (first) {
    await notify({
      workspaceId,
      kind: 'system',
      refId: `recipe-ratelimit:${recipeId}`,
      title: `「${cur.name}」这次被站点拦下了`,
      body: `采集 ${origin} 时遇到人机验证或「访问过于频繁」。已经跳过，不算配方坏了。`
        + '过一阵子会自动再试；一直这样的话把采集频率调低一些。',
      link: '/skills',
    });
  }
  return { notified: first };
}

/**
 * 一个配方「久未成功」多少天算该提醒。
 *
 * 【为什么需要这条，而 needs_login 不够】登录墙判据认的是**明显的登录页**。
 * 但登录态过期最常见的形态不是跳登录页，而是**同一个页面渲染成了未登录视图**——
 * 结构还在、字段没了。那条路上我们只会看到「一个字段都没取到」，
 * 于是判成站点改版、拿去重学；重学时看到的仍是未登录视图，学出来的规则永远取不到值。
 * 表现就是「它一直在自己修，一直修不好」，而真正要做的只是去登录一次。
 *
 * 所以补一条**时间维度**的判据：一个曾经好过的配方连着这么多天没成功过，
 * 就明确提醒「先看看是不是登录态过期了」——这是我们能给出的最有用的一句话。
 */
export const RECIPE_STALE_DAYS = 3;

/**
 * 久未成功的配方：提醒一次，让用户先去看登录态。
 *
 * 【只提醒不改状态】它可能真的是站点改版了。改状态等于替用户下结论，
 * 而我们并不知道是哪一种——能确定的只有「它已经三天没成过了」这个事实。
 * 记录事实、给出最可能的下一步，不做推断（与采集台账同一条口径）。
 *
 * 【为什么要 lastOkAt 不为空才提醒】从来没成功过的配方是「还没学会」，
 * 那是另一件事（status=learning），提醒他去检查登录态只会把人带偏。
 */
export async function noticeStaleRecipes(workspaceId: string, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - RECIPE_STALE_DAYS * 86_400_000);
  const stale = await prisma.scrapeRecipe.findMany({
    where: {
      workspaceId,
      status: { in: ['active', 'broken'] },
      lastOkAt: { not: null, lt: cutoff },
    },
    select: { id: true, name: true, origin: true, lastOkAt: true },
    take: 20,
  });

  for (const r of stale) {
    const days = Math.floor((now - (r.lastOkAt?.getTime() ?? now)) / 86_400_000);
    await notify({
      workspaceId,
      kind: 'system',
      // 【refId 带天数 + once】天数让「情况恶化」能再响一次（3 天 → 10 天是两条不同的提醒），
      // once 让**同一天里**只响一次。
      // 原来这里只有天数，注释写的是「不带的话 notify 会按 refId 合并」——
      // 而 notify 从来不合并（它就是个裸 create）。于是 `20 */6 * * *` 一天 4 轮，
      // 同一天的 days 相同却发 4 条一模一样的，把真正要人动手的通知挤出可见列表。
      refId: `recipe-stale:${r.id}:${days}`,
      once: true,
      title: `「${r.name}」已经 ${days} 天没采到数据了`,
      body: `最可能的原因是 ${r.origin} 的登录态过期了——登录态过期时页面往往不跳登录页，`
        + '而是原地渲染成未登录的样子，我们只会看到「字段都没了」。'
        + '请在那台电脑的 Chrome 里打开这个站点看一眼；确实已登录的话，那就是站点改版，会自动重学。',
      link: '/skills',
    });
  }
  return stale.length;
}

// ── 进化：抓不到就重新学 ──────────────────────────────────────────────

/**
 * 记一次抓取结果。连续失败到阈值就转 broken，等下一次进站时重新学。
 *
 * 【为什么成功要清零而不是递减】递减会让一个「时好时坏」的配方永远卡在中间态，
 * 既不修也不报警。清零之后，broken 只会由**连续**失败触发，语义清楚。
 */
export async function recordScrapeResult(
  recipeId: string,
  workspaceId: string,
  ok: boolean,
): Promise<{ status: string; shouldRelearn: boolean }> {
  const r = await prisma.scrapeRecipe.findFirst({ where: { id: recipeId, workspaceId }, select: { failCount: true } });
  if (!r) return { status: 'missing', shouldRelearn: false };

  if (ok) {
    await prisma.scrapeRecipe.update({
      where: { id: recipeId },
      // 采到了就说明登录/风控都过去了——needs_login 与 rate_limited 一并恢复
      data: { failCount: 0, status: 'active', lastOkAt: new Date() },
    });
    return { status: 'active', shouldRelearn: false };
  }

  const next = r.failCount + 1;
  const broken = next >= RECIPE_BROKEN_AT;
  await prisma.scrapeRecipe.update({
    where: { id: recipeId },
    data: { failCount: next, lastFailAt: new Date(), ...(broken ? { status: 'broken' } : {}) },
  });
  return { status: broken ? 'broken' : 'active', shouldRelearn: broken };
}
