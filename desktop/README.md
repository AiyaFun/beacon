# 烽火台桌面壳（Tauri 2）

给**整机版**配的原生桌面外壳：一个真正的 Mac/Windows 应用——窗口、托盘、开机自启。
界面本体就是本机 `http://localhost:3070` 的完整 Web 界面，壳只负责「像个桌面应用」。

## 边界（为什么壳不管服务）

服务的启动/守护由整机版安装器注册给操作系统（Mac `launchctl`、Windows 计划任务），
壳再管一遍就是双头管理互相打架。壳只做四件事：

1. **窗口（双模式，2026-08-27）**：启动先探 `localhost:3070/api/health`——
   通了直接进本机（整机版用户零改变）；探不到就让用户选：**连云端账号**（默认 beacon.iyunci.cn）／
   **连本机整机版**（给安装指引）／**填自建地址**。选过一次记在 localStorage，之后直接进。
   改这段之前先读 `ui/index.html` 的注释：此前壳写死 localhost，SaaS 用户装了永远停在「服务没在跑」。
2. **托盘**：常驻菜单栏/任务栏，「打开烽火台 / 退出」。
3. **关窗＝收进托盘**：服务在后台，窗口只是视图；真正退出走托盘菜单。
4. **开机自启**（tauri-plugin-autostart，装好即注册）。

改过服务端口（`BEACON_PORT`）的话，把 `src-tauri/tauri.conf.json` 里窗口 `url`
设为 `index.html?port=你的端口` 再构建即可（引导页认 `?port=` 参数）。
私有化客户要把「云端」那一项指到自己的域名：同样在窗口 `url` 上加 `?cloud=https://beacon.mycorp.com`。

## 打包给用户下载

各平台**各自构建**后，回项目根目录跑一次收集脚本，网页端「桌面客户端」页就有下载了：

```bash
npm run pack:desktop      # 收集 desktop/src-tauri/target/release/bundle/ 下的产物
```

它是**合并收集**：这次没重新构建的平台原样保留在清单里（跨机器接力打包的唯一姿势）——
在 Mac 上打完 .dmg、把 Windows 机器上打的 .msi 拷进 bundle 目录再跑一次，两个包就都在清单里了。
⚠️ 版本号一变，上一版遗留的其它平台条目会被丢弃（免得把 1.2.0 的标题挂在 1.1.0 的文件上）。

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

## Windows 构建

**推荐走 CI**：`.github/workflows/desktop-build.yml`（Actions 页面手动触发 workflow_dispatch），
`windows-latest` 原生构建 `.exe` + `.msi`，`macos-latest` 同时出 `.dmg`；跑完下载 artifact，
放进 `src-tauri/target/**/release/bundle/{dmg,msi,nsis}/` 再在项目根目录跑 `npm run pack:desktop`。

### 从 Mac 交叉编译？exe 能，安装包不能（2026-08-27 实测）

别再重复试这条路，结论已经验过：

| | 结果 |
|---|---|
| Windows **exe 主程序** | ✅ 能出。`rustup target add x86_64-pc-windows-msvc` + `cargo install cargo-xwin` + `brew install llvm`（要 `llvm-rc`，缺了 `tauri-winres` 会 panic `NotAttempted("llvm-rc")`），命令 `npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis`，产物是真 PE32+ x86-64 |
| **NSIS 安装包** | ❌ Homebrew 的 makensis 3.12 在 Apple 芯片上是坏的——4 行空脚本就 `std::bad_alloc`（NSISDIR/stub 都正常，与本项目无关）；`brew reinstall --build-from-source makensis` 被「Xcode 太旧」挡住 |
| **MSI** | ❌ WiX 只能 Windows / wine |

而且交叉产物**无法在 Mac 上真机验证**，Tauri 自己也打 `Cross-platform compilation is experimental` 警告。

### 手动在 Windows 机器上构建

在 Win10/11 上：

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
