import { parseJson } from '../json';
import { safeFetch, htmlToText, assertPublicUrl, isPrivateIp, type FetchPage } from '../web/fetch';
import { llmComplete } from '../llm/gateway';
import { createCustomSkill, SKILL_OUTPUT_KINDS, type SkillOutputKind, type SkillSummary } from './index';
import { SKILL_PLATFORM_OPTIONS } from './platform';

// 从网址一键导入技能（两种来源，自动识别）：
//   ① 技能定义链接（如 GitHub 上的 skill JSON / 带 frontmatter 的 SKILL.md）→ 解析字段直接导入。
//   ② 内容作品链接（公众号/小红书/知乎等文章）→ 抓正文 → 大模型解析排版与风格 → 生成技能。
// 统一落到 createCustomSkill（复用其校验 + 创建即安装）。LLM 走同一 llmComplete 网关（配额/BYOK/记账一致）。

const VALID_PLATFORMS = new Set(SKILL_PLATFORM_OPTIONS.map((p) => p.key));

const MAX_CONTENT_CHARS = 8_000; // 送进 LLM 的正文截断长度

export type ImportSkillResult = { ok: true; skill: SkillSummary; via: 'definition' | 'generated' } | { ok: false; error: string };

// 抓取与 SSRF 护栏统一在 lib/web/fetch（群里发链接抓正文也用它）。
// 这里 re-export 是为了不打断既有引用点（含 tests/skills/import.test.ts）。
export { assertPublicUrl, isPrivateIp, type FetchPage };

// ── 归一化 ────────────────────────────────────────────
function normalizePlatform(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (VALID_PLATFORMS.has(s)) return s;
  const alias: Record<string, string> = { xhs: 'xiaohongshu', rednote: 'xiaohongshu', 'wechat-mp': 'wechat', gongzhonghao: 'wechat', bili: 'bilibili', twitter: 'x', tiktok: 'douyin' };
  return alias[s] ?? 'generic';
}

function normalizeOutputKind(v: unknown): SkillOutputKind {
  const s = String(v ?? '').trim().toLowerCase();
  return (SKILL_OUTPUT_KINDS as string[]).includes(s) ? (s as SkillOutputKind) : 'markdown';
}

/** createCustomSkill 硬要求模板含 {{content}}；来源模板没有时补一段标准包裹，保证可用。 */
function ensureContentPlaceholder(tpl: string): string {
  if (/\{\{\s*content\s*\}\}/.test(tpl)) return tpl;
  return `${tpl.trim()}\n\n---\n以下是需要按上述要求处理的正文：\n{{content}}`;
}

function str(v: unknown, max = 100_000): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// ── 来源①：结构化技能定义（JSON / frontmatter Markdown）────────────────
type SkillDraft = { name: string; description: string; platform: string; promptTemplate: string; outputKind: SkillOutputKind; emoji: string };

function fromJsonDefinition(text: string): SkillDraft | null {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = str(obj.name ?? obj.title, 40).trim();
  const promptTemplate = str(obj.promptTemplate ?? obj.prompt ?? obj.template ?? obj.instructions ?? obj.body ?? obj.content).trim();
  if (!name || !promptTemplate) return null; // 不是技能定义
  return {
    name,
    description: (str(obj.description ?? obj.desc ?? obj.summary, 200) || `${name}（导入）`).trim(),
    platform: normalizePlatform(obj.platform),
    promptTemplate: ensureContentPlaceholder(promptTemplate),
    outputKind: normalizeOutputKind(obj.outputKind ?? obj.output ?? obj.kind),
    emoji: str(obj.emoji, 8).trim() || '📦',
  };
}

/** 极简 frontmatter 解析（`---\nkey: value\n---\n正文`）。够解析 SKILL.md 这类结构，不追求全 YAML。 */
function fromFrontmatterMarkdown(text: string): SkillDraft | null {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  const body = m[2].trim();
  const name = (meta.name || meta.title || '').slice(0, 40).trim();
  if (!name || !body) return null;
  return {
    name,
    description: (meta.description || meta.desc || `${name}（导入）`).slice(0, 200),
    platform: normalizePlatform(meta.platform),
    promptTemplate: ensureContentPlaceholder(body.slice(0, 6000)),
    outputKind: normalizeOutputKind(meta.outputkind || meta.output),
    emoji: (meta.emoji || '📦').slice(0, 8),
  };
}

