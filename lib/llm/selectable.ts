import { prisma } from '@/lib/db';
import { can } from '@/lib/edition';
import { LLM_VENDORS } from '@/lib/constants';
import { PLATFORM_PROVIDER_ID } from './gateway';

// 新任务页「用哪个模型」下拉的数据源（2026-08-26）。
//
// 【为什么分自接入 / 外接入两档】用户问的是「我这次花谁的钱、用谁的模型」：
//   · 自接入（byok）＝ 你自己在「接入与密钥」里填的 Key，烧你自己的额度、不受平台预算闸约束；
//   · 外接入（platform）＝ 平台垫付的公共渠道，按套餐分档计费、过平台预算闸。
// 这两句差别必须写在选项上，不能只列个模型名——否则用户不知道自己在选什么。
//
// 【自动那一档不是"随便挑一个"】它是既有的按功能路由（routing → 默认渠道 → 平台 → env），
// 也就是不选时系统本来的行为。默认必须是它：用户没表达偏好时，按功能配好的路由比
// 「上次随手选的那个」更可能是对的。
export type SelectableModel = {
  id: string;
  label: string;
  /** 模型名（自动档没有具体模型，为 null） */
  model: string | null;
  kind: 'auto' | 'byok' | 'platform';
  /** 境外模型要显式标出来：出海合规与延迟都不一样 */
  overseas: boolean;
  /** 这一档在界面上的一句话说明 */
  note: string;
};

export const AUTO_MODEL_ID = 'auto';

/**
 * 把界面上选的模型 id 归一成可落库的 providerId（2026-09-11 按任务选模型）。
 *   ''/auto/undefined → null（按功能路由，旧行为）
 *   'platform'        → 'platform'（这个形态开了平台渠道才认）
 *   其它              → 必须是本租户一条没失效的 ModelProvider，否则报错——别人的 id 静默落回自动会让用户以为选中了
 */
export async function normalizeProviderChoice(tenantId: string, id: string | null | undefined): Promise<{ ok: true; providerId: string | null } | { ok: false; error: string }> {
  const v = (id ?? '').trim();
  if (!v || v === AUTO_MODEL_ID) return { ok: true, providerId: null };
  if (v === PLATFORM_PROVIDER_ID) return can('platformLlmChannel') ? { ok: true, providerId: PLATFORM_PROVIDER_ID } : { ok: false, error: '这个部署形态没有平台模型渠道' };
  const p = await prisma.modelProvider.findFirst({ where: { id: v, tenantId, status: { not: 'failed' } }, select: { id: true } });
  return p ? { ok: true, providerId: p.id } : { ok: false, error: '选的模型渠道不存在或已失效，去「接入与密钥」看一眼' };
}

/** providerId → 给人看的名字。null = 自动。 */
export async function providerLabel(tenantId: string, id: string | null | undefined, lang: string = 'zh'): Promise<string> {
  const isEn = lang === 'en';
  if (!id || id === AUTO_MODEL_ID) return isEn ? 'Auto' : '自动';
  if (id === PLATFORM_PROVIDER_ID) return isEn ? 'Platform default' : '平台默认模型';
  const p = await prisma.modelProvider.findFirst({ where: { id, tenantId }, select: { label: true, vendor: true, model: true, status: true } });
  if (!p) return isEn ? 'Channel removed' : '（渠道已删除，按自动跑）';
  return `${p.label || (LLM_VENDORS[p.vendor]?.name ?? p.vendor)}${p.model ? ` · ${p.model}` : ''}${p.status === 'failed' ? (isEn ? ' (failed)' : '（已失效）') : ''}`;
}

/** 这次派活可以选哪些模型。顺序即界面顺序：自动 → 自接入若干 → 外接入。 */
export async function listSelectableModels(tenantId: string, lang: string = 'zh'): Promise<SelectableModel[]> {
  const isEn = lang === 'en';
  const out: SelectableModel[] = [
    {
      id: AUTO_MODEL_ID,
      label: isEn ? 'Auto' : '自动',
      model: null,
      kind: 'auto',
      overseas: false,
      note: isEn
        ? 'Routes automatically by function; uses default provider if unconfigured'
        : '按你在「接入与密钥」里配的功能路由挑，没配就用默认渠道',
    },
  ];

  // status: 'failed' 的不列——列出来点了必报错，等于给用户一个坏选项。
  // 'untested' 保留：没测过不代表不能用，而且不列会让刚填完 Key 的用户以为没生效。
  const providers = await prisma.modelProvider.findMany({
    where: { tenantId, status: { not: 'failed' } },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  const vendorName = (v: string) => LLM_VENDORS[v]?.name ?? v;
  for (const p of providers) {
    out.push({
      id: p.id,
      label: p.label || vendorName(p.vendor),
      model: p.model,
      kind: 'byok',
      overseas: p.region === 'overseas',
      note: isEn
        ? (p.isDefault ? 'Default channel · uses your quota' : 'Custom connected · uses your quota')
        : (p.isDefault ? '你的默认渠道 · 烧你自己的额度' : '你自己接入的 · 烧你自己的额度'),
    });
  }

  // 企业版没有平台垫付渠道（lib/llm/gateway.ts 对 platform 段整段跳过），
  // 列出来就是告诉客户一个他机器上不存在的东西可以用。
  if (can('platformLlmChannel')) {
    out.push({
      id: PLATFORM_PROVIDER_ID,
      label: isEn ? 'Platform Default Model' : '平台默认模型',
      model: null,
      kind: 'platform',
      overseas: false,
      note: isEn
        ? 'Platform covered · billed by plan tier, no key needed'
        : '平台垫付 · 按套餐分档计费，不用自己填 Key',
    });
  }
  return out;
}
