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
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &data, &quit])?;
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
