'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { fetchCatalog, markInstalled } from '@/lib/market/catalog';
import { installFromUrl, checkUpdates, exportSkillPack } from '@/lib/market/install';
import { requireRole } from '@/lib/rbac';
import { installSkill, uninstallSkill, createCustomSkill } from '@/lib/skills';
import { importSkillFromUrl } from '@/lib/skills/import';
import { prisma } from '@/lib/db';
import { assertNotDemo } from '@/lib/demo/guard';

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

// ── 市场 ────────────────────────────────────────────────────────────────────
//
// 【与「从网址一键导入」的分工，说死】
//   · 市场来的一律走 beaconPack 严格校验（lib/market/pack.ts）——那是它能回答
//     「谁做的、版本几、有没有新版本」的前提。
//   · 「贴一个链接」那条宽松识别链留着（用户手上的 SKILL.md、一篇想学的文章），
//     但它**不是绕过市场校验的近路**：走那条路的技能没有版本、没有来源，
//     也就享受不到「检查更新」。界面上要把这个差别说清楚。

export async function actFetchMarket() {
  const s = await getSession();
  requireRole(s, 'content.view');

  const [catalog, installed] = await Promise.all([
    fetchCatalog(),
    prisma.contentSkill.findMany({
      where: { tenantId: s.tenantId },
      select: { slug: true, version: true },
    }),
  ]);
  if (!catalog.ok) return { ok: false as const, error: catalog.error, entries: [] };
  return { ok: true as const, entries: markInstalled(catalog.entries, installed), updatedAt: catalog.updatedAt };
}

export async function actInstallFromMarket(url: string): Promise<ActionResult & { name?: string; updated?: boolean }> {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);

  const r = await installFromUrl(s.tenantId, s.memberId, url);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath('/skills');
  return { ok: true, name: r.name, updated: r.updated };
}

/**
 * 检查已装的市场技能有没有新版本。**只报告，不自动更新。**
 *
 * 内置技能的同步是静默覆盖的（那些是平台自己写的，用户对它没有预期）；
 * 市场装的不一样——用户挑过、看过、可能还改过用法。上游一改他手上那条就变了
 * 而没人告诉他，比「有新版本没装」糟得多。
 */
export async function actCheckSkillUpdates() {
  const s = await getSession();
  requireRole(s, 'content.view');
  return { ok: true as const, updates: await checkUpdates(s.tenantId) };
}

/**
 * 把一个技能导出成可分享的 beaconPack 包。
 *
 * 【为什么补这个】`exportSkillPack` 2026-08-29 被全库「写了没接」扫描查出：
 * 建好了、能跑，但**没有任何入口**。而工作流那边是对称通的（actExportWorkflow）——
 * 于是技能包变成「能装不能导」：用户能从市场装别人的，却分享不出自己的，
 * 而市场本来就把技能包当作可分发单位之一（beaconPack:1 的 kind='skill'）。
 *
 * 不是空承诺（界面上没说过技能能导出），但是个半成品能力。
 * 按这个项目的规矩：**要么接上它，要么删掉它**——这里选接上。
 */
export async function actExportSkill(skillId: string): Promise<{ ok: boolean; json?: string; error?: string }> {
  const s = await getSession();
  // 与导入/新建同级：导出的是提示词模板本身，属于工作区资产
  requireRole(s, 'content.create');
  const json = await exportSkillPack(s.tenantId, String(skillId ?? ''));
  return json ? { ok: true, json } : { ok: false, error: '技能不存在，或不属于这个工作区' };
}
