import { getSession } from '@/lib/session';
import { can } from '@/lib/rbac';
import { listSkillsForTenant } from '@/lib/skills';
import { PageHead, Stat } from '@/components/ui';
import { SkillCenter } from './SkillCenter';

export const dynamic = 'force-dynamic';

// 技能中心：内置技能全租户可见、按租户安装；自定义技能（提示词模板）归属本租户。
// 装好的技能在创作工坊对草稿/终稿一键生成平台成品。

export default async function SkillsPage() {
  const s = await getSession();
  const skills = await listSkillsForTenant(s.tenantId);
  const readOnly = !can(s.role, 'content.create');

  const installed = skills.filter((k) => k.installed).length;
  const custom = skills.filter((k) => !k.isBuiltin).length;

  return (
    <>
      <PageHead
        title="技能中心"
        desc="技能 = 教 AI 按某个平台的规矩出成品。装上后在创作工坊一键使用。"
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="可用技能" value={skills.length} foot="内置 + 本团队自定义" />
        <Stat label="已安装" value={installed} foot="创作工坊里可直接用" />
        <Stat label="自定义技能" value={custom} foot="你自己教 AI 的活" />
        <Stat label="内置技能" value={skills.length - custom} foot="平台维护，持续更新" />
      </div>

      {readOnly && (
        <div className="small muted" style={{ marginBottom: 12 }}>
          你是只读成员：可以浏览技能，但安装/卸载/创建需要编辑及以上权限。
        </div>
      )}

      <SkillCenter skills={skills} readOnly={readOnly} />
    </>
  );
}
