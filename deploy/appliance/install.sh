#!/usr/bin/env bash
# 烽火台 · 整机版一键安装（macOS / Linux）
#
# 卖给客户的那台机器上跑这一个脚本，跑完就能用：
#   bash deploy/appliance/install.sh
#
# 它做完这些事：
#   ① 体检 Node 版本      ② 生成 .env.appliance（含随机主密钥与装机口令）
#   ③ 装依赖 + 建库 + 构建 ④ 注册开机自启（launchd）
#   ⑤ 生成桌面启动器与《安装说明》 ⑥ 跑上线体检 ⑦ 打开浏览器进装机向导
#
# 【为什么不用 Docker】整机版的全部依赖就是 Node + 一个 SQLite 文件 ——
# 队列走进程内、定时跑在 web 进程里（BEACON_QUEUE=local，见 lib/jobs/local-scheduler.ts），
# 没有 Postgres、没有 Redis。给客户装 Docker Desktop 只会多一层会坏的东西。
set -euo pipefail

# ── 参数 ────────────────────────────────────────────────────────────────
PORT="${BEACON_PORT:-3070}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env.appliance"
NODE_MIN=20

cd "$ROOT"

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

say "烽火台 · 整机版安装"
say "安装目录：$ROOT"
echo

# ── ① Node ─────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "没找到 Node.js。请先安装 Node ${NODE_MIN}+（https://nodejs.org），再重跑本脚本。"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$NODE_MIN" ] || die "Node 版本过低：当前 v$(node -p 'process.versions.node')，需要 ${NODE_MIN}+。"
say "✅ Node v$(node -p 'process.versions.node')"

# ── ② 环境文件 ─────────────────────────────────────────────────────────
# 已存在就**不覆盖**：重跑安装脚本是常见操作（升级、修复），
# 覆盖会把主密钥换掉 —— 那等于把库里所有加密字段（模型 Key、机器人密钥）全部变成乱码。
if [ -f "$ENV_FILE" ]; then
  say "✅ 已有 $ENV_FILE，保持不变（主密钥一旦更换，库里加密字段会全部失效）"
  # 口令可能已被用掉（装过机），这里只读出来给最后的说明用
  SETUP_TOKEN="$(grep -E '^BEACON_SETUP_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"
else
  MASTER_KEY="$(openssl rand -hex 32)"
  SETUP_TOKEN="$(openssl rand -hex 16)"
  cat > "$ENV_FILE" <<ENVEOF
# 烽火台 · 整机版环境（由 deploy/appliance/install.sh 生成，请勿手工改主密钥）
BEACON_EDITION=appliance
NODE_ENV=production
PORT=${PORT}
BEACON_SITE_URL=http://localhost:${PORT}

# 数据库：单文件 SQLite，就在 prisma/appliance.db。备份 = 复制这个文件。
DATABASE_URL="file:./appliance.db"

# 队列与定时：走进程内队列（无需 Redis），并让 web 进程自己到点跑定时任务。
#
# 【为什么是 local 而不是留空】留空只有队列没有调度——「每天自动跑一遍」这件事
# 在整机版上整个不存在（界面直接不给配）。而定时不该因为部署形态而缺席：
# appliance 与 private 的**能力面必须一致**，差别只在基础设施。
#
# 【为什么不另起一个 worker 进程】这台机器的库是单文件 SQLite，
# 两个 Node 进程同时写会撞锁（SQLITE_BUSY），而且那种失败是间歇性的、最难查。
# 调度放进 web 进程自己：一个进程、一份连接、没有锁竞争。
BEACON_QUEUE=local

# ⚠️ 主密钥：库里所有加密字段（模型 API Key、机器人密钥）都用它加解密。
#    换掉它 = 那些字段全部变成读不出来的乱码。备份机器时必须连这个文件一起备份。
BEACON_MASTER_KEY=${MASTER_KEY}

# 装机口令：只在第一次打开 /setup 时用一次。装完可以留着（向导已自动关闭）。
BEACON_SETUP_TOKEN=${SETUP_TOKEN}
ENVEOF
  chmod 600 "$ENV_FILE"
  say "✅ 已生成 $ENV_FILE（权限 600）"
fi

set -a; . "$ENV_FILE"; set +a

# ── ③ 依赖 / 建库 / 构建 ───────────────────────────────────────────────
if [ ! -d node_modules ]; then
  say "→ 安装依赖（首次较慢）…"
  npm ci
fi

say "→ 生成 Prisma 客户端并建库…"
npx prisma generate >/dev/null
npx prisma db push --skip-generate >/dev/null
say "→ 灌入系统数据（敏感词库、算法规则等）…"
npx tsx prisma/seed.ts >/dev/null

if [ ! -d .next ]; then
  say "→ 构建前端（首次较慢，约几分钟）…"
  npm run build
fi

