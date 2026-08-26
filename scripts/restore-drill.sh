#!/usr/bin/env bash
# 恢复演练：把一份备份**真的还原出来**，并逐项证明它可用。
#
# 为什么要有这个脚本：没验证过恢复的备份等于没有备份。而「恢复演练」如果每次都靠人
# 手敲十几条命令，实际结果就是永远不做（本项目 2026-07-17 起挂了七次待办，一次没做成）。
#
# 它做四件事，任何一件不过都判失败（exit 1）：
#   1. 起一个**一次性** Postgres 容器（pgvector 镜像——库里有 vector 列，普通 postgres 镜像还原会炸）
#   2. pg_restore 还原备份
#   3. 逐表行数与备份当天的 .counts 基准**对账**（这是能发现「RLS 静默过滤导致备份是空壳」的唯一硬证据）
#   4. 用 BEACON_MASTER_KEY 解开还原库里的一条 BYOK 密文（证明主密钥与这份数据配套——
#      主密钥丢了，库恢复出来也全是乱码，那种「备份成功」毫无意义）
#
# 用法：
#   BEACON_MASTER_KEY="…" scripts/restore-drill.sh                      # 用最新一份日备
#   BEACON_MASTER_KEY="…" scripts/restore-drill.sh /path/to/xxx.dump    # 指定备份
#   BEACON_BACKUP_PASSPHRASE="…" …                                      # 备份是 .enc 时需要
#
# ⚠️ 全程不碰生产库：只读备份文件 + 起一个临时容器，结束即销毁。

set -euo pipefail

BACKUP_DIR="${BEACON_BACKUP_DIR:-/var/backups/beacon}"
DUMP="${1:-}"
PG_IMAGE="${BEACON_DRILL_PG_IMAGE:-pgvector/pgvector:pg17}"
NODE_IMAGE="${BEACON_DRILL_NODE_IMAGE:-node:20-alpine}"
CONTAINER="beacon-restore-drill-$$"
PGPW="drill-$(date +%s)"

log()  { printf '[drill %s] %s\n' "$(date '+%F %T')" "$*"; }
die()  { printf '[drill %s] ❌ %s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; [ -n "${PLAIN_TMP:-}" ] && rm -f "$PLAIN_TMP"; }
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || die "需要 docker 来起临时库。"

# ── 选备份 ──
if [ -z "$DUMP" ]; then
  DUMP="$(ls -1t "$BACKUP_DIR"/daily/*.dump "$BACKUP_DIR"/daily/*.dump.enc 2>/dev/null | head -1 || true)"
  [ -n "$DUMP" ] || die "$BACKUP_DIR/daily 下没有备份文件。先跑 scripts/backup.sh。"
fi
[ -f "$DUMP" ] || die "备份文件不存在：$DUMP"
COUNTS_FILE="${DUMP}.counts"
log "演练对象：$DUMP"

# ── 加密备份先解开（解到临时文件，结束即删）──
RESTORE_SRC="$DUMP"
case "$DUMP" in
  *.enc)
    [ -n "${BEACON_BACKUP_PASSPHRASE:-}" ] || die "这是加密备份，但没给 BEACON_BACKUP_PASSPHRASE。"
    PLAIN_TMP="$(mktemp)"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BEACON_BACKUP_PASSPHRASE -in "$DUMP" -out "$PLAIN_TMP" \
      || die "解密失败——口令不对，或这份备份根本解不开（这正是演练要发现的事）。"
    RESTORE_SRC="$PLAIN_TMP"
    log "已解密到临时文件"
    ;;
esac

# ── 1. 起临时库 ──
log "启动临时 Postgres（$PG_IMAGE，不映射端口，仅容器内可达）…"
docker image inspect "$PG_IMAGE" >/dev/null 2>&1 || docker pull "$PG_IMAGE" >/dev/null || die "拉取 $PG_IMAGE 失败。"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD="$PGPW" -e POSTGRES_DB=drill "$PG_IMAGE" >/dev/null

for i in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres -d drill >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && die "临时库 60 秒没起来。"
  sleep 1
done
log "临时库就绪"

