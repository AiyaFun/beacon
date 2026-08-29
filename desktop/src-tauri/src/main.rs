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

fn launch_collect_browser(_app: &tauri::AppHandle) -> Result<String, String> {
    let chrome = find_chrome().ok_or_else(|| "没找到 Chrome。请先安装 Google Chrome。".to_string())?;

    if chrome_running() {
        return Err(
            "Chrome 正开着。运行中的 Chrome 没法再打开调试端口（这是 Chrome 的限制）。\n\n             请先完全退出 Chrome（macOS 按 ⌘Q，不是关窗口），再点一次这里。\n             重开后它会恢复你原来的标签页，登录态也都还在。"
                .to_string(),
        );
    }

    // 不传 --user-data-dir：就用他的默认 profile，登录态全在
    std::process::Command::new(&chrome)
        .arg("--remote-debugging-port=9222")
        .arg("--no-default-browser-check")
        .spawn()
        .map_err(|e| format!("启动不了 Chrome：{e}"))?;
    Ok("http://127.0.0.1:9222".to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "打开烽火台", true, None::<&str>)?;
            let data = MenuItem::with_id(app, "data", "打开本地数据目录", true, None::<&str>)?;
            let collect = MenuItem::with_id(app, "collect", "启动采集浏览器", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &collect, &data, &quit])?;
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
                    // 起一个独立 profile 的采集浏览器（不影响他正开着的那个 Chrome）。
                    // 成功/失败都要让他看见：静默失败会让他一直以为「点了没反应」。
                    "collect" => {
                        let msg = match launch_collect_browser(app) {
                            Ok(url) => format!("采集浏览器已启动。请到「设置 → 本机命令执行」把调试端点填成 {url}"),
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
