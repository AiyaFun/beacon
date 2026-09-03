#!/usr/bin/env bash
# 把当前分支的代码发布到公开仓库 github/main。
#
# 【为什么必须有这个脚本】发布 = 一次性把整棵树推到公网，推错了 git 历史里永远删不掉。
# 而这棵树里就躺着 **macOS Developer ID 私钥**（deploy/private/signing/*.p12）。
# 2026-08-28 手工发布过两次，全靠人记着剥离清单——这次把清单和**校验**一起钉进脚本：
# 剥完还要逐条断言它真的不在了，任何一条没剥干净就中止，绝不推。
#
# 另外两件也靠这个脚本保证（都踩过）：
#   · 以 AiyaFun 身份提交——直推会带上 cnb 的作者信息和 Claude 尾注
#   · squash 成一次提交——内部提交历史里有服务器地址、密钥轮换记录之类的东西
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SRC="${1:-$(git rev-parse --abbrev-ref HEAD)}"
MSG="${2:-}"
[ -n "$MSG" ] || { echo "用法: $0 <源分支> <提交说明>" >&2; exit 1; }

# 【剥离清单】方案与交付物不发，代码照发
STRIP=(
  "deploy/private"      # 私有化交付物 + 签名私钥备份 ← 泄了最要命
  "deploy/appliance"    # 整机版装机脚本（交付物）
  "deploy/README.md"    # 部署方案
  "docs/上线清单-"      # 内部上线清单（含服务器细节）
)

say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

WT=$(mktemp -d); TREE=$(mktemp -d)
cleanup() { git worktree remove --force "$WT" 2>/dev/null || true; rm -rf "$TREE"; }
trap cleanup EXIT

say "取出 github/main 作为基线"
git fetch github main --quiet
git worktree add --detach "$WT" github/main --quiet

say "导出 $SRC 的已提交内容（只发提交过的，不发工作区脏文件）"
git archive "$SRC" | tar -x -C "$TREE"

say "剥离不发布的部分"
for p in "${STRIP[@]}"; do rm -rf "${TREE:?}/${p}"* ; done

say "同步进工作树"
rsync -a --delete --exclude '.git' "$TREE/" "$WT/"

# ── 硬校验：剥干净了吗。这一步失败必须中止，不许「大概没问题」就推
say "校验"
for p in "${STRIP[@]}"; do
  found=$(cd "$WT" && find . -path "./.git" -prune -o -path "./$p*" -print 2>/dev/null | head -1)
  [ -z "$found" ] || die "剥离清单没生效，$p 还在：$found"
done
# 兜底：全树扫私钥材料，任何一条命中都中止（剥离清单可能漏掉新出现的路径）
# 豁免只写精确路径——写成 tests/** 之类的宽豁免，等于给以后真的泄漏开了门。
# · tests/pay/official-key.ts — 微信支付**官方公开发布**的测试商户 PEM
# · lib/agent/redact.ts — 秘密脱敏检测器自身的**匹配正则**（不是真密钥）
# · tests/agent/redact.test.ts — 上面检测器的测试用假密钥（sk-abcdef… / AKIA…）
LEAK=$(cd "$WT" && grep -rlE "BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY" . --exclude-dir=.git 2>/dev/null \
  | grep -v '^\./tests/pay/official-key\.ts$' \
  | grep -v '^\./lib/agent/redact\.ts$' \
  | grep -v '^\./tests/agent/redact\.test\.ts$' \
  | head -3 || true)
[ -z "$LEAK" ] || die "树里有私钥材料：$LEAK"
# tauri-updater.key 是桌面一键更新的**真签名钥匙**（minisign 格式，PEM 扫描抓不到它）。
# 按名字点杀：它唯一合法的家是 deploy/private/signing/（上面已整目录剥掉），
# 出现在其它任何地方都是泄漏。CI 用的一次性钥匙叫 ci-throwaway-updater.key，名字错开，不误伤。
BIN=$(cd "$WT" && find . -path ./.git -prune -o \( -name '*.p12' -o -name '*.p8' -o -name '*.p8.enc' -o -name '*.cer' -o -name '*.mobileprovision' -o -name 'tauri-updater.key*' \) -print 2>/dev/null | head -3 || true)
[ -z "$BIN" ] || die "树里有证书/密钥文件：$BIN"

# 临时脚本 / 根目录调试脚本兜底（杜绝 login-tmp.ts 等遗留调试代码进入公开仓库）
TMP_FILES=$(cd "$WT" && find . -maxdepth 2 -path ./.git -prune -o \( -name '*-tmp.*' -o -name '*tmp*.ts' -o -name 'repro-*.ts' \) -print 2>/dev/null | head -3 || true)
[ -z "$TMP_FILES" ] || die "树里有未清理的临时/调试脚本：$TMP_FILES"

# 检查根目录是否有包含临时执行逻辑的单发脚本
ROOT_MINT=$(cd "$WT" && find . -maxdepth 1 -name '*.ts' -exec grep -lE 'issueLocalLoginTicket' {} + 2>/dev/null || true)
[ -z "$ROOT_MINT" ] || die "根目录存在直接调用凭据签发的临时脚本：$ROOT_MINT"

say "✅ 校验通过：剥离清单生效，无私钥材料，无临时凭证脚本"

cd "$WT"
git add -A
if git diff --cached --quiet; then say "没有变化，不用发"; exit 0; fi
say "变更 $(git diff --cached --name-only | wc -l | tr -d ' ') 个文件"

# 以 AiyaFun 身份提交：直推会带上 cnb 的作者信息
GIT_AUTHOR_NAME=AiyaFun GIT_AUTHOR_EMAIL="293326193+AiyaFun@users.noreply.github.com" \
GIT_COMMITTER_NAME=AiyaFun GIT_COMMITTER_EMAIL="293326193+AiyaFun@users.noreply.github.com" \
  git commit -q --no-verify -m "$MSG"

if [ -n "${DRY_RUN:-}" ]; then say "DRY_RUN：到此为止，不推送"; exit 0; fi
say "推送到 github/main"
git push github HEAD:main
say "✅ 已发布"
