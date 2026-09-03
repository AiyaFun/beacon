// 烽火台桌面壳（Tauri 2，2026-08-26 用户拍板）。
//
// 【壳的边界】它不接管服务生命周期——整机版已把服务注册给系统（Mac launchctl /
// Win 计划任务），双头管理只会互相打架。壳只做四件事：
//   窗口（界面按双模式连本机或云端，见 ui/index.html）、托盘、开机自启、关窗最小化到托盘。
//
// 【本地缓存，2026-08-27】网页缓存、登录 Cookie、localStorage 全部落在**这台电脑上**，
// 关掉应用不丢，下次打开不用重新登录，静态资源也不必重下。
//   · Windows：由 tauri.conf.json 的 `dataDirectory: "webview"` 钉在 appDataDir/main/webview；
//   · macOS：WKWebView 不支持 dataDirectory，但它的默认存储本来就是持久且按应用隔离的。
//     **刻意不用 dataStoreIdentifier**——那个要 macOS 14+，而且一改就等于换了个存储位置，
//     已经装过的用户会集体掉登录态。默认行为已经满足「缓存在本地」，就别为了显式而显式。
// 托盘里给一个「打开本地数据目录」：缓存看得见、要清的时候自己能删，比藏起来诚实。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_opener::OpenerExt;


/// 找本机的 Chrome。**只找固定安装位置，不去 PATH 里碰运气**——
/// PATH 上叫 chrome 的东西可能是任何程序，而这里要启动的是一个带调试端口的浏览器。
fn find_chrome() -> Option<std::path::PathBuf> {
    let candidates: Vec<&str> = if cfg!(target_os = "macos") {
        vec![
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        ]
    } else {
        vec!["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    };
    candidates.into_iter().map(std::path::PathBuf::from).find(|p| p.exists())
}

/// 用**你自己的默认 profile** 带调试端口启动 Chrome。
///
/// 【为什么用默认 profile 而不是单开一个】独立 profile 是干净的，但代价是
/// **每个站点都要重新登一次**——而采集的价值恰恰在于「读你登录后才看得见的内容」。
/// 用默认 profile，你已有的登录态全都在，装完就能用。（用户 2026-08-29 定的口径。）
///
/// 【Chrome 的硬限制，绕不过去】同一个 user-data-dir 只跑一个进程：
/// 他日常那个 Chrome 已经开着的话，再带 --remote-debugging-port 启动**什么都不会发生**
/// （新进程把参数交给旧进程就退出了），而且**运行中的 Chrome 无法再打开调试端口**。
/// 所以必须先完全退出再启动。**我们不替他杀浏览器**——他可能开着几十个标签在干活，
/// 那是他自己的决定。这里只如实告诉他要做什么。
///
/// 【要说破的代价】调试端口开着时，**这台机器上任何本地程序都能驱动这个浏览器**。
/// Chrome 只把它绑在 127.0.0.1（不对外网开放），但本机范围内是敞开的。
/// 用完不采集时，正常关掉 Chrome 再普通启动即可。
fn chrome_running() -> bool {
    // 只做「有没有在跑」这一个判断，不去动它。判不出来时按「没在跑」处理——
    // 判错的代价只是多一句提示，而误杀用户的浏览器是不可接受的。
    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("/usr/bin/pgrep")
            .arg("-x").arg("Google Chrome")
            .output().map(|o| !o.stdout.is_empty()).unwrap_or(false);
    }
    #[cfg(target_os = "windows")]
    {
        return std::process::Command::new("tasklist")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("chrome.exe"))
            .unwrap_or(false);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return std::process::Command::new("pgrep")
            .arg("-x").arg("chrome")
            .output().map(|o| !o.stdout.is_empty()).unwrap_or(false);
    }
}

/// 调试端口通不通。
///
/// 【为什么必须先探这一下，而不是先看 Chrome 在不在跑】
/// 原来的顺序是「Chrome 在跑 → 报错让他退出」。但一个**已经照做过一次**的用户，
/// 他的 Chrome 正是带着调试端口开着的——却仍然被告知「请先完全退出 Chrome」。
/// 于是他要么白关一次浏览器（几十个标签），要么以为这功能坏了。
/// 端口通 = 事情已经成了，此时唯一正确的回答是「不用做任何事」。
fn debug_port_open() -> bool {
    // 只做一次极短的 TCP 连接，不发 HTTP 请求：我们要判断的只是「有没有人在听」。
    // 判不出来时按「不通」处理——多一句提示的代价，远小于让他以为配好了却采不到。
    std::net::TcpStream::connect_timeout(
        &"127.0.0.1:9222".parse().expect("固定字面量，解析不会失败"),
        std::time::Duration::from_millis(400),
    )
    .is_ok()
}

