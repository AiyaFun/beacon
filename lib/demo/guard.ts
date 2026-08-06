// 演示（游客）租户的固定标识与只读护栏。**不依赖 prisma**（可被任意层安全引用）。
//
// 用固定 ID 常量识别演示租户，而非给 Tenant 加 isDemo 字段——零 schema 改动，
// 且判定只是一次字符串比较。演示成员本身是 viewer 角色（RBAC 已挡住绝大多数写/生成入口），
// 这里的 assertNotDemo 是**纵深防御**：兜住 viewer 仍可能触达、且有成本/副作用的少数路径
//（LLM 网关烧 token、下单）。

export const DEMO_TENANT_ID = 'demo-tenant-fixed-0001';
export const DEMO_WORKSPACE_ID = 'demo-workspace-fixed-0001';
export const DEMO_MEMBER_ID = 'demo-member-fixed-0001';
export const DEMO_ACCOUNT_ID = 'demo-account-fixed-0001';

export function isDemoTenant(tenantId: string | null | undefined): boolean {
  return tenantId === DEMO_TENANT_ID;
}

export class DemoReadonlyError extends Error {
  readonly code = 'DEMO_READONLY';
  constructor(message = '当前是演示模式（只读体验）。注册一个账号即可开启你自己的工作台。') {
    super(message);
    this.name = 'DemoReadonlyError';
  }
}

/** 演示租户禁止的写/计费/生成动作在此硬拦（抛 DemoReadonlyError，文案可直接展示）。 */
export function assertNotDemo(tenantId: string | null | undefined): void {
  if (isDemoTenant(tenantId)) throw new DemoReadonlyError();
}
