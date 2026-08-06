#!/usr/bin/env bash
# 烽火台数据库恢复：把 scripts/backup.sh 的产物还原到**外部连接串**（火山引擎 Supabase 版）。
#
# 用法：DATABASE_URL="postgresql://beacon_app:<PWD>@<HOST>:<PORT>/postgres?schema=beacon&sslmode=require" \
#         scripts/restore.sh <备份文件>
#      …… scripts/restore.sh /var/backups/beacon/daily/beacon-20260717-030000.dump
#      …… scripts/restore.sh /var/backups/beacon/daily/beacon-20260717-030000.dump.enc   # 需 BEACON_BACKUP_PASSPHRASE
#
# ⚠️ 破坏性操作：--clean 会 DROP 并重建目标库里的对象，当前数据全部丢失。脚本会要求手打确认。
# ⚠️ 恢复演练请指到**另一个库/分支**（在连接串里换库名，或用 BEACON_RESTORE_DATABASE_URL），别在生产库上练手。
# ⚠️ 整库灾备优先用火山平台的 PITR/快照（更快、更完整）；本脚本是外部逻辑还原兜底。
#    逻辑还原最干净的做法是恢复进一个**空库/新分支**（避免 --clean 删扩展依赖时回滚）。见 docs。

set -euo pipefail

SRC_URL="${BEACON_RESTORE_DATABASE_URL:-${DATABASE_URL:-}}"
PASSPHRASE="${BEACON_BACKUP_PASSPHRASE:-}"
FORCE="${BEACON_RESTORE_FORCE:-}"   # =1 跳过确认（仅供自动化演练，生产别用）

log() { printf '[restore %s] %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '[restore %s] 错误：%s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

sanitize_libpq_url() {
  local url="$1" base query kv key keep=""
  base="${url%%\?*}"
  [ "$base" = "$url" ] && { printf '%s' "$url"; return; }
  query="${url#*\?}"
  local IFS='&'
  for kv in $query; do
    key="${kv%%=*}"
    case "$key" in
      sslmode|sslrootcert|sslcert|sslkey|sslpassword|connect_timeout|application_name|target_session_attrs|gssencmode|options|keepalives|keepalives_idle)
        keep="${keep:+$keep&}$kv" ;;
    esac
  done
  [ -n "$keep" ] && printf '%s?%s' "$base" "$keep" || printf '%s' "$base"
}

# 百分号解码：URI 里密码是百分号编码的，PGPASSWORD 要解码后的原文（含特殊字符的密码才不会验证失败）。
urldecode() { printf '%b' "${1//%/\\x}"; }

# 剥密码进 PGPASSWORD + 去 Prisma 参数。产出全局 PGURL；副作用 export PGPASSWORD。
resolve_pgconn() {
  local url="$1" scheme rest authority pathq userinfo hostport user nopwd
  scheme="${url%%://*}"
  rest="${url#*://}"
  authority="${rest%%/*}"
  pathq="${rest#"$authority"}"
  if [ "$authority" != "${authority#*@}" ]; then
    userinfo="${authority%@*}"
    hostport="${authority##*@}"
    if [ "$userinfo" != "${userinfo#*:}" ]; then
      export PGPASSWORD="$(urldecode "${userinfo#*:}")"
      user="${userinfo%%:*}"
    else
      user="$userinfo"
    fi
    nopwd="${scheme}://${user}@${hostport}${pathq}"
  else
    nopwd="$url"
  fi
  PGURL="$(sanitize_libpq_url "$nopwd")"
}

# 从 PGURL（已无密码）取库名 / 主机，用于确认展示
url_dbname() { local u="${1%%\?*}"; printf '%s' "${u##*/}"; }
url_host()   { local u="${1#*@}"; printf '%s' "${u%%/*}"; }

FILE="${1:-}"
[ -n "$FILE" ] || die "缺少参数。用法：scripts/restore.sh <备份文件>"
[ -f "$FILE" ] || die "备份文件不存在：$FILE"
[ -s "$FILE" ] || die "备份文件是空的：$FILE"

# ── 前置检查 ──
[ -n "$SRC_URL" ] || die "没有连接串。设 DATABASE_URL（或 BEACON_RESTORE_DATABASE_URL）指向目标库。"
case "$SRC_URL" in
  postgres://*|postgresql://*) : ;;
  file:*|*sqlite*) die "连接串指向 SQLite（dev 库）。本脚本只还原 Postgres，拒绝执行。" ;;
  *) die "连接串不像 Postgres（应以 postgresql:// 开头）。" ;;
