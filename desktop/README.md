# 烽火台桌面壳（Tauri 2）

给**整机版**配的原生桌面外壳：一个真正的 Mac/Windows 应用——窗口、托盘、开机自启。
界面本体就是本机 `http://localhost:3070` 的完整 Web 界面，壳只负责「像个桌面应用」。

## 边界（为什么壳不管服务）

服务的启动/守护由整机版安装器注册给操作系统（Mac `launchctl`、Windows 计划任务），
壳再管一遍就是双头管理互相打架。壳只做四件事：

1. **窗口**：启动即探测 `localhost:3070/api/health`，通了就进界面；没通显示指引（提示先跑 `deploy/appliance/install.sh`）。
2. **托盘**：常驻菜单栏/任务栏，「打开烽火台 / 退出」。
3. **关窗＝收进托盘**：服务在后台，窗口只是视图；真正退出走托盘菜单。
4. **开机自启**（tauri-plugin-autostart，装好即注册）。

改过服务端口（`BEACON_PORT`）的话，把 `src-tauri/tauri.conf.json` 里窗口 `url`
设为 `index.html?port=你的端口` 再构建即可（引导页认 `?port=` 参数）。

## Mac 构建

前置：Rust（`rustup` 装 minimal 档即可）+ Node。

```bash
cd desktop
npm install
npm run build          # 产物在 src-tauri/target/release/bundle/{macos,dmg}/
```

- 图标改动后重新生成：`npx tauri icon ../public/logo.png -o src-tauri/icons`
- **DMG 一步若报 `bundle_dmg.sh` 失败**：那是 Finder 自动化权限被拒（美化步骤），.app 本体已打好。手动补 DMG：

```bash
cd src-tauri/target/release/bundle
mkdir -p /tmp/beacon-dmg && cp -R macos/烽火台.app /tmp/beacon-dmg/ && ln -sf /Applications /tmp/beacon-dmg/Applications
hdiutil create -volname 烽火台 -srcfolder /tmp/beacon-dmg -ov -format UDZO dmg/烽火台_aarch64.dmg
```

- 未签名应用首次打开：右键 → 打开（或系统设置 → 隐私与安全性 → 仍要打开）。

## Windows 构建（必须在 Windows 机器上跑）

Tauri 不支持从 Mac 交叉编译 Windows 包。在 Win10/11 上：

1. 装 [Rust](https://rustup.rs)（会提示装 Visual Studio Build Tools 的 C++ 工作负载，照装）。
2. WebView2 运行时（Win11 自带；Win10 缺就装 Evergreen 版）。
3. 同一个仓库目录里：

```powershell
cd desktop
npm install
npm run build          # 产物 .msi / .exe 在 src-tauri\target\release\bundle\{msi,nsis}\
```

## 与整机版的关系

| 层 | 谁负责 |
|---|---|
| 服务安装 / 升级 / 守护 | `deploy/appliance/install.sh`·`update.sh`（Win 为 .ps1） |
| 桌面窗口 / 托盘 / 自启 | 本目录的壳 |

壳装不装都不影响服务——不装壳，浏览器开 `localhost:3070` 一样用。
