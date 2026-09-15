import { prisma } from '../db';
import { parseJson } from '../json';
import { llmComplete } from '../llm/gateway';
import { readPersona, personaPromptBlock } from '../persona';
import { readFingerprint, fingerprintPromptBlock } from '../style';
import { materialContextForAccount } from '../material';
import { buildMemoryContext } from '../memory/core';

// 「当前账号内容 × 实时热点」结合分析：给定一个热点，结合账号人设/风格/历史记忆，
// 产出契合度、结合切入角、制作建议与合规风险。回答「这个热点我该怎么蹭」。

export type HotFitAngle = { angle: string; why: string };
export type HotFitAnalysis = {
  hotTitle: string;
  fit: number; // 契合度 0-100
  verdict: string; // 一句话判断：值不值得做、怎么做
  angles: HotFitAngle[]; // 结合切入角（差异化）
  production: string[]; // 制作建议
  risk: string; // 合规/风险提示
  mocked: boolean;
};

export async function analyzeHotFit(accountId: string, workspaceId: string, tenantId: string | null, hotTitle: string): Promise<HotFitAnalysis> {
  const account = await prisma.creatorAccount.findUnique({ where: { id: accountId } });
  const persona = readPersona(account?.personaCard ?? '{}');
  const fp = readFingerprint(account?.styleFingerprint ?? '{}');
  const memory = await buildMemoryContext(workspaceId, accountId, hotTitle);
  const materialCtx = await materialContextForAccount(accountId);

  const messages = [
    {
      role: 'system' as const,
      content: [
        '你是资深内容策划。判断一个实时热点是否适合这个账号来做，并给出「怎么结合」的具体方案。',
        personaPromptBlock(persona),
        fingerprintPromptBlock(fp),
        materialCtx,
        memory,
        '严格输出 JSON：{"fit":0-100的整数,"verdict":"一句话判断该不该做、怎么切","angles":[{"angle":"结合切入角","why":"为什么适合这个账号"}]（2-4个）,"production":["制作建议"]（2-4条）,"risk":"合规或翻车风险提示"}',
        '切入角必须结合账号人设做差异化，不要泛泛而谈；若热点与人设完全无关，fit 给低分并说明。',
      ].join('\n\n'),
    },
    { role: 'user' as const, content: `实时热点：${hotTitle}` },
  ];

  const res = await llmComplete(tenantId, 'advisor', messages, { json: true, temperature: 0.6 });
  const normalized = normalizeHotFit(parseJson<unknown>(res.text, {}), hotTitle);

  // 结构合法且至少有一条切入角才算「解析成功」；否则用人设启发式兜底，保证永远有可用结果（含 Mock 模式）
  if (normalized) {
    return { ...normalized, mocked: res.mocked || Boolean(res.degraded) };
  }
  // 走到启发式兜底 = AI 输出不可用（Mock、真实响应缺 angles 字段、或字段形状不对）→ 这不是真 AI 分析，
  // 必须标 mocked=true，否则关键词兜底会被当成真结论展示（review 指出的静默降级）。
  return heuristicFallback(hotTitle, persona.niche || persona.identity, true);
}

const DEFAULT_VERDICT = '结合账号人设做差异化切入即可尝试。';
const DEFAULT_RISK = '发布前过一遍分平台合规检测。';

/**
 * 把模型吐出来的「合法 JSON 但形状未必对」收口成 HotFitAnalysis。
 *
 * 此前只判 `angles` 存不存在就整包放行：模型返回 `angles:["文本"]`、`production:{}`、
 * 对象型 `risk` 都是合法 JSON，前端 `.map()` / JSX 渲染当场炸。这里逐字段按类型过滤：
 * 不是对象的切入角丢掉、不是字符串的制作建议丢掉、非字符串的 verdict/risk 换缺省句；
 * 过滤后一条切入角都不剩 → 返回 null，交给调用方走启发式兜底。
 */
export function normalizeHotFit(raw: unknown, hotTitle: string): Omit<HotFitAnalysis, 'mocked'> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  const angles: HotFitAngle[] = Array.isArray(r.angles)
    ? r.angles
        .map((a): HotFitAngle | null => {
          if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
          const o = a as Record<string, unknown>;
          const angle = str(o.angle);
          if (!angle) return null;
          return { angle, why: str(o.why) };
        })
        .filter((a): a is HotFitAngle => a !== null)
        .slice(0, 4)
    : [];
  if (!angles.length) return null;

  const production = Array.isArray(r.production)
    ? r.production.map(str).filter(Boolean).slice(0, 6)
    : [];

  return {
    hotTitle,
    fit: clampInt(r.fit, 60),
    verdict: str(r.verdict) || DEFAULT_VERDICT,
    angles,
    production,
    risk: str(r.risk) || DEFAULT_RISK,
  };
}

function clampInt(v: unknown, def: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : def;
}

function heuristicFallback(hotTitle: string, niche: string, mocked: boolean): HotFitAnalysis {
  return {
    hotTitle,
    fit: 62,
    verdict: `从「${niche || '你的赛道'}」视角二次解读这个热点，避开大众通稿角度。`,
    angles: [
      { angle: '把热点迁移到你的专业场景', why: `用「${niche || '你擅长的领域'}」的经验重新解释这件事，做出别人给不了的增量` },
      { angle: '反常识/唱反调切入', why: '多数人跟风追热点，你给一个冷静或相反的判断更容易记住' },
      { angle: '结合亲身经历', why: '用你的真实故事把抽象热点落到具体可感，提升信任' },
    ],
    production: ['开头3秒点出你的独特角度，别复述新闻', '用一个你自己的例子支撑观点', '结尾抛一个引发评论的问题'],
    risk: '蹭社会热点注意不越界、不蹭悲剧流量；发布前过分平台合规检测。',
    mocked,
  };
}
