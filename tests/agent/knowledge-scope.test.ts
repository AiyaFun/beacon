import { describe, it, expect } from 'vitest';
import { scopeOf, libraryInScope, libraryItemAllowed, materialTypesInScope, knowledgePromptBlock, type KnowledgeBinding } from '@/lib/agent/knowledge-scope';

// 知识范围（2026-09-11 P1）：同一任务换员工后知识范围必须不同；禁用后下一次不再检索。

const b = (p: Partial<KnowledgeBinding>): KnowledgeBinding => ({ id: 'x', sourceType: 'library_item', sourceId: 'i1', purpose: '', priority: 0, enabled: true, ...p });

describe('scopeOf：绑定行 → 范围', () => {
  it('一条都没有 = null（不收窄，旧行为）', () => {
    expect(scopeOf('t', [])).toBeNull();
  });
  it('🔒 全部禁用 ≠ 不收窄：范围变空，资讯库/素材/记忆全部不在范围里（审计修正：关掉最后一条不能反而读全库）', () => {
    const s = scopeOf('t', [b({ enabled: false })]);
    expect(s).not.toBeNull();
    expect(libraryInScope(s)).toBe(false);
    expect(materialTypesInScope(s)).toEqual({ allowed: false, types: [] });
    expect(s!.memory).toBe(false);
    expect(knowledgePromptBlock(s, { libraryTitles: [] })).toContain('没有任何启用的来源');
  });
  it('有绑定时资讯库只认绑定的 id/标签；素材只认绑定的类型；记忆要显式绑', () => {
    const s = scopeOf('t', [b({ sourceId: 'i1' }), b({ id: 'y', sourceType: 'library_tag', sourceId: '职场' }), b({ id: 'z', sourceType: 'material_type', sourceId: '案例' })])!;
    expect(s.libraryItemIds).toEqual(['i1']);
    expect(s.libraryTags).toEqual(['职场']);
    expect(s.materialTypes).toEqual(['案例']);
    expect(s.memory).toBe(false);
  });
});

describe('过滤判据', () => {
  const s = scopeOf('t', [b({ sourceId: 'i1' }), b({ id: 'y', sourceType: 'library_tag', sourceId: '职场' })])!;
  it('按 id 命中或按标签命中；都不中就不给', () => {
    expect(libraryItemAllowed(s, { id: 'i1', tags: '' })).toBe(true);
    expect(libraryItemAllowed(s, { id: 'i9', tags: '职场,沟通' })).toBe(true);
    expect(libraryItemAllowed(s, { id: 'i9', tags: '育儿' })).toBe(false);
    expect(libraryItemAllowed(null, { id: 'i9', tags: '' })).toBe(true);
  });
  it('范围里没有资讯库 = 资讯库不在范围内（要直说，不静默返回空）', () => {
    const onlyMaterial = scopeOf('t', [b({ sourceType: 'material_type', sourceId: '*' })])!;
    expect(libraryInScope(onlyMaterial)).toBe(false);
    expect(libraryInScope(s)).toBe(true);
    expect(libraryInScope(null)).toBe(true);
  });
  it('素材：没绑 = 不允许；绑 * = 全部；绑类型 = 只那些', () => {
    expect(materialTypesInScope(s)).toEqual({ allowed: false, types: [] });
    expect(materialTypesInScope(scopeOf('t', [b({ sourceType: 'material_type', sourceId: '*' })]))).toEqual({ allowed: true, types: null });
    expect(materialTypesInScope(scopeOf('t', [b({ sourceType: 'material_type', sourceId: '案例' })]))).toEqual({ allowed: true, types: ['案例'] });
    expect(materialTypesInScope(null)).toEqual({ allowed: true, types: null });
  });
  it('提示词块把范围与用途写清楚；无范围为空串', () => {
    expect(knowledgePromptBlock(null, { libraryTitles: [] })).toBe('');
    const txt = knowledgePromptBlock(scopeOf('t', [b({ purpose: '写稿时引用案例' })]), { libraryTitles: ['为什么高效的人不做时间管理'] });
    expect(txt).toContain('知识范围');
    expect(txt).toContain('为什么高效的人不做时间管理');
    expect(txt).toContain('写稿时引用案例');
    expect(txt).toContain('不在范围内');
  });
});
