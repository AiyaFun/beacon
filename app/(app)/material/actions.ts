'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession, withSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { parseJson, toJson } from '@/lib/json';
import { MATERIAL_TYPES, type MaterialType, type MaterialItem } from './types';

// 关于 withSession（RLS 生效路径）的取舍，见 lib/session.ts 顶部注释：
// 「先查归属再按 id 改」这类**短事务、纯 DB** 的写操作走 withSession，
// 让 Postgres 行级策略在应用层 where 之外再兜一层；带 LLM 调用的动作**不能**这么写。

export async function actCreateMaterial(
  type: MaterialType,
  content: string,
  tags: string[],
): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'persona.edit');
  if (!s.accountId) return { ok: false, error: '未选择账号' };

  const clean = content.trim().slice(0, 2000);
  if (clean.length < 4) return { ok: false, error: '内容至少 4 个字' };
  if (!Object.keys(MATERIAL_TYPES).includes(type)) return { ok: false, error: '类型无效' };

  const cleanTags = (tags || [])
    .map((t) => t.trim().slice(0, 20))
    .filter(Boolean)
    .slice(0, 5);

  const count = await prisma.material.count({ where: { accountId: s.accountId } });
  if (count >= 100) return { ok: false, error: '素材上限 100 条，请删除旧素材后再添加' };

  await prisma.material.create({
    data: {
      accountId: s.accountId,
      type,
      content: clean,
      tags: toJson(cleanTags),
    },
  });

  revalidatePath('/material');
  return { ok: true };
}

export async function actUpdateMaterial(
  id: string,
  content: string,
  tags: string[],
): Promise<{ ok: boolean; error?: string }> {
  const clean = content.trim().slice(0, 2000);
  if (clean.length < 4) return { ok: false, error: '内容至少 4 个字' };
  const cleanTags = (tags || [])
    .map((t) => t.trim().slice(0, 20))
    .filter(Boolean)
    .slice(0, 5);

  return withSession(async (s, tx) => {
    requireRole(s, 'persona.edit');
    // 查归属与改动在**同一个事务**里：RLS 上下文已设好，跨租户的 id 在库层就查不到
    const item = await tx.material.findFirst({ where: { id, accountId: s.accountId } });
    if (!item) return { ok: false, error: '素材不存在' };
    await tx.material.update({ where: { id }, data: { content: clean, tags: toJson(cleanTags) } });
    revalidatePath('/material');
    return { ok: true };
  });
}

export async function actDeleteMaterial(id: string): Promise<{ ok: boolean }> {
  return withSession(async (s, tx) => {
    requireRole(s, 'persona.edit');
    const item = await tx.material.findFirst({ where: { id, accountId: s.accountId } });
    if (!item) return { ok: false };
    await tx.material.delete({ where: { id } });
    revalidatePath('/material');
    return { ok: true };
  });
}

export async function actListMaterials(): Promise<MaterialItem[]> {
  const s = await getSession();
  if (!s.accountId) return [];

  const items = await prisma.material.findMany({
    where: { accountId: s.accountId },
    orderBy: { createdAt: 'desc' },
  });

  return items.map((m) => ({
    id: m.id,
    type: m.type as MaterialType,
    content: m.content,
    tags: parseJson<string[]>(m.tags, []),
    createdAt: m.createdAt.toISOString(),
  }));
}
