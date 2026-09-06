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

// 【2026-09-04 删掉了「用日常 Chrome 采集」那一整套】
//
// 这里原有 chrome_running / debug_port_open / launch_collect_browser / write_browser_shortcut，
// 走的是「不传 --user-data-dir，用你自己的默认 profile 带调试端口起 Chrome」。那条路已经死了，
// 两个各自致命的原因：
//   ① Chrome ≥136 拒绝在默认 user-data-dir 上开调试端口（Google 2025-03 的安全改动）。
//      真机是 Chrome 152：就算用户 ⌘Q 退出日常 Chrome 再让我们拉起，端口也不会通。
//   ② 同一个 user-data-dir 只跑一个进程：日常 Chrome 开着时，带端口启动的新进程把参数交给
//      旧进程后自己退出，端口一样不通——于是每次采集都要用户先 ⌘Q。真机连撞三次，任务三次判死。
// 现在一律走 collect_browser.rs 的**采集专用浏览器**（独立 profile、9223、绝不碰日常 Chrome）。
// 真机验证（2026-09-04，Chrome 152）：端口一次通过，日常 Chrome 全程不受影响。
// 留着这几个函数只会让人以为还有第二条路可选。






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

mod collect_browser;
mod executor;

fn main() {
    tauri::Builder::default()
        .manage(executor::ExecutorState::default())
        .invoke_handler(tauri::generate_handler![
            executor::register_executor,
            executor::unregister_executor,
            executor::executor_status, executor::executor_kick])
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
            let collect = MenuItem::with_id(app, "collect", "打开采集浏览器（登录用）", true, None::<&str>)?;
            let shortcut = MenuItem::with_id(app, "shortcut", "清除采集浏览器登录数据", true, None::<&str>)?;
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
                    // 【不许在主线程阻塞】（2026-09-04 审计）托盘菜单事件在事件循环线程上调用，
                    // ensure 里最多等 24 秒端口——直接调会把整个窗口和托盘卡死 24 秒。丢到线程里跑，结果再回主线程弹。
                    "collect" => {
                        let app2 = app.clone();
                        std::thread::spawn(move || {
                            let app = &app2;
                            let msg = match collect_browser::ensure(app) {
                                Ok(_) => {
                                    collect_browser::focus_window();
                                    "采集浏览器已打开（它跟你日常的 Chrome 是分开的两个浏览器，互不影响）。\n\n在这个窗口里把要采的平台登一次（比如 X），登录态就长期留在它里面，以后采集不用再登。\n采集任务会自动用它，你平时不用管这个窗口。".to_string()
                                }
                                Err(e) => e,
                            };
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                                let _ = w.eval(&format!("window.alert({})", serde_json::to_string(&msg).unwrap_or_else(|_| "\"操作完成\"".into())));
                            }
                        });
                    }
                    // 桌面上放一个启动器：以后从它开 Chrome 就一直带着调试端口，
                    // 再不用每次先完全退出——那才是这条路上最大的摩擦
                    "shortcut" => {
                        let msg = match collect_browser::wipe(app) {
                            Ok(()) => "采集浏览器的数据已清除（各平台的登录态也一起没了，下次采集要重新登一次）。\n你日常的 Chrome 不受影响。".to_string(),
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
