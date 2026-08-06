#!/usr/bin/env bash
# 烽火台反代证书：自签（测试）/ 签发（Let's Encrypt）/ 续期。
# nginx 固定读 deploy/certs/{fullchain,privkey}.pem，本脚本负责把证书放到那儿。
#
# 用法（在仓库根目录跑）：
#   deploy/cert.sh self-signed [CN]        # 无域名 / 内网 / 先跑通链路。浏览器会红锁警告。
#   deploy/cert.sh issue <域名> <邮箱>      # Let's Encrypt 正式签发（前置条件见下）
#   deploy/cert.sh renew                   # 续期，建议上 cron
#
# ⚠️ issue 的前置条件（缺一不可）：
#   1. 域名 A 记录已解析到本机公网 IP；
#   2. 公网能访问本机 80 端口（安全组 / 防火墙 / 云厂商都要放行）；
#   3. **服务器在中国大陆 + 绑域名 → 域名必须已完成 ICP 备案**。
#      未备案时大陆机房的 80/443 会被运营商拦掉，http-01 校验必然失败 ——
#      这不是脚本的问题，备案下来之前先用 self-signed 或把服务放在境外/香港。
set -euo pipefail

cd "$(dirname "$0")/.."
CERT_DIR="deploy/certs"
mkdir -p "$CERT_DIR" deploy/acme-webroot

cmd="${1:-}"

case "$cmd" in
  self-signed)
    cn="${2:-localhost}"
    openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
      -keyout "$CERT_DIR/privkey.pem" \
      -out "$CERT_DIR/fullchain.pem" \
      -subj "/CN=$cn" >/dev/null 2>&1
    chmod 600 "$CERT_DIR/privkey.pem"
    echo "已生成自签证书（CN=$cn，365 天）→ $CERT_DIR/"
    echo "⚠️ 仅供测试：浏览器会告警。正式环境用 issue 换成 Let's Encrypt。"
    ;;

  issue)
    domain="${2:?用法: deploy/cert.sh issue <域名> <邮箱>}"
    email="${3:?用法: deploy/cert.sh issue <域名> <邮箱>}"
    # http-01 走 webroot：nginx 的 80 已经把 /.well-known/acme-challenge/ 指到这个目录，
    # 所以签发期间 nginx 必须是起着的（不要停 proxy）。
    docker compose run --rm certbot certonly \
      --webroot -w /var/www/certbot \
      -d "$domain" --email "$email" \
      --agree-tos --no-eff-email --non-interactive
    docker compose run --rm --entrypoint sh certbot -c "
      cp -L /etc/letsencrypt/live/$domain/fullchain.pem /certs-out/fullchain.pem &&
      cp -L /etc/letsencrypt/live/$domain/privkey.pem  /certs-out/privkey.pem"
    docker compose exec proxy nginx -s reload
    echo "已签发 $domain 并 reload 反代。"
    echo "记得把续期挂 cron：0 3 * * * cd $(pwd) && deploy/cert.sh renew >> /var/log/beacon-cert.log 2>&1"
    ;;

  renew)
    docker compose run --rm certbot renew --webroot -w /var/www/certbot
    # certbot 只更新 /etc/letsencrypt，得把新证书拷回 nginx 读的固定路径再 reload。
    docker compose run --rm --entrypoint sh certbot -c '
      d=$(ls -d /etc/letsencrypt/live/*/ 2>/dev/null | head -1) || exit 0
      [ -n "$d" ] && cp -L "$d/fullchain.pem" /certs-out/fullchain.pem && cp -L "$d/privkey.pem" /certs-out/privkey.pem'
    docker compose exec proxy nginx -s reload
    echo "续期检查完成。"
    ;;

  *)
    sed -n '2,20p' "$0"
    exit 1
    ;;
esac
