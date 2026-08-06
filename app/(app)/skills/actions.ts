'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { installSkill, uninstallSkill, createCustomSkill, type SkillOutputKind } from '@/lib/skills';
import { importSkillFromUrl } from '@/lib/skills/import';

// 技能中心 server actions。安装/卸载/创建都是内容生产链路的配置动作，
// 与创作工坊同口径收 content.create（viewer 只读，页面按钮也不给渲染，这里是硬拦）。

type ActionResult = { ok: boolean; error?: string };

export async function actInstallSkill(skillId: string): Promise<ActionResult> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create');
    await installSkill(s.tenantId, skillId);
    revalidatePath('/skills');
    revalidatePath('/studio'); // 已装技能列表在创作工坊出现
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function actUninstallSkill(skillId: string): Promise<ActionResult> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create');
    await uninstallSkill(s.tenantId, skillId);
    revalidatePath('/skills');
    revalidatePath('/studio');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type CreateSkillInput = {
  name: string;
  description: string;
  platform: string;
  promptTemplate: string;
  // 自定义技能只开放文本三态；image（AI 生图封面）v1 仅内置（见 lib/skills/createCustomSkill）
  outputKind: 'markdown' | 'html' | 'text';
  emoji?: string;
};

export async function actCreateSkill(input: CreateSkillInput): Promise<ActionResult> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create');
    await createCustomSkill(s.tenantId, input);
    revalidatePath('/skills');
    revalidatePath('/studio');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// 从网址一键导入技能：技能定义链接（GitHub 等）直接解析，内容作品链接交 LLM 生成。
// 与创建同口径收 content.create（viewer 只读）。SSRF 护栏与解析在 lib/skills/import.ts。
export async function actImportSkillFromUrl(url: string): Promise<ActionResult & { skillName?: string; via?: string }> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create');
    const r = await importSkillFromUrl(s.tenantId, String(url ?? ''));
    if (!r.ok) return { ok: false, error: r.error };
    revalidatePath('/skills');
    revalidatePath('/studio');
    return { ok: true, skillName: r.skill.name, via: r.via };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