esac
command -v pg_restore >/dev/null 2>&1 || die "找不到 pg_restore。装 postgresql-client。"

resolve_pgconn "$SRC_URL"
PG_DB="$(url_dbname "$PGURL")"
PG_HOST="$(url_host "$PGURL")"

# ── 解密（如果是 .enc）──
PLAIN="$FILE"
CLEANUP=""
if [ "${FILE##*.}" = "enc" ]; then
  [ -n "$PASSPHRASE" ] || die "这是加密备份（.enc），但没设 BEACON_BACKUP_PASSPHRASE。"
  command -v openssl >/dev/null 2>&1 || die "需要 openssl 解密，但没找到。"
  PLAIN="$(mktemp "${TMPDIR:-/tmp}/beacon-restore.XXXXXX")"
  CLEANUP="$PLAIN"
  trap 'rm -f "$CLEANUP"' EXIT
  chmod 600 "$PLAIN"
  log "解密中…"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -pass env:BEACON_BACKUP_PASSPHRASE -in "$FILE" -out "$PLAIN" \
    || die "解密失败：密码不对，或文件损坏。"
fi

# ── 先验证再动生产库：读不出目录就别往下走了 ──
log "校验备份文件…"
pg_restore --list "$PLAIN" > /dev/null 2>&1 \
  || die "备份文件读不出来（不是 pg_dump -Fc 格式，或已损坏）。没有对数据库做任何改动。"

OBJECTS="$(pg_restore --list "$PLAIN" 2>/dev/null | grep -c ';' || true)"

# ── 确认 ──
cat <<EOF

────────────────────────────────────────────────
  ⚠️  破坏性操作确认
────────────────────────────────────────────────
  备份文件 : $FILE
  目标主机 : $PG_HOST（火山 Supabase）
  目标数据库: $PG_DB
  备份条目 : ${OBJECTS:-未知} 项

  这会 DROP 并重建 $PG_DB 里的对象。
  该库现有数据将被备份中的数据覆盖，且无法撤销。
────────────────────────────────────────────────

EOF

if [ "$FORCE" = "1" ]; then
  log "BEACON_RESTORE_FORCE=1，跳过确认。"
else
  [ -t 0 ] || die "非交互式运行但没设 BEACON_RESTORE_FORCE=1，拒绝执行。"
  printf '要继续请完整输入目标数据库名【%s】：' "$PG_DB"
  read -r ANSWER
  [ "$ANSWER" = "$PG_DB" ] || die "输入不匹配，已取消。数据库未做任何改动。"
fi

# ── 恢复 ──
log "开始恢复…"
# --clean --if-exists：先删旧对象；--no-owner：适配 RLS 非超级用户角色 / 托管库
# pg_restore 对已存在/权限类对象常有非致命告警，用 exit code 判定整体成败
if pg_restore -d "$PGURL" --clean --if-exists --no-owner --single-transaction "$PLAIN"; then
  log "恢复完成。"
else
  die "pg_restore 失败。用了 --single-transaction，失败会整体回滚，库应保持恢复前状态。
       若报 DROP EXTENSION/依赖类错误：改成恢复进一个空库/新分支，或改用火山平台 PITR。"
fi

cat <<EOF

恢复后请自查：
  1. docker compose restart web worker     # 让连接池重连火山库
  2. curl -s localhost:3000/api/health     # 探针
  3. 抽查关键表行数（本机装了 psql 时）：
     psql "$PGURL" -c '\\dt'
     psql "$PGURL" -c 'SELECT count(*) FROM "Workspace";'
  4. pgvector 索引 / RLS 策略随 dump 一起还原；若报缺失，重跑 scripts/db-init-supabase.sh 的后两步
     （prisma/postgres/01-pgvector.sql、02-rls.sql）

EOF
