import { prisma } from '../db';
import { fmtDate } from '../format';
import { checkText, redlineHits, redlineReason } from '../compliance/engine';
import { loadMaterials } from '../material';
import { writeMemory, recentlyLearnedMemories } from '../memory/core';
import { clipUrl } from '../clip';
import { platformOfLink } from '../clip/platform';
import { platformName } from '../constants';
import type { AgentTool } from './tool-types';
import { clamp, num, str } from './tool-types';

// ── 内容与记忆类工具 ────────────────────────────────────────────────────────
//
// 这一组回答「手上有什么料、这篇能不能发、把这件事记住」。
//
// 【这一组的共同注意事项】下面复用的 lib 函数**几乎都不校验归属**——
// loadMaterials 只吃 accountId、writeMemory 只吃 workspaceId，传什么用什么。
// 所以规矩是：租户/工作区/账号一律取自 ToolContext，**绝不接受模型传来的 id**。
// 模型能决定的只有「查什么、写什么内容」，不能决定「在谁的地盘上查/写」。


const complianceCheck: AgentTool = {
  name: 'compliance_check',
  label: '查合规风险',
  action: 'content.view',
  write: false,
  def: {
    name: 'compliance_check',
    description:
      '检查一段文案有没有违规风险：法律红线词、平台禁词、行业词与团队自定义词。'
      + '返回命中的词、位置与建议改法，以及三档结论 pass/warn/block。'
      + 'block = 有法律红线，这篇按现状不能导出也不能发。用户问「这篇能发吗」「查一下有没有违规」时用。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要检查的文案正文' },
        platform: { type: 'string', description: '目标平台（不同平台禁词不同），如 xiaohongshu / douyin / wechat' },
      },
      required: ['text'],
    },
  },
  async run(ctx, args) {
    const text = str(args.text);
    if (!text) return { ok: false, error: '没有要检查的文案', summary: '文案是空的' };
    const platform = str(args.platform) || 'general';

    // 【为什么不用 gateSkillOutput】那是技能输出的**出口闸**，命中红线时它把 hits 吞掉
    // 只回一句拒绝文案。这里要的恰恰是「查到了什么」——命中哪些词、在什么位置、怎么改，
    // 所以直接组合 checkText + redlineHits（与 /compliance 页同一个写法）。
    const [result, redlines] = await Promise.all([
      checkText(text, platform, ctx.tenantId),
      redlineHits(text),
    ]);

    // 同一个词出现三次会有三条命中，给模型看之前按词去重——否则它会说「这个词出现了 3 次风险很高」，
    // 而风险等级跟出现次数无关
    const byWord = new Map<string, { word: string; tier: string; action: string; suggestion?: string; 出现次数: number }>();
    for (const h of result.hits) {
      const prev = byWord.get(h.word);
      if (prev) prev.出现次数 += 1;
      else byWord.set(h.word, { word: h.word, tier: h.tier, action: h.action, suggestion: h.suggestion, 出现次数: 1 });
    }

    return {
      ok: true,
      data: {
        结论: result.riskLevel,
        平台: platform === 'general' ? '通用（没指定平台）' : platformName(platform),
        命中词: [...byWord.values()],
        红线: redlines.length > 0 ? redlineReason(redlines) : null,
        // 语义层（LLM 复检）刻意不在这里跑：那是要花钱的一次模型调用，
        // 该由用户在合规页显式点，而不是 AI 顺手替他花掉
        说明: '这是词库层检测。更深的语义违规（变体极限词、隐含承诺）要用户去「合规检测」页跑一次语义复检',
      },
      summary:
        result.riskLevel === 'block'
          ? `⚠️ 命中法律红线，按现状不能发：${redlineReason(redlines)}`
          : result.riskLevel === 'warn'
            ? `有 ${byWord.size} 个需要注意的词，建议改一下`
            : '词库层没查出问题',
    };
  },
};

