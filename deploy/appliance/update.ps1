# 烽火台整机版 · 升级到新版本（Windows）
#
# 用法：把新版本的代码解压到同一个目录，然后在项目根目录跑
#     powershell -ExecutionPolicy Bypass -File deploy\appliance\update.ps1
#
# 与 update.sh 一一对应。分工同样是：
#   install.ps1 —— 第一次装（生成 .env、建库、灌种子、注册开机自启、开装机向导）
#   update.ps1  —— 已经装过了，只做「让新代码跑起来」，**绝不碰 .env、绝不重灌种子**
#
# 顺序不能换：备份 → 停服务 → 装依赖 → 迁库 → 构建 → 起服务。
# 迁库必须在构建之前，否则就是「代码新、库旧」的整站 500。

$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host "▸ $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$EnvFile = Join-Path $Root '.env.appliance'
Set-Location $Root

if (-not (Test-Path $EnvFile)) { Die "找不到 .env.appliance —— 这台机器还没装过。第一次装请跑 deploy\appliance\install.ps1" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die '找不到 node。请先安装 Node 20+' }

# 读 .env（只取 KEY=VALUE 行；值里含 = 的按第一个 = 切）
Get-Content $EnvFile | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
  }
}
$Port = if ($env:BEACON_PORT) { $env:BEACON_PORT } else { '3070' }

# ── 0. 备份数据库 ────────────────────────────────────────────────────────
# 单文件 SQLite，备份就是复制。**升级前必做**：db push 遇到「删列/类型变窄」
# 这类变更会丢数据，而那种变更从 schema 上看常常并不显眼。
$DbFile = Join-Path $Root 'prisma\appliance.db'
if (Test-Path $DbFile) {
  $Backup = Join-Path $Root ("prisma\appliance.db.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Copy-Item $DbFile $Backup
  Say "✅ 已备份数据库 → $(Split-Path $Backup -Leaf)"
  # 只留最近 5 份
  Get-ChildItem (Join-Path $Root 'prisma') -Filter 'appliance.db.bak-*' |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 5 | Remove-Item -Force
} else {
  Say '（还没有数据库文件，跳过备份）'
}

# ── 1. 停服务 ────────────────────────────────────────────────────────────
Say '停止服务…'
schtasks /End /TN 'Beacon' 2>$null | Out-Null
schtasks /End /TN 'BeaconConnector' 2>$null | Out-Null
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($Root) } |
  Stop-Process -Force -ErrorAction SilentlyContinue

# ── 2. 依赖 ──────────────────────────────────────────────────────────────
Say '安装依赖（npm ci）…'
npm ci --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Die 'npm ci 失败' }

# ── 3. 迁移数据库 ────────────────────────────────────────────────────────
# 不加 --accept-data-loss：真遇到会丢数据的变更时，宁可停下来让人看一眼
Say '同步数据库结构…'
npx prisma generate | Out-Null
npx prisma db push --skip-generate
if ($LASTEXITCODE -ne 0) { Die '数据库结构同步失败。库已备份在 prisma\ 下，可回退。' }

# ── 4. 构建 ──────────────────────────────────────────────────────────────
Say '构建（首次或大改动时要几分钟）…'
npm run build
if ($LASTEXITCODE -ne 0) { Die '构建失败——旧版本的服务已经停了，修好后重跑本脚本' }

# ── 5. 起服务 ────────────────────────────────────────────────────────────
Say '启动服务…'
schtasks /Run /TN 'Beacon' | Out-Null
schtasks /Run /TN 'BeaconConnector' 2>$null | Out-Null

# ── 6. 验一下真的起来了 ──────────────────────────────────────────────────
Say '等服务就绪…'
$Ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 -UseBasicParsing | Out-Null
    $Ok = $true; break
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $Ok) { Die "服务没起来。看日志：$Root\appliance.log" }

Say "✅ 升级完成：http://127.0.0.1:$Port"
Say '   数据库备份留在 prisma\appliance.db.bak-*（只保留最近 5 份）'
