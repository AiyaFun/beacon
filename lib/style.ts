import { parseJson } from './json';
import { llmComplete } from './llm/gateway';

export type FingerprintItem = {
  tag: string;
  score: number;
  count: number;
};

export type StyleFingerprint = {
  voice: FingerprintItem[];
  format: FingerprintItem[];
  topic: FingerprintItem[];
};

const MAX_ITEMS_PER_LAYER = 12;

export function emptyFingerprint(): StyleFingerprint {
  return { voice: [], format: [], topic: [] };
}

export function readFingerprint(raw: string): StyleFingerprint {
  const parsed = parseJson<Record<string, unknown>>(raw, {});
  return {
    voice: normalizeLayer(parsed.voice),
    format: normalizeLayer(parsed.format),
    topic: normalizeLayer(parsed.topic),
  };
}

function normalizeLayer(layer: unknown): FingerprintItem[] {
  if (!Array.isArray(layer)) return [];
  return layer.map((it) => {
    if (typeof it === 'string') return { tag: it, score: 0.5, count: 1 };
    if (typeof it === 'object' && it && typeof (it as Record<string, unknown>).tag === 'string') {
      const obj = it as Record<string, unknown>;
      return {
        tag: String(obj.tag),
        score: typeof obj.score === 'number' ? obj.score : 0.5,
        count: typeof obj.count === 'number' ? obj.count : 1,
      };
    }
    return null;
  }).filter((x): x is FingerprintItem => x !== null);
}

export function toFingerprintJson(fp: StyleFingerprint): string {
  return JSON.stringify(fp);
}

export function mergeLayer(
  existing: FingerprintItem[],
  incoming: FingerprintItem[],
): FingerprintItem[] {
  const map = new Map<string, FingerprintItem>();
  for (const it of existing) map.set(it.tag, { ...it });
  for (const it of incoming) {
    const prev = map.get(it.tag);
    if (prev) {
      prev.count += it.count;
      prev.score = Math.min(1, prev.score + 0.1);
    } else {
      map.set(it.tag, { ...it });
    }
  }
  return [...map.values()]
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, MAX_ITEMS_PER_LAYER);
}

export type StyleAnalysis = {
  voice: FingerprintItem[];
  format: FingerprintItem[];
  mocked: boolean;
};

export async function analyzeContentStyle(
  tenantId: string,
  texts: string[],
): Promise<StyleAnalysis> {
  if (texts.length === 0) return { voice: [], format: [], mocked: false };

  const sample = texts.slice(0, 5).map((t) => t.slice(0, 500)).join('\n---\n');

  const sys = `你是内容风格分析引擎。分析以下内容样本，提取稳定的风格特征。

语气层 voice（最多 6 个标签）：
关注表达方式，如：幽默、专业、口语化、毒舌、温暖、犀利、克制、煽情、理性、故事感

结构层 format（最多 6 个标签）：
关注内容组织方式，如：列表体、教程式、故事线、对比测评、问答体、金句体、数据驱动、碎碎念

输出 JSON：
{"voice":[{"tag":"标签","score":0.8}],"format":[{"tag":"标签","score":0.7}]}

score 为 0-1 的置信度（出现在多个样本中=高分）。只提取确信的特征，宁缺毋滥。`;

  try {
    const r = await llmComplete(tenantId, 'compliance', [
      { role: 'system', content: sys },
      { role: 'user', content: sample },
    ], { temperature: 0.2, json: true });

    const parsed = parseJson<Record<string, unknown>>(r.text, {});
    return {
      voice: parseAnalysisLayer(parsed.voice),
      format: parseAnalysisLayer(parsed.format),
      mocked: r.mocked,
    };
  } catch {
    return { voice: [], format: [], mocked: false };
  }
}

function parseAnalysisLayer(raw: unknown): FingerprintItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> =>
      typeof x === 'object' && x !== null && typeof (x as Record<string, unknown>).tag === 'string',
    )
    .slice(0, 6)
    .map((x) => ({
      tag: String(x.tag).slice(0, 20),
      score: typeof x.score === 'number' ? Math.min(1, Math.max(0, x.score)) : 0.5,
      count: 1,
    }));
}

export function fingerprintPromptBlock(fp: StyleFingerprint): string {
  const lines: string[] = [];
  if (fp.voice.length > 0) {
    lines.push(`语气风格：${fp.voice.map((v) => `${v.tag}(${Math.round(v.score * 100)}%)`).join('、')}`);
  }
  if (fp.format.length > 0) {
    lines.push(`结构偏好：${fp.format.map((f) => `${f.tag}(${Math.round(f.score * 100)}%)`).join('、')}`);
  }
  if (fp.topic.length > 0) {
    lines.push(`擅长选题：${fp.topic.map((t) => t.tag).join('、')}`);
  }
  return lines.length > 0 ? `【风格指纹】\n${lines.join('\n')}` : '';
}
