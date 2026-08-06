#!/usr/bin/env bash
# 零中断部署切换（2026-07-23 加）。替代原来的 `docker compose up -d --build web worker`。
#
# 为什么需要它：原来的做法会把 web 容器停掉再起，宿主 nginx 死盯 127.0.0.1:8100，
# 这中间几秒钟所有请求都是 502。用户端表现之一就是 `Loading chunk XXXX failed`
# ——旧页面正好在这个窗口里去取分片。
#
# 怎么做到零中断（配合宝塔 nginx 的 0.beacon-upstream.conf）：
#   upstream 里 8100 是主、8101 标 backup。稳态只有 8100 在跑。
#   部署时把新版本先起在 8101，等它健康了再重建 8100 —— 8100 断开的那几秒，
#   nginx 连接被拒后自动改投 8101。连接未建立 = 请求尚未发出，
#   所以连 POST(Server Action) 都能被安全重试，不只是 GET。
#
# 附带的大好处：**构建出问题的版本永远到不了线上**。
#   新实例健康检查不通过 → 直接中止，8100 上的旧版本一根汗毛都没动过。
#   原来的做法是「先把旧的停了再说」，坏版本会直接把站点带下线。
#
# 用法（服务器工程根目录）：bash scripts/deploy-swap.sh
# 前置：scripts/deploy-gate.sh 必须已放行。
set -u

PORT_A="${BEACON_WEB_PORT:-8100}"        # 主实例（web），nginx upstream 的主上游
export BEACON_WEB_PORT_B="${BEACON_WEB_PORT_B:-8101}"   # 临时实例（web_b），nginx 的 backup 上游
PORT_B="$BEACON_WEB_PORT_B"
READY_TIMEOUT="${BEACON_READY_TIMEOUT:-90}"

say()  { printf '%s\n' "$*"; }
die()  { printf '⛔ 部署中止：%s\n' "$*"; exit 1; }

cd "$(dirname "$0")/.." || die "进不了工程根目录"

# 等某个端口上的实例变健康。/api/health 只在 DB 连通时回 200，是真就绪而非「端口开了」。
wait_ready() {
  local port="$1" name="$2" waited=0
  while [ "$waited" -lt "$READY_TIMEOUT" ]; do
    if curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:${port}/api/health"; then
      say "✅ ${name}(:${port}) 已就绪（等待 ${waited}s）"
      return 0
    fi
    sleep 2; waited=$((waited + 2))
  done
  return 1
}

# 无论成功失败都要把临时实例收干净，否则 8101 会一直挂着占内存、
# 且下次部署 `up -d web_b` 会复用这个旧容器造成版本错乱。
cleanup_b() {
  docker compose --profile bluegreen rm -sf web_b >/dev/null 2>&1 || true
}

say "―― 1/5 构建新镜像（旧版本照常对外服务，此步骤零影响）"
docker compose build web worker || die "镜像构建失败，线上仍是旧版本，未受任何影响。"

say "―― 2/5 用新镜像拉起临时实例 web_b(:${PORT_B})"
cleanup_b   # 防上次部署中断留下的残骸
docker compose --profile bluegreen up -d web_b || { cleanup_b; die "web_b 启动失败，线上未受影响。"; }

say "―― 3/5 健康检查临时实例（不通过就中止，绝不动线上）"
if ! wait_ready "$PORT_B" "web_b"; then
  say "新版本 ${READY_TIMEOUT}s 内没能就绪，最后 20 行日志："
  docker compose --profile bluegreen logs web_b --tail 20 2>&1 | tail -20
  cleanup_b
  die "新版本起不来。**线上仍是旧版本，用户无感知**。修好再来。"
fi

say "―― 4/5 重建主实例 web(:${PORT_A})，此刻流量由 nginx 自动转向 web_b"
if ! docker compose up -d --no-deps web; then
  cleanup_b
  die "主实例重建失败。检查 docker compose logs web。"
fi
if ! wait_ready "$PORT_A" "web"; then
  say "主实例没能就绪，最后 20 行日志："
  docker compose logs web --tail 20 2>&1 | tail -20
  say "⚠️ 临时实例 web_b 保持运行，nginx 正靠它兜底，站点仍可访问。"
  say "⚠️ 修复 web 后手动收尾：docker compose --profile bluegreen rm -sf web_b"
  die "主实例不健康，已保留兜底实例，未造成停服。"
fi

say "―― 5/5 撤下临时实例，重启 worker"
cleanup_b
docker compose up -d --no-deps worker || say "⚠️ worker 重启失败（不影响网站，单独查 docker compose logs worker）"

say ""
say "✅ 零中断部署完成：稳态回到「只有 web(:${PORT_A}) 在跑」"
docker compose ps --format 'table {{.Name}}\t{{.Status}}'
