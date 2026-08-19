import { prisma } from './db';
import { parseJson, type Metrics } from './json';
import { readPersona, personaPromptBlock, type PersonaCard } from './persona';
import { readFingerprint, fingerprintPromptBlock, type StyleFingerprint } from './style';
import { materialContextForAccount, catchphrasePromptBlock, loadMaterials } from './material';
import { buildMemoryContext } from './memory/core';
import { buildBaseline, type MetricBaseline } from './algorithm/coach';
import { heatForSort } from './insight/heat';
import { accountPlatformProfiles } from './insight/learn';
import { platformName } from './constants';
import { topBuckets } from './ingest/own-account';

// 统一账号上下文构造器（方案一期基建）。
//
// 收敛此前散落在 pipeline / scoring / combine / advisor / studio 各处、各自手拼的账号上下文块，
// 让「哪个功能带哪些块」变成一处可声明的契约，杜绝块组合漂移与重复兜底（safePersona / 双份 system prompt）。
//
// 六块：
//   persona     人设卡（personaPromptBlock）
//   fingerprint 风格指纹（fingerprintPromptBlock，含被数据验证的擅长选题）
//   exemplar    风格原句样本（few-shot：他自己写过的整段真文字，见下方 exemplarBlock 的长注释）
//   catchphrase 口头禅（语气资产，与素材分开）
//   material    素材库（真实经历/观点，差异化生成原料）
//   memory      长期记忆（语义召回，可带 query）
//   baseline    真实数据基线（PublishRecord + OwnPost；给定 platform 则单平台，否则跨平台画像）
//   audience    受众画像（性别/年龄/地域，来自创作者后台回填；无数据则整块缺席）
//   competitor  本工作区订阅竞对近期高热作品
//
// 设计原则：任何块在数据缺失时都返回空串，绝不注入占位噪声——「越用越懂」不能靠喂假上下文。

export type AccountContextBlock =
  | 'persona'
  | 'fingerprint'
  | 'exemplar'
  | 'catchphrase'
  | 'material'
  | 'memory'
  | 'baseline'
  | 'audience'
  | 'competitor';

export interface AccountContextInput {
  workspaceId: string;
  accountId: string;
  blocks: AccountContextBlock[];
  // memory 块的语义召回 query（如当前选题/热点/议题）；不传则按置信度召回
  memoryQuery?: string;
  // baseline 块：给定平台 → 单平台基线；不给 → 跨平台账号画像
  platform?: string;
  competitorLimit?: number;
  // 预算裁剪（字符数）：超出时按保留优先级丢弃整块，persona 永远保留
  maxChars?: number;
  // 调用方已握有的账号记录，避免重复查库（需含 personaCard 与 styleFingerprint）
  account?: { personaCard: string; styleFingerprint: string } | null;
}

export interface AccountContext {
  persona: PersonaCard;
  fingerprint: StyleFingerprint;
  // 各块文本（空块为空串，未请求的块 key 缺席）
  parts: Partial<Record<AccountContextBlock, string>>;
  // 按可读顺序拼好、已做预算裁剪的完整上下文
  text: string;
}

// 阅读顺序：人设 → 指纹 → 原句样本 → 口头禅 → 素材 → 基线 → 竞对 → 记忆
// （记忆放最后，标注「可能过时仅供参考」贴近其语义）
const READ_ORDER: AccountContextBlock[] = [
  'persona', 'fingerprint', 'exemplar', 'catchphrase', 'material', 'baseline', 'audience', 'competitor', 'memory',
];
// 预算吃紧时的保留优先级：人设与记忆是「你是谁 + 你的口味」的地基，最先保；素材/竞对最先舍。
// audience 排在 fingerprint 之后：它是「读者是谁」的事实，比竞对/素材更该保。
//
// ⚠️ exemplar **排在 fingerprint 之前**，这是本表唯一一处需要解释的顺序：
// 指纹是把文风压成「幽默(80%)」这样的标签，是有损压缩；原句样本是无损的。
// 预算只够留一个时，留原句——模型能从三段真文字里学到的东西，远多于三个形容词。
const KEEP_PRIORITY: AccountContextBlock[] = [
  'persona', 'exemplar', 'memory', 'baseline', 'catchphrase', 'audience', 'fingerprint', 'competitor', 'material',
];

