-- 媒体资产表（MediaAsset）+ Draft.coverAssetId —— 2026-08-16 新增，**生产需手动执行一次**。
--
-- 为什么单独给一份 SQL 而不是让人跑 db-init-supabase.sh：那个脚本会 `prisma db push`
-- 整个 schema，任何一处本地与生产的漂移都会被一起推上去。加一张表就只加这一张。
--
-- 用法（在能连到生产库的机器上，或 `docker compose exec web`）：
--   DATABASE_URL="postgresql://beacon_app:<PWD>@<HOST>:<PORT>/postgres?schema=beacon&sslmode=require" \
--     npx prisma db execute --schema prisma/schema.postgres.prisma --file prisma/postgres/05-media-asset.sql
--
-- 幂等：全部 IF NOT EXISTS + DO 块判存在，重复跑安全。
--
-- ⚠️ 索引名与 Prisma 的命名规则严格一致（Table_field1_field2_idx）。
--    名字对不上，下次谁跑 db push 时 Prisma 会认为索引缺失并重建一遍。
--
-- ⚠️ data 是 BYTEA：portrait/background/brand 存的是 AES-256-GCM 密文（lib/crypto.ts encryptBytes），
--    cover 存明文。备份（pg_dump）会把它们一起带走，所以配额是硬的、封面历史有保留期
--    （lib/cover/rules.ts 与 lib/legal/retention.ts）。

SET search_path TO beacon, extensions, public;

CREATE TABLE IF NOT EXISTS "MediaAsset" (
  "id"             TEXT NOT NULL,
  "workspaceId"    TEXT NOT NULL,
  "accountId"      TEXT,
  "draftId"        TEXT,
  "kind"           TEXT NOT NULL,
  "mime"           TEXT NOT NULL,
  "data"           BYTEA NOT NULL,
  "encrypted"      BOOLEAN NOT NULL DEFAULT false,
  "size"           INTEGER NOT NULL,
  "width"          INTEGER,
  "height"         INTEGER,
  "meta"           TEXT NOT NULL DEFAULT '{}',
  "label"          TEXT,
  "pinned"         BOOLEAN NOT NULL DEFAULT false,
  "consentAt"      TIMESTAMP(3),
  "consentVersion" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MediaAsset_workspaceId_kind_createdAt_idx"
  ON "MediaAsset" ("workspaceId", "kind", "createdAt");
CREATE INDEX IF NOT EXISTS "MediaAsset_workspaceId_draftId_idx"
  ON "MediaAsset" ("workspaceId", "draftId");
-- 保留期清理按时间扫全表，不带 workspaceId
CREATE INDEX IF NOT EXISTS "MediaAsset_createdAt_idx"
  ON "MediaAsset" ("createdAt");

-- 外键：工作区删除时带走资产（注销链路靠它，见 lib/account/delete.ts）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MediaAsset_workspaceId_fkey'
  ) THEN
    ALTER TABLE "MediaAsset"
      ADD CONSTRAINT "MediaAsset_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- RLS：与 02-rls.sql 里「直接带 workspaceId」那一批同一套策略。
-- 这里重复一遍是刻意的——只跑本文件也必须把策略带上。
ALTER TABLE "MediaAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MediaAsset" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MediaAsset";
CREATE POLICY tenant_isolation ON "MediaAsset" FOR ALL
  USING (app_current_tenant() IS NULL OR "workspaceId" IN (SELECT app_tenant_workspaces()));

-- 草稿选定的封面（MediaAsset.id，无外键——见 schema 注释）
ALTER TABLE "Draft" ADD COLUMN IF NOT EXISTS "coverAssetId" TEXT;

-- ── 「我的风格库」：用户自己写的封面风格 ──
CREATE TABLE IF NOT EXISTS "CoverStylePreset" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoverStylePreset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CoverStylePreset_workspaceId_createdAt_idx"
  ON "CoverStylePreset" ("workspaceId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CoverStylePreset_workspaceId_fkey') THEN
    ALTER TABLE "CoverStylePreset"
      ADD CONSTRAINT "CoverStylePreset_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "CoverStylePreset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoverStylePreset" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CoverStylePreset";
CREATE POLICY tenant_isolation ON "CoverStylePreset" FOR ALL
  USING (app_current_tenant() IS NULL OR "workspaceId" IN (SELECT app_tenant_workspaces()));
