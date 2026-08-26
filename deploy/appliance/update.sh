#!/usr/bin/env bash
# 烽火台整机版 · 升级到新版本（macOS / Linux）
#
# 用法：把新版本的代码解压/拉到同一个目录，然后在项目根目录跑
#     bash deploy/appliance/update.sh
#
# 【为什么必须有这个脚本】在此之前整机版**没有任何升级通道**：deploy/ 下只有 install.sh，
# 重跑它虽然幂等，但它不会拉新代码、不会迁移库、也不知道该不该重启服务。
# 一个装在客户机器上的常驻产品，没有升级机制 = 交付的是一次性快照：
# 修好的缺陷永远到不了已经装好的那些机器上。
#
# 【它与 install.sh 的分工】
#   install.sh —— 第一次装：生成 .env、建库、灌种子、注册开机自启、开装机向导。
#   update.sh  —— 已经装过了：只做「让新代码跑起来」这一件事，**绝不碰 .env、绝不重灌种子**。
#
# 【顺序不能换】停服务 → 装依赖 → 迁库 → 构建 → 起服务。
#   · 先停服务：构建产物是原地替换的，边跑边换会让运行中的进程读到半新半旧的文件；
#   · 迁库在构建之前：新代码假设新列已经在了，反过来就是「代码新、库旧」的整站 500
#     （这正是生产那边 deploy-gate.sh 拦的同一类事故）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env.appliance"
say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$ROOT"

[ -f "$ENV_FILE" ] || die "找不到 $ENV_FILE —— 这台机器还没装过。第一次装请跑 deploy/appliance/install.sh"
command -v node >/dev/null || die "找不到 node。请先安装 Node 20+"

set -a; . "$ENV_FILE"; set +a
PORT="${BEACON_PORT:-3070}"

# ── 0. 先把数据库备份一份 ────────────────────────────────────────────────
# 整机版的库是单文件 SQLite，备份就是复制一个文件——**升级前必做**。
# prisma db push 在遇到「列被删/类型变窄」这类变更时会丢数据，而那种变更
# 从 schema 上看常常并不显眼。有这一份副本，最坏情况也只是回退。
DB_FILE="$ROOT/prisma/appliance.db"
if [ -f "$DB_FILE" ]; then
  BACKUP="$ROOT/prisma/appliance.db.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$DB_FILE" "$BACKUP"
  say "✅ 已备份数据库 → $(basename "$BACKUP")"
  # 只留最近 5 份，别把用户磁盘占满
  ls -1t "$ROOT"/prisma/appliance.db.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
else
  say "（还没有数据库文件，跳过备份）"
fi

# ── 1. 停服务 ────────────────────────────────────────────────────────────
say "停止服务…"
if [ "$(uname)" = "Darwin" ]; then
  launchctl unload "$HOME/Library/LaunchAgents/cn.iyunci.beacon.plist" 2>/dev/null || true
  launchctl unload "$HOME/Library/LaunchAgents/cn.iyunci.beacon.connector.plist" 2>/dev/null || true
else
  # Linux 上 install.sh 只生成 start.sh、自启由用户自己配，这里尽力而为
  pkill -f "next start.*$PORT" 2>/dev/null || true
fi

# ── 2. 依赖 ──────────────────────────────────────────────────────────────
say "安装依赖（npm ci）…"
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3 || die "npm ci 失败"

# ── 3. 迁移数据库 ────────────────────────────────────────────────────────
# 用 db push 而不是 migrate deploy：整机版的 SQLite 库没有迁移历史
#（install.sh 当初就是 db push 建的）。--accept-data-loss **不加**：
# 真遇到会丢数据的变更时，宁可在这里停下来让人看一眼，也不能默默把用户的数据抹掉。
say "同步数据库结构…"
npx prisma generate >/dev/null 2>&1 || die "prisma generate 失败"
if ! npx prisma db push --skip-generate 2>&1 | tail -5; then
  die "数据库结构同步失败。库已备份在 prisma/ 下，可回退。"
fi

# ── 4. 构建 ──────────────────────────────────────────────────────────────
say "构建（首次或大改动时要几分钟）…"
npm run build 2>&1 | tail -5 || die "构建失败——旧版本的服务已经停了，修好后重跑本脚本"

# ── 5. 起服务 ────────────────────────────────────────────────────────────
say "启动服务…"
if [ "$(uname)" = "Darwin" ]; then
  launchctl load "$HOME/Library/LaunchAgents/cn.iyunci.beacon.plist"
  [ -f "$HOME/Library/LaunchAgents/cn.iyunci.beacon.connector.plist" ] \
    && launchctl load "$HOME/Library/LaunchAgents/cn.iyunci.beacon.connector.plist" 2>/dev/null || true
else
  say "Linux：请自行重启你配置的服务（或跑 ./start.sh）"
fi

# ── 6. 验一下真的起来了 ──────────────────────────────────────────────────
say "等服务就绪…"
OK=""
for i in $(seq 1 30); do
  if curl -sS -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then OK=1; break; fi
  sleep 2
done
[ -n "$OK" ] || die "服务没起来。看日志：tail -50 $ROOT/appliance.log（或 launchctl 的日志路径）"

say "✅ 升级完成：http://127.0.0.1:$PORT"
say "   数据库备份留在 prisma/appliance.db.bak-*（只保留最近 5 份）"
