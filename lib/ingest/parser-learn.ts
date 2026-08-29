import { prisma } from '../db';
import { parseJson, toJson } from '../json';
import { llmComplete, llmVision } from '../llm/gateway';
import { sendOpsAlert } from '../ops/alert';
import { createLogger } from '../logger';

const log = createLogger({ module: 'parser-learn' });

// ── 采集自学习：从「看得见」到「自己修得好」 ──────────────────────────────────
//
// 【链路】采不到 → 插件上传**脱敏结构骨架**（正看着的页面还会带一张压缩截图）
//        → 合并成事件 → 模型推断新锚点（候选规则）→ 骨架静态验证（机器硬闸）
//        → 自动上线（2026-08-26 起；冷静期+告警+一键回滚）或人工审核
//        → 规则包下发（插件当天用上，不必发版）→ 可回滚。
//
// 【三条硬规矩】
// 1. **骨架里不许有内容**。上传的是标签/类名/属性名与文本的**形状**（数字→NUM、中文→CJK），
//    不含正文、昵称、链接、图片。服务端收到后再脱敏一次——客户端上传的东西一律不信。
//    （截图是这条的**显式例外**：只在用户正看着的页面失败时截、只用于排障、30 天清空，
//    三份隐私政策都写了；后台自动回填那些用户没在看的页面绝不截。）
// 2. **没过机器验证的候选不许自动上线**。模型很可能指到旁边那个数字（抖音「关注 178 /
//    粉丝 328.3万」那次事故的形状）。自动上线的前提是 verifyAgainstSkeleton 逐 token
//    对上骨架；人工回滚过的字段 24h 冷静期内不再自动上线（autoAdoptIncident）。
// 3. **命中率是 null 就说 null**。没验证过不等于 0，也不等于 1；界面上要显示「未验证」。

/** 骨架的大小上限。超了截断——一份 MB 级的 DOM 摘要既喂不进模型，也不该占着库。 */
export const MAX_SKELETON_CHARS = 20_000;

/** 一个事件最多留几次样本（撞多了只加计数，不重复存骨架）。 */
export const MAX_SAMPLES_KEPT = 20;

/**
 * 失败现场截图（dataUrl）的大小上限。
 *
 * 【为什么是 150K 字符】生产的 WAF 对超过 client_body_buffer_size（约 256KB）的请求体
 * 会回「HTTP 200 + HTML 错误页」——插件看到的是一次假成功，连骨架都一起丢。
 * 截图 150K + 骨架 60K + JSON 外壳 ≈ 220K，压在阈值之下。插件端同一数值再闸一道。
 */
export const MAX_SCREENSHOT_CHARS = 150_000;

/**
 * 截图字段的准入闸：不是合法的 data:image JPEG/PNG/WebP、或超长，一律**丢字段不打回**
 * ——截图是锦上添花，骨架才是诊断主料，为附件拒掉整次上报本末倒置（截断不打回同一原则）。
 */
export function vetScreenshot(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SCREENSHOT_CHARS) return '';
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(raw) ? raw : '';
}

export type SkeletonNode = {
  tag: string;
  cls?: string[];
  /** data-* / aria-* 之类的属性**名**（不含值：值里可能是用户 ID） */
  attrs?: string[];
  /** 文本的形状，如 "NUM万" / "CJK" / "NUM" */
  shape?: string;
  children?: SkeletonNode[];
};

const TEXT_SHAPE_MAX = 24;

/**
 * 文本 → 形状。**这是脱敏的核心**：把「张三的美食日记」变成「CJK」，把「12.3万」变成「NUM万」。
 * 模型要的是「这个位置是个带万字的数字」，不需要知道那个数字属于谁。
 */
export function textShape(raw: string): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  // ⚠️ 必须**一次扫描**替换，不能链式 replace：链式的话前一步产出的 'NUM'/'CJK'
  // 会被后一步的 /[A-Za-z]{3,}/ 再替换成 'EN'（单测抓到的真 bug——「粉丝 328.3万」曾变成「粉丝 EN万」）。
  return t
    .replace(/(\d+(?:\.\d+)?)|([一-龥]+)|([A-Za-z]{3,})/g, (_m, num, cjk, en) => {
      if (num) return 'NUM';
      if (cjk) return cjk.length <= 2 ? cjk : 'CJK'; // 「粉丝」「获赞」这类短标签要留：它们正是文本锚点
      if (en) return 'EN';
      return _m;
    })
    .slice(0, TEXT_SHAPE_MAX);
}

