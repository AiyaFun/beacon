-- 20 · 技能市场：版本与溯源（2026-08-21）
--
-- 【version 这一列本来就在，但一直是个死字段】默认 "1.0"，全代码库零读写。
-- 市场化之后它才有了含义：装的是哪一版、上游有没有新版本，全靠它比。
-- 这里把默认值改成三段式（"1.0.0"），与 lib/market/pack.ts 的 compareVersion 对齐。
-- **存量行不动**：它们的 "1.0" 会被 compareVersion 当成 1.0.0 处理（缺的段按 0 补），
-- 不需要也不应该批量改写——那是在替用户重写他自己建的技能的元数据。
--
-- sourceUrl / sourceAuthor：只有从市场或网址装进来的技能才有。
--   · sourceUrl 用于「检查更新」：回这个地址拿最新版本比一比。
--     留着它还有一层意思——能说清「这东西是哪来的」。
--   · sourceAuthor 是包里声明的署名，**不是身份凭证**（没有签名机制）。
--     界面上必须说清这一点，别让用户把它当成认证过的来源。
--
-- 三列都幂等；两个新列可空（NULL = 用户自己写的，不是从外面装的）。
ALTER TABLE "ContentSkill" ALTER COLUMN "version" SET DEFAULT '1.0.0';
ALTER TABLE "ContentSkill" ADD COLUMN IF NOT EXISTS "sourceUrl" TEXT;
ALTER TABLE "ContentSkill" ADD COLUMN IF NOT EXISTS "sourceAuthor" TEXT;
