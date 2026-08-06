// RBAC 权限矩阵（PRD §14 团队协作）。
// 动作粒度而非页面粒度：页面可以合并拆分，动作是稳定的业务语义。
// 用法：页面用 can() 决定渲染，server action 用 requireRole() 硬拦。

export const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  owner: '所有者',
  admin: '管理员',
  editor: '编辑',
  viewer: '只读',
};

export const ROLE_DESC: Record<Role, string> = {
  owner: '全部权限，含删除工作区、转让所有权、管理计费',
  admin: '管理成员与模型配置 + 全部内容操作，不能动所有者',
  editor: '内容创作全流程（选题/创作/合规/发布），不能管成员与模型',
  viewer: '只读，看得到所有内容但不能改',
};

// 可授予的角色：owner 不在其中——所有权只能通过「转让」流转，不能靠邀请/改角色凭空产生
export const ASSIGNABLE_ROLES: Role[] = ['admin', 'editor', 'viewer'];

export type Action =
  // 租户级（仅 owner）
  | 'tenant.delete'
  | 'tenant.transfer'
  | 'billing.manage'
  // 成员管理
  | 'member.view'
  | 'member.invite'
  | 'member.role'
  | 'member.suspend'
  | 'member.remove'
  // 模型接入（BYOK）
  | 'byok.manage'
  // 全量数据导出（一次把整个工作区打包带走）
  | 'data.export'
  // 内容创作
  | 'persona.edit'
  | 'topic.manage'
  | 'competitor.manage'
  | 'content.create'
  | 'content.publish'
  | 'compliance.check'
  | 'compliance.resolve'
  | 'task.manage'
  // 只读
  | 'content.view';

// 权限矩阵：动作 → 允许的角色
const MATRIX: Record<Action, readonly Role[]> = {
  'tenant.delete': ['owner'],
  'tenant.transfer': ['owner'],
  'billing.manage': ['owner'],

  'member.view': ['owner', 'admin'],
  'member.invite': ['owner', 'admin'],
  'member.role': ['owner', 'admin'],
  'member.suspend': ['owner', 'admin'],
  'member.remove': ['owner', 'admin'],

  'byok.manage': ['owner', 'admin'],

  // 逐页浏览与「一个文件带走全部」不是同一件事：editor/viewer 看得到内容，
  // 但把整个工作区打包成一份可离线传播的副本，责任面已经越出内容协作，收口到管理者。
  'data.export': ['owner', 'admin'],

  'persona.edit': ['owner', 'admin', 'editor'],
  'topic.manage': ['owner', 'admin', 'editor'],
  'competitor.manage': ['owner', 'admin', 'editor'],
  'content.create': ['owner', 'admin', 'editor'],
  'content.publish': ['owner', 'admin', 'editor'],
  'compliance.check': ['owner', 'admin', 'editor'],
  // 处理误报申诉＝对本租户的合规口径下结论，收口到管理者
  'compliance.resolve': ['owner', 'admin'],
  'task.manage': ['owner', 'admin', 'editor'],

  'content.view': ['owner', 'admin', 'editor', 'viewer'],
};

// 动作的中文名，用于拒绝时给人话
const ACTION_LABEL: Record<Action, string> = {
  'tenant.delete': '删除工作区',
  'tenant.transfer': '转让所有权',
  'billing.manage': '管理计费',
  'member.view': '查看成员',
  'member.invite': '邀请成员',
  'member.role': '修改成员角色',
  'member.suspend': '停用成员',
  'member.remove': '移除成员',
  'byok.manage': '修改模型接入配置',
  'data.export': '导出全部数据',
  'persona.edit': '编辑人设与记忆',
  'topic.manage': '管理选题',
  'competitor.manage': '管理对标账号',
  'content.create': '创作内容',
  'content.publish': '发布内容',
  'compliance.check': '执行合规检测',
  'compliance.resolve': '处理合规申诉',
  'task.manage': '管理任务清单',
  'content.view': '查看内容',
};

export function isRole(x: string): x is Role {
  return (ROLES as readonly string[]).includes(x);
}

export function can(role: string, action: Action): boolean {
  return isRole(role) && MATRIX[action].includes(role);
}

// 权限不足错误：server action 里 throw，前端 catch 到的是这句中文
export class RbacError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RbacError';
  }
}

// server action 守卫：不满足直接 throw，调用方不必判返回值
export function requireRole(ctx: { role: string }, action: Action): void {
  if (!can(ctx.role, action)) {
    const label = isRole(ctx.role) ? ROLE_LABEL[ctx.role] : ctx.role;
    throw new RbacError(`权限不足：${label}无权${ACTION_LABEL[action]}`);
  }
}
