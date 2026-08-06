#!/usr/bin/env bash
# crontab 入口：每日备份 + （周日）恢复演练。
#
# 为什么要这层包装而不是直接把 backup.sh 写进 crontab：
#   · cron 的环境几乎是空的，DATABASE_URL 得自己从 .env.production 取（那份文件被 rsync 排除，
#     是服务器独有配置，密码不进仓库）；
#   · 失败必须**看得见**。没有这一条，「备份挂了三个月没人知道」是默认结局。
#
# 安装（服务器上执行一次）：
#   (crontab -l 2>/dev/null; echo "30 3 * * * /var/www/beacon/scripts/cron-backup.sh") | crontab -
#
# 失败告警：在 .env.production 里配 BEACON_OPS_WEBHOOK（飞书/钉钉/企微机器人 webhook），
#   失败时推一条文本；不配则只写日志。

set -uo pipefail

APP_DIR="${BEACON_APP_DIR:-/var/www/beacon}"
LOG_DIR="${BEACON_LOG_DIR:-/var/log/beacon}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/backup-$(date +%Y%m).log"   # 按月分文件：自然限长，不用配 logrotate
STATE="$LOG_DIR/backup-last-status"

cd "$APP_DIR" || { echo "[cron-backup] 找不到 $APP_DIR" >> "$LOG"; exit 1; }

read_env() { grep -m1 "^$1=" .env.production 2>/dev/null | cut -d= -f2- | tr -d '"'; }

notify_failure() {
  local msg="$1" hook
  hook="$(read_env BEACON_OPS_WEBHOOK)"
  [ -n "$hook" ] || return 0
  # 飞书/企微/钉钉的自定义机器人都收这个最简文本结构里的一种；失败告警不值得为此引依赖，
  # 两种形状各发一次，收得到哪条算哪条。
  curl -s -m 10 -X POST "$hook" -H 'Content-Type: application/json' \
    -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"$msg\"}}" >/dev/null 2>&1
  curl -s -m 10 -X POST "$hook" -H 'Content-Type: application/json' \
    -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"$msg\"}}" >/dev/null 2>&1
}

DB="$(read_env DATABASE_URL)"
if [ -z "$DB" ]; then
  echo "[cron-backup $(date '+%F %T')] .env.production 里没有 DATABASE_URL，跳过" >> "$LOG"
  echo "FAILED $(date '+%F %T') no-database-url" > "$STATE"
  notify_failure "【烽火台】备份失败：服务器 .env.production 读不到 DATABASE_URL"
  exit 1
fi

echo "===== $(date '+%F %T') 备份开始 =====" >> "$LOG"
if DATABASE_URL="$DB" BEACON_BACKUP_DIR="${BEACON_BACKUP_DIR:-/var/backups/beacon}" \
     bash scripts/backup.sh >> "$LOG" 2>&1; then
  echo "OK $(date '+%F %T')" > "$STATE"
else
  echo "FAILED $(date '+%F %T') backup" > "$STATE"
  notify_failure "【烽火台】数据库备份失败，看 $LOG（服务器 $(hostname)）"
  exit 1
fi

# 周日顺带做一次恢复演练——备份没验证过等于没有备份，而「靠人记得演练」的结果是永远不演练。
if [ "$(date +%u)" = "7" ]; then
  echo "===== $(date '+%F %T') 恢复演练开始 =====" >> "$LOG"
  MK="$(read_env BEACON_MASTER_KEY)"
  if BEACON_MASTER_KEY="$MK" bash scripts/restore-drill.sh >> "$LOG" 2>&1; then
    echo "OK $(date '+%F %T') backup+drill" > "$STATE"
  else
    echo "FAILED $(date '+%F %T') drill" > "$STATE"
    notify_failure "【烽火台】每周恢复演练失败：备份文件可能不可用，看 $LOG"
    exit 1
  fi
fi
