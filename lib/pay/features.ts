// 套餐功能对照表（2026-09-05 从 app/(app)/billing/page.tsx 抽出来）：
// 登录后的「套餐与计费」页与公开的 /pricing 页共用同一份，两边各写一份必然漂移。
//
// 两个付费档的差异只有一条轴：AI 的 token 钱谁出。
//   标准版 —— 平台垫（200 次/天）；自带 Key 版 —— 用户自己出（平台 Key 仅 30 次/天兜底）。
export type PlanFeatureRow = { name: string; personal: string; byok: string; free?: string };

export function planFeatures(lang: string): PlanFeatureRow[] {
  const en = lang === 'en';
  return [
    {
      name: en ? 'AI Invocations (Platform Key, ready to use)' : 'AI 调用（平台 Key，即开即用）',
      personal: en ? '200 / day · 3,000 / mo' : '200 次/天 · 3,000 次/月',
      byok: en ? '30 / day (Fallback)' : '30 次/天（兜底）',
      free: en ? '30 / day · 300 / mo' : '30 次/天 · 300 次/月',
    },
    {
      name: en ? 'AI Invocations (BYOK, token fee self-paid)' : 'AI 调用（自带 Key，token 费自付）',
      personal: en ? 'Unlimited (Guardrail 5,000/day)' : '不限量（护栏 5,000 次/天）',
      byok: en ? 'Unlimited (Guardrail 5,000/day)' : '不限量（护栏 5,000 次/天）',
      free: en ? '30 / day (capped)' : '30 次/天（收口）',
    },
    { name: en ? 'Trending Topics · Topic Engine' : '热点聚合 · 选题引擎', personal: '✓', byok: '✓', free: '✓' },
    { name: en ? 'Creation Studio · Compliance Check' : '创作工坊 · 合规检测', personal: '✓', byok: '✓', free: '✓' },
    { name: en ? 'Team Member Collaboration' : '团队成员协作', personal: '✓', byok: '✓', free: '✓' },
  ];
}
