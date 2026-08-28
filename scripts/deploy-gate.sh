#!/usr/bin/env bash
# 部署闸门：rsync 之后、docker compose up --build 之前必跑，放行（退出 0）才准构建。
#
# 背景（2026-07-23 事故）：第八轮代码 rsync+build 上了生产，但两轮积压的 schema 迁移
# 和内置技能模板同步都没跑 → 已登录首页 P2022（TopicIdea.queue 不存在）崩了约一刻钟。
# 根因不是不知道流程，而是「迁移」在部署里是条件步骤，靠人记得。本脚本把它变成无条件闸门。
#
# 背景（2026-07-23 事故之二）：根盘 100% 满，宿主 nginx 传不完静态响应体，浏览器随机报
# "Loading chunk XXXX failed"；worker 同时因 mkdir /tmp 失败崩溃重启。元凶是历次 --build
# 残留的 419 个镜像 + 656 条构建缓存（共 72G），从无清理。构建本身还要吃几 G，
# 满盘时再 --build 只会雪上加霜 —— 所以磁盘水位成为第一道闸门，先于任何构建。
#
# 检查三件事（全部只读：不写库、不改仓库文件，跑多少遍都安全）：
#   0. 磁盘水位：余量不足时先自动清 docker 垃圾，清完仍不足才拦截（详见闸门 1/4）。
#   1. schema 漂移：生产库 vs 即将构建的 prisma/schema.postgres.prisma（migrate diff）。
#      白名单 = 3 条手工 pgvector 资产的 DROP（它们不在 Prisma schema 里，diff 永远想删，永远不执行）。
#      除白名单外还有任何语句 → 拦下，先按增量流程迁移。
#   2. 系统数据：sync-system-data.ts dry-run（敏感词/算法规则/内置技能模板）。
#   3. 分发产物：整机版增量更新包在不在、版本对不对得上（漏跑 deploy-prepare.sh 的兜底）。
#      有待同步项 → 拦下，核对后 --apply。旧容器跑不动 dry-run（旧 client 不认新字段）→
#      放行构建但要求构建后立刻重跑本闸门补查。
#
# 用法（在服务器工程根目录）：bash scripts/deploy-gate.sh
# 测试后门：BEACON_GATE_SCHEMA=<path> 用别的 schema 文件跑闸门 1（验证拦截路径用）。

set -u

say() { printf '%s\n' "$*"; }
die() { printf '⛔ 闸门拦截：%s\n' "$*"; exit 1; }

cd "$(dirname "$0")/.." || { echo "进不了工程根目录"; exit 1; }

SCHEMA_SRC="${BEACON_GATE_SCHEMA:-prisma/schema.postgres.prisma}"
[ -f "$SCHEMA_SRC" ] || die "schema 文件不存在：$SCHEMA_SRC"


# ── 闸门 1/4：磁盘水位 ───────────────────────────────────────────
# 放在最前面：盘满时 docker build 会以各种离奇姿势失败（写不了层、mkdir /tmp 失败），
# 且构建产物本身还要占几 G。先清垃圾，清完仍不够才拦。
NEED_GB="${BEACON_GATE_DISK_GB:-8}"
avail_gb() { df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9'; }
used_pct() { df --output=pcent  / 2>/dev/null | tail -1 | tr -dc '0-9'; }

say "―― 闸门 1/4：磁盘水位（构建需至少 ${NEED_GB}G 余量）"
say "当前：已用 $(used_pct)%，可用 $(avail_gb)G"

if [ "$(avail_gb)" -lt "$NEED_GB" ] || [ "$(used_pct)" -ge 85 ]; then
  say "余量不足或水位偏高，先自动清理 docker 垃圾（只清悬空镜像与构建缓存，不动有 tag 的镜像）"
  # 服务器上装了守卫脚本就用它（口径一致）；没装则内联等效清理，闸门不依赖外部文件存在。
  if [ -x /usr/local/bin/docker-disk-guard.sh ]; then
    /usr/local/bin/docker-disk-guard.sh pressure >/dev/null 2>&1
  else
    docker builder prune -af >/dev/null 2>&1
    docker image   prune -f  >/dev/null 2>&1
  fi
  say "清理后：已用 $(used_pct)%，可用 $(avail_gb)G"
fi

if [ "$(avail_gb)" -lt "$NEED_GB" ]; then
  say "docker 垃圾已清空但余量仍不足，说明占盘的不是构建残留。排查方向："
  say "  du -sh /var/lib/docker/* | sort -rh | head    # 卷 / 容器日志"
  say "  du -sh /var/log/* /www/* 2>/dev/null | sort -rh | head"
  die "根盘可用 $(avail_gb)G < 需要 ${NEED_GB}G，不放行构建（满盘构建必炸，且会拖垮线上静态资源）。"
fi
say "✅ 磁盘余量充足（可用 $(avail_gb)G）"

# ── 闸门 2/4：分发产物（整机版一键更新的弹药）─────────────────────────────
#
# 【拦的是什么】整机版客户点「一键更新」读的是 public/downloads/appliance.manifest.json。
# 忘了跑 scripts/deploy-prepare.sh 就部署，站上挂的是上一次的包——
# 版本号没变时客户查到「已经是最新版」，新修的东西永远到不了他机器上。
# 这类错不报错、不变红，只会安静地让升级通道失效，所以要有一道机器判据。
#
# 【为什么放在这么前面】它是纯本地文件检查,最便宜、且不依赖数据库或容器——
# 快速失败比让人等完 schema diff 再被拦下友好得多。
#
# 【为什么只查「存在 + 版本对得上」而不查内容是否最新】要判「内容是否为当前代码的快照」
# 得在服务器上重打一次包再比 sha256——那是几秒的 tar 加上一份 13MB 的临时文件，
# 而且服务器上的树与本地并不完全一致（rsync 有 exclude），比出来的差异是噪音不是信号。
# 「无条件重打」的保证放在本地那一步；这里守的是**漏跑**与**版本对不上**这两种硬错。
say "―― 闸门 2/4：分发产物（整机版一键更新的弹药）"
MF="public/downloads/appliance.manifest.json"
if [ ! -f "$MF" ]; then
  die "缺 $MF —— 部署前请在**本地**跑 bash scripts/deploy-prepare.sh 再 rsync"
fi
PKG_VER=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)
MF_VER=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MF" | head -1)
MF_FILE=$(sed -n 's|.*"file"[[:space:]]*:[[:space:]]*"/downloads/\([^"]*\)".*|\1|p' "$MF" | head -1)
if [ "$PKG_VER" != "$MF_VER" ]; then
  die "更新包版本对不上：package.json=$PKG_VER 而清单=$MF_VER。本地跑 bash scripts/deploy-prepare.sh 重打后再来"