// ── 来源②：内容作品 → LLM 生成技能 ────────────────
async function generateFromContent(tenantId: string, sourceUrl: URL, rawText: string, looksHtml: boolean): Promise<SkillDraft> {
  const { title, text } = looksHtml ? htmlToText(rawText) : { title: '', text: rawText.replace(/\s+/g, ' ').trim() };
  const sample = text.slice(0, MAX_CONTENT_CHARS);
  if (sample.length < 20) throw new Error('这个网址没解析出可用的正文内容');

  let generated: Partial<SkillDraft> | null = null;
  try {
    const res = await llmComplete(
      tenantId,
      'generation',
      [
        {
          role: 'system',
          content:
            '你是新媒体「技能」设计师。技能 = 一段可复用的提示词模板，能把用户任意正文改写成与参考作品同款的风格与排版。' +
            '只输出一个 JSON 对象，字段：name(技能名,≤20字), description(一句话用途,≤40字), emoji(1个), ' +
            'platform(wechat/xiaohongshu/douyin/shipinhao/zhihu/bilibili/generic 之一), outputKind(markdown/html/text), ' +
            'promptTemplate(提示词模板，必须包含占位符 {{content}} 代表用户正文，指导 AI 仿照参考作品的结构、语气、排版把 {{content}} 改写成成品)。不要输出解释。',
        },
        {
          role: 'user',
          content: `参考作品标题：${title || '(无)'}\n来源：${sourceUrl.hostname}\n\n参考作品正文（用于提炼风格，不要照抄内容）：\n${sample}`,
        },
      ],
      { json: true, temperature: 0.4 },
    );
    const obj = parseJson<Record<string, unknown>>(res.text, {});
    if (obj && typeof obj === 'object' && str(obj.promptTemplate).trim()) {
      generated = {
        name: str(obj.name, 40).trim(),
        description: str(obj.description, 200).trim(),
        platform: normalizePlatform(obj.platform),
        promptTemplate: ensureContentPlaceholder(str(obj.promptTemplate).trim()),
        outputKind: normalizeOutputKind(obj.outputKind),
        emoji: str(obj.emoji, 8).trim() || '✨',
      };
    }
  } catch {
    generated = null; // LLM 报错（如配额）→ 走确定性兜底，不阻断导入
  }

  // 兜底（LLM 无 key / Mock / 解析失败）：用参考作品做「风格仿写」模板，保证 dev 与无 key 环境也能出技能。
  const fallbackName = (title || `${sourceUrl.hostname} 风格仿写`).slice(0, 40);
  const excerpt = sample.slice(0, 600);
  const draft: SkillDraft = {
    name: generated?.name || fallbackName,
    description: generated?.description || `仿照「${title || sourceUrl.hostname}」的风格与排版改写正文`,
    platform: generated?.platform || 'generic',
    promptTemplate:
      generated?.promptTemplate ||
      ensureContentPlaceholder(
        `请仿照下面这篇参考作品的选题角度、语气和排版结构，把我的正文改写成同款风格的成品。\n\n【参考作品片段】\n${excerpt}\n\n只输出改写后的成品本身。`,
      ),
    outputKind: generated?.outputKind || 'markdown',
    emoji: generated?.emoji || '✨',
  };
  if (!draft.name) draft.name = fallbackName || '导入的技能';
  return draft;
}

/**
 * 主入口：解析网址 → 识别来源类型 → 落成技能（创建即安装）。
 * 识别顺序：JSON 技能定义 → frontmatter Markdown → 否则按内容作品交给 LLM 生成。
 */
export async function importSkillFromUrl(tenantId: string, url: string, fetchPage: FetchPage = safeFetch): Promise<ImportSkillResult> {
  const raw = (url ?? '').trim();
  if (!raw) return { ok: false, error: '请输入要导入的网址' };

  let fetched;
  try {
    fetched = await fetchPage(raw);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const { finalUrl, contentType, text } = fetched;
  const looksJson = contentType.includes('json') || /^\s*[[{]/.test(text);
  const looksHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(text.slice(0, 200));

  // ① 结构化技能定义
  let draft: SkillDraft | null = null;
  let via: 'definition' | 'generated' = 'definition';
  if (looksJson) draft = fromJsonDefinition(text);
  if (!draft) draft = fromFrontmatterMarkdown(text);

  // ② 内容作品 → LLM 生成
  if (!draft) {
    try {
      draft = await generateFromContent(tenantId, finalUrl, text, looksHtml);
      via = 'generated';
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  try {
    const skill = await createCustomSkill(tenantId, {
      name: draft.name,
      description: draft.description,
      platform: draft.platform,
      promptTemplate: draft.promptTemplate,
      // 导入/AI 解析出的技能一律文本三态：image 只走内置，不经由导入落地（真出了 image 就按 text 收）
      outputKind: draft.outputKind === 'image' ? 'text' : draft.outputKind,
      emoji: draft.emoji,
    });
    return { ok: true, skill, via };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
