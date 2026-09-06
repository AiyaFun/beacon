//! 采集专用浏览器（2026-09-04）。
//!
//! 【为什么必须单开一个，而不是用日常那个】不是取舍，是唯一能跑的路：
//!   ① **Chrome ≥136 拒绝在默认 user-data-dir 上开调试端口**（Google 2025-03 的安全改动）。
//!      用户机器上是 Chrome 152——就算他 ⌘Q 退出日常 Chrome 再让我们带端口拉起，端口也不会通。
//!      旧代码「不传 --user-data-dir，用你的默认 profile」那条路在 2025 年后的 Chrome 上是死的。
//!   ② 同一个 user-data-dir 只跑一个进程：日常 Chrome 开着时，带端口启动的新进程会把参数
//!      交给旧进程然后自己退出，端口一样不通——于是每次采集都要用户先 ⌘Q，是持续的摩擦。
//!
//! 用独立目录两个问题一起消失：跟日常 Chrome 各跑各的（他不用退出任何东西），
//! 端口也真的能开。代价是**登录态要各登一次**——所以这个目录必须长期留着：
//! 它住在 app_data_dir/collect-profile，升级客户端不清、除非用户自己点「清除采集浏览器数据」。
//! 用户的要求原话是「最好的结果是不要经常登录」，而 X 这类站点的会话通常几个月不掉。
//!
//! 🔒 只读采集的红线不变：CDP 只用来开页面、读 DOM，不点、不填、不提交，绝不替用户输密码。
//! 🔒 端口绑 127.0.0.1，且**只在采集期间开着**；这个 profile 里没有用户日常的任何数据。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

/// 我们自己拉起的采集浏览器进程号（0 = 不是我们起的/还没起）。抬窗口时按它精确找进程，
/// 而不是 `activate "Google Chrome"`——那会把用户日常那个 Chrome 抬到前面（同一个 bundle）。
static SPAWNED_PID: AtomicU32 = AtomicU32::new(0);

/// 采集浏览器的调试端口。**刻意不用 9222**——那是托盘那条老路（日常 profile）在用的号，
/// 两者撞号的话，我们会连上他手工起的那个日常 Chrome，行为就不可预测了。
pub const COLLECT_PORT: u16 = 9223;
pub const COLLECT_CDP: &str = "http://127.0.0.1:9223";

pub fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().expect("固定字面量"),
        Duration::from_millis(400),
    )
    .is_ok()
}

/// 采集 profile 的落脚点。跟令牌同目录（app_data_dir），跟着客户端走。
pub fn profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|d| d.join("collect-profile"))
        .map_err(|e| format!("找不到应用数据目录：{e}"))
}

