#!/usr/bin/env bash
# 火山引擎 Supabase 版数据库一次性初始化：建表 → pgvector → RLS。
#
# 背景：火山 Supabase 上没有本地 postgres 容器的 docker-entrypoint-initdb.d 自动初始化机制，
#       两份 SQL 必须手工按顺序跑。顺序是硬约束：01-pgvector.sql 要 ALTER 已建的表，必须先 db push。
#
# 用法（在工程根目录，一台能连到火山库的机器上）：
#   DATABASE_URL="postgresql://beacon_app:<PWD>@<HOST>:<PORT>/postgres?schema=beacon&sslmode=require" \
#     scripts/db-init-supabase.sh
#
#   连接串从火山控制台复制，用户建议用 beacon_app（非 postgres），表放在 beacon schema。
#   也可在 `docker compose exec web` 里跑（容器内含 prisma CLI 与 schema）。
#
# 幂等：三步都是 IF NOT EXISTS / db push 差量 / DROP POLICY IF EXISTS，重复跑安全。

set -euo pipefail

PROJECT_DIR="${BEACON_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SCHEMA="prisma/schema.postgres.prisma"
SQL_DIR="prisma/postgres"

log() { printf '[db-init %s] %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '[db-init %s] 错误：%s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

# ── 前置检查 ──
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL 未设置。用法见脚本头部注释。"

# 防手滑：这个脚本只对生产 Postgres 跑，绝不能指到 dev 的 SQLite。
case "$DATABASE_URL" in
  postgres://*|postgresql://*) : ;;
  file:*|*sqlite*) die "DATABASE_URL 指向 SQLite（dev 库）。本脚本只初始化生产 Postgres，拒绝执行。" ;;
  *) die "DATABASE_URL 不像 Postgres 连接串（应以 postgresql:// 开头）：$DATABASE_URL" ;;
esac

case "$DATABASE_URL" in
  *sslmode=*) : ;;
  *) log "⚠️ 连接串里没有 sslmode=require。火山 Supabase 走加密连接，建议加上（加了永远安全）。" ;;
esac

cd "$PROJECT_DIR" || die "进不去项目目录 $PROJECT_DIR"
[ -f "$SCHEMA" ]      || die "找不到 $SCHEMA（当前目录 $PWD 不是工程根目录？用 BEACON_PROJECT_DIR 指定）。"
[ -d "$SQL_DIR" ]     || die "找不到 $SQL_DIR"
command -v npx >/dev/null 2>&1 || die "找不到 npx（需要 Node + 项目依赖已安装，或在 docker compose exec web 里跑）。"

# 展示目标主机（不打印密码）：postgresql://user:pwd@HOST:PORT/db → HOST:PORT/db
TARGET="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://[^@]*@##; s#\?.*$##')"
log "目标库：$TARGET"

# ── 1/3 建表：把生产 schema 推到火山 ──
log "1/2 prisma db push（建表，--skip-generate 不动本地 client）…"
npx prisma db push --schema "$SCHEMA" --skip-generate \
  || die "prisma db push 失败。常见原因：连不上库（先把服务器公网 IP 加进火山 ACL 白名单）、密码/端口不对、SSL。"

# ── 2/2 按序应用 prisma/postgres/*.sql ──────────────────────────────────
#
# 【为什么改成遍历目录】原先这里只写死跑 01 和 02，其余（03-reader-comment、04-angle-shape、
# 05-media-asset、06-platform-ops、07-publish、08-workflow、09-parser-learn…）全靠人记得
# 手工执行。历史上「⚠️ 部署前必须先建表」这句话在多份笔记里反复出现，就是这个缺口的产物：
# 忘一次 = 生产 42P01（表不存在），而且往往是在某个功能第一次被用到时才炸。
# 私有化交付更是不可接受 —— 每来一个客户都要你亲手连一次库。
#
# 目录里的文件名带序号，排序即执行顺序；每份 SQL 自身都写成幂等
# （IF NOT EXISTS / DROP POLICY IF EXISTS），重复跑安全。
log "2/2 应用 $SQL_DIR 下的全部 SQL（按文件名顺序）…"
applied=0
for f in "$SQL_DIR"/*.sql; do
  [ -e "$f" ] || die "$SQL_DIR 下一个 .sql 都没有，不正常"
  name="$(basename "$f")"
  log "   → $name"
  (echo "SET search_path TO beacon, extensions, public;"; cat "$f") \
    | npx prisma db execute --schema "$SCHEMA" --stdin \
    || die "$name 执行失败。若是 01-pgvector.sql 报 permission denied to create extension，先在 SQL Editor 以 postgres 身份执行：CREATE EXTENSION IF NOT EXISTS vector;"
  applied=$((applied+1))
done
log "   共应用 $applied 份 SQL"

log "✅ 初始化完成：建表 + 全部 SQL（pgvector / RLS / 各版本增量）均已就绪。"

cat <<'EOF'

────────────────────────────────────────────────────────────
  ⚠️  安全红线：立刻去控制台锁 Data API（PostgREST）
────────────────────────────────────────────────────────────
  业务表已放在 beacon schema（非 public），Data API 默认只暴露 public，
  所以**即使没关 Data API，业务表也不在暴露面内**。但仍建议关掉 Data API 以杜绝意外。
  本项目走 Prisma 直连、完全不用 Data API。

  建议（控制台 → Workspace → 分支 → Data API / API 设置）：
    a) 关闭 Data API，或确认 exposed schemas 不含 beacon。
    b) 自检：
       curl "https://<你的-supabase-域名>/rest/v1/" \
         -H "apikey: <anon_key>" -H "Authorization: Bearer <anon_key>"
       期望：返回空数组或 404，不含任何业务表名。

  详见 docs/火山Supabase迁移.md「Data API 安全锁定」。
────────────────────────────────────────────────────────────
EOF