fi
if [ ! -f "public/downloads/$MF_FILE" ]; then
  die "清单指向 $MF_FILE，但文件不在（rsync 漏传？）。本地跑 deploy-prepare.sh 后重新 rsync"
fi
say "✅ 更新包在位：$MF_FILE（v$MF_VER）"

# 【页面文件必须真的传上来了】2026-08-28 事故：部署技能的 rsync 写了 --exclude desktop，
# 而 rsync **不带前导斜杠的模式匹配任意层级**——本意是排掉根目录的 Tauri 子项目，
# 结果把 app/(app)/desktop/（下载页）也一起排除了。线上那个页面从来没存在过，
# 用户点侧栏下载卡直接 404，而 health/状态码全绿，谁也看不出来。
# 判据用 lib/nav.ts 的导航表：里面列了的页面，源码就必须在这台机器上。
MISSING=""
for href in $(grep -oE "href: '/[a-z-]+'" lib/nav.ts 2>/dev/null | sed "s/href: '//;s/'//" | sort -u); do
  [ "$href" = "/" ] && continue
  # 页面可能在 app/(app)/<name>/page.tsx 或 app/<name>/page.tsx
  if ! find app -type f -name page.tsx -path "*${href}/page.tsx" 2>/dev/null | grep -q .; then
    MISSING="$MISSING $href"
  fi
done
if [ -n "$MISSING" ]; then
  say "⛔ 导航里列了这些页面，但源码没传上来：$MISSING"
  say "   多半是 rsync 的 exclude 模式没锚定（如 --exclude desktop 会连 app/(app)/desktop 一起排掉，"
  say "   要写成 --exclude /desktop）。修好 exclude 后重新 rsync。"
  die "页面缺失会让用户点进去 404，而状态码检查全绿——已拦下本次构建。"
fi
say "✅ 导航里的页面源码齐全"

# 【签名凭据绝不能出现在这台机器上】生产是公网 SaaS 部署，既不打包也不签名，
# deploy/private/signing/ 里那份 macOS 签名私钥对它毫无用处，放在这儿纯属多一个暴露面。
# 2026-08-28 真同步上来过一次（部署技能的 rsync 当时漏了 --exclude deploy/private）。
# 文档改了还是会被忘，所以在这儿加一道机器判据：发现就拦，并告诉运维怎么收拾。
if [ -e "deploy/private/signing" ]; then
  say "⛔ 生产上出现了签名凭据目录 deploy/private/signing/"
  say "   立即处理：rm -rf /var/www/beacon/deploy/private/signing"
  say "   根因：rsync 少了 --exclude deploy/private（见部署技能第 2 步的 exclude 表）"
  die "签名私钥不该出现在公网机器上，已拦下本次构建。"
fi