/// 保证采集浏览器带着端口在跑。已经在跑就直接用（不重复拉起、更不杀任何浏览器）。
///
/// 【绝不碰用户日常的 Chrome】不探 9222、不判断他的 Chrome 在不在跑、不要求他退出。
/// 这个函数从头到尾只跟自己那个 profile 打交道。
pub fn ensure(app: &tauri::AppHandle) -> Result<String, String> {
    if port_open(COLLECT_PORT) {
        return Ok(COLLECT_CDP.to_string());
    }
    let chrome = crate::find_chrome().ok_or_else(|| "没找到 Chrome。请先安装 Google Chrome。".to_string())?;
    let dir = profile_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建不了采集浏览器的数据目录：{e}"))?;
    name_profile(&dir);

    let child = std::process::Command::new(&chrome)
        .arg(format!("--user-data-dir={}", dir.display()))
        .arg(format!("--remote-debugging-port={COLLECT_PORT}"))
        // 绑本机：调试端口不对外网开放
        .arg("--remote-debugging-address=127.0.0.1")
        .arg("--no-default-browser-check")
        .arg("--no-first-run")
        // 别让它抢焦点：采集是后台的事，用户可能正在干别的。
        // 需要他登录时执行器对自己那一页发 Page.bringToFront，再由 focus_window 把应用提到前台。
        .arg("--window-position=60,60")
        .arg("--window-size=1200,860")
        // 起一个空白页，不要每次弹出「恢复上次会话」之类的东西
        .arg("about:blank")
        .spawn()
        .map_err(|e| format!("启动不了采集浏览器：{e}"))?;
    SPAWNED_PID.store(child.id(), Ordering::SeqCst);
    // 【回收子进程】spawn 出来的 Child 直接丢掉的话，退出后在 macOS/Linux 上会挂成 defunct 直到客户端退出。
    // 起一个线程等它退出（不阻塞任何调用方）。
    std::thread::spawn(move || { let mut c = child; let _ = c.wait(); });

    // 【等够 24 秒，不是 12 秒】2026-09-04 真机实测：profile 目录是空的时候，Chrome 152
    // 要花 5 秒以上才开始听端口（第一次要建整个 profile）。12 秒的窗口在冷启动那一次会误判成
    // 「端口没通」，而进程其实好好地在起——用户看到的就是「第一次总是失败，再派一次就好了」。
    for _ in 0..60 {
        if port_open(COLLECT_PORT) {
            return Ok(COLLECT_CDP.to_string());
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    Err("采集浏览器起来了，但调试端口一直没通（超过 24 秒）".into())
}

/// 把采集浏览器这个**应用窗口**提到前台——**不开任何新标签**。
///
/// 【2026-09-04 审计查出的致命错，务必别改回去】原先这里是
/// `PUT /json/new?<url>`：那会**另开一个标签**给用户登录，而执行器的等待循环盯的是
/// `Cdp::open` 绑定的**原来那一页**——那一页在后台永不重新加载，DOM 从头到尾是登录墙那一版。
/// 于是用户在新标签里登录成功、cookie 都写进这个 profile 了，循环仍然每 3 秒判出「还没登上」，
/// 一直空转到超时，最后告诉他「等了 5 分钟还没登上」——与事实完全相反。
///
/// 正确做法：让执行器对**它自己那一页**发 `Page.bringToFront`（同一个 target，用户看到的
/// 就是循环在判的那一页），这里只负责把 Chrome 这个应用本身提到前台。
/// 🔒 只提窗口，不点任何东西、不输任何东西。
pub fn focus_window() {
    #[cfg(target_os = "macos")]
    {
        // 【按 pid 抬，不按应用名抬】`activate "Google Chrome"` 抬的是整个应用，日常那个 Chrome 与采集浏览器
        // 是同一个 bundle 的两个进程——很可能抬起来的是用户正在用的那个。有 pid 就按 pid 精确抬。
        let pid = SPAWNED_PID.load(Ordering::SeqCst);
        let script = if pid > 0 {
            format!("tell application \"System Events\" to set frontmost of (first process whose unix id is {pid}) to true")
        } else {
            "tell application \"Google Chrome\" to activate".to_string()
        };
        if let Ok(child) = std::process::Command::new("osascript").arg("-e").arg(script).spawn() {
            std::thread::spawn(move || { let mut c = child; let _ = c.wait(); });
        }
    }
    #[cfg(target_os = "windows")]
    {
        // 【Windows 也按 pid 抬】（2026-09-05 审计 #17）Page.bringToFront 只能提标签，
        // 窗口在别的窗口后面用户照样看不见「请登录」。WScript.Shell.AppActivate 接受 pid，
        // 不引额外 crate；只在等登录那一刻调一次，不是持续抢焦点。
        use std::os::windows::process::CommandExt;
        let pid = SPAWNED_PID.load(Ordering::SeqCst);
        if pid > 0 {
            let cmd = format!("(New-Object -ComObject WScript.Shell).AppActivate({pid}) | Out-Null");
            if let Ok(child) = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &cmd])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW：别闪一个黑框
                .spawn()
            {
                std::thread::spawn(move || { let mut c = child; let _ = c.wait(); });
            }
        }
    }
    // Linux：Page.bringToFront 已经把标签提到前台，窗口本身由窗口管理器决定是否抬起。
    // 不引额外依赖去强抢焦点——抢用户正在打字的窗口比不抬起更糟。
}

/// 给采集浏览器的 profile 起名（2026-09-05 审计 #35）。
///
/// 两个 Chrome 窗口长得一模一样，用户分不清哪个是采集的、哪个是自己的。Chrome 会把 profile 名
/// 显示在工具栏右上的头像芯片和窗口标题里；名字从 `Default/Preferences` 的 `profile.name` 读。
/// 只在**首次建 profile**（Preferences 还不存在）时写一份最小的 Preferences，之后 Chrome 自己维护，
/// 我们绝不再碰——覆盖会把用户的登录态与设置一起抹掉。写失败也不拦启动：名字是锦上添花。
fn name_profile(dir: &std::path::Path) {
    let default = dir.join("Default");
    let prefs = default.join("Preferences");
    if prefs.exists() {
        return;
    }
    if std::fs::create_dir_all(&default).is_err() {
        return;
    }
    let _ = std::fs::write(
        &prefs,
        r#"{"profile":{"name":"烽火台采集浏览器","avatar_index":26,"using_default_name":false,"using_default_avatar":false}}"#,
    );
}

/// 清掉采集浏览器的数据（用户主动要求时）。登录态会一起没掉，所以只由用户点。
pub fn wipe(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = profile_dir(app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("清不掉：{e}"))?;
    }
    Ok(())
}
