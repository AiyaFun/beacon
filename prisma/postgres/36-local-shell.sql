-- 2026-08-29 本机命令执行（localShell）：Workspace 上的策略三件套。
--
-- **默认全关**：形态允许 ≠ 默认开。shellRoot 为空时哪怕 shellEnabled=true 也不许跑——
-- 没有工作目录就没有边界，而「没有边界的允许」比「不允许」危险得多。
--
-- SaaS 生产库照样加这三列（schema 要同构），但那边能力矩阵恒 false，永远走不到。
--
-- 幂等，可重复执行。

ALTER TABLE beacon."Workspace" ADD COLUMN IF NOT EXISTS "shellEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE beacon."Workspace" ADD COLUMN IF NOT EXISTS "shellAllow"   TEXT    NOT NULL DEFAULT '[]';
ALTER TABLE beacon."Workspace" ADD COLUMN IF NOT EXISTS "shellRoot"    TEXT;
