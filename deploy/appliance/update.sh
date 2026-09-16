#!/usr/bin/env bash
# 烽火台整机版 · 升级到新版本（macOS / Linux）
#
# 用法（两条路，都保留）：
#   ① 自己拿包：把新版本的代码解压/拉到同一个目录，然后跑
#        bash deploy/appliance/update.sh
#   ② 一键更新：让脚本自己去官方站拉最新包（站内「桌面客户端」页那个按钮走的就是这条）
#        bash deploy/appliance/update.sh --fetch
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

# re-exec 到 /tmp 之后 BASH_SOURCE 不再指向工程目录,所以允许用 env 传进来(见下方自我覆盖防护)
ROOT="${BEACON_UPDATE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ENV_FILE="$ROOT/.env.appliance"
say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$ROOT"

[ -f "$ENV_FILE" ] || die "找不到 $ENV_FILE —— 这台机器还没装过。第一次装请跑 deploy/appliance/install.sh"
command -v node >/dev/null || die "找不到 node。请先安装 Node 20+"

set -a; . "$ENV_FILE"; set +a
PORT="${BEACON_PORT:-3070}"

# 状态文件:站内「一键更新」靠它判「是不是已经有一次在跑」,也靠它显示跑到哪一步。
# trap 保证异常退出也会清掉——留下一个孤儿状态文件会让下次更新被永久挡在门外。
STATE="$ROOT/.appliance-update.state"
step() { printf '%s\n' "$*" > "$STATE"; say "$*"; }
cleanup() { rm -f "$STATE"; }
trap cleanup EXIT

# ── -1. 拉新代码(--fetch)────────────────────────────────────────────────
#
# 【为什么默认不拉】本脚本原本的用法是「你自己把新代码放到同一个目录再跑我」,
# 那条路要保留:内网机器、自己改过代码的客户,都不该被强制走网络。
# --fetch 是**站内一键更新**走的那条路(lib/appliance/update.ts 起的就是它)。
#
# 【安全三条,与 lib/appliance/update.ts 的闸一一对应】
#   · 来源钉死:只认 BEACON_UPDATE_ORIGIN(运维配)或官方站,不接受命令行传 URL;
#   · sha256 必须对上才解包——**校验和解包在同一个脚本里、对同一个文件**,
#     不给「校验过的」与「实际用的」不是同一份的窗口;
#   · 覆盖用白名单式排除:.env* / prisma/*.db / node_modules 一律不动,
#     覆盖的是代码不是用户的数据与密钥。
FETCH=""
[ "${1:-}" = "--fetch" ] && FETCH=1

# 【自我覆盖防护——不加这段必炸】下面的 rsync 会把**本脚本自己**也覆盖掉,
# 而 bash 是边读边执行的:运行中的脚本文件被换掉后,解释器按原字节偏移继续读新文件,
# 执行出来的是半行乱码(经典 footgun,表现为「更新跑到一半报语法错」)。
# 所以 --fetch 模式先把自己复制到临时文件、exec 过去再干活——被覆盖的是原地那一份,
# 正在跑的是 /tmp 里的副本,与工程目录无关。
if [ -n "$FETCH" ] && [ -z "${BEACON_UPDATE_REEXEC:-}" ]; then
  SELF_COPY="$(mktemp -t beacon-update)" || die "建不了临时文件"
  cp "${BASH_SOURCE[0]}" "$SELF_COPY" || die "复制脚本失败"
  export BEACON_UPDATE_REEXEC=1 BEACON_UPDATE_ROOT="$ROOT"
  exec bash "$SELF_COPY" "$@"
fi
# 副本跑完自己删掉(exec 过来的那一份)
[ -n "${BEACON_UPDATE_REEXEC:-}" ] && trap 'rm -f "${BASH_SOURCE[0]}"; cleanup' EXIT