# 备份里 embedding 列是 vector 类型，扩展要先建；schema 由 dump 自带（-n beacon）
docker exec "$CONTAINER" psql -U postgres -d drill -q -c 'CREATE EXTENSION IF NOT EXISTS vector;' \
  || die "临时库建 vector 扩展失败（镜像不带 pgvector？）"

# ── 2. 还原 ──
log "pg_restore 还原中…"
docker cp "$RESTORE_SRC" "$CONTAINER:/tmp/beacon.dump" >/dev/null
# --no-owner：备份里的属主角色（beacon_app）在临时库不存在
# 不加 --exit-on-error：RLS 策略里引用的 app_current_tenant() 函数属于 beacon schema，
# 会随 dump 一起还原；但个别 GRANT 到不存在角色的语句报错属预期噪声，靠行数对账判成败。
RESTORE_LOG="$(docker exec "$CONTAINER" pg_restore -U postgres -d drill --no-owner /tmp/beacon.dump 2>&1 || true)"
ERRORS="$(printf '%s\n' "$RESTORE_LOG" | grep -c '^pg_restore: error' || true)"
log "还原完成（pg_restore 报错行 $ERRORS 条）"
# 报错行一律打出来。「有几条错但我不告诉你是什么」等于把真问题藏在噪声里——
# 已知的良性一条是 GRANT 给 beacon_app（临时库里没有这个角色）。
if [ "$ERRORS" != "0" ]; then
  printf '%s\n' "$RESTORE_LOG" | grep -A2 '^pg_restore: error' | sed 's/^/    /'
fi

# ── 3. 行数对账 ──
COUNT_SQL="SELECT c.relname || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from beacon.%I', c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'beacon' AND c.relkind = 'r' ORDER BY c.relname;"
RESTORED_COUNTS="$(docker exec "$CONTAINER" psql -U postgres -d drill -At -c "$COUNT_SQL")" || die "还原库里数不出行数——还原大概率失败了。"
RESTORED_TABLES="$(printf '%s\n' "$RESTORED_COUNTS" | wc -l | tr -d ' ')"
log "还原库：$RESTORED_TABLES 张表"

if [ -f "$COUNTS_FILE" ]; then
  # ── 对账口径：严一处、松一处 ──────────────────────────────────────────────
  #
  # 【为什么不能要求逐表完全相等】基准是在 pg_dump **之后**记的（见 backup.sh），
  # 而热榜、话题簇这些全局表在这几十秒里一直被 cron 写入和清理。
  # 于是每周都会冒出一两张表差个几行——2026-08-23 就是 HotItem 1907→1913 让整场演练判红。
  # **一个每周都喊狼来了的守卫，最后只会被无视**，而那时它就真的不设防了。
  #
  # 严的那一处一点不松：这场演练存在的理由是发现「RLS 静默过滤 → 备份是空壳」，
  # 那种失败长这样：本来有数据的表还原后是 0，或者少掉一大截。这两种照样判死。
  TOL_PCT="${BEACON_DRILL_TOLERANCE_PCT:-1}"   # 允许的相对漂移
  TOL_MIN="${BEACON_DRILL_TOLERANCE_MIN:-5}"   # 小表按绝对条数放行，不然 3→4 就是 33%
  MISMATCH=0
  DRIFT=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    t="${line%%=*}"; want="${line#*=}"
    got="$(printf '%s\n' "$RESTORED_COUNTS" | sed -n "s/^${t}=//p")"

    if [ -z "$got" ]; then
      printf '  ❌ %s：备份时 %s 行 → 还原后**缺这张表**\n' "$t" "$want"
      MISMATCH=$((MISMATCH + 1)); continue
    fi
    [ "$want" = "$got" ] && continue

    # 本来有数据、还原后一条不剩 —— 这正是 RLS 空壳的样子，永远判死
    if [ "$want" -gt 0 ] && [ "$got" = 0 ]; then
      printf '  ❌ %s：备份时 %s 行 → 还原后 0 行（空壳）\n' "$t" "$want"
      MISMATCH=$((MISMATCH + 1)); continue
    fi

    diff=$(( got > want ? got - want : want - got ))
    allow=$(( want * TOL_PCT / 100 ))
    [ "$allow" -lt "$TOL_MIN" ] && allow="$TOL_MIN"
    if [ "$diff" -le "$allow" ]; then
      printf '  ·  %s：%s → %s（差 %s 行，在容差内；备份期间 cron 还在写）\n' "$t" "$want" "$got" "$diff"
      DRIFT=$((DRIFT + 1))
    else
      printf '  ❌ %s：备份时 %s 行 → 还原后 %s（差 %s 行，超出容差 %s）\n' "$t" "$want" "$got" "$diff" "$allow"
      MISMATCH=$((MISMATCH + 1))
    fi
  done < "$COUNTS_FILE"
  [ "$MISMATCH" = 0 ] || die "行数对账有 $MISMATCH 张表对不上——这份备份不可信。"
  if [ "$DRIFT" -gt 0 ]; then
    log "✅ 行数对账通过（$DRIFT 张表有容差内的漂移，是备份期间 cron 在写，不是丢数据）"
  else
    log "✅ 行数对账全表一致（基准 $COUNTS_FILE）"
  fi