const searchLibrary: AgentTool = {
  name: 'search_library',
  label: '查资讯库',
  action: 'content.view',
  write: false,
  def: {
    name: 'search_library',
    description:
      '在已经剪藏/拆解过的内容里检索（资讯库 + 灵感箱）：标题、摘要、要点、备注。'
      + '用户说「我之前存过一篇讲…的」「上次拆解的那条视频」时用。返回条目带 id 与来源链接。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词，不传就按时间列最近的' },
        limit: { type: 'number', description: '默认 10，上限 30' },
      },
    },
  },
  async run(ctx, args) {
    const keyword = str(args.keyword);
    const limit = clamp(num(args.limit, 10), 1, 30);

    // 【为什么不用 loadInspirations】那个函数是选题管线用的：固定 state='open'、
    // 条数写死、没有关键词搜索。这里要的是「翻我存过的东西」，两码事。
    const where = {
      workspaceId: ctx.workspaceId,
      // 本账号专属 + 工作区共享，与页面口径一致
      OR: [{ accountId: ctx.accountId }, { accountId: null }],
      ...(keyword
        ? {
            AND: [
              {
                OR: [
                  { title: { contains: keyword } },
                  { summary: { contains: keyword } },
                  { note: { contains: keyword } },
                  { points: { contains: keyword } },
                ],
              },
            ],
          }
        : {}),
    };

    const rows = await prisma.inspirationItem.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, title: true, url: true, platform: true, author: true,
        summary: true, note: true, source: true, state: true, createdAt: true,
      },
    });

    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        标题: r.title,
        来源: r.platform ? platformName(r.platform) : (r.source ?? '手动'),
        作者: r.author,
        链接: r.url,
        摘要: r.summary,
        我的备注: r.note,
        存于: fmtDate(r.createdAt),
      })),
      summary: rows.length
        ? `找到 ${rows.length} 条${keyword ? `与「${keyword}」相关的` : ''}存档`
        : keyword
          ? `资讯库里没有与「${keyword}」相关的存档`
          : '资讯库还是空的（用插件剪藏，或在群里给机器人发链接）',
    };
  },
};

const listMaterials: AgentTool = {
  name: 'list_materials',
  label: '查我的素材库',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_materials',
    description:
      '列出这个账号的素材：亲身经历、案例、观点、口头禅、文风样本。'
      + '写稿前先看一眼——**只有用户自己有**的这些东西，是内容不像 AI 写的关键。'
      + '用户说「用我那个案例」「按我平时的说法」时先调它。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(ctx) {
    const materials = await loadMaterials(ctx.accountId);
    if (materials.length === 0) {
      return { ok: true, data: [], summary: '素材库还是空的——让用户去「经历/素材」页存几条，生成出来的东西会很不一样' };
    }
    return {
      ok: true,
      data: materials.map((m) => ({ 类型: m.type, 内容: m.content, 标签: m.tags })),
      summary: `${materials.length} 条素材`,
    };
  },
};

const readMemory: AgentTool = {
  name: 'read_persona_memory',
  label: '看我记住了什么',
  action: 'content.view',
  write: false,
  def: {
    name: 'read_persona_memory',
    description:
      '列出最近学到或被再次验证的记忆条目（对这个账号的长期认知）。'
      + '用户问「你都记住了我什么」「你怎么知道我喜欢…」时用。'
      + '⚠️ 只列**已生效**的；置信度不够的推断不在里面。',
    parameters: {
      type: 'object',
      properties: { days: { type: 'number', description: '看最近几天的，默认 30' } },
    },
  },
  async run(ctx, args) {
    const days = clamp(num(args.days, 30), 1, 365);
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await recentlyLearnedMemories(ctx.workspaceId, ctx.accountId, since, 20);
    return {
      ok: true,
      data: rows,
      summary: rows.length
        ? `最近 ${days} 天新学到或被再次验证的记忆 ${rows.length} 条`
        : `最近 ${days} 天没有新学到的记忆（不代表以前没记住——这里只看新增和被验证的）`,
    };
  },
};

