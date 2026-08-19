import { prisma } from '../db';
import { parseJson, toJson } from '../json';
import { llmComplete } from '../llm/gateway';
import { sendOpsAlert } from '../ops/alert';
import { createLogger } from '../logger';

const log = createLogger({ module: 'parser-learn' });

// ── 采集自学习：从「看得见」到「自己修得好」 ──────────────────────────────────
//
// 【链路】采不到 → 插件上传**脱敏结构骨架** → 合并成事件 → 模型推断新锚点（候选规则）
//        → 影子验证命中率 → 人工审核 → 规则包下发（插件当天用上，不必发版）→ 可回滚。
//
// 【三条硬规矩】
// 1. **骨架里不许有内容**。上传的是标签/类名/属性名与文本的**形状**（数字→NUM、中文→CJK），
//    不含正文、昵称、链接、图片。服务端收到后再脱敏一次——客户端上传的东西一律不信。
// 2. **候选规则不许自动上线**。模型很可能指到旁边那个数字（抖音「关注 178 / 粉丝 328.3万」
//    那次事故的形状），自动上线 = 把一个看着正常、实际差三个数量级的数字写进所有人的库。
// 3. **命中率是 null 就说 null**。没验证过不等于 0，也不等于 1；界面上要显示「未验证」。

/** 骨架的大小上限。超了截断——一份 MB 级的 DOM 摘要既喂不进模型，也不该占着库。 */
export const MAX_SKELETON_CHARS = 20_000;

/** 一个事件最多留几次样本（撞多了只加计数，不重复存骨架）。 */
export const MAX_SAMPLES_KEPT = 20;

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

  if (existing) {
    await prisma.parserIncident.update({
      where: { id: existing.id },
      data: {
        samples: Math.min(existing.samples + 1, MAX_SAMPLES_KEPT),
        // 已经有骨架就不覆盖：第一份多半来自最早发现的那个用户，覆盖没有收益，
        // 反而让每次上传都写一次大字段。
        skeleton: existing.skeleton || skeleton,
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

// ── 诊断：让模型从骨架里推断新锚点 ────────────────────────────────────────────

export type ProposeResult =
  | { ok: true; ruleId: string; selectors: string[]; anchors: string[] }
  | { ok: false; error: string };

export async function proposeSelectors(incidentId: string, tenantId: string | null): Promise<ProposeResult> {
  const incident = await prisma.parserIncident.findUnique({ where: { id: incidentId } });
  if (!incident) return { ok: false, error: '事件不存在' };
  if (!incident.skeleton) return { ok: false, error: '这条事件还没有页面结构样本，没法诊断' };

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
        content: `平台：${incident.platform}\n目标字段：${incident.field}\n结构骨架：\n${incident.skeleton}`,
      },
    ],
    { temperature: 0.2, json: true },
  );

  if (res.mocked) {
    // Mock 会编出一组看着像模像样的选择器。把它写进候选规则，人工审核时几乎分辨不出来。
    return { ok: false, error: '还没接入真实模型（示例模型会编造选择器），无法诊断' };
  }

  const parsed = parseJson<{ selectors?: string[]; anchors?: string[]; note?: string }>(res.text, {});
  const selectors = (parsed.selectors ?? []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 6);
  const anchors = (parsed.anchors ?? []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 6);
  if (selectors.length === 0 && anchors.length === 0) {
    return { ok: false, error: '模型没能给出可用的选择器' };
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
