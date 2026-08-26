-- 14 · 工作流模板/安装补租户外键（2026-08-19 · 注销租户时会留孤儿行）
--
-- 【问题】ContentSkill / SkillInstall 都有 `tenant ... onDelete: Cascade`，
-- 而同构的 WorkflowTemplate / WorkflowInstall 漏了。注销租户走的是
-- `tx.tenant.delete()` 靠外键级联，没有这条外键 = 用户自建的工作流模板与安装记录
-- 永远留在库里，没有任何路径会清理它们。
--
-- 【顺序要紧】先清孤儿再建约束：存量库里可能已经有指向已删租户的行，
-- 直接 ADD CONSTRAINT 会失败（而且是在部署中途失败）。
-- 内置模板 tenantId IS NULL，不受影响——WHERE 里显式排除。

-- ① 清掉指向已不存在租户的行（内置模板 tenantId 为 NULL，不动）
DELETE FROM "WorkflowInstall" wi
 WHERE NOT EXISTS (SELECT 1 FROM "Tenant" t WHERE t.id = wi."tenantId");

DELETE FROM "WorkflowTemplate" wt
 WHERE wt."tenantId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "Tenant" t WHERE t.id = wt."tenantId");

-- ② 建约束（幂等：先判存在再加）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkflowTemplate_tenantId_fkey') THEN
    ALTER TABLE "WorkflowTemplate"
      ADD CONSTRAINT "WorkflowTemplate_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkflowInstall_tenantId_fkey') THEN
    ALTER TABLE "WorkflowInstall"
      ADD CONSTRAINT "WorkflowInstall_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