export async function buildAccountContext(input: AccountContextInput): Promise<AccountContext> {
  const { workspaceId, accountId } = input;
  const want = new Set(input.blocks);

  const account =
    input.account !== undefined
      ? input.account
      : await prisma.creatorAccount.findUnique({
          where: { id: accountId },
          select: { personaCard: true, styleFingerprint: true },
        });
  const persona = readPersona(account?.personaCard ?? '{}');
  const fingerprint = readFingerprint(account?.styleFingerprint ?? '{}');

  const parts: Partial<Record<AccountContextBlock, string>> = {};
  if (want.has('persona')) parts.persona = personaPromptBlock(persona);
  if (want.has('fingerprint')) parts.fingerprint = fingerprintPromptBlock(fingerprint);

  // 异步块并行取，互不阻塞
  const jobs: Promise<void>[] = [];
  if (want.has('material')) {
    jobs.push(materialContextForAccount(accountId).then((t) => { parts.material = t; }));
  }
  if (want.has('catchphrase')) {
    jobs.push(loadMaterials(accountId).then((m) => { parts.catchphrase = catchphrasePromptBlock(m); }));
  }
  if (want.has('exemplar')) {
    jobs.push(exemplarBlock(accountId, input.platform).then((t) => { parts.exemplar = t; }));
  }
  if (want.has('baseline')) {
    jobs.push(accountBaselineBlock(accountId, input.platform).then((t) => { parts.baseline = t; }));
  }
  if (want.has('audience')) {
    jobs.push(audienceBlock(accountId, input.platform).then((t) => { parts.audience = t; }));
  }
  if (want.has('competitor')) {
    jobs.push(competitorContextBlock(workspaceId, input.competitorLimit).then((t) => { parts.competitor = t; }));
  }
  if (want.has('memory')) {
    jobs.push(buildMemoryContext(workspaceId, accountId, input.memoryQuery).then((t) => { parts.memory = t; }));
  }
  await Promise.all(jobs);

  const text = composeParts(parts, input.maxChars);
  return { persona, fingerprint, parts, text };
}

// 按保留优先级做预算裁剪，再按阅读顺序拼装
function composeParts(parts: Partial<Record<AccountContextBlock, string>>, maxChars?: number): string {
  const nonEmpty = (b: AccountContextBlock) => {
    const t = parts[b];
    return typeof t === 'string' && t.trim().length > 0;
  };
  let keep = new Set(READ_ORDER.filter(nonEmpty));
  if (maxChars && maxChars > 0) {
    keep = new Set<AccountContextBlock>();
    let used = 0;
    for (const b of KEEP_PRIORITY) {
      if (!nonEmpty(b)) continue;
      const len = parts[b]!.length + 2; // 计入分隔符
      if (b === 'persona' || used + len <= maxChars) {
        keep.add(b);
        used += len;
      }
    }
  }
  return READ_ORDER.filter((b) => keep.has(b))
    .map((b) => parts[b]!)
    .join('\n\n');
}

// ── 基线块 ──

