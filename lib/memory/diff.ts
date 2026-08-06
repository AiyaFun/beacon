import { llmComplete } from '../llm/gateway';
import { writeMemory } from './core';

// AI 初稿 vs 人工终稿 = 最真实的偏好信号来源（PRD §8：数据只提议，人设由用户定）。
// 两层信号：
//   1. 字数增减摘要 —— 不依赖模型、永远可信，每次都写（与 studio 落版本时的 diff 口径一致）；
//   2. LLM 归纳的偏好结论 —— 只有真模型（非 Mock）且输出合格才写。
//      红线：Mock 编出来的「偏好」进记忆等于给账号造假口味，宁缺毋滥。
// 结论措辞被 prompt 锁死为「偏好：<12 字内动作短语>」——稳定措辞才能被 writeMemory
// 的 content 全等去重累计命中：同一偏好反复出现 → hitCount/置信度攀升 → 生效注入，
// 与 learn.ts 的切入角结论是同一套设计约定。

const MAX_PREFERENCES = 3;
const PREF_PREFIX = '偏好：';
// 前缀 3 字 + 动作短语 ≤12 字
const MAX_PREF_LEN = 15;
// 喂给模型的单稿截断长度：归纳改稿动作看整体即可，不必全文，也防超长稿烧穿 token
const MAX_DRAFT_CHARS = 4000;

// 记录「AI 初稿 → 人工终稿」体现的创作偏好。整体兜底：偏好沉淀是锦上添花，
// 任何失败（LLM 挂了、配额超限、写库失败）都不许打断保存终稿的主流程，绝不向外 throw。
export async function recordDiffPreference(opts: {
  tenantId: string;
  workspaceId: string;
  accountId: string;
  aiDraft: string;
  humanFinal: string;
}): Promise<void> {
  try {
    // 第一层：字数摘要（措辞与 studio 既有偏好记忆完全一致，历史条目继续累计命中）
    const delta = opts.humanFinal.length - opts.aiDraft.length;
    const sign = delta > 0 ? `扩写 +${delta}` : delta < 0 ? `精简 ${delta}` : '等量重写';
    await writeMemory({
      workspaceId: opts.workspaceId,
      accountId: opts.accountId,
      type: 'preference',
      content: `人工在 AI 初稿基础上改稿：人工终稿：${sign} 字`,
      confidence: 0.4,
    });

    // 第二层：让 LLM 对比两稿归纳偏好
    const res = await llmComplete(
      opts.tenantId,
      'generation',
      [
        {
          role: 'system',
          content: [
            '你是内容偏好归纳助手。对比同一篇内容的「AI 初稿」与「人工终稿」，归纳创作者改稿动作背后的稳定偏好。',
            '输出要求（严格遵守）：',
            '1. 只输出一个 JSON 字符串数组，不要任何其他文字，例如：["偏好：删减语气词","偏好：结论前置"]',
            '2. 数组 1 到 3 条；每条固定格式「偏好：<动作短语>」，动作短语不超过 12 个字',
            '3. 只归纳两稿对比能确认的修改动作，确认不了的不写，不要臆测',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `【AI 初稿】\n${opts.aiDraft.slice(0, MAX_DRAFT_CHARS)}\n\n【人工终稿】\n${opts.humanFinal.slice(0, MAX_DRAFT_CHARS)}`,
        },
      ],
      { json: true, temperature: 0.2 },
    );

    // Mock 编的偏好绝不进记忆；解析不出合格条目同样只留字数摘要
    if (res.mocked) return;
    const prefs = parsePreferences(res.text);
    for (const p of prefs) {
      await writeMemory({
        workspaceId: opts.workspaceId,
        accountId: opts.accountId,
        type: 'preference',
        content: p,
        confidence: 0.4,
      });
    }
  } catch {
    /* 兜底：见函数头注释 */
  }
}

// 解析并过滤 LLM 输出：只收「偏好：<12 字内短语>」格式的条目，其余静默丢弃
function parsePreferences(text: string): string[] {
  try {
    const arr: unknown = JSON.parse(text);
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const item of arr) {
      if (typeof item !== 'string') continue;
      const s = item.trim();
      if (!s.startsWith(PREF_PREFIX)) continue;
      if (s.length <= PREF_PREFIX.length || s.length > MAX_PREF_LEN) continue;
      if (out.includes(s)) continue;
      out.push(s);
      if (out.length >= MAX_PREFERENCES) break;
    }
    return out;
  } catch {
    return [];
  }
}