fn launch_collect_browser(_app: &tauri::AppHandle) -> Result<(String, bool), String> {
    // 【先探端口】三种状态要分清楚，给三种不同的话：
    //   端口通           → 已经好了，什么都别做
    //   端口不通 + 在跑  → 必须先完全退出（Chrome 的硬限制）
    //   端口不通 + 没跑  → 直接带端口起
    // 第二个返回值 = 这次是不是我们刚起的（false 表示本来就开着）。
    // 分开是为了不对一个什么都没做的用户说「已启动」——那会让他以为自己的浏览器被重启了。
    if debug_port_open() {
        return Ok(("http://127.0.0.1:9222".to_string(), false));
    }

    let chrome = find_chrome().ok_or_else(|| "没找到 Chrome。请先安装 Google Chrome。".to_string())?;

    if chrome_running() {
        return Err(
            "Chrome 正开着，但它没有打开调试端口。运行中的 Chrome 没法再打开（这是 Chrome 的限制）。\n\n             请先完全退出 Chrome（macOS 按 ⌘Q，不是关窗口），再点一次这里。\n             重开后它会恢复你原来的标签页，登录态也都还在。\n\n             想以后不用每次这样：托盘里的「生成采集浏览器快捷方式」会在桌面放一个启动器，\n             以后用它开 Chrome 就一直带着调试端口。"
                .to_string(),
        );
    }

    // 不传 --user-data-dir：就用他的默认 profile，登录态全在
    std::process::Command::new(&chrome)
        .arg("--remote-debugging-port=9222")
        .arg("--no-default-browser-check")
        .spawn()
        .map_err(|e| format!("启动不了 Chrome：{e}"))?;
    Ok(("http://127.0.0.1:9222".to_string(), true))
}

/// 在桌面放一个「带调试端口启动 Chrome」的启动器。
///
/// 【为什么这件事值得做】真正的摩擦不是「点一下托盘」，而是**每次都得先完全退出 Chrome**——
/// 因为他日常是从 Dock/开始菜单打开的，那样起来的 Chrome 没有调试端口。
/// 给他一个启动器，以后**从一开始就带着端口**，那一步就永远不用做了。
///
/// 【为什么是桌面上的一个文件，而不是改系统设置】写 LaunchAgent、改默认浏览器、
/// 替换 Dock 图标都是**不可见且不好撤销**的改动。一个他看得见、能拖走、能删掉的文件，
/// 是同样效果里侵入性最小的形态。
fn write_browser_shortcut() -> Result<String, String> {
    let chrome = find_chrome().ok_or_else(|| "没找到 Chrome。请先安装 Google Chrome。".to_string())?;
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "找不到你的用户目录".to_string())?;
    let desktop = std::path::Path::new(&home).join("Desktop");
    let dir = if desktop.is_dir() { desktop } else { std::path::Path::new(&home).to_path_buf() };

    #[cfg(target_os = "windows")]
    let (file, body) = (
        dir.join("采集浏览器.bat"),
        format!("@echo off\r\nstart \"\" \"{}\" --remote-debugging-port=9222 --no-default-browser-check\r\n",
            chrome.display()),
    );
    #[cfg(not(target_os = "windows"))]
    let (file, body) = (
        dir.join("采集浏览器.command"),
        format!("#!/bin/sh\n# 用调试端口启动 Chrome，烽火台才连得上。\n# 以后就用这个启动器开 Chrome，不必每次先退出。\nexec \"{}\" --remote-debugging-port=9222 --no-default-browser-check\n",
            chrome.display()),
    );

    std::fs::write(&file, body).map_err(|e| format!("写不了启动器：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 不可执行的 .command 双击只会用文本编辑器打开——那等于没做
        let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755));
    }
    Ok(file.display().to_string())
}

