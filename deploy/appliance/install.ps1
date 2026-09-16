# 烽火台 · 整机版一键安装（Windows）
#
#   右键「使用 PowerShell 运行」，或：
#   powershell -ExecutionPolicy Bypass -File deploy\appliance\install.ps1
#
# 与 macOS 版 install.sh 一一对应，差别只在三处平台机制：
#   开机自启 launchd → 计划任务(schtasks)；桌面 .command → .bat；openssl → .NET RNG。
$ErrorActionPreference = 'Stop'

$Port = if ($env:BEACON_PORT) { $env:BEACON_PORT } else { '3070' }
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$EnvFile = Join-Path $Root '.env.appliance'
$NodeMin = 20

function Say  ($m) { Write-Host $m -ForegroundColor Cyan }
function Warn ($m) { Write-Host $m -ForegroundColor Yellow }
function Die  ($m) { Write-Host $m -ForegroundColor Red; exit 1 }

# Windows 上没有 openssl，用 .NET 的加密安全随机数
function New-Token ([int]$bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

Say '烽火台 · 整机版安装'
Say "安装目录：$Root"
Set-Location $Root

# ① Node
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "没找到 Node.js。请先安装 Node $NodeMin+（https://nodejs.org），再重跑本脚本。"
}
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt $NodeMin) { Die "Node 版本过低：当前 v$(node -p 'process.versions.node')，需要 $NodeMin+。" }
Say "✅ Node v$(node -p 'process.versions.node')"

# ② 环境文件（已存在则不覆盖：换掉主密钥会让库里所有加密字段变成乱码）
if (Test-Path $EnvFile) {
  Say "✅ 已有 $EnvFile，保持不变（主密钥一旦更换，库里加密字段会全部失效）"
  $SetupToken = (Select-String -Path $EnvFile -Pattern '^BEACON_SETUP_TOKEN=' |
                 Select-Object -First 1).Line -replace '^BEACON_SETUP_TOKEN=', '' -replace '"', ''
} else {
  $MasterKey  = New-Token 32
  $SetupToken = New-Token 16
  @"
# 烽火台 · 整机版环境（由 deploy\appliance\install.ps1 生成，请勿手工改主密钥）
BEACON_EDITION=appliance
NODE_ENV=production
PORT=$Port
BEACON_SITE_URL=http://localhost:$Port

# 数据库：单文件 SQLite，就在 prisma\appliance.db。备份 = 复制这个文件。
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

# 主密钥：库里所有加密字段（模型 API Key、机器人密钥）都用它加解密。
# 换掉它 = 那些字段全部变成读不出来的乱码。备份机器时必须连这个文件一起备份。
BEACON_MASTER_KEY=$MasterKey

# 装机口令：只在第一次打开 /setup 时用一次。
BEACON_SETUP_TOKEN=$SetupToken
"@ | Set-Content -Path $EnvFile -Encoding UTF8
  Say "✅ 已生成 $EnvFile"
}

# 把 .env.appliance 读进当前进程（后面的 prisma/next 要用）
Get-Content $EnvFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"'), 'Process')
  }
}

# ③ 依赖 / 建库 / 构建
if (-not (Test-Path (Join-Path $Root 'node_modules'))) { Say '→ 安装依赖（首次较慢）…'; npm ci }
Say '→ 生成 Prisma 客户端并建库…'
npx prisma generate | Out-Null
npx prisma db push --skip-generate | Out-Null
Say '→ 灌入系统数据（敏感词库、算法规则等）…'
npx tsx prisma/seed.ts | Out-Null
if (-not (Test-Path (Join-Path $Root '.next'))) { Say '→ 构建前端（首次较慢，约几分钟）…'; npm run build }

# ④ 启动器 + 开机自启（计划任务）
$StartBat = Join-Path $Root 'deploy\appliance\start.bat'
@"
@echo off
cd /d "$Root"
for /f "usebackq tokens=1,* delims==" %%a in ("$EnvFile") do (
  echo %%a| findstr /b "#" >nul || set "%%a=%%b"
)
npx next start -p $Port
"@ | Set-Content -Path $StartBat -Encoding ASCII

schtasks /Delete /TN 'Beacon' /F 2>$null | Out-Null
schtasks /Create /TN 'Beacon' /TR "`"$StartBat`"" /SC ONLOGON /RL HIGHEST /F | Out-Null
Say '✅ 已注册开机自启（计划任务：Beacon）'

# 第二个常驻服务：飞书长连接 connector。
# 整机在 NAT 后面没有公网地址，飞书 webhook 打不进来；长连接由本机主动出站，
# 不需要公网 IP / 域名 / 证书 / 备案。没配飞书应用时它打印原因后退出，配好重启即可。
$ConnBat = Join-Path $Root 'deploy\appliance\connector.bat'
@"
@echo off
cd /d "$Root"
for /f "usebackq tokens=1,* delims==" %%a in ("$EnvFile") do (
  echo %%a| findstr /b "#" >nul || set "%%a=%%b"
)
npx tsx connector.ts
"@ | Set-Content -Path $ConnBat -Encoding ASCII

schtasks /Delete /TN 'BeaconConnector' /F 2>$null | Out-Null
schtasks /Create /TN 'BeaconConnector' /TR "`"$ConnBat`"" /SC ONLOGON /RL HIGHEST /F | Out-Null
Say '✅ 已注册飞书长连接服务（计划任务：BeaconConnector）'

$Desktop = [Environment]::GetFolderPath('Desktop')
@"
@echo off
start "" "http://localhost:$Port"
"@ | Set-Content -Path (Join-Path $Desktop '打开烽火台.bat') -Encoding ASCII

# ⑤ 说明书
@"
烽火台 · 整机版
--------------------------------
访问地址：http://localhost:$Port
装机口令：$SetupToken

第一次打开会进入「初始化」页面，四步：
  1. 输入上面的装机口令
  2. 填团队名称和管理员称呼
  3. 选大模型厂商、填你自己的 API Key
  4. 填飞书/钉钉/企业微信应用的 AppID 与 Secret（可跳过，之后在设置里补）

装完之后：
  · 同事在群里 @机器人 就能下令
  · 每个人的 Chrome 装上「烽火台采集助手」，服务器地址填 http://localhost:$Port

[!] 备份：整台机器的数据在这两个文件里，一起复制即可
     $Root\prisma\appliance.db   （全部业务数据）
     $Root\.env.appliance        （主密钥，缺了它数据库里的 Key 解不开）

重启：schtasks /End /TN Beacon  然后  schtasks /Run /TN Beacon
"@ | Set-Content -Path (Join-Path $Desktop '烽火台-安装说明.txt') -Encoding UTF8
Say '✅ 已写出《烽火台-安装说明.txt》到桌面'

# ⑥ 体检
Say '→ 上线体检…'
try { npx tsx scripts/preflight.ts } catch { Warn '体检有 FAIL，请按上面提示处理后再交付。' }

# ⑦ 打开
Say ''
Say "安装完成。装机口令：$SetupToken"
Start-Process (Join-Path $Root 'deploy\appliance\start.bat')
Start-Sleep -Seconds 6
Start-Process "http://localhost:$Port/setup"
