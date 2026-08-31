#!/usr/bin/env bash
# 部署前的本地预备：把「分发产物」刷新成即将上线的这份代码的快照。
#
# 【为什么必须每次跑】整机版客户点「一键更新」时读的是 public/downloads/appliance.manifest.json，
# 而那份清单描述的是**打包那一刻**的代码。忘了重打，站上挂的就是旧包：
#   · 版本号没变时 → 客户查到「已经是最新版」，新修的东西永远到不了他机器上；
#   · 版本号变了但包是旧的 → 客户下到的代码与站点宣称的版本对不上。
# 这类错不会报错、不会变红，只会安静地让升级通道失效——所以不靠人记得，写进流程。
#
# 【与 pack:ext 的关系】插件 zip 已经挂在 `npm run build` 里（服务器构建时自动重打），
# 而整机版包与桌面包**不能**放进 build：前者会在容器里打包自己（递归且产物落不到宿主），
# 后者依赖 Tauri 构建产物（服务器上根本没有）。所以它们由本脚本在**本地、rsync 之前**做。
#
# 用法：bash scripts/deploy-prepare.sh   （部署技能的第 0 步）
set -euo pipefail

cd "$(dirname "$0")/.."
say() { printf '\033[36m▸\033[0m %s\n' "$*"; }

MF="public/downloads/appliance.manifest.json"
OLD_SHA=""
OLD_VER=""
if [ -f "$MF" ]; then
  OLD_SHA=$(node -p "try{require('./$MF').sha256}catch(e){''}" 2>/dev/null || echo "")
  OLD_VER=$(node -p "try{require('./$MF').version}catch(e){''}" 2>/dev/null || echo "")
fi

# ① 整机版增量更新包：**无条件重打**。判断「代码有没有变」比直接打一遍还贵，
#    而打一遍只要几秒（tar + sha256），没有省的必要。
say "重打整机版增量更新包…"
npm run --silent pack:appliance

NEW_SHA=$(node -p "require('./$MF').sha256")
NEW_VER=$(node -p "require('./$MF').version")
if [ "$OLD_SHA" = "$NEW_SHA" ]; then
  say "更新包内容未变（sha ${NEW_SHA:0:12}…），v$NEW_VER"
else
  say "更新包已刷新：${OLD_SHA:0:12}… → ${NEW_SHA:0:12}…，v$NEW_VER"
  # ── 内容变了、版本号却没变 = 这次更新**送不出去** ───────────────────────
  #
  # 客户端的判据是 `compareVersion(清单版本, 本机版本) > 0`（lib/appliance/update.ts）。
  # 版本相同 → hasUpdate=false → 客户查到「已经是最新版」，而他手上跑的是旧代码。
  #
  # 本文件开头那段注释早就写着这个后果，但**只是注释**——2026-08-31 真踩了一次：
  # 一整轮修复（含两份结构变更）打进了包，sha 变了、版本没动，
  # 整机版客户一个更新提示都收不到。写进注释治不了这个，所以变成硬闸。
  #
  # 真要给同一个版本号重打（比如上一份包损坏了），先删掉 $MF 再跑。
  if [ -n "$OLD_SHA" ] && [ "$OLD_VER" = "$NEW_VER" ]; then
    printf '\n⛔ 拦下：更新包内容变了，但版本号还是 v%s。\n' "$NEW_VER"
    printf '   客户端按版本号判断有没有新版（lib/appliance/update.ts 的 compareVersion），\n'
    printf '   版本不变 = 所有整机版客户都会查到「已经是最新版」，这次的修复送不到他们手上。\n'
    printf '   请先升 package.json 的 version（以及 lib/market/version.ts 的 APP_VERSION），再跑本脚本。\n'
    exit 1
  fi
fi

# ② 桌面客户端清单：**只在本机真有构建产物时收集**。
#    没有产物就跳过——它是「各平台各自构建、跨机器接力」的，
#    在一台没构建过的机器上强行重打只会把已有清单清空（那才是真的破坏）。
if ls desktop/src-tauri/target/*/release/bundle/*/* >/dev/null 2>&1 \
   || ls desktop/src-tauri/target/release/bundle/*/* >/dev/null 2>&1; then
  say "发现桌面构建产物，收集进下载页…"
  npm run --silent pack:desktop || say "⚠️ 桌面产物收集失败（不阻断部署，站上仍是上一份清单）"
else
  say "本机没有桌面构建产物，跳过（站上保留现有清单）"
fi

say "✅ 预备完成，可以 rsync 了"
