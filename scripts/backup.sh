#!/usr/bin/env bash
# 烽火台数据库备份：对**外部连接串**（火山引擎 Supabase 版）跑 pg_dump 自定义格式(-Fc)，
# 带时间戳 + 保留策略(7 日 + 4 周) + 可选加密。
#
# 用法：DATABASE_URL="postgresql://beacon_app:<PWD>@<HOST>:<PORT>/postgres?schema=beacon&sslmode=require" scripts/backup.sh
#   连接串同 .env.production 里那条（本脚本会自动剥掉 Prisma 专有参数再交给 pg_dump）。
#   想用专门的备份端点（如私网/只读实例）可设 BEACON_BACKUP_DATABASE_URL 覆盖。
#   cron / 恢复演练 / 异地备份见 docs/生产化部署.md「备份与恢复」。
#
# 平台优先：火山 Supabase 自带逻辑备份 + 物理备份(WAL-G) + PITR。整库灾备优先用平台快照/PITR，
#   本脚本是**外部逻辑导出兜底**（便于异地、离线、跨平台留一份）。见 docs。
#
# ⚠️ 备份文件含全部用户数据和加密后的 BYOK key，等同于生产库本体。存放见 docs。
# ⚠️ 需要本机装了 postgresql-client（pg_dump / pg_restore）。火山连接要求服务器公网 IP 在其 ACL 白名单里。

set -euo pipefail

# ── 配置（环境变量可覆盖）──
BACKUP_DIR="${BEACON_BACKUP_DIR:-/var/backups/beacon}"
SRC_URL="${BEACON_BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
KEEP_DAILY="${BEACON_KEEP_DAILY:-7}"             # 保留最近 N 份日备
KEEP_WEEKLY="${BEACON_KEEP_WEEKLY:-4}"           # 保留最近 N 份周备（周日那份）
PASSPHRASE="${BEACON_BACKUP_PASSPHRASE:-}"       # 非空则用 AES-256 加密