else
  log "⚠️  没有 .counts 基准（旧备份），跳过对账——只能证明「能还原」，不能证明「还原全」。"
fi

# 核心表非空：对账通过但全是 0 也算失败（空库和空库当然一致）
for core in Tenant Member Workspace; do
  n="$(printf '%s\n' "$RESTORED_COUNTS" | sed -n "s/^${core}=//p")"
  [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null || die "还原库里 ${core} 为空——恢复出来是个空壳。"
done

# ── 4. BYOK 主密钥配套验证 ──
if [ -z "${BEACON_MASTER_KEY:-}" ]; then
  log "⚠️  未提供 BEACON_MASTER_KEY，跳过密文解密验证。**这一步跳过 = 没有证明主密钥与这份备份配套**。"
else
  ENC="$(docker exec "$CONTAINER" psql -U postgres -d drill -At -c 'SELECT "apiKeyEnc" FROM beacon."ModelProvider" LIMIT 1;' 2>/dev/null || true)"
  if [ -z "$ENC" ]; then
    log "库里没有 BYOK 密文（ModelProvider 为空），改试机器人密钥…"
    ENC="$(docker exec "$CONTAINER" psql -U postgres -d drill -At -c 'SELECT "secretsEnc" FROM beacon."BotIntegration" WHERE "secretsEnc" <> '"''"' LIMIT 1;' 2>/dev/null || true)"
  fi
  if [ -z "$ENC" ]; then
    log "⚠️  库里没有任何密文可验（尚无 BYOK/机器人配置），跳过。"
  else
    # 与 lib/crypto.ts 逐字同构：key = sha256(BEACON_MASTER_KEY)，密文格式 iv.tag.data（均 base64），AES-256-GCM
    OUT="$(docker run --rm -e ENC="$ENC" -e MK="$BEACON_MASTER_KEY" "$NODE_IMAGE" node -e '
      const c=require("crypto");
      const key=c.createHash("sha256").update(process.env.MK).digest();
      const [iv,tag,data]=process.env.ENC.split(".");
      try{
        const d=c.createDecipheriv("aes-256-gcm",key,Buffer.from(iv,"base64"));
        d.setAuthTag(Buffer.from(tag,"base64"));
        const p=Buffer.concat([d.update(Buffer.from(data,"base64")),d.final()]).toString("utf8");
        console.log(p.length>0?"OK:"+p.length:"EMPTY");
      }catch(e){console.log("FAIL:"+e.message)}
    ' 2>&1)" || die "解密验证容器跑不起来。"
    case "$OUT" in
      OK:*) log "✅ 主密钥配套验证通过（解出明文 ${OUT#OK:} 字符，内容不打印）" ;;
      *)    die "主密钥解不开还原库里的密文（$OUT）。备份还原出来了，但 BYOK 密钥全是废数据。" ;;
    esac
  fi
fi

log "🎉 恢复演练通过：备份可还原、行数对得上、密钥配套。临时库即将销毁。"
