import { describe, it, expect } from 'vitest';
import { can, requireRole, RbacError, ROLES, ASSIGNABLE_ROLES, isRole, type Action, type Role } from '@/lib/rbac';

// RBAC 权限矩阵。这里把矩阵**再写一遍**当作期望值，而不是 import 实现里的 MATRIX——
// 用实现去测实现等于什么都没测。改权限时这份表也要改，那次改动就会被迫过一次脑子。
const EXPECTED: Record<Action, Role[]> = {
  'tenant.delete': ['owner'],
  'tenant.transfer': ['owner'],
  'billing.manage': ['owner'],
  'member.view': ['owner', 'admin'],
  'member.invite': ['owner', 'admin'],
  'member.role': ['owner', 'admin'],
  'member.suspend': ['owner', 'admin'],
  'member.remove': ['owner', 'admin'],
  'byok.manage': ['owner', 'admin'],
  // 逐页看得到 ≠ 能把整个工作区打包带走，收口到管理者
  'data.export': ['owner', 'admin'],
  'persona.edit': ['owner', 'admin', 'editor'],
  'topic.manage': ['owner', 'admin', 'editor'],
  'competitor.manage': ['owner', 'admin', 'editor'],
  'content.create': ['owner', 'admin', 'editor'],
  'content.publish': ['owner', 'admin', 'editor'],
  'compliance.check': ['owner', 'admin', 'editor'],
  // 处理误报申诉＝对本租户合规口径下结论，收口到管理者
  'compliance.resolve': ['owner', 'admin'],
  'task.manage': ['owner', 'admin', 'editor'],
  'content.view': ['owner', 'admin', 'editor', 'viewer'],
};

describe('rbac · 权限矩阵逐格校验', () => {
  // 19 动作 × 4 角色 = 76 格，全测
  for (const [action, allowed] of Object.entries(EXPECTED) as [Action, Role[]][]) {
    for (const role of ROLES) {
      const should = allowed.includes(role);
      it(`${role} ${should ? '可以' : '不可以'} ${action}`, () => {
        expect(can(role, action)).toBe(should);
      });
    }
  }
});

describe('rbac · 角色单调性', () => {
  it('owner 拥有全部动作', () => {
    for (const a of Object.keys(EXPECTED) as Action[]) expect(can('owner', a)).toBe(true);
  });

  it('viewer 只有 content.view', () => {
    const allowed = (Object.keys(EXPECTED) as Action[]).filter((a) => can('viewer', a));
    expect(allowed).toEqual(['content.view']);
  });

  it('权限逐级包含：viewer ⊂ editor ⊂ admin ⊂ owner', () => {
    const setOf = (r: Role) => new Set((Object.keys(EXPECTED) as Action[]).filter((a) => can(r, a)));
    const [viewer, editor, admin, owner] = [setOf('viewer'), setOf('editor'), setOf('admin'), setOf('owner')];
    for (const a of viewer) expect(editor.has(a)).toBe(true);
    for (const a of editor) expect(admin.has(a)).toBe(true);
    for (const a of admin) expect(owner.has(a)).toBe(true);
  });

  it('editor 碰不到成员管理与 BYOK', () => {
    for (const a of ['member.view', 'member.invite', 'member.role', 'member.remove', 'byok.manage'] as Action[]) {
      expect(can('editor', a)).toBe(false);
    }
  });

  it('admin 碰不到租户级动作（删除/转让/计费）', () => {
    for (const a of ['tenant.delete', 'tenant.transfer', 'billing.manage'] as Action[]) {
      expect(can('admin', a)).toBe(false);
    }
  });
});

describe('rbac · 未知角色一律拒绝（默认关闭）', () => {
  for (const bogus of ['', 'OWNER', 'root', 'superadmin', 'admin ', 'null', 'undefined']) {
    it(`未知角色 ${JSON.stringify(bogus)} 对所有动作都是 false`, () => {
      for (const a of Object.keys(EXPECTED) as Action[]) expect(can(bogus, a)).toBe(false);
    });
  }

  it('isRole 只认这四个', () => {
    expect(ROLES.every(isRole)).toBe(true);
    for (const b of ['Owner', 'guest', '']) expect(isRole(b)).toBe(false);
  });
});

describe('rbac · owner 不可授予（「至少保留一个 owner」的结构性保证）', () => {
  // 这条是 rbac agent 声称的核心设计：owner 不在可授予集合里，
  // 配合「owner 不可降级/移除/停用」，owner 既不能被抹掉也无法凭空产生。
  // 这里验证前半句——后半句（业务边界）在 tests/members-guard.test.ts。
  it('ASSIGNABLE_ROLES 不含 owner', () => {
    expect(ASSIGNABLE_ROLES).not.toContain('owner');
  });

  it('ASSIGNABLE_ROLES 恰为 admin/editor/viewer', () => {
    expect([...ASSIGNABLE_ROLES].sort()).toEqual(['admin', 'editor', 'viewer']);
  });

  it('ASSIGNABLE_ROLES 里每个都是合法角色', () => {
    for (const r of ASSIGNABLE_ROLES) expect(isRole(r)).toBe(true);
  });
});

describe('rbac · requireRole 守卫', () => {
  it('有权限时不抛', () => {
    expect(() => requireRole({ role: 'admin' }, 'member.invite')).not.toThrow();
  });

  it('无权限时抛 RbacError', () => {
    expect(() => requireRole({ role: 'viewer' }, 'member.invite')).toThrow(RbacError);
  });

  it('错误文案是可直接展示的中文：「权限不足：只读无权邀请成员」', () => {
    expect(() => requireRole({ role: 'viewer' }, 'member.invite')).toThrow('权限不足：只读无权邀请成员');
  });

  it('未知角色的错误文案回显原始角色名，便于排查脏数据', () => {
    expect(() => requireRole({ role: 'weird' }, 'content.view')).toThrow('权限不足：weird无权查看内容');
  });

  it('editor 越权改角色的文案', () => {
    expect(() => requireRole({ role: 'editor' }, 'member.role')).toThrow('权限不足：编辑无权修改成员角色');
  });

  it('RbacError.name 正确，供上层区分权限错误与业务错误', () => {
    try {
      requireRole({ role: 'viewer' }, 'tenant.delete');
      expect.unreachable('应当抛出');
    } catch (e) {
      expect((e as Error).name).toBe('RbacError');
    }
  });
});
