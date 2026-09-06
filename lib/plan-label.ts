/**
 * 套餐显示名。抽出来是因为顶栏与侧栏账号区两处都要用——
 * 各写一份的话改套餐名时必然漏一处，而这种漏法不会红、只会两处显示不一致。
 */
export const PLAN_LABEL: Record<string, string> = {
  free: '免费版',
  trial: '试用中',
  personal: '标准版',
  byok: '自带 Key 版',
  team: '团队版', // 已下线，存量租户显示用
  enterprise: '企业版',
};

export const PLAN_LABEL_EN: Record<string, string> = {
  free: 'Free Tier',
  trial: 'Trial',
  personal: 'Pro Plan',
  byok: 'BYOK Plan',
  team: 'Team Plan',
  enterprise: 'Enterprise',
};

export function getPlanLabel(plan: string | null | undefined, lang?: string): string {
  const p = plan ?? 'free';
  if (lang === 'en') return PLAN_LABEL_EN[p] ?? p;
  return PLAN_LABEL[p] ?? '免费版';
}