const writeMemoryTool: AgentTool = {
  name: 'write_memory',
  label: '记住一件事',
  action: 'content.create',
  write: true,
  // 影响不止这一次执行：写进去之后**每一次生成**都会带着它
  contract: true,
  def: {
    name: 'write_memory',
    description:
      '把一件关于这个账号的长期事实记下来（人设/偏好/表现规律/事实），以后每次生成都会带上它。'
      + '只记**长期成立**的事，别记一次性的上下文（「这次要写春节」不该记）。'
      + '措辞要短、要稳定：同一件事下次用同样的说法才会累加置信度，换个说法就是新的一条。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['persona', 'preference', 'performance', 'fact'], description: '哪一类记忆' },
        content: { type: 'string', description: '一句话，陈述句，尽量短且稳定' },
      },
      required: ['type', 'content'],
    },
  },
  async run(ctx, args) {
    const type = str(args.type);
    const content = str(args.content);
    if (!content) return { ok: false, error: '要记的内容是空的', summary: '没有内容' };
    if (!['persona', 'preference', 'performance', 'fact'].includes(type)) {
      return { ok: false, error: `记忆类型只能是 persona / preference / performance / fact，收到的是「${type}」`, summary: '类型不对' };
    }
    if (content.length > 200) {
      return { ok: false, error: '一条记忆超过 200 字就不是「一件事」了，拆短一点', summary: '太长了' };
    }

    // 【为什么显式传 confidence 0.5】writeMemory 的新建缺省是 0.3，而生效线是 0.5——
    // 用缺省值写进去的记忆是**不生效**的，用户会以为「AI 说记住了却没起作用」。
    // 0.5 的含义：这是用户当面让它记的，比模型自己推断出来的可信，但仍低于「人设保存」那档的 1。
    const entry = await writeMemory({
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      type: type as 'persona' | 'preference' | 'performance' | 'fact',
      content,
      confidence: 0.5,
    });

    return {
      ok: true,
      data: { id: entry.id, active: entry.active, hitCount: entry.hitCount },
      summary: entry.active
        ? `记住了：${content}（以后生成会带上它）`
        : `记下了：${content}（还没到生效线，再被验证一次就会开始起作用）`,
    };
  },
};

const clipUrlTool: AgentTool = {
  name: 'clip_url',
  label: '收藏一个链接',
  action: 'content.create',
  write: true,
  // 抓正文之后要调一次模型出摘要/要点/分析
  costly: true,
  timeoutMs: 3 * 60_000,
  def: {
    name: 'clip_url',
    description:
      '把一篇文章收进资讯库：抓正文 → 出摘要与要点 → 结合本账号人设分析「对你有什么用」。'
      + '用户发来一个链接说「存一下」「看看这篇」时用。'
      + '⚠️ 微信/小红书/抖音/知乎/X/B站等平台服务端抓不到（要登录或全是 JS），'
      + '这类链接会直接告诉你抓不了，让用户用浏览器插件剪藏。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '文章链接' },
        note: { type: 'string', description: '可选：用户为什么想收藏它' },
      },
      required: ['url'],
    },
  },
  async run(ctx, args) {
    const url = str(args.url);
    if (!url) return { ok: false, error: '没有链接', summary: '缺少 url' };

    // 先查这条链接服务端能不能抓——直接试抓一次再报错要等 10 秒，用户会以为卡住了
    const p = platformOfLink(url);
    if (!p.canFetch) {
      return {
        ok: false,
        error: `${p.name} 的内容服务端抓不到${p.hint ? `（${p.hint}）` : ''}。让用户用浏览器插件在那个页面上点「存进资讯库」，或者把正文直接贴给你。`,
        summary: `${p.name} 抓不到，要走插件`,
      };
    }

    // SSRF 护栏在 clipUrl 内部（默认走 lib/web/fetch 的 safeFetch）——别在这里另写一份抓取
    const r = await clipUrl({
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      url,
      note: str(args.note) || undefined,
    });

    if (!r.ok) return { ok: false, error: r.error, summary: '没收进来' };

    return {
      ok: true,
      data: {
        id: r.id,
        标题: r.title,
        摘要: r.summary,
        要点: r.points,
        对我的用处: r.analysis,
        是否已存在: r.duplicate ?? false,
      },
      // degraded = 正文存下来了但 AI 那步没跑成（多半是配额用完）。
      // 不说破的话，模型会拿着空摘要对用户说「已经帮你总结好了」
      summary: r.degraded
        ? `《${r.title}》已存进资讯库，但这次没能生成摘要（AI 额度可能用完了），正文还在`
        : `《${r.title}》已存进资讯库`,
    };
  },
};

export const CONTENT_TOOLS: AgentTool[] = [
  complianceCheck,
  searchLibrary,
  listMaterials,
  readMemory,
  writeMemoryTool,
  clipUrlTool,
];