# 下面两道要进容器跑 prisma（宿主机没有 node_modules）。容器检查放在这里而不是更早，
# 是为了让纯本地的闸门 1/2 先跑完——旧镜像没起来时也该先把「产物漏打」这类错报出来。
WEB_ID=$(docker compose ps --status running -q web 2>/dev/null)
[ -n "$WEB_ID" ] || die "web 容器未运行，没法对生产库做检查。先 docker compose up -d web 起旧镜像再跑闸门。"

say "―― 闸门 3/4：schema 漂移（生产库 vs ${SCHEMA_SRC}）"
docker cp "$SCHEMA_SRC" "$WEB_ID":/tmp/schema.gate.prisma >/dev/null || die "docker cp schema 进容器失败"

DIFF_ERR=$(mktemp)
DIFF=$(docker compose exec -T web sh -c 'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel /tmp/schema.gate.prisma --script' 2>"$DIFF_ERR")
RC=$?
if [ "$RC" -ne 0 ]; then
  say "migrate diff 执行失败（退出码 $RC）："
  cat "$DIFF_ERR"; rm -f "$DIFF_ERR"
  die "无法完成漂移检查，不放行。"
fi
rm -f "$DIFF_ERR"

# 白名单外还剩什么（压空白、去注释行和空行后精确比对）
LEFT=$(printf '%s\n' "$DIFF" \
  | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' \
  | grep -v '^--' | grep -v '^$' \
  | grep -vxF 'DROP INDEX "memory_embedding_hnsw";' \
  | grep -vxF 'ALTER TABLE "MemoryEntry" DROP COLUMN "embedding_vec";' \
  | grep -vxF 'ALTER TABLE "TopicCluster" DROP COLUMN "centroid_vec";')

if [ -n "$LEFT" ]; then
  say "生产库与目标 schema 有漂移，完整 diff："
  say "----------------------------------------"
  printf '%s\n' "$DIFF"
  say "----------------------------------------"
  say "处理流程（交接文档四.2 / beacon-deploy skill 3.5）："
  say "  1) 从上面 diff 里剔除 3 条 pgvector DROP（那是手工资产，永远不执行）"
  say "  2) 其余包一层 BEGIN; … COMMIT; 存成 SQL 文件"
  say "  3) docker compose exec -T web sh -c 'npx prisma db execute --url \"\$DATABASE_URL\" --stdin' < 该文件"
  say "  4) 如 diff 里有 CREATE TABLE：再幂等重跑 prisma/postgres/02-rls.sql 补新表策略"
  die "迁移完成后重跑本闸门，放行了才准构建。绝不整体 db push。"
fi
say "✅ schema 已同步（diff 为空或仅剩 3 条 pgvector 白名单 DROP）"

say "―― 闸门 4/4：系统数据同步检查（dry-run，只读）"
docker exec -u root "$WEB_ID" mkdir -p /app/scripts || die "容器内建 /app/scripts 失败"
docker cp scripts/sync-system-data.ts "$WEB_ID":/app/scripts/ >/dev/null || die "docker cp 同步脚本失败"
docker cp prisma/system-data.ts "$WEB_ID":/app/prisma/system-data.ts >/dev/null || die "docker cp system-data 失败"

SYNC_OUT=$(docker compose exec -T web npx tsx scripts/sync-system-data.ts 2>&1)
SYNC_RC=$?
if [ "$SYNC_RC" -ne 0 ]; then
  say "⚠️ dry-run 在旧容器里跑不起来（常见原因：旧 prisma client 不认识新字段）。末尾输出："
  printf '%s\n' "$SYNC_OUT" | tail -12
  say "⚠️ 此项不拦构建——但构建完成后必须立刻重跑本闸门补查（新容器里就能跑了）。"
else
  SECTIONS=$(printf '%s\n' "$SYNC_OUT" | grep -c '新增 ')
  PENDING=$(printf '%s\n' "$SYNC_OUT" | grep -Eo '新增 [0-9]+ / 更新 [0-9]+' | grep -Eo '[0-9]+' | awk '{s+=$1} END{print s+0}')
  if [ "$SECTIONS" -lt 3 ]; then
    say "⚠️ dry-run 输出不是预期格式（新增行少于 3 段），人工核对："
    printf '%s\n' "$SYNC_OUT"
    say "⚠️ 按告警处理不自动拦截，但核对完再构建。"
  elif [ "$PENDING" -gt 0 ]; then
    say "系统数据有待同步项（dry-run 输出）："
    printf '%s\n' "$SYNC_OUT"
    say "核对以上只涉全局行（tenantId=null）后执行："
    say "  docker compose exec -T web npx tsx scripts/sync-system-data.ts --apply"
    die "apply 完成后重跑本闸门，放行了才准构建。"
  else
    say "✅ 系统数据已是最新（新增 0 / 更新 0）"
  fi
fi

say "✅✅ 闸门放行：可以 docker compose up -d --build web worker"
exit 0
