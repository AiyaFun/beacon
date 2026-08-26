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

/** 这次派活可以选哪些模型。顺序即界面顺序：自动 → 自接入若干 → 外接入。 */
export async function listSelectableModels(tenantId: string): Promise<SelectableModel[]> {
  const out: SelectableModel[] = [
    {
      id: AUTO_MODEL_ID,
      label: '自动',
      model: null,
      kind: 'auto',
      overseas: false,
      note: '按你在「接入与密钥」里配的功能路由挑，没配就用默认渠道',
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
      note: p.isDefault ? '你的默认渠道 · 烧你自己的额度' : '你自己接入的 · 烧你自己的额度',
    });
  }

  // 企业版没有平台垫付渠道（lib/llm/gateway.ts 对 platform 段整段跳过），
  // 列出来就是告诉客户一个他机器上不存在的东西可以用。
  if (can('platformLlmChannel')) {
    out.push({
      id: PLATFORM_PROVIDER_ID,
      label: '平台默认模型',
      model: null,
      kind: 'platform',
      overseas: false,
      note: '平台垫付 · 按套餐分档计费，不用自己填 Key',
    });
  }
  return out;
}
