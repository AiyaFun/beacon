// 运维台能给租户设置的档位。
//
// 【为什么单独一个文件】它同时被 'use server' 的 actions.ts（服务端校验）与
// TenantRow.tsx（客户端下拉框）用。放进 actions.ts 会违反 Next 的规矩
//（'use server' 文件只应导出 async 函数），也会把整份 action 模块拖进客户端依赖图。
// 一份纯数据、两边都能引，才是正解。
export const ASSIGNABLE_PLANS = ['free', 'trial', 'personal', 'byok', 'enterprise'] as const;
export type AssignablePlan = (typeof ASSIGNABLE_PLANS)[number];
