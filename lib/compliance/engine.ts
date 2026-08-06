import { prisma } from '../db';

// 敏感词检测引擎（PRD §9）：DFA 多模式匹配做本地初筛（免费、毫秒级）。
// 四级词库：legal(全局) / platform(按平台) / industry(行业) / custom(租户)。
// 生产态在此之上再叠加 LLM 语义复检 + 云审核兜底。

export type WordHit = {
  word: string;
  tier: string;
  action: string; // block | warn | suggest
  start: number;
  end: number;
  suggestion?: string;
  platform?: string;
};

type DfaNode = {
  children: Map<string, DfaNode>;
  end: boolean;
  meta?: { word: string; tier: string; action: string; suggestion?: string; platform?: string };
};

// 敏感词是「低频变更、高频读取」的数据：缓存构建好的 DFA，省掉每次 checkText 的查库 + 建树。
// ⚠️ 正确性不变式：缓存必须在词库变更时**立刻**失效。只靠 TTL 是错的——运营在合规中心加/删/停用一个词后，
// 最长 5 分钟内检测仍按旧词库走（漏检或误拦）。所以：
//   ① 所有词库写入点（app/(app)/compliance/actions.ts 的增/删/停用）显式调 invalidateDfaCache()；
//   ② TTL 仅作兜底，自愈任何遗漏的写入路径；
//   ③ 测试在 setup 的 beforeEach 里也调一次，隔离各用例各自 seed 的词库。
const DFA_TTL_MS = 5 * 60 * 1000;
const dfaCache = new Map<string, { dfa: DfaNode; ts: number }>();

/** 清空 DFA 缓存。词库任何写入后必须调用，否则新词/删词/停用最长 5 分钟内不生效。 */
export function invalidateDfaCache() {
  dfaCache.clear();
}

function getCachedDfa(key: string): DfaNode | null {
  const entry = dfaCache.get(key);
  if (entry && Date.now() - entry.ts < DFA_TTL_MS) return entry.dfa;
  return null;
}

function setCachedDfa(key: string, dfa: DfaNode) {
  dfaCache.set(key, { dfa, ts: Date.now() });
}

function buildDfa(words: { word: string; tier: string; action: string; suggestion?: string | null; platform?: string | null }[]): DfaNode {
  const root: DfaNode = { children: new Map(), end: false };
  for (const w of words) {
    if (!w.word) continue;
    let node = root;
    for (const ch of w.word) {
      if (!node.children.has(ch)) node.children.set(ch, { children: new Map(), end: false });
      node = node.children.get(ch)!;
    }
    node.end = true;
    node.meta = {
      word: w.word,
      tier: w.tier,
      action: w.action,
      suggestion: w.suggestion ?? undefined,
      platform: w.platform ?? undefined,
    };
  }
  return root;
}

export function scan(text: string, dfa: DfaNode): WordHit[] {
  const hits: WordHit[] = [];
  for (let i = 0; i < text.length; i++) {
    let node = dfa;
    let j = i;
    while (j < text.length && node.children.has(text[j])) {
      node = node.children.get(text[j])!;
      j++;
      if (node.end && node.meta) {
        hits.push({
          word: node.meta.word,
          tier: node.meta.tier,
          action: node.meta.action,
          suggestion: node.meta.suggestion,
          platform: node.meta.platform,
          start: i,
          end: j,
        });
      }
    }
  }
  return hits;
}

export type ComplianceResult = {
  hits: WordHit[];
  riskLevel: 'pass' | 'warn' | 'block';
  platform: string;
};

// 针对目标平台做检测：法律级 + 该平台的平台级 + 行业级 + 租户自定义
export async function checkText(text: string, platform: string, tenantId: string | null): Promise<ComplianceResult> {
  const cacheKey = `check:${platform}:${tenantId ?? ''}`;
  let dfa = getCachedDfa(cacheKey);
  if (!dfa) {
    const words = await prisma.sensitiveWord.findMany({
      where: {
        enabled: true,
        OR: [
          { tier: 'legal' },
          { tier: 'platform', platform },
          { tier: 'industry' },
          ...(tenantId ? [{ tier: 'custom', tenantId }] : []),
        ],
      },
    });
    dfa = buildDfa(words);
    setCachedDfa(cacheKey, dfa);
  }
  const hits = scan(text, dfa);
  let riskLevel: ComplianceResult['riskLevel'] = 'pass';
  if (hits.some((h) => h.action === 'block')) riskLevel = 'block';
  else if (hits.length > 0) riskLevel = 'warn';
  return { hits, riskLevel, platform };
}

// ── AIGC 标识（《人工智能生成合成内容标识办法》2025-09-01 施行）──
// 实现在 ./aigc（不依赖 prisma，客户端组件也要用）；此处原样 re-export 保持既有引用不变。
export {
  AIGC_LABEL,
  hasAigcLabel,
  ensureAigcLabel,
  buildAigcMetadata,
  aigcMetadataJson,
  aigcHtmlPayload,
  type AigcMetadata,
} from './aigc';

// 红线阻断集：命中即禁止导出——生产态用独立高优词表。
// 口径 = legal 级 + action=block，与 prisma/seed.ts 的定级注释严格对齐：
// seed 把「最好/最优」这类有日常口语用法的词**刻意降级为 warn**，理由正是「block 会触发禁止导出硬闸，
// 误伤代价太大」。所以这里的口径一旦放宽（比如把 platform/industry 的 block 也算红线），
// 就等于推翻了词库的定级前提，会开始误伤。要改口径必须连着 seed 的定级一起改。
export async function redlineHits(text: string): Promise<WordHit[]> {
  const cacheKey = 'redline';
  let dfa = getCachedDfa(cacheKey);
  if (!dfa) {
    const legal = await prisma.sensitiveWord.findMany({
      where: { enabled: true, tier: 'legal', action: 'block' },
    });
    dfa = buildDfa(legal);
    setCachedDfa(cacheKey, dfa);
  }
  return scan(text, dfa);
}

export async function hasRedline(text: string): Promise<boolean> {
  return (await redlineHits(text)).length > 0;
}

// 红线拒绝理由（中文可读）：告诉用户命中了**哪个词**、替代写法是什么，而不是甩一句「不合规」。
export function redlineReason(hits: WordHit[]): string {
  const seen = new Map<string, string | undefined>();
  for (const h of hits) if (!seen.has(h.word)) seen.set(h.word, h.suggestion);
  const parts = [...seen.entries()]
    .slice(0, 5)
    .map(([word, sug]) => `「${word}」${sug ? ` → 建议改为${sug}` : ''}`);
  const more = seen.size > 5 ? `等 ${seen.size} 个词` : '';
  return `内容命中合规红线，已阻止导出：${parts.join('；')}${more}。请到合规中心修改后再导出。`;
}
