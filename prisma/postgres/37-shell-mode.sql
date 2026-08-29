-- 2026-08-29 本机命令执行补两列：执行模式与超时。
--
-- shellExecMode='full' 是给「开终端」准备的档：一旦用户能开终端，命令白名单在语义上就不存在了
-- （他敲 bash 就什么都能跑）。与其假装白名单还管用，不如给一个明确的、他自己知道选了什么的档。
-- 默认仍是 'allowlist'。
--
-- shellTimeoutSec：装东西（npm/pip install）动辄几分钟，20 秒默认值会把它直接废掉。
--
-- 幂等，可重复执行。

ALTER TABLE beacon."Workspace" ADD COLUMN IF NOT EXISTS "shellExecMode"   TEXT    NOT NULL DEFAULT 'allowlist';
ALTER TABLE beacon."Workspace" ADD COLUMN IF NOT EXISTS "shellTimeoutSec" INTEGER NOT NULL DEFAULT 20;