/// 查一次更新；有新版就问用户，点了就装。装完再问要不要立刻重启。
///
/// 【为什么全程不在失败时打扰】没网、站点维护、清单还没发——这些都不是用户能修的事，
/// 弹窗只会让人习惯性点掉，等真有更新时那一下也被顺手点掉了。
/// 【签名从哪来】tauri.conf.json 里钉死的 pubkey + /downloads/desktop-update.json 的 .sig；
/// 校验不过 updater 自己会拒装，这里不用再做判断。私钥只在打包机上（deploy/private/signing）。
async fn check_and_prompt_update(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(_) => return,
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        _ => return, // 没更新或没查到，都安静
    };
    let ver = update.version.clone();
    let asked = app
        .dialog()
        .message(format!(
            "烽火台桌面客户端有新版 v{ver}。\n\n现在更新吗？下载和安装都在后台进行，一般不到一分钟。"
        ))
        .title("发现新版本")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("现在更新".into(), "下次再说".into()))
        .blocking_show();
    if !asked {
        return;
    }
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => {
            let restart = app
                .dialog()
                .message("新版本已装好。重启后生效——现在重启吗？")
                .title("更新完成")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom("立刻重启".into(), "稍后自己重启".into()))
                .blocking_show();
            if restart {
                app.restart();
            }
        }
        Err(e) => {
            // 用户已经点了「现在更新」，这一步的失败必须让他知道，不然就是点了没反应
            app.dialog()
                .message(format!("更新没装上：{e}\n\n可以稍后再试，或到官网下载页手动覆盖安装。"))
                .title("更新失败")
                .kind(MessageDialogKind::Warning)
                .blocking_show();
        }
    }
}

mod executor;

fn main() {
    tauri::Builder::default()
        .manage(executor::ExecutorState::default())
        .invoke_handler(tauri::generate_handler![
            executor::register_executor,
            executor::unregister_executor,
            executor::executor_status
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "打开烽火台", true, None::<&str>)?;
            let data = MenuItem::with_id(app, "data", "打开本地数据目录", true, None::<&str>)?;
            let collect = MenuItem::with_id(app, "collect", "启动采集浏览器", true, None::<&str>)?;
            let shortcut = MenuItem::with_id(app, "shortcut", "生成采集浏览器快捷方式", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &collect, &shortcut, &data, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    // 本地缓存（登录态/网页缓存）就在这个目录下，给用户一条看得见、删得掉的路。
                    // 取不到目录时什么都不做——为一个菜单项崩掉整个壳不值得。
                    "data" => {
                        if let Ok(dir) = app.path().app_data_dir() {
                            let _ = std::fs::create_dir_all(&dir);
                            let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
                        }
                    }
                    // 用**他自己的默认 profile** 带调试端口起 Chrome（见 launch_collect_browser
                    // 的说明：独立 profile 是干净的，但每个站点都要重登一次，而采集的价值
                    // 恰恰在于读登录后才看得见的内容）。
                    // 成功/失败都要让他看见：静默失败会让他一直以为「点了没反应」。
                    "collect" => {
                        let msg = match launch_collect_browser(app) {
                            // 本来就开着的时候**不能说「已启动」**——他什么都没做，
                            // 那句话会让他以为自己的浏览器刚被重启了一次
                            Ok((url, false)) => format!(
                                "采集浏览器已经在用调试端口跑着了，不用做任何事。\n调试端点：{url}\n（如果设置里还没填，去「设置 → 本机命令执行」填上就行。）"
                            ),
                            Ok((url, true)) => format!("采集浏览器已启动。请到「设置 → 本机命令执行」把调试端点填成 {url}"),
                            Err(e) => e,
                        };
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = w.eval(&format!("window.alert({})", serde_json::to_string(&msg).unwrap_or_else(|_| "\"操作完成\"".into())));
                        }
                    }
                    // 桌面上放一个启动器：以后从它开 Chrome 就一直带着调试端口，
                    // 再不用每次先完全退出——那才是这条路上最大的摩擦
                    "shortcut" => {
                        let msg = match write_browser_shortcut() {
                            Ok(path) => format!(
                                "启动器已生成：{path}\n\n以后用它打开 Chrome（不要从 Dock/开始菜单开），调试端口就一直是开的。\n它只是一个普通文件，不想要了直接删掉即可。"
                            ),
                            Err(e) => e,
                        };
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = w.eval(&format!("window.alert({})", serde_json::to_string(&msg).unwrap_or_else(|_| "\"操作完成\"".into())));
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            // 一键更新（2026-09-01）：启动后台默默查一次，有新版才打扰。
            // 查失败一律静默——弹「检查更新失败」只会教会用户忽略弹窗；
            // 而这台机器可能整月不重启壳，所以每 6 小时再看一眼。
            // 采集执行器（2026-09-03）：登记过就每分钟领一次活；没登记不发任何请求
            executor::start_loop(app.handle().clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    check_and_prompt_update(&handle).await;
                    tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
                }
            });
            Ok(())
        })
        // 关窗=收进托盘（服务在后台，窗口只是视图；真正退出走托盘菜单）
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("烽火台桌面壳启动失败");
}