// 账号在单个平台的真实数据基线（PublishRecord 发布回流 + OwnPost 历史作品，各取近 20 条）
export async function loadPlatformBaseline(accountId: string, platform: string): Promise<MetricBaseline> {
  const [records, ownPosts] = await Promise.all([
    prisma.publishRecord.findMany({
      where: { accountId, platform },
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: { metrics: true },
    }),
    prisma.ownPost.findMany({
      where: { accountId, platform },
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: { metrics: true },
    }),
  ]);
  const list = [...records, ...ownPosts]
    .map((r) => parseJson<Metrics>(r.metrics, {}))
    .filter((m) => (m.views ?? 0) > 0);
  return buildBaseline(list);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// 基线注入块：给定平台 → 单平台一行；否则跨平台画像（各平台一行，按均播放降序）。
// 无回流数据一律返回空串——traffic/personaFit 打分宁可没有基线，也不能拿零数据充数。
export async function accountBaselineBlock(accountId: string, platform?: string): Promise<string> {
  if (platform) {
    const b = await loadPlatformBaseline(accountId, platform);
    if (b.sample === 0) return '';
    // ⚠️ 这段是**喂给模型**的事实块。抖音这类平台公开页没有播放量，率类指标全是 null——
    // 那就**整项不写**，绝不写成「点赞率 0.0%」：模型会拿它当真实观测，
    // 然后一本正经地建议你「点赞率过低要改开头」，而你的号根本没有这个数据。
    const parts = [`近 ${b.sample} 条`];
    if (b.avgViews !== null) parts.push(`均播放 ${b.avgViews}`);
    if (b.avgCompletion !== null) parts.push(`完播/完读 ${pct(b.avgCompletion)}`);
    if (b.likeRate !== null) parts.push(`点赞率 ${pct(b.likeRate)}`);
    if (b.commentRate !== null) parts.push(`评论率 ${pct(b.commentRate)}`);
    if (b.collectRate !== null) parts.push(`收藏率 ${pct(b.collectRate)}`);
    if (b.avgViews === null) parts.push('（该平台公开页不提供播放量，率类指标不可得；点赞/评论/收藏/转发的绝对数是真实的）');
    const line = `${platformName(platform)}：${parts.join('，')}`;
    return `【账号真实数据基线】\n${line}`;
  }
  const profiles = await accountPlatformProfiles(accountId);
  const lines = profiles
    .filter((p) => p.sample > 0)
    .map(
      (p) =>
        `${platformName(p.platform)}：近 ${p.sample} 条均播放 ${p.avgViews}，完播/完读 ${
          p.avgCompletion === null ? '无' : pct(p.avgCompletion)
        }${p.engagement === null ? '' : `，互动率 ${pct(p.engagement)}`}`,
    );
  return lines.length ? `【账号真实数据基线（各平台历史表现）】\n${lines.join('\n')}` : '';
}

// ── 竞对块 ──

// 本工作区订阅竞对的近期高热作品（供智囊团竞对席、爆款拆解席引用）
export async function competitorContextBlock(workspaceId: string, limit = 8): Promise<string> {
  const watch = await prisma.watchlistItem.findMany({
    where: { workspaceId },
    select: { competitorId: true },
  });
  if (watch.length === 0) return '';
  const posts = await prisma.crawledPost.findMany({
    where: { competitorId: { in: watch.map((w) => w.competitorId) } },
    orderBy: { publishedAt: 'desc' },
    take: Math.max(limit * 6, 60),
  });
  if (posts.length === 0) return '';
  // ⚠️ 此前这里按 hotScore 排、并对模型说「热度 N」。hotScore 是 `views / 20000`，
  // 没有播放量的平台恒为 0 —— 模型收到的是「这些作品热度 0」，那是编的。
  // 改成按互动量排，并把**真实的数**告诉它（点赞/评论这些是真采到的）。
  const ranked = [...posts]
    .sort((a, b) => heatForSort(parseJson<Metrics>(b.metrics, {})) - heatForSort(parseJson<Metrics>(a.metrics, {})))
    .slice(0, limit);
  const lines = ranked.map((p) => {
    const m = parseJson<Metrics>(p.metrics, {});
    const bits = [
      m.views ? `播放 ${m.views}` : '',
      m.likes ? `点赞 ${m.likes}` : '',
      m.comments ? `评论 ${m.comments}` : '',
    ].filter(Boolean);
    return `- 【${platformName(p.platform)}】${p.title}${bits.length ? `（${bits.join('，')}）` : ''}`;
  });
  return `【订阅竞对近期高热作品】\n${lines.join('\n')}`;
}

// ─────────────────────────── 风格原句样本块（few-shot） ───────────────────────────
//
// 【为什么必须是原句，不能是标签】
// 风格指纹给模型的是「语气风格：幽默(80%)、口语化(70%)」。这是把一个人的文风做了一次**有损压缩**，
// 压成了几个所有人共用的形容词。模型收到「幽默」，只能回给你**它理解的平均幽默**——
// 那正是「AI 味」的定义：分布的中心化。
// 风格活在具体的句子里：句子多长、在哪断、爱用哪个连接词、用不用感叹号、怎么开头、怎么收尾。
// 这些东西没法用标签表示，只能把原文整段给它看。
//
// 【样本从哪来，为什么是这个顺序】
//   ① 素材库里 type='sample' 的「文风样本」——用户明确指定的代表作，最可信；
//   ② PublishRecord.contentText——他真的发出去过的正文（同平台优先，播放高优先）；
//   ③ DraftVersion(authorType='human')——他亲手写/改过的终稿。
// 注意 **OwnPost 不在其列**：那张表只有标题没有正文（contentRef 是链接），拿不到可模仿的文字。
//
// 【一条硬指令】prompt 里必须写死「只学怎么说，不要抄内容」。否则模型会把样本里的经历
// 当成用户的经历写进新稿——那是**编造事实**，比 AI 味严重得多。

export type StyleExemplar = { source: 'sample' | 'published' | 'human_draft'; label: string; text: string };

// 单条样本截断长度：够看出句式节奏，又不至于一条就吃掉整个预算
const EXEMPLAR_CHARS = 600;
// 太短的东西看不出文风（一句话的草稿版本、一行的发布记录）
const EXEMPLAR_MIN_CHARS = 80;

export async function loadExemplars(accountId: string, platform?: string, limit = 3): Promise<StyleExemplar[]> {
  const out: StyleExemplar[] = [];
  const seen = new Set<string>();
  const push = (source: StyleExemplar['source'], label: string, raw: string | null | undefined) => {
    const text = (raw ?? '').trim();
    if (text.length < EXEMPLAR_MIN_CHARS) return;
    const key = text.slice(0, 40);
    if (seen.has(key)) return; // 同一篇同时躺在草稿与发布记录里，别喂两遍
    seen.add(key);
    out.push({ source, label, text: text.slice(0, EXEMPLAR_CHARS) });
  };

  const materials = await prisma.material.findMany({
    where: { accountId, type: 'sample' },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  for (const m of materials) push('sample', '我指定的代表作', m.content);

  if (out.length < limit) {
    // 同平台优先：跨平台的文风差别很大，拿知乎长文教模型写抖音口播是帮倒忙
    const records = await prisma.publishRecord.findMany({
      where: { accountId, contentText: { not: null }, ...(platform ? { platform } : {}) },
      orderBy: { publishedAt: 'desc' },
      take: 12,
      select: { title: true, contentText: true, platform: true, metrics: true },
    });
    const ranked = records
      .map((r) => ({ r, views: parseJson<Metrics>(r.metrics, {}).views ?? 0 }))
      .sort((a, b) => b.views - a.views);
    for (const { r, views } of ranked) {
      if (out.length >= limit) break;
      const perf = views > 0 ? `播放/阅读 ${views}` : '暂无回流数据';
      push('published', `我发过的《${r.title ?? '无标题'}》（${platformName(r.platform)}·${perf}）`, r.contentText);
    }
  }

  if (out.length < limit) {
    const versions = await prisma.draftVersion.findMany({
      where: { authorType: 'human', draft: { accountId } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { content: true, draft: { select: { title: true } } },
    });
    for (const v of versions) {
      if (out.length >= limit) break;
      push('human_draft', `我自己改定的《${v.draft.title}》`, v.content);
    }
  }

  return out.slice(0, limit);
}

export async function exemplarBlock(accountId: string, platform?: string, limit = 3): Promise<string> {
  const list = await loadExemplars(accountId, platform, limit);
  return renderExemplarBlock(list);
}

// 纯函数拆出来便于单测与复用（去 AI 味改写要用同一份指令）
export function renderExemplarBlock(list: StyleExemplar[]): string {
  if (list.length === 0) return '';
  const body = list
    .map((e, i) => `样本${i + 1}（${e.label}）：\n${e.text}`)
    .join('\n\n');
  return [
    '【他自己写的原文样本——照着这个语感写】',
    body,
    '',
    '模仿的是**怎么说**：句子长短的起伏、在哪里断句、爱用哪些连接词和语气词、标点习惯、开头和收尾的方式。',
    '不要模仿**说了什么**：样本里的经历、数据、案例都不属于本篇，一个字都不要搬进来。',
    '写完自查一遍：如果这段话放进上面的样本里读起来像另一个人写的，就重写。',
  ].join('\n');
}

// ─────────────────────────── 受众画像块 ───────────────────────────
// 「读者是谁」此前只有用户在人设卡里手写的一句话（主观、可能过时）。这里注入的是
// 创作者后台回的**真实分布**，让 AI 判断「这个选题跟你的读者对不对得上」时有据可依。
//
// 只在真有数据时输出；无数据整块缺席（绝不写「受众未知」之类的占位噪声——那只会
// 让模型把一句废话当成事实去推理）。
async function audienceBlock(accountId: string, platform?: string): Promise<string> {
  // 未指定平台时，取该账号已回填过画像的任一平台（多数用户只经营一两个平台）
  const rows = await prisma.audienceProfile.findMany({
    where: { accountId, ...(platform ? { platform } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: 1,
  });
  const row = rows[0];
  if (!row) return '';

  const fmt = (label: string, raw: string): string => {
    const top = topBuckets(parseJson<Record<string, number>>(raw, {}), 3);
    if (top.length === 0) return '';
    return `${label}：${top.map((t) => `${t.name} ${Math.round(t.share * 100)}%`).join('、')}`;
  };
  const lines = [
    fmt('性别', row.gender),
    fmt('年龄', row.age),
    fmt('地域', row.region),
    fmt('兴趣', row.interest),
  ].filter(Boolean);
  if (lines.length === 0) return '';

  return [
    `【${platformName(row.platform)}真实受众画像（创作者后台回填，非推测）】`,
    ...lines.map((l) => `- ${l}`),
    '判断选题是否匹配时以这份分布为准；与人设卡里写的受众不一致时，如实指出差异，不要糊弄过去。',
  ].join('\n');
}