if [ -n "$FETCH" ]; then
  ORIGIN="${BEACON_UPDATE_ORIGIN:-https://beacon.iyunci.cn}"
  ORIGIN="${ORIGIN%/}"
  command -v curl >/dev/null || die "--fetch 需要 curl"
  command -v tar  >/dev/null || die "--fetch 需要 tar"

  step "读取更新清单…"
  MF="$(curl -fsSL --max-time 30 "$ORIGIN/downloads/appliance.manifest.json")" \
    || die "读不到更新清单:$ORIGIN/downloads/appliance.manifest.json"

  # 不引 jq(客户机器上未必有):用 node 解析,node 是本脚本的硬前置
  NEW_VER="$(printf '%s' "$MF" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).version||""))}catch{}})')"
  NEW_FILE="$(printf '%s' "$MF" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).file||""))}catch{}})')"
  NEW_SHA="$(printf '%s' "$MF" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).sha256||""))}catch{}})')"
  [ -n "$NEW_VER" ] && [ -n "$NEW_FILE" ] && [ -n "$NEW_SHA" ] || die "清单不完整(缺 version/file/sha256)"

  CUR_VER="$(node -p 'require("./package.json").version' 2>/dev/null || echo 0)"
  say "当前 v$CUR_VER → 目标 v$NEW_VER"
  [ "$CUR_VER" != "$NEW_VER" ] || die "已经是 v$CUR_VER,无需更新"

  TMP="$(mktemp -d)"
  # 这一层 trap 覆盖上一层:临时目录、脚本副本、状态文件三样都要清
  trap 'rm -rf "$TMP"; [ -n "${BEACON_UPDATE_REEXEC:-}" ] && rm -f "${BASH_SOURCE[0]}"; cleanup' EXIT
  step "下载更新包 v$NEW_VER…"
  curl -fsSL --max-time 600 -o "$TMP/pkg.tar.gz" "$ORIGIN$NEW_FILE" || die "下载失败:$ORIGIN$NEW_FILE"

  step "校验完整性…"
  if command -v shasum >/dev/null; then GOT="$(shasum -a 256 "$TMP/pkg.tar.gz" | awk '{print $1}')"
  else GOT="$(sha256sum "$TMP/pkg.tar.gz" | awk '{print $1}')"; fi
  [ "$GOT" = "$NEW_SHA" ] || die "校验失败!包可能被篡改或下载不完整。期望 $NEW_SHA,实际 $GOT"
  say "✅ sha256 一致"

  step "解包并覆盖代码…"
  mkdir -p "$TMP/x"
  tar -xzf "$TMP/pkg.tar.gz" -C "$TMP/x" || die "解包失败"
  # 覆盖:只动代码。**这份排除清单漏一条就是抹掉客户的密钥或数据**,
  # 与 scripts/pack-appliance.ts 的 APPLIANCE_EXCLUDE 是一对(那边不打进包、这边不覆盖),
  # 两层都拦,因为任一层写错的后果都不可逆。
  if command -v rsync >/dev/null; then
    rsync -a \
      --exclude '.env' --exclude '.env.*' \
      --exclude 'prisma/*.db' --exclude 'prisma/*.db-journal' --exclude 'prisma/*.db.bak-*' \
      --exclude 'node_modules' --exclude '.next' \
      --exclude 'deploy/certs' --exclude '.appliance-update.state' \
      "$TMP/x"/ "$ROOT"/ || die "覆盖失败"
  else
    # 没有 rsync(极少见)时退化成 cp:同样先把要保护的东西挪开
    die "需要 rsync 来安全覆盖代码。装一个再重试(mac: brew install rsync;linux: apt install rsync)"
  fi
  say "✅ 代码已更新到 v$NEW_VER"
fi

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
step "停止服务…"
if [ "$(uname)" = "Darwin" ]; then
  launchctl unload "$HOME/Library/LaunchAgents/cn.iyunci.beacon.plist" 2>/dev/null || true
  launchctl unload "$HOME/Library/LaunchAgents/cn.iyunci.beacon.connector.plist" 2>/dev/null || true
else
  # Linux 上 install.sh 只生成 start.sh、自启由用户自己配，这里尽力而为
  pkill -f "next start.*$PORT" 2>/dev/null || true
fi

# ── 2. 依赖 ──────────────────────────────────────────────────────────────
step "安装依赖（npm ci）…"
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3 || die "npm ci 失败"

# ── 3. 迁移数据库 ────────────────────────────────────────────────────────
# 用 db push 而不是 migrate deploy：整机版的 SQLite 库没有迁移历史
#（install.sh 当初就是 db push 建的）。--accept-data-loss **不加**：
# 真遇到会丢数据的变更时，宁可在这里停下来让人看一眼，也不能默默把用户的数据抹掉。
step "同步数据库结构…"
npx prisma generate >/dev/null 2>&1 || die "prisma generate 失败"
if ! npx prisma db push --skip-generate 2>&1 | tail -5; then
  die "数据库结构同步失败。库已备份在 prisma/ 下，可回退。"
fi

# ── 4. 构建 ──────────────────────────────────────────────────────────────
step "构建（首次或大改动时要几分钟）…"
npm run build 2>&1 | tail -5 || die "构建失败——旧版本的服务已经停了，修好后重跑本脚本"

# ── 5. 起服务 ────────────────────────────────────────────────────────────
step "启动服务…"
if [ "$(uname)" = "Darwin" ]; then
  launchctl load "$HOME/Library/LaunchAgents/cn.iyunci.beacon.plist"
  [ -f "$HOME/Library/LaunchAgents/cn.iyunci.beacon.connector.plist" ] \
    && launchctl load "$HOME/Library/LaunchAgents/cn.iyunci.beacon.connector.plist" 2>/dev/null || true
else
  say "Linux：请自行重启你配置的服务（或跑 ./start.sh）"
fi

# ── 6. 验一下真的起来了 ──────────────────────────────────────────────────
step "等服务就绪…"
OK=""
for i in $(seq 1 30); do
  if curl -sS -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then OK=1; break; fi
  sleep 2
done
[ -n "$OK" ] || die "服务没起来。看日志：tail -50 $ROOT/appliance.log（或 launchctl 的日志路径）"

say "✅ 升级完成：http://127.0.0.1:$PORT"
say "   数据库备份留在 prisma/appliance.db.bak-*（只保留最近 5 份）"