log()  { printf '[backup %s] %s\n' "$(date '+%F %T')" "$*"; }
die()  { printf '[backup %s] 错误：%s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

# libpq 不认 Prisma 专有的查询参数（connection_limit / pool_timeout / pgbouncer / schema…），
# 直接把生产 DATABASE_URL 丢给 pg_dump 会报 invalid URI query parameter。只保留 libpq 认识的键。
sanitize_libpq_url() {
  local url="$1" base query kv key keep=""
  base="${url%%\?*}"
  [ "$base" = "$url" ] && { printf '%s' "$url"; return; }   # 没有查询串
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

# 百分号解码：URI 里密码是百分号编码的（@→%40、:→%3A 等），而 PGPASSWORD 要的是解码后的原文，
# 否则含特殊字符的火山密码会验证失败。注意 userinfo 里 + 是字面量（不是空格），故不转 +→空格。
urldecode() { printf '%b' "${1//%/\\x}"; }

# 把连接串里的密码剥进 PGPASSWORD（命令行上不带密码，避免同机其他用户 ps 看到），
# 再去掉 Prisma 参数。产出：全局 PGURL（无密码、libpq 干净）；副作用：export PGPASSWORD。
resolve_pgconn() {
  local url="$1" scheme rest authority pathq userinfo hostport user nopwd
  scheme="${url%%://*}"
  rest="${url#*://}"
  authority="${rest%%/*}"          # user:pwd@host:port
  pathq="${rest#"$authority"}"     # /db?query（可能为空）
  if [ "$authority" != "${authority#*@}" ]; then      # authority 含 @ → 有 userinfo
    userinfo="${authority%@*}"                         # 最后一个 @ 之前
    hostport="${authority##*@}"
    if [ "$userinfo" != "${userinfo#*:}" ]; then       # 含 : → 有密码
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

# ── 前置检查 ──
[ -n "$SRC_URL" ] || die "没有连接串。设 DATABASE_URL（或 BEACON_BACKUP_DATABASE_URL）指向火山 Supabase 库。"
case "$SRC_URL" in
  postgres://*|postgresql://*) : ;;
  file:*|*sqlite*) die "连接串指向 SQLite（dev 库），不是生产 Postgres。拒绝备份。" ;;
  *) die "连接串不像 Postgres（应以 postgresql:// 开头）。" ;;
esac
# ── pg 工具来源：本机优先，没有就借 Docker 里的 postgres 镜像 ──
# 生产机是 CentOS 7（已 EOL，装 postgresql-client 16 要折腾第三方源），但机器上本来就有
# postgres 镜像。与其在 EOL 系统上装包，不如把 pg_dump/pg_restore 跑在容器里——
# 版本还能钉死（新版 pg_dump 连老版服务端是官方支持方向，反过来不行）。
# ⚠️ 镜像大版本必须 **≥ 服务端**：pg_dump 连更高版本的服务端会直接
# 「aborting because of server version mismatch」拒绝导出（实测火山这套是 17.5，
# 用 16-alpine 一行都导不出来）。服务端升大版本时这里要跟着升。
PG_IMAGE="${BEACON_PG_IMAGE:-postgres:17-alpine}"
PG_MODE="local"
if ! command -v pg_dump >/dev/null 2>&1 || ! command -v pg_restore >/dev/null 2>&1; then
  command -v docker >/dev/null 2>&1 \
    || die "本机既没有 pg_dump/pg_restore，也没有 docker。装 postgresql-client（Debian: apt install postgresql-client-16），或提供可用的 docker。"
  docker image inspect "$PG_IMAGE" >/dev/null 2>&1 \
    || docker pull "$PG_IMAGE" >/dev/null 2>&1 \
    || die "拉取 $PG_IMAGE 失败，无法在容器里跑 pg_dump。"
  PG_MODE="docker"
fi
if [ -n "$PASSPHRASE" ]; then
  command -v openssl >/dev/null 2>&1 || die "设了 BEACON_BACKUP_PASSPHRASE 但找不到 openssl，无法加密。"
fi

# 两个模式下的统一入口。docker 模式把备份目录挂进容器，dump 直接落在挂载点上
# （不走 stdout：容器 stdout 混进日志时会污染二进制流，这类损坏 pg_restore --list 才发现）。
# ⚠️ --enable-row-security 不是可选项而是必需项：beacon schema 的 31 张表都是
# FORCE ROW LEVEL SECURITY（2026-07-22 的租户隔离加固），而连接角色 beacon_app 既非
# superuser 也无 BYPASSRLS。没有这个开关，pg_dump 会直接罢工：
#   ERROR: query would be affected by row-level security policy for table "AccountDailyStat"
# 加上它之后导出的是「该连接可见的行」——策略是 `app_current_tenant() IS NULL OR …`，
# 而 pg_dump 用的是全新连接（GUC 为 NULL）⇒ 可见全量。
# 🔒 但「应该可见全量」必须被验证，不能靠推理：见下面的 dump_row_counts + 核心表非空硬闸。
pg_dump_to() { # $1 = 宿主机绝对路径
  local out="$1"
  if [ "$PG_MODE" = local ]; then
    pg_dump "$PGURL" -Fc --no-owner --enable-row-security -n beacon -f "$out"
  else
    docker run --rm -e PGPASSWORD -v "$(dirname "$out")":/bk "$PG_IMAGE" \
      pg_dump "$PGURL" -Fc --no-owner --enable-row-security -n beacon -f "/bk/$(basename "$out")"
  fi
}

# 以与 pg_dump 相同的身份和连接条件，逐表数一遍行数。
# 用途有二：① 当天的「这份备份应该有多少行」对账基准（恢复演练拿它比对）；
#          ② RLS 静默过滤的探针 —— 万一哪天策略改成默认拒绝，这里会立刻塌成 0。
COUNT_SQL="SELECT c.relname || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from beacon.%I', c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'beacon' AND c.relkind = 'r' ORDER BY c.relname;"
dump_row_counts() { # → stdout: 表名=行数
  if [ "$PG_MODE" = local ]; then
    psql "$PGURL" -At -c "$COUNT_SQL"
  else
    docker run --rm -e PGPASSWORD "$PG_IMAGE" psql "$PGURL" -At -c "$COUNT_SQL"
  fi
}
pg_restore_list() { # $1 = 宿主机绝对路径
  local f="$1"
  if [ "$PG_MODE" = local ]; then
    pg_restore --list "$f" > /dev/null 2>&1
  else
    docker run --rm -v "$(dirname "$f")":/bk "$PG_IMAGE" \
      pg_restore --list "/bk/$(basename "$f")" > /dev/null 2>&1
  fi
}

resolve_pgconn "$SRC_URL"
log "目标库：${PGURL#*@}"

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

TS="$(date '+%Y%m%d-%H%M%S')"
BASENAME="beacon-${TS}.dump"
TMP="$(mktemp "${BACKUP_DIR}/.${BASENAME}.XXXXXX")"
# 任何一步失败都不留半截文件
trap 'rm -f "$TMP"' EXIT

# ── 导出 ──
log "开始 pg_dump（-Fc --no-owner，连到火山 Supabase；pg 工具来源：$PG_MODE）…"
pg_dump_to "$TMP" \
  || die "pg_dump 失败，已丢弃半截文件。查：服务器公网 IP 是否在火山 ACL 白名单、连接串端口/密码/SSL 是否对。"

[ -s "$TMP" ] || die "pg_dump 产出 0 字节，判定失败。"

# ── 完整性校验：能被 pg_restore 读出目录才算数（挡住截断/损坏的 dump）──
log "校验备份可读性（pg_restore --list）…"
pg_restore_list "$TMP" \
  || die "备份文件 pg_restore --list 读不出来，文件可能损坏，已丢弃。"

SIZE="$(du -h "$TMP" | cut -f1)"

# ── 行数基准 + RLS 静默过滤硬闸 ──
log "记录逐表行数基准（同时探测 RLS 是否在静默过滤）…"
COUNTS="$(dump_row_counts)" || die "行数基准查询失败——先别信这份备份。"
[ -n "$COUNTS" ] || die "行数基准为空（一张表都没数到），判定异常。"
for core in Tenant Member Workspace; do
  n="$(printf '%s\n' "$COUNTS" | sed -n "s/^${core}=//p")"
  # 空 = 表不存在（schema 漂移）；0 = 明明有用户却一行都没导出（RLS 在过滤）。两种都必须炸。
  [ -n "$n" ] || die "核心表 ${core} 不在导出范围内，schema 与预期不符，拒绝把这份备份当成功。"
  [ "$n" -gt 0 ] 2>/dev/null || die "核心表 ${core} 行数为 0 —— 极可能是 RLS 把行全过滤了。这种备份恢复出来是空库，拒绝落盘。"
done
log "行数基准：$(printf '%s\n' "$COUNTS" | wc -l | tr -d ' ') 张表，Tenant=$(printf '%s\n' "$COUNTS" | sed -n 's/^Tenant=//p') Member=$(printf '%s\n' "$COUNTS" | sed -n 's/^Member=//p')"

# ── 可选加密 ──
DEST="$BACKUP_DIR/daily/$BASENAME"
if [ -n "$PASSPHRASE" ]; then
  DEST="${DEST}.enc"
  log "加密中（AES-256-CBC + PBKDF2）…"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -pass env:BEACON_BACKUP_PASSPHRASE -in "$TMP" -out "$DEST" \
    || die "加密失败。"
  rm -f "$TMP"
else
  mv "$TMP" "$DEST"
fi
trap - EXIT
chmod 600 "$DEST"
# 行数基准与 dump 同名存放：恢复演练用它对账（scripts/restore-drill.sh 直接读）
printf '%s\n' "$COUNTS" > "${DEST}.counts"
chmod 600 "${DEST}.counts"
log "完成：$DEST（原始 $SIZE）· 行数基准 ${DEST}.counts"

# ── 周备：周日那份复制一份进 weekly ──
if [ "$(date +%u)" = "7" ]; then
  cp -p "$DEST" "$BACKUP_DIR/weekly/$(basename "$DEST")"
  log "周日 → 已复制到 weekly/"
fi

# ── 异地副本（S3 兼容对象存储：腾讯云 COS / 阿里云 OSS / MinIO 都行）──
#
# 为什么必须有：备份和应用跑在**同一台机器**上，机器被删、盘满、误 rm 就是备份和生产一起没。
# 2026-07-23 那次根盘 100% 满已经演示过这台机器不是绝对安全的。
#
# 配置（.env.production，四个都填齐才启用；缺任一项 = 明确跳过并说明，绝不静默）：
#   BEACON_BACKUP_S3_BUCKET      桶名，可带前缀路径，如 my-bucket/beacon
#   BEACON_BACKUP_S3_ENDPOINT    如 https://cos.ap-guangzhou.myqcloud.com
#   BEACON_BACKUP_S3_KEY / _SECRET
#   BEACON_BACKUP_S3_REGION      可选，默认 auto
#
# ⚠️ 异地放的是**与生产库等价的数据**，桶必须私有；且 BEACON_MASTER_KEY 要另外异地保管——
#    密钥丢了，还原出来的 BYOK 密文全是废数据（恢复演练验过这一条）。
# 本机没有 aws cli 时借 Docker 镜像跑（与 pg_dump 同一套路：CentOS 7 装不动新客户端）。
offsite_upload() {
  local file="$1" name bucket endpoint
  bucket="${BEACON_BACKUP_S3_BUCKET:-}"
  endpoint="${BEACON_BACKUP_S3_ENDPOINT:-}"
  if [ -z "$bucket" ] || [ -z "$endpoint" ] || [ -z "${BEACON_BACKUP_S3_KEY:-}" ] || [ -z "${BEACON_BACKUP_S3_SECRET:-}" ]; then
    log "异地副本：未配置（BEACON_BACKUP_S3_*），本次只有本机一份"
    return 0
  fi
  name="$(basename "$file")"
  local args=(--endpoint-url "$endpoint" s3 cp "$file" "s3://${bucket}/${name}")
  if command -v aws >/dev/null 2>&1; then
    AWS_ACCESS_KEY_ID="$BEACON_BACKUP_S3_KEY" AWS_SECRET_ACCESS_KEY="$BEACON_BACKUP_S3_SECRET" \
      AWS_DEFAULT_REGION="${BEACON_BACKUP_S3_REGION:-auto}" aws "${args[@]}" >/dev/null
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm \
      -e AWS_ACCESS_KEY_ID="$BEACON_BACKUP_S3_KEY" \
      -e AWS_SECRET_ACCESS_KEY="$BEACON_BACKUP_S3_SECRET" \
      -e AWS_DEFAULT_REGION="${BEACON_BACKUP_S3_REGION:-auto}" \
      -v "$(dirname "$file")":/data:ro \
      amazon/aws-cli:latest --endpoint-url "$endpoint" s3 cp "/data/$name" "s3://${bucket}/${name}" >/dev/null
  else
    log "异地副本：本机既没有 aws cli 也没有 docker，跳过"
    return 1
  fi
}

if offsite_upload "$DEST" && offsite_upload "${DEST}.counts"; then
  # ⚠️ 这里不能写成 `[ -n "$X" ] && log ...`：test 为假会返回 1，
  # 而它是 then 分支的最后一条命令 → set -e 直接把整个备份判成失败（配置为空时天天误报）。
  if [ -n "${BEACON_BACKUP_S3_BUCKET:-}" ]; then
    log "异地副本：已上传 $(basename "$DEST") 与 .counts"
  fi
else
  # 上传失败**要让整个备份任务失败**：cron-backup.sh 据此告警。
  # 「本机有备份就算成功」正是异地副本长期缺失却没人发现的原因。
  die "异地副本上传失败（本机备份已生成：$DEST）"
fi

# ── 保留策略：按时间倒序，超出数量的删掉 ──
prune() {
  local dir="$1" keep="$2" count=0 f
  # 只按**备份本体**计数（.counts 是它的附属文件，跟着一起删）。
  # 反例：把 .counts 也算进来，KEEP_DAILY=7 实际只留 3 份半，还可能删了 dump 留下孤儿 counts。
  # 文件名带时间戳且无空格，ls -1t 排序足够
  for f in $(ls -1t "$dir" 2>/dev/null | grep -v '\.counts$'); do
    count=$((count + 1))
    if [ "$count" -gt "$keep" ]; then
      rm -f "$dir/$f" "$dir/$f.counts"
      log "清理过期备份：$dir/$f"
    fi
  done
}
prune "$BACKUP_DIR/daily" "$KEEP_DAILY"
prune "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"

# 只数备份本体（.counts 是附属文件）——报「保留 4 份」而实际只有 2 份备份，
# 是会让人对保留策略产生错误安全感的那种数字。
count_backups() { ls -1 "$1" 2>/dev/null | grep -vc '\.counts$' || true; }
log "当前保留：daily=$(count_backups "$BACKUP_DIR/daily") weekly=$(count_backups "$BACKUP_DIR/weekly")"