# ── ④ 开机自启 ─────────────────────────────────────────────────────────
START_SH="$ROOT/deploy/appliance/start.sh"
cat > "$START_SH" <<'STARTEOF'
#!/usr/bin/env bash
# 启动烽火台整机版。双击 or 开机自启都走这里。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
set -a; . "$ROOT/.env.appliance"; set +a
exec npx next start -p "${PORT:-3070}"
STARTEOF
chmod +x "$START_SH"

if [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/cn.iyunci.beacon.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>cn.iyunci.beacon</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>${START_SH}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StandardOutPath</key><string>${ROOT}/deploy/appliance/beacon.log</string>
  <key>StandardErrorPath</key><string>${ROOT}/deploy/appliance/beacon.err.log</string>
</dict></plist>
PLISTEOF
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST"
  say "✅ 已注册开机自启（launchd: cn.iyunci.beacon）"

  # 第二个常驻服务：飞书长连接 connector。
  # 【为什么整机版必须有它】飞书事件订阅默认走 webhook —— 飞书服务器要主动打到你的公网地址，
  # 而这台机器在 NAT 后面根本没有公网地址。长连接反过来由本机主动出站连飞书，
  # 不需要公网 IP / 域名 / 证书 / 备案。没配飞书应用时它会打印原因后退出，等配好重启即可。
  CONNECTOR_SH="$ROOT/deploy/appliance/connector.sh"
  cat > "$CONNECTOR_SH" <<'CONNEOF'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
set -a; . "$ROOT/.env.appliance"; set +a
exec npx tsx connector.ts
CONNEOF
  chmod +x "$CONNECTOR_SH"
  CPLIST="$HOME/Library/LaunchAgents/cn.iyunci.beacon.connector.plist"
  cat > "$CPLIST" <<CPLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>cn.iyunci.beacon.connector</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>${CONNECTOR_SH}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StandardOutPath</key><string>${ROOT}/deploy/appliance/connector.log</string>
  <key>StandardErrorPath</key><string>${ROOT}/deploy/appliance/connector.err.log</string>
</dict></plist>
CPLISTEOF
  launchctl unload "$CPLIST" >/dev/null 2>&1 || true
  launchctl load "$CPLIST"
  say "✅ 已注册飞书长连接服务（launchd: cn.iyunci.beacon.connector）"

  # 桌面双击启动器
  DESKTOP="$HOME/Desktop"
  if [ -d "$DESKTOP" ]; then
    cat > "$DESKTOP/打开烽火台.command" <<CMDEOF
#!/usr/bin/env bash
open "http://localhost:${PORT}"
CMDEOF
    chmod +x "$DESKTOP/打开烽火台.command"
  fi
else
  warn "非 macOS：已生成 $START_SH，请自行注册为 systemd 服务或开机项。"
fi

# ── ⑤ 说明书 ───────────────────────────────────────────────────────────
DESKTOP="${HOME}/Desktop"
[ -d "$DESKTOP" ] || DESKTOP="$ROOT"
cat > "$DESKTOP/烽火台-安装说明.txt" <<DOCEOF
烽火台 · 整机版
────────────────────────────────
访问地址：http://localhost:${PORT}
装机口令：${SETUP_TOKEN:-（已在 .env.appliance 中）}

第一次打开会进入「初始化」页面，四步：
  1. 输入上面的装机口令
  2. 填团队名称和管理员称呼
  3. 选大模型厂商、填你自己的 API Key
  4. 填飞书/钉钉/企业微信应用的 AppID 与 Secret（可跳过，之后在设置里补）

装完之后：
  · 同事在群里 @机器人 就能下令
  · 每个人的 Chrome 装上「烽火台采集助手」插件，服务器地址填 http://localhost:${PORT}

⚠️ 备份：整台机器的数据在这两个文件里，一起复制即可
     ${ROOT}/prisma/appliance.db      （全部业务数据）
     ${ROOT}/.env.appliance           （主密钥，缺了它数据库里的 Key 解不开）

日志：${ROOT}/deploy/appliance/beacon.log
      ${ROOT}/deploy/appliance/connector.log  （飞书长连接）
重启：launchctl kickstart -k gui/\$(id -u)/cn.iyunci.beacon
DOCEOF
say "✅ 已写出《烽火台-安装说明.txt》到桌面"

# ── ⑥ 体检 ─────────────────────────────────────────────────────────────
say "→ 上线体检…"
npx tsx scripts/preflight.ts || warn "体检有 FAIL，请按上面提示处理后再交付。"

# ── ⑦ 打开 ─────────────────────────────────────────────────────────────
echo
say "安装完成。装机口令：${SETUP_TOKEN:-见 .env.appliance}"
say "正在打开 http://localhost:${PORT}/setup"
sleep 2
command -v open >/dev/null 2>&1 && open "http://localhost:${PORT}/setup" || true
