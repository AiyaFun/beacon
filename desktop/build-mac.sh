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
# 一键更新工件（.app.tar.gz + .sig）的签名钥匙：真钥匙只住这台打包机，绝不进 CI/rsync。
# 【为什么在 ~ 不在仓库树里】树里的签名目录只收**加密的**凭据（.p12 带口令 / .p8.enc），
# 有守卫钉着（tests/downloads/desktop-and-update.test.ts）。minisign 钥匙是明文，
# 放树里等于把「打包机被翻 = 更新通道沦陷」写成必然。备份见 deploy/private/signing/还原说明.md。
UPDATER_KEY="$HOME/.beacon-signing/tauri-updater.key"
[ -f "$UPDATER_KEY" ] || die "更新签名钥匙不在（$UPDATER_KEY）——没有它出不了一键更新工件"
# ⚠️ 打包器只认 TAURI_SIGNING_PRIVATE_KEY（**内容**）；_PATH 变体是 signer 子命令的参数，
# 打包时传 _PATH 会静默当没配，最后报「A public key has been found, but no private key」
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
# 【刻意只打 app 束、dmg 全程 hdiutil】两个实测教训合成的取舍：
#   ① bundle_dmg.sh 在本机必挂（Finder 自动化权限，2026-08-28/31/09-01 三次实测）；
#   ② updater 工件（.app.tar.gz+.sig）在**所有束打完之后**才生成——dmg 束一挂，
#      它就被中断，表现为「createUpdaterArtifacts 配了却没产物」（2026-09-01 实测）。
# app 束是最后一个束时，tar.gz 稳定产出；dmg 用 hdiutil 打，不再给 bundle_dmg.sh 机会。
npx tauri build --bundles app

APP="src-tauri/target/release/bundle/macos/烽火台.app"
[ -d "$APP" ] || die ".app 都没构建出来——这是真失败，往上看编译错误"
ls src-tauri/target/release/bundle/macos/*.app.tar.gz >/dev/null 2>&1 \
  || die "没找到 .app.tar.gz——createUpdaterArtifacts 没生效？查 tauri.conf.json 的 bundle 段"
ls src-tauri/target/release/bundle/macos/*.app.tar.gz.sig >/dev/null 2>&1 \
  || die "没找到 .app.tar.gz.sig——TAURI_SIGNING_PRIVATE_KEY 没被吃到？"

say "hdiutil 打 dmg"
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
mkdir -p src-tauri/target/release/bundle/dmg
hdiutil create -volname "烽火台" -srcfolder "$STAGE" -ov -format UDZO \
  "src-tauri/target/release/bundle/dmg/烽火台_${VERSION}_aarch64.dmg" >/dev/null
rm -rf "$STAGE"

DMG=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg | head -1)
[ -n "$DMG" ] || die "hdiutil 没出 dmg"

# 【dmg 外壳也要签】hdiutil 出的镜像是**没签名**的（Tauri 自己的 bundle_dmg.sh 会顺手签，
# 改用 hdiutil 就把这步弄丢了）。里面的 .app 照样能跑，但对 dmg 本身
# `spctl -t install` 会报 source=no usable signature——发布前的验证信号从此读不出结论。
# 2026-09-01 v1.2.5 真踩：包没坏，但「这份包到底签没签」没法一句话回答了。
# 必须在公证**之前**签：签名会让已装订的票据失效。
say "签 dmg 外壳"
codesign --force --sign "$IDENTITY" --timestamp "$DMG" || die "dmg 签名失败"
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
  || die "Gatekeeper 不认 .app 是已公证的 Developer ID 包：$SPCTL"
# dmg 外壳单独再判一次：只验 .app 的话，「dmg 没签」这种事验证阶段完全看不出来
# （2026-09-01 就是这么漏过去的，最后是在生产下回来复检时才发现）。
SPCTL_DMG=$(spctl -a -vvv -t install "$DMG" 2>&1 || true)
echo "$SPCTL_DMG" | grep -q "source=Notarized Developer ID" \
  || die "dmg 外壳没签或没公证：$SPCTL_DMG"
say "✅ v$VERSION 已签名并公证：$DMG"
