-- 2026-08-26 解析自学习补「失败现场截图」：ParserIncident 加 screenshot 列。
--
-- 插件 0.9.9 起，解析失败发生在用户**正看着的页面**时，连同一张压缩后的当页截图上报
--（后台自动回填那些用户没在看的页面绝不截）。用途：/ops/parser 人工核对自动上线的规则、
-- 视觉模型辅助诊断（llmVision，未配置就跳过）。30 天后由保留期任务清空该列。
-- 大小由服务端 vetScreenshot 闸住（150K 字符，WAF client_body_buffer_size ~256KB 之下）。
--
-- 幂等，可重复执行。

ALTER TABLE beacon."ParserIncident" ADD COLUMN IF NOT EXISTS "screenshot" TEXT NOT NULL DEFAULT '';
