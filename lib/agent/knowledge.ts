import { prisma } from '../db';
import { createLogger } from '../logger';
import { scopeOf, knowledgePromptBlock, isKnowledgeSourceType, type KnowledgeBinding, type KnowledgeScope, type KnowledgeSourceType } from './knowledge-scope';

export * from './knowledge-scope';

const log = createLogger({ module: 'agent-knowledge' });

// ── 数字员工的知识范围（2026-09-11 P1）：不同员工读不同资料，且能说清答案来自哪里 ─────
//
// 【只是范围声明，不复制内容】AgentKnowledgeBinding 一行 = 「这个模板可读某份资料」。
// 原始资料留在 InspirationItem / Material / MemoryEntry 各自的表里，只读；
// 绑定被禁用或删除，下一次检索立刻不再包含它（范围每次执行现算，不缓存）。
//
// 【一条都没有 = 不收窄】这是兼容旧行为：装了的所有智能体照旧能读整个资料库。
// 有 ≥1 条启用的绑定，search_library / list_materials / read_persona_memory 就只在范围内查，
// 范围外的来源直接返回「不在这个员工的知识范围里」，而不是静默返回空。
//
// 【引用】工具把命中的条目以 citations 回给执行器，执行器写成 AgentStep(kind='citation', seq=0)。
// seq=0 是刻意的：引用不参与步骤顺序（tool_call/tool_result 那条 ++seq 的线由主循环独占），
// 它只回答「这次执行引用了哪些源对象」，按 createdAt 排。

export async function listBindings(workspaceId: string, templateId: string): Promise<KnowledgeBinding[]> {
  const rows = await prisma.agentKnowledgeBinding.findMany({
    where: { workspaceId, templateId },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  });
  return rows
    .filter((r) => isKnowledgeSourceType(r.sourceType))
    .map((r) => ({ id: r.id, sourceType: r.sourceType as KnowledgeSourceType, sourceId: r.sourceId, purpose: r.purpose, priority: r.priority, enabled: r.enabled }));
}

/** 这次执行的知识范围（按模板现算；模板为空 = 通用助手，不收窄）。 */
export async function loadKnowledgeScope(workspaceId: string, templateId: string | null | undefined): Promise<KnowledgeScope | null> {
  if (!templateId) return null;
  try {
    return scopeOf(templateId, await listBindings(workspaceId, templateId));
  } catch (err) {
    // 表还没建（老部署没跑 55 号 SQL）：按不收窄处理并记一笔，别让所有执行都起不来
    log.warn('读知识范围失败，按不收窄处理', { templateId, error: (err as Error).message });
    return null;
  }
}

/** 系统提示词那段需要条目标题（模型看 id 没用）。 */
export async function knowledgeBlockFor(workspaceId: string, scope: KnowledgeScope | null): Promise<string> {
  if (!scope) return '';
  const items = scope.libraryItemIds.length
    ? await prisma.inspirationItem.findMany({ where: { workspaceId, id: { in: scope.libraryItemIds } }, select: { title: true } })
    : [];
  return knowledgePromptBlock(scope, { libraryTitles: items.map((i) => i.title) });
}

export type Citation = { sourceType: KnowledgeSourceType; sourceId: string; label: string };

/** 引用落库：AgentStep(kind='citation', seq=0)。旁路增强，记不下来不影响执行。 */
export async function recordCitations(runId: string, items: readonly Citation[]): Promise<void> {
  if (items.length === 0) return;
  try {
    await prisma.agentStep.createMany({
      data: items.slice(0, 50).map((c) => ({ runId, seq: 0, kind: 'citation', tool: c.sourceType, args: JSON.stringify({ sourceId: c.sourceId }), result: c.label.slice(0, 300), ok: true })),
    });
  } catch (err) {
    log.warn('引用没记下来', { runId, error: (err as Error).message });
  }
}

export type CitationView = Citation & { href: string; at: string };

function citationHref(sourceType: string, sourceId: string): string {
  if (sourceType === 'library_item') return `/library?item=${sourceId}`;
  if (sourceType === 'library_tag') return `/library?tag=${encodeURIComponent(sourceId)}`;
  if (sourceType === 'material_type') return '/material';
  if (sourceType === 'memory') return '/persona';
  return '';
}

export async function listCitations(runId: string): Promise<CitationView[]> {
  const rows = await prisma.agentStep.findMany({ where: { runId, kind: 'citation' }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => {
    let sourceId = '';
    try { sourceId = String((JSON.parse(r.args) as { sourceId?: string }).sourceId ?? ''); } catch { /* 老行 */ }
    return { sourceType: r.tool as KnowledgeSourceType, sourceId, label: r.result, href: citationHref(r.tool, sourceId), at: r.createdAt.toISOString() };
  });
}

// ── 增删改（页面动作层调；权限在调用方判） ──────────────────────────────────

export type BindInput = { sourceType: KnowledgeSourceType; sourceId: string; purpose?: string; priority?: number };

export async function bindKnowledge(workspaceId: string, templateId: string, memberId: string, input: BindInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const sourceId = input.sourceId.trim().slice(0, 120);
  if (!sourceId) return { ok: false, error: '来源不能为空' };
  // 各类来源的取值口径（2026-09-11 审计补的校验）：记忆只有 '*'；标签不许带分隔符；素材类型要么 '*' 要么现有类型
  if (input.sourceType === 'memory' && sourceId !== '*') return { ok: false, error: '人设记忆只能整体绑定（sourceId 用 *）' };
  if (input.sourceType === 'library_tag' && /[,，\s]/.test(sourceId)) return { ok: false, error: '标签不能含逗号或空格' };
  if (input.sourceType === 'material_type' && sourceId !== '*') {
    const acc = await prisma.creatorAccount.findMany({ where: { workspaceId }, select: { id: true } });
    const has = await prisma.material.count({ where: { accountId: { in: acc.map((a) => a.id) }, type: sourceId } });
    if (!has) return { ok: false, error: `这个工作区没有类型为「${sourceId}」的素材` };
  }
  if (input.sourceType === 'library_item') {
    const item = await prisma.inspirationItem.findFirst({ where: { id: sourceId, workspaceId }, select: { id: true } });
    if (!item) return { ok: false, error: '这条资讯库条目不存在或不属于当前工作区' };
  }
  const row = await prisma.agentKnowledgeBinding.upsert({
    where: { workspaceId_templateId_sourceType_sourceId: { workspaceId, templateId, sourceType: input.sourceType, sourceId } },
    create: { workspaceId, templateId, sourceType: input.sourceType, sourceId, purpose: (input.purpose ?? '').slice(0, 200), priority: input.priority ?? 0, createdBy: memberId },
    update: { purpose: (input.purpose ?? '').slice(0, 200), priority: input.priority ?? 0, enabled: true },
  });
  return { ok: true, id: row.id };
}

export async function setBindingEnabled(workspaceId: string, id: string, enabled: boolean): Promise<boolean> {
  const r = await prisma.agentKnowledgeBinding.updateMany({ where: { id, workspaceId }, data: { enabled } });
  return r.count > 0;
}

export async function removeBinding(workspaceId: string, id: string): Promise<boolean> {
  const r = await prisma.agentKnowledgeBinding.deleteMany({ where: { id, workspaceId } });
  return r.count > 0;
}
