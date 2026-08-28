#!/usr/bin/env bash
# macOS 客户端：构建 → 签名 → 公证 → 装订 → 验证。一条命令跑完。
#
# 【为什么要有这个脚本】2026-08-28 第一次签名公证是手工敲的，没留下任何记录；
# 第二次要发版时只能靠翻聊天记录复原。签名链一步错（签成 Apple Development、
# 忘了 hardened runtime、公证完没 staple）用户那边都是「打不开」，而本机看不出来——
# 本机有证书，怎么试都是好的。所以把每一步和**验证**一起钉进脚本。
#
# 前置（换电脑后要重做一次）：
#   1. Developer ID Application 证书在钥匙串里（见 deploy/private/signing/还原说明.md）
#   2. 公证凭据存过一次：
#      xcrun notarytool store-credentials beacon-notary --key AuthKey_XXXX.p8 \
#        --key-id <KEY_ID> --issuer <ISSUER_ID>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

IDENTITY="Developer ID Application: Xiamen Yunci Digital Technology Co.,Ltd. (8639VLTT9H)"
PROFILE="beacon-notary"

say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 前置检查：缺什么当场说清楚，别等构建完十分钟才发现签不了
security find-identity -v -p codesigning | grep -q "Developer ID Application" \
  || die "钥匙串里没有 Developer ID Application 证书。见 deploy/private/signing/还原说明.md"
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
  || die "没存过公证凭据。先跑 xcrun notarytool store-credentials $PROFILE …"

VERSION=$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
say "构建 v$VERSION（签名主体：${IDENTITY%% (*}）"

# Tauri 认这个环境变量来签名；不设就是无签名包，用户双击会被 Gatekeeper 拦
export APPLE_SIGNING_IDENTITY="$IDENTITY"
npm run build

DMG=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg | head -1)
[ -n "$DMG" ] || die "没找到 .dmg（bundle_dmg.sh 在本机常因 Finder 自动化权限失败，见 README）"
say "产物：$DMG"

say "提交公证（苹果服务器排队，通常 1-3 分钟）"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait

say "装订公证票据（不做的话用户断网时仍会被拦）"
xcrun stapler staple "$DMG"

# ── 验证：这三条才是「用户那边能不能打开」的判据，缺一不可
say "验证"
xcrun stapler validate "$DMG" || die "装订校验没过"
APP="src-tauri/target/release/bundle/macos/烽火台.app"
codesign --verify --deep --strict "$APP" || die "签名校验没过"
SPCTL=$(spctl -a -vvv -t install "$APP" 2>&1 || true)
echo "$SPCTL" | grep -q "source=Notarized Developer ID" \
  || die "Gatekeeper 不认这是已公证的 Developer ID 包：$SPCTL"
say "✅ v$VERSION 已签名并公证：$DMG"