const ALLOWED_ATTR = /^(data-[\w-]+|aria-[\w-]+|role|type|id)$/;

/**
 * 服务端再脱敏一次。客户端**可能被改**（插件是本地代码，用户能改），
 * 所以这里不假设上传的东西已经干净：属性只留名字、文本一律过 textShape、深度与体积都封顶。
 */
export function sanitizeSkeleton(raw: unknown, depth = 0): SkeletonNode | null {
  if (!raw || typeof raw !== 'object' || depth > 8) return null;
  const n = raw as Record<string, unknown>;
  const tag = typeof n.tag === 'string' ? n.tag.toLowerCase().slice(0, 20) : '';
  if (!tag || !/^[a-z][a-z0-9-]*$/.test(tag)) return null;

  const out: SkeletonNode = { tag };
  if (Array.isArray(n.cls)) {
    out.cls = n.cls.filter((c): c is string => typeof c === 'string').slice(0, 8).map((c) => c.slice(0, 40));
  }
  if (Array.isArray(n.attrs)) {
    // 只留属性名，且只留白名单形状的——`href` / `src` / `alt` 里可能带用户 ID、昵称、图片地址
    out.attrs = n.attrs
      .filter((a): a is string => typeof a === 'string' && ALLOWED_ATTR.test(a))
      .slice(0, 8);
  }
  if (typeof n.shape === 'string' && n.shape) out.shape = textShape(n.shape);
  else if (typeof n.text === 'string' && n.text) out.shape = textShape(n.text);

  if (Array.isArray(n.children)) {
    const kids = n.children
      .slice(0, 20)
      .map((c) => sanitizeSkeleton(c, depth + 1))
      .filter((c): c is SkeletonNode => c !== null);
    if (kids.length) out.children = kids;
  }
  return out;
}

export function serializeSkeleton(node: SkeletonNode | null): string {
  if (!node) return '';
  return toJson(node).slice(0, MAX_SKELETON_CHARS);
}

// ── 事件 ────────────────────────────────────────────────────────────────────

export function incidentFingerprint(platform: string, scope: string, field: string): string {
  return `${platform}:${scope}:${field}`;
}

export type RecordIncidentInput = {
  workspaceId: string;
  platform: string;
  scope: 'rival' | 'self';
  field: string;
  skeleton?: unknown;
  /** 失败现场截图（dataUrl）。这里收 unknown，vetScreenshot 说了算——插件是可改的本地代码 */
  screenshot?: unknown;
  note?: string;
};

/**
 * 记一次「这个字段采不到」。同指纹的合并计数，不每次都建新行——
 * 一个平台改版会在几百个用户那里同时发生，一人一行的话运维台会被同一件事刷屏。
 */
export async function recordParserIncident(input: RecordIncidentInput): Promise<{ id: string; created: boolean }> {
  const fingerprint = incidentFingerprint(input.platform, input.scope, input.field);
  const existing = await prisma.parserIncident.findFirst({
    where: { fingerprint, status: { in: ['open', 'proposed'] } },
    orderBy: { createdAt: 'desc' },
  });

  const skeleton = serializeSkeleton(sanitizeSkeleton(input.skeleton));
  const screenshot = vetScreenshot(input.screenshot);

  if (existing) {
    await prisma.parserIncident.update({
      where: { id: existing.id },
      data: {
        samples: Math.min(existing.samples + 1, MAX_SAMPLES_KEPT),
        // 已经有骨架就不覆盖：第一份多半来自最早发现的那个用户，覆盖没有收益，
        // 反而让每次上传都写一次大字段。截图同一政策。
        skeleton: existing.skeleton || skeleton,
        screenshot: existing.screenshot || screenshot,
        note: input.note?.slice(0, 300) || existing.note,
      },
    });
    return { id: existing.id, created: false };
  }

  const row = await prisma.parserIncident.create({
    data: {
      workspaceId: input.workspaceId,
      platform: input.platform,
      scope: input.scope,
      field: input.field,
      fingerprint,
      skeleton,
      screenshot,
      note: input.note?.slice(0, 300) ?? '',
    },
  });
  // 第一次出现才告警：同指纹后续只是计数，再响就是刷屏（告警一吵就会被关掉）
  await sendOpsAlert({
    level: 'warn',
    title: `解析疑似失效：${input.platform} 的 ${input.field}`,
    lines: [
      `${input.scope === 'self' ? '自有' : '竞对'}采集读不到「${input.field}」，已留结构样本待诊断。`,
      '到运维台 /ops/parser 可以让模型从脱敏结构里推断新锚点。',
    ],
    fingerprint: `parser-incident:${fingerprint}`,
  }).catch(() => { /* 告警失败不影响留证 */ });
  return { id: row.id, created: true };
}

