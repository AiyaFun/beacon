// ── 知识范围的类型与纯函数：**零依赖**（tool-types / 客户端 / 用例都能 import） ─────
// 说明见 lib/agent/knowledge.ts（那边是读库与落库）。这里不许引 prisma。

export const KNOWLEDGE_SOURCE_TYPES = ['library_item', 'library_tag', 'material_type', 'memory'] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABEL: Record<KnowledgeSourceType, string> = {
  library_item: '资讯库条目',
  library_tag: '资讯库标签',
  material_type: '素材类型',
  memory: '人设记忆',
};

export type KnowledgeBinding = {
  id: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  purpose: string;
  priority: number;
  enabled: boolean;
};

/** 一次执行的知识范围。null = 没有绑定，不收窄。 */
export type KnowledgeScope = {
  templateId: string;
  bindings: KnowledgeBinding[];
  /** 资讯库：只许这些 id / 这些标签。两者都空 = 资讯库不在范围内 */
  libraryItemIds: string[];
  libraryTags: string[];
  /** 素材：只许这些类型；含 '*' = 全部素材。空 = 素材不在范围内 */
  materialTypes: string[];
  /** 人设记忆在不在范围内 */
  memory: boolean;
};

export function isKnowledgeSourceType(v: string): v is KnowledgeSourceType {
  return (KNOWLEDGE_SOURCE_TYPES as readonly string[]).includes(v);
}

/**
 * 绑定行 → 范围。**纯函数**，用例直接测。
 *
 * 【策略只看有没有行，不看有没有启用的行】（2026-09-11 审计修正）
 *   一行都没有 → null = 不收窄（旧行为，读整库）；
 *   有行、哪怕全被禁用 → 收窄成「什么都不在范围里」，检索一律拒绝。
 * 第一版把「全禁用」也返回 null，于是用户关掉最后一条资料时员工反而拿到全库——
 * 这是权限的反向漏洞。禁用最后一条不改变策略，只让范围变空。
 */
export function scopeOf(templateId: string, rows: readonly KnowledgeBinding[]): KnowledgeScope | null {
  if (rows.length === 0) return null;
  const on = rows.filter((b) => b.enabled);
  const scope: KnowledgeScope = { templateId, bindings: on, libraryItemIds: [], libraryTags: [], materialTypes: [], memory: false };
  for (const b of on) {
    if (b.sourceType === 'library_item') scope.libraryItemIds.push(b.sourceId);
    else if (b.sourceType === 'library_tag') scope.libraryTags.push(b.sourceId);
    else if (b.sourceType === 'material_type') scope.materialTypes.push(b.sourceId);
    else if (b.sourceType === 'memory') scope.memory = true;
  }
  return scope;
}

/** 资讯库在不在范围内（有任一条目或标签绑定） */
export function libraryInScope(scope: KnowledgeScope | null | undefined): boolean {
  return !scope || scope.libraryItemIds.length > 0 || scope.libraryTags.length > 0;
}

/** 素材在不在范围内；返回允许的类型（null = 不限类型） */
export function materialTypesInScope(scope: KnowledgeScope | null | undefined): { allowed: boolean; types: string[] | null } {
  if (!scope) return { allowed: true, types: null };
  if (scope.materialTypes.length === 0) return { allowed: false, types: [] };
  if (scope.materialTypes.includes('*')) return { allowed: true, types: null };
  return { allowed: true, types: scope.materialTypes };
}

/** 一条资讯库条目在不在范围内（按 id 或标签命中）。**纯函数**。 */
export function libraryItemAllowed(scope: KnowledgeScope | null | undefined, item: { id: string; tags: string }): boolean {
  if (!scope) return true;
  if (scope.libraryItemIds.includes(item.id)) return true;
  if (scope.libraryTags.length === 0) return false;
  const tags = item.tags.split(/[,，\s]+/).filter(Boolean);
  return tags.some((t) => scope.libraryTags.includes(t));
}

/** 写进系统提示词的一段：让模型知道自己该读什么、不该编什么。 */
export function knowledgePromptBlock(scope: KnowledgeScope | null, labels: { libraryTitles: string[] }): string {
  if (!scope) return '';
  const lines: string[] = ['【你的知识范围】只用下面这些来源回答与创作；范围外的事实要么用工具查，要么明说不知道，不要编。'];
  if (scope.bindings.length === 0) lines.push('- 当前没有任何启用的来源：资讯库、素材、记忆都不在范围内，相关工具会拒绝。');
  if (labels.libraryTitles.length) lines.push(`- 资讯库：${labels.libraryTitles.slice(0, 12).join('；')}${labels.libraryTitles.length > 12 ? `…共 ${labels.libraryTitles.length} 条` : ''}`);
  if (scope.libraryTags.length) lines.push(`- 资讯库标签：${scope.libraryTags.join('、')}`);
  if (scope.materialTypes.length) lines.push(`- 素材：${scope.materialTypes.includes('*') ? '全部素材' : scope.materialTypes.join('、')}`);
  lines.push(`- 人设记忆：${scope.memory ? '可读' : '不在范围内（read_persona_memory 会拒绝）'}`);
  for (const b of scope.bindings) if (b.purpose) lines.push(`  · ${SOURCE_TYPE_LABEL[b.sourceType]}「${b.sourceId}」用途：${b.purpose}`);
  return lines.join('\n');
}