// ── 骨架静态验证：把「绝不编造」从提示词软约束变成机器硬闸 ─────────────────────
//
// 【为什么必须有】提示词里写着「绝不编造骨架里不存在的类名」，但那只是请求；
// 自动上线（2026-08-26 用户授权自学习闭环）之前，必须机器验一遍：
// 选择器里的每个类名/属性 token、每个文本锚点，都要真的出现在这次的骨架样本里。
// 通不过的**逐条剔除**而不是整批拒——模型常常一半真一半编，把真的留下来。

/** 从一条 CSS 选择器里抽出可验证的 token（类名 / 属性名 / id）。 */
export function selectorTokens(selector: string): string[] {
  const out: string[] = [];
  for (const m of selector.matchAll(/\.([\w-]{3,})/g)) out.push(m[1]);
  for (const m of selector.matchAll(/\[([\w-]{3,})/g)) out.push(m[1]);
  for (const m of selector.matchAll(/#([\w-]{3,})/g)) out.push(m[1]);
  return out;
}

/**
 * 候选在骨架文本上的验证。返回**通过的子集**。
 * 判据刻意保守：token 长度 ≥3 才参与（避免 `.a` 这类误配），
 * 纯标签选择器（div > span，一个 token 都没有）不算通过——那是结构猜测，改版最先碎的就是它。
 */
// ── 锚点不许是人名（2026-08-29）────────────────────────────────────────
//
// 【为什么这条必须有，而且必须在咽喉处】
// 脱敏规则是「纯数字→NUM、**连续 4 个以上**中文→CJK」，所以两三个字的中文原样保留——
// 这是刻意的，因为「粉丝」「点赞」「标题」全是两个字，把阈值降到 2 等于抹掉所有可用锚点。
// 代价是**两三个字的人名也原样保留**，可能被模型选成锚点。
//
// 而 activeRulePack() **没有租户过滤**：解析规则是全局下发到每个用户插件的。
// 一个人名混进规则，就会被推送给所有人——这不是「某个租户的数据留在自己库里」，
// 是跨租户分发。所以判据放进 verifyAgainstSkeleton：两条学习链路
//（插件自学习 / 任意站点配方）都走它，谁也绕不过去。
//
// 【判据与它的边界，说清楚】按「常见姓氏打头 + 长度 2~3 + 全中文」拦。
// 这挡得住绝大多数中文姓名，但**挡不住外文名**（"John Smith" 这类在骨架里也原样保留，
// 而按空格+大写去猜会误杀 "Sign In"、"Read More" 这类真标签）。
// 误杀的代价只是少一个锚点候选——选择器仍在，其它锚点仍在；漏放的代价是跨租户泄一个名字。
// 两边不对等，所以宁可误杀。
const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴鬱胥能苍双闻莘党翟谭贡劳逄';

/** 这个锚点像不像一个人名。见上面那段的判据与边界。 */
export function looksLikePersonalName(raw: string): boolean {
  const t = String(raw ?? '').trim();
  if (t.length < 2 || t.length > 3) return false;
  if (!/^[\u4e00-\u9fa5]+$/.test(t)) return false; // 只判全中文
  return SURNAMES.includes(t[0]);
}


export function verifyAgainstSkeleton(
  skeleton: string,
  selectors: string[],
  anchors: string[],
): { selectors: string[]; anchors: string[]; pass: boolean } {
  const okSelectors = selectors.filter((sel) => {
    const tokens = selectorTokens(sel);
    return tokens.length > 0 && tokens.every((t) => skeleton.includes(t));
  });
  // 【人名一律不收】见上面 looksLikePersonalName 那段：规则包是全局下发的，
  // 一个人名混进去会被推送给所有用户。这一层是咽喉——两条学习链路都走这里。
  const okAnchors = anchors.filter((a) => a.length >= 2 && skeleton.includes(a) && !looksLikePersonalName(a));
  return { selectors: okSelectors, anchors: okAnchors, pass: okSelectors.length > 0 || okAnchors.length > 0 };
}

// ── 诊断：让模型从骨架里推断新锚点 ────────────────────────────────────────────

export type ProposeResult =
  | { ok: true; ruleId: string; selectors: string[]; anchors: string[] }
  | { ok: false; error: string };

/**
 * 让视觉模型看一眼失败现场截图，说清目标字段出现在页面哪个区域、旁边有什么标签文字。
 *
 * 产出只是给诊断模型的**参考语境**，绝不成为选择器的依据——选择器仍要逐 token
 * 过 verifyAgainstSkeleton 的机器验证，视觉模型编出来的类名一样会被剔掉。
 * 没配视觉模型（llmVision 诚实返回 not_configured）或调用失败：跳过，诊断照跑。
 */
async function screenshotHint(
  tenantId: string | null,
  incident: { platform: string; field: string; screenshot: string },
): Promise<string | null> {
  if (!incident.screenshot) return null;
  const res = await llmVision(
    tenantId,
    [
      {
        role: 'system',
        content:
          '你在帮排查一次网页数据解析失败。只回答两件事：'
          + '① 目标字段的数值大概出现在截图哪个区域（如「头部资料区左侧」「作品卡片右下角标」）；'
          + '② 它紧挨着什么标签文字（如「粉丝」「获赞」）。'
          + '120 字以内，中文。看不到目标字段就如实说「截图里没看到」。不要编造类名或代码。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `平台：${incident.platform}，目标字段：${incident.field}。` },
          { type: 'image_url', image_url: { url: incident.screenshot } },
        ],
      },
    ],
    { temperature: 0 },
  );
  if (!res.ok) {
    if (res.reason === 'failed') log.warn('截图视觉描述失败，诊断照常走骨架', { error: res.error });
    return null;
  }
  const hint = res.text.trim().slice(0, 300);
  return hint || null;
}

export async function proposeSelectors(incidentId: string, tenantId: string | null): Promise<ProposeResult> {
  const incident = await prisma.parserIncident.findUnique({ where: { id: incidentId } });
  if (!incident) return { ok: false, error: '事件不存在' };
  if (!incident.skeleton) return { ok: false, error: '这条事件还没有页面结构样本，没法诊断' };

  // 有截图就先要一份视觉描述（没配视觉模型 = null，不影响主链路）
  const hint = await screenshotHint(tenantId, incident).catch(() => null);

  const res = await llmComplete(
    tenantId,
    'diagnosis',
    [
      {
        role: 'system',
        content: [
          '你是网页解析专家。给你一份**脱敏后的 DOM 结构骨架**（文本已被替换成形状：NUM=数字、CJK=中文段落），',
          '请推断出能定位到目标字段的 CSS 选择器候选，以及可用于就近取数的文本锚点。',
          '要求：',
          '- selectors 按可靠性排序，优先用 data-* 埋点属性，其次语义化类名，最后结构路径；',
          '- anchors 是页面上紧挨着目标数字的**短标签文字**（如「粉丝」「获赞」），没有就给空数组；',
          '- 拿不准就少给几条，**绝不编造**骨架里不存在的类名或属性。',
          '只输出 JSON：{"selectors":["..."],"anchors":["..."],"note":"一句话说明依据"}',
        ].join('\n'),
      },
      {
        role: 'user',
        content:
          `平台：${incident.platform}\n目标字段：${incident.field}\n结构骨架：\n${incident.skeleton}`
          // 视觉描述只帮模型判断「该往骨架的哪一片找」，类名依据仍然只能来自骨架本身
          + (hint ? `\n\n失败现场截图的视觉描述（另一模型看图所得，仅供定位参考，不能作为类名依据）：${hint}` : ''),
      },
    ],
    { temperature: 0.2, json: true },
  );

  if (res.mocked) {
    // Mock 会编出一组看着像模像样的选择器。把它写进候选规则，人工审核时几乎分辨不出来。
    return { ok: false, error: '还没接入真实模型（示例模型会编造选择器），无法诊断' };
  }

  const parsed = parseJson<{ selectors?: string[]; anchors?: string[]; note?: string }>(res.text, {});
  const rawSelectors = (parsed.selectors ?? []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 6);
  const rawAnchors = (parsed.anchors ?? []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 6);
  // 机器验证：编造的（骨架里找不到 token 的）逐条剔掉，剩下的才有资格成为候选
  const verified = verifyAgainstSkeleton(incident.skeleton, rawSelectors, rawAnchors);
  const selectors = verified.selectors;
  const anchors = verified.anchors;
  if (!verified.pass) {
    return { ok: false, error: '模型给的选择器在页面骨架上一个都对不上（疑似编造），已丢弃' };
  }

  const last = await prisma.parserRule.findFirst({
    where: { platform: incident.platform, field: incident.field },
    orderBy: { version: 'desc' },
  });
  const rule = await prisma.parserRule.create({
    data: {
      platform: incident.platform,
      field: incident.field,
      selectors: toJson(selectors),
      anchors: toJson(anchors),
      status: 'candidate',
      version: (last?.version ?? 0) + 1,
      source: 'llm',
      note: (parsed.note ?? '').slice(0, 300),
      incidentId: incident.id,
    },
  });
  await prisma.parserIncident.update({ where: { id: incident.id }, data: { status: 'proposed' } });
  log.info('产出候选解析规则', { platform: incident.platform, field: incident.field, version: rule.version });
  return { ok: true, ruleId: rule.id, selectors, anchors };
}

// ── 审核与下发 ──────────────────────────────────────────────────────────────

/** 采纳一条候选规则：同 platform+field 的旧 active 退休，新的上线。 */
export async function activateRule(ruleId: string, reviewedBy: string): Promise<{ ok: boolean; error?: string }> {
  const rule = await prisma.parserRule.findUnique({ where: { id: ruleId } });
  if (!rule) return { ok: false, error: '规则不存在' };
  if (rule.status === 'active') return { ok: true };

  await prisma.parserRule.updateMany({
    where: { platform: rule.platform, field: rule.field, status: 'active' },
    data: { status: 'retired' },
  });
  await prisma.parserRule.update({ where: { id: ruleId }, data: { status: 'active', reviewedBy } });
  if (rule.incidentId) {
    await prisma.parserIncident.update({ where: { id: rule.incidentId }, data: { status: 'resolved' } }).catch(() => {});
  }
  return { ok: true };
}

/** 回滚：把当前 active 退掉，把上一版重新点亮（没有上一版就只是退掉）。 */
export async function rollbackRule(platform: string, field: string, reviewedBy: string): Promise<{ ok: boolean; error?: string }> {
  const current = await prisma.parserRule.findFirst({ where: { platform, field, status: 'active' } });
  if (!current) return { ok: false, error: '这个字段当前没有生效中的规则' };
  await prisma.parserRule.update({ where: { id: current.id }, data: { status: 'retired', reviewedBy } });
  const prev = await prisma.parserRule.findFirst({
    where: { platform, field, status: 'retired', version: { lt: current.version } },
    orderBy: { version: 'desc' },
  });
  if (prev) await prisma.parserRule.update({ where: { id: prev.id }, data: { status: 'active', reviewedBy } });
  return { ok: true };
}

// ── 自动采纳（2026-08-26 用户授权「可以自我学习，不要因为网页改了无法抓取」）────
//
// 之前的闭环卡在「人工点头才下发」。现在：骨架验证通过 → 自动上线 → 发告警留痕，
// 运维台随时一键回滚。三道闸守住「自动」不变成「放飞」：
//   ① 机器验证：候选 token 必须真在骨架里（proposeSelectors 内已剔编造）；
//   ② 冷却：同 platform+field 的自动规则 24h 内被人回滚过 → 不再自动，留给人审；
//   ③ 兜底：下发后仍有既有的量级闸/坏值拒绝（parser-health）挡住学歪了的规则。
export async function autoAdoptIncident(
  incidentId: string,
  tenantId: string | null,
): Promise<{ adopted: boolean; reason: string }> {
  const incident = await prisma.parserIncident.findUnique({ where: { id: incidentId } });
  if (!incident || incident.status !== 'open') return { adopted: false, reason: '事件不存在或已处理' };

  // 冷却判据：这个字段上一条「自动上线」的规则最近 24h 被人退掉了 —— 说明自动学的不靠谱，让人来
  const recentAutoRollback = await prisma.parserRule.findFirst({
    where: {
      platform: incident.platform,
      field: incident.field,
      source: 'llm',
      status: 'retired',
      reviewedBy: { not: 'auto' },
      updatedAt: { gte: new Date(Date.now() - 24 * 3600_000) },
    },
  });
  if (recentAutoRollback) return { adopted: false, reason: '24h 内该字段的自动规则被人工回滚过，冷却中' };

  const p = await proposeSelectors(incidentId, tenantId);
  if (!p.ok) return { adopted: false, reason: p.error };

  const act = await activateRule(p.ruleId, 'auto');
  if (!act.ok) return { adopted: false, reason: act.error ?? '上线失败' };

  // 留痕告警：自动学了新规则这件事必须有人知道，且告警里就带着回滚的路
  await sendOpsAlert({
    level: 'info',
    title: `🧠 解析自学习：${incident.platform} 的 ${incident.field} 已自动上线新规则`,
    lines: [
      '插件报改版 → 模型从脱敏骨架推断 → 骨架验证通过 → 已自动下发（插件当天生效）。',
      `选择器：${p.selectors.join(' , ') || '（走文本锚点）'}`,
      '学歪了就去 /ops/parser 一键回滚；回滚后 24h 内该字段不再自动上线。',
    ],
    fingerprint: `parser-auto:${incident.platform}:${incident.field}:v`,
  }).catch(() => { /* 告警失败不拦上线：规则本身已可回滚 */ });

  log.info('解析规则自动上线', { platform: incident.platform, field: incident.field });
  return { adopted: true, reason: 'ok' };
}

/** 影子验证回传的命中率。**只记不判**——够不够格上线由人看着数字决定。 */
export async function recordHitRate(ruleId: string, hitRate: number): Promise<void> {
  if (!Number.isFinite(hitRate) || hitRate < 0 || hitRate > 1) return;
  await prisma.parserRule.update({ where: { id: ruleId }, data: { hitRate } }).catch(() => {});
}

export type RulePack = {
  version: string;
  rules: { platform: string; field: string; selectors: string[]; anchors: string[]; version: number }[];
};

/**
 * 插件拉的规则包。只给 active 的。
 *
 * version 用「最新一条 active 的更新时间」拼出来，插件据此判断要不要换缓存——
 * 用条数或哈希都行，但时间戳最容易在日志里对上「用户手上是哪一版」。
 */
export async function activeRulePack(): Promise<RulePack> {
  const rows = await prisma.parserRule.findMany({
    where: { status: 'active' },
    orderBy: [{ platform: 'asc' }, { field: 'asc' }],
  });
  const latest = rows.reduce((acc, r) => Math.max(acc, r.updatedAt.getTime()), 0);
  return {
    version: latest ? String(latest) : '0',
    rules: rows.map((r) => ({
      platform: r.platform,
      field: r.field,
      selectors: parseJson<string[]>(r.selectors, []),
      anchors: parseJson<string[]>(r.anchors, []),
      version: r.version,
    })),
  };
}

// ── 保留期：截图 30 天清空 ───────────────────────────────────────────────────

/** 截图最长保存天数。诊断在事发当天就跑完了，截图长期躺着只剩风险没有用途。 */
export const SCREENSHOT_RETENTION_DAYS = 30;

/**
 * 清空超期的失败现场截图（只清 screenshot 列，骨架与事件本身保留）。
 * 挂在合规保留期任务（lib/legal/retention.ts）里每天跑；按 updatedAt 算——
 * 一条还在活跃合并样本的事件，它的截图也跟着事件的活跃时间走。
 */
export async function purgeParserScreenshots(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SCREENSHOT_RETENTION_DAYS * 24 * 3600_000);
  const r = await prisma.parserIncident.updateMany({
    where: { screenshot: { not: '' }, updatedAt: { lt: cutoff } },
    data: { screenshot: '' },
  });
  return r.count;
}
