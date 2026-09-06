//! 采集执行器（2026-09-03）：云端账号 + 桌面客户端时，「浏览器操作」的载体。
//!
//! 【为什么要有它】用户在 Mac/Win 客户端里连的是云端账号：服务在机房，够不到他的 Chrome；
//! 整机版那条「本机浏览器」路在这里不存在。他要的是「像 Claude Code 一样的 Browser use 权限」——
//! 权限的载体只能是客户端本身：拿一枚采集令牌，在后台领活、用本机 Chrome（CDP）采、把结果交回。
//! 与插件是**同一套令牌、同一条任务队列、同一份解析器**，只是执行者从内容脚本换成了这里。
//!
//! 【它有多「哑」】开页 → 判登录墙 → 注入解析器 → 取值 → 交回。解析器与判据脚本每次从服务端
//! /api/ingest/executor 现取（平台改版修了解析器，客户端不用发版）；要开哪一页由服务端随任务给
//! （target），竞对的 handle、平台地址怎么拼，这里一概不知道。
//!
//! 【边界，与 lib/browser/local-collect.ts 那五条相同】
//!   只读：Runtime.evaluate 跑的是只读脚本，不点、不填、不提交，不替用户登录；
//!   一页复用（采完导航到 about:blank 留着，下次接着用），只碰自己留下的那一页；
//!   端点只在 127.0.0.1:9223（**采集专用浏览器**，见 collect_browser.rs）；绝不碰用户日常的 Chrome；
//!   令牌只存在 app_data_dir/executor.json，不进页面、不进日志。
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio_tungstenite::tungstenite::Message;

/// 自报给服务端的能力：只列这里真的会做的 kind。公众号后台回填要插件那套步进机，这里不做。
pub const SUPPORTED_KINDS: &str = "collect_competitor,collect_self_profile,open_and_read";
/// 领活间隔。2026-09-05 从 60s 降到 20s：用户要「派下去立刻开始」——一分钟的等待在他眼里就是「没反应」。
/// 网页派活后还会 invoke `executor_kick` 让这边立刻领一次，20s 只是兜底。
const POLL_SECS: u64 = 20;
const MAX_TASKS_PER_WAKE: usize = 3;
const CDP_HTTP: &str = crate::collect_browser::COLLECT_CDP;

/// 撞上登录墙时等用户登录的轮数。每轮 ≈ 3s sleep + 1.2s 导航等待 ≈ 4.2 秒。
/// 60 轮 ≈ 4 分 12 秒——够走完扫码/二次验证，又不至于把执行器占太久。
const LOGIN_WAIT_ROUNDS: usize = 60;
/// 单个任务的硬超时。**必须大于登录等待预算**，否则等待会被腰斩、
/// 并报出一个与真实原因无关的超时（2026-09-04 审计查出的真实缺陷）。
/// 60 轮 × 4.2s ≈ 252s，加上取脚本/等上下文/渲染/解析的余量 → 420s。
const TASK_TIMEOUT_SECS: u64 = 420;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ExecutorConfig {
    pub base: String,
    pub token: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorStatus {
    pub registered: bool,
    pub base: Option<String>,
    pub last_poll_at: Option<String>,
    pub last_error: Option<String>,
    pub done: u32,
    /// 这台机器的名字（2026-09-05 审计 #29）：同一个账号两台电脑都登记时，令牌标签得分得开。
    /// 签令牌是网页那边做的（页面拿不到主机名），所以由壳报上去。
    #[serde(default)]
    pub host: String,
}

/// 机器名：mac 上优先「系统设置里的电脑名」（Jiang 的 MacBook Pro），比 hostname 的 xxx.local 好认；
/// Windows 用 COMPUTERNAME；都拿不到就空串（标签退回没有机器名的老样子）。
fn host_name() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return s.chars().take(30).collect();
            }
        }
    }
    for k in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(v) = std::env::var(k) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return v.chars().take(30).collect();
            }
        }
    }
    if let Ok(out) = std::process::Command::new("hostname").output() {
        let s = String::from_utf8_lossy(&out.stdout).trim().trim_end_matches(".local").to_string();
        if !s.is_empty() {
            return s.chars().take(30).collect();
        }
    }
    String::new()
}

#[derive(Default)]
pub struct ExecutorState {
    pub status: Mutex<ExecutorStatus>,
    pub busy: AtomicBool,
    /// 【只认自己那一页】上一次任务用完、停在 about:blank 的那个 target id。
    ///
    /// 2026-09-04 真机：原先复用「/json/list 里任意一个 url==about:blank 的页」，
    /// 而用户为了登录平台，正是在采集浏览器里那唯一一个标签上打开站点的——
    /// 执行器下一分钟领活时把**他正在用的那一页**导航去目标站，采完又导航回 about:blank。
    /// 用户看到的就是「打开站点、刷新一下，又回到 about:blank」，登录根本做不完。
    /// 记住 id 之后：只复用自己留下的那一页，且它必须仍停在 about:blank；
    /// 用户在那页上打开了别的东西，就另开一页，绝不抢。
    pub parked: Mutex<Option<String>>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("executor.json"))
        .map_err(|e| format!("找不到数据目录：{e}"))
}

pub fn load_config(app: &AppHandle) -> Option<ExecutorConfig> {
    let p = config_path(app).ok()?;
    let s = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_config(app: &AppHandle, cfg: &ExecutorConfig) -> Result<(), String> {
    let p = config_path(app)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建不了数据目录：{e}"))?;
    }
    std::fs::write(&p, serde_json::to_string(cfg).map_err(|e| e.to_string())?).map_err(|e| format!("写不了配置：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 令牌等于工作区的采集钥匙：只许本人读
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn clear_config(app: &AppHandle) -> Result<(), String> {
    let p = config_path(app)?;
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("删不掉配置：{e}"))?;
    }
    Ok(())
}

/// 只接受 https 站点，或本机（http://localhost / 127.0.0.1）——令牌不能被交给一个明文的远端。
fn validate_base(base: &str) -> Result<String, String> {
    let b = base.trim().trim_end_matches('/');
    let (scheme, rest) = b.split_once("://").ok_or("地址格式不对")?;
    let host = rest.split('/').next().unwrap_or("").split(':').next().unwrap_or("");
    let local = host == "localhost" || host == "127.0.0.1";
    if scheme == "https" || (scheme == "http" && local) {
        Ok(b.to_string())
    } else {
        Err("只接受 https 站点或本机地址".into())
    }
}

fn now_hhmm() -> String {
    // 不引时区库：按北京时间（UTC+8）给个「几点几分」，够界面用
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let day = (secs + 8 * 3600) % 86400;
    format!("{:02}:{:02}", day / 3600, (day % 3600) / 60)
}

fn set_status(app: &AppHandle, f: impl FnOnce(&mut ExecutorStatus)) {
    if let Some(state) = app.try_state::<ExecutorState>() {
        if let Ok(mut s) = state.status.lock() {
            f(&mut s);
        }
    }
}

#[tauri::command]
pub fn register_executor(app: AppHandle, base: String, token: String) -> Result<(), String> {
    let base = validate_base(&base)?;
    let token = token.trim().to_string();
    if !token.starts_with("bcn_") || token.len() < 16 {
        return Err("这不像一枚采集令牌".into());
    }
    save_config(&app, &ExecutorConfig { base: base.clone(), token })?;
    set_status(&app, |s| {
        s.registered = true;
        s.base = Some(base);
        s.last_error = None;
    });
    // 登记完立刻领一轮，别让用户等到下一个整分钟
    let h = app.clone();
    tauri::async_runtime::spawn(async move { run_once(&h).await });
    Ok(())
}

#[tauri::command]
pub fn unregister_executor(app: AppHandle) -> Result<(), String> {
    clear_config(&app)?;
    set_status(&app, |s| {
        *s = ExecutorStatus::default();
    });
    Ok(())
}

/// 网页派完活立刻叫执行器领一次（2026-09-05）。
///
/// 服务端够不到客户端，只能客户端去领；等 20 秒的轮询在用户眼里就是「派了没反应」。
/// 网页与壳在同一个 webview 里，派活工具一返回就 invoke 这个命令。
/// busy 时（上一轮还在跑）直接返回：run_once 自己会跳过，不会并发跑两轮。
#[tauri::command]
pub fn executor_kick(app: AppHandle) {
    let h = app.clone();
    tauri::async_runtime::spawn(async move { run_once(&h).await });
}

#[tauri::command]
pub fn executor_status(app: AppHandle) -> ExecutorStatus {
    let cfg = load_config(&app);
    let mut s = app
        .try_state::<ExecutorState>()
        .and_then(|st| st.status.lock().ok().map(|g| g.clone()))
        .unwrap_or_default();
    s.registered = cfg.is_some();
    s.host = host_name();
    if s.base.is_none() {
        s.base = cfg.map(|c| c.base);
    }
    s
}

/// 启动后台轮询：每分钟看一眼有没有活。没登记就什么都不做（不发任何请求）。
pub fn start_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            run_once(&app).await;
            tokio::time::sleep(Duration::from_secs(POLL_SECS)).await;
        }
    });
}

async fn run_once(app: &AppHandle) {
    let Some(cfg) = load_config(app) else { return };
    let Some(state) = app.try_state::<ExecutorState>() else { return };
    if state.busy.swap(true, Ordering::SeqCst) {
        return; // 上一轮还在跑（一页最长一分多钟），这轮跳过
    }
    let r = poll_and_run(app, &cfg).await;
    let stamp = now_hhmm();
    set_status(app, |s| {
        s.last_poll_at = Some(stamp);
        s.last_error = r.as_ref().err().cloned();
    });
    state.busy.store(false, Ordering::SeqCst);
}

async fn poll_and_run(app: &AppHandle, cfg: &ExecutorConfig) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;

    for _ in 0..MAX_TASKS_PER_WAKE {
        let res = client
            .get(format!("{}/api/ingest/tasks", cfg.base))
            .header("x-beacon-ingest-token", &cfg.token)
            .header("x-beacon-ingest-kinds", SUPPORTED_KINDS)
            .send()
            .await
            .map_err(|e| format!("连不上工作区：{e}"))?;
        if res.status().as_u16() == 401 {
            let _ = clear_config(app);
            set_status(app, |s| { s.registered = false; s.base = None; });
            return Err("采集令牌已被吊销，登记已解除。请在页面顶部重新点「允许」。".into());
        }
        let v: serde_json::Value = res.json().await.map_err(|e| format!("领活回应不是 JSON：{e}"))?;
        let Some(task) = v.get("task").filter(|t| !t.is_null()) else { return Ok(()) };
        let task_id = task["id"].as_str().unwrap_or("").to_string();
        if task_id.is_empty() {
            return Ok(());
        }

        // 领到活了才去碰浏览器：没活的时候不要每分钟探一次 Chrome
        let outcome = match ensure_cdp(app) {
            // 【超时必须容得下登录等待】2026-09-04 审计：这里原本是 120 秒，而登录墙分支要等用户
            // 登录（LOGIN_WAIT_ROUNDS × ~4.2 秒）。于是用户正在输密码、界面上却已经报
            // 「这一页超过两分钟没跑完」——一个与真实原因毫不相干的理由，而那句写好的
            // 「去采集浏览器窗口里登录」永远执行不到。超时值必须由等待预算推出来，不能各写各的。
            Ok(()) => tokio::time::timeout(Duration::from_secs(TASK_TIMEOUT_SECS), execute(app, &client, cfg, task))
                .await
                .unwrap_or_else(|_| Err(format!("这一页超过 {} 分钟没跑完，放弃", TASK_TIMEOUT_SECS / 60).into())),
            Err(e) => Err(e),
        };

        let body = match &outcome {
            Ok(Outcome::Parsed(p)) => serde_json::json!({ "taskId": task_id, "ok": true, "parsed": p }),
            Ok(Outcome::Read(d)) => serde_json::json!({ "taskId": task_id, "ok": true, "data": d }),
            Err(e) => serde_json::json!({ "taskId": task_id, "ok": false, "error": e.chars().take(300).collect::<String>() }),
        };
        // 【交活必须看回应】（2026-09-04 审计）原先 `let _ = ...send()`：网络抖一下、服务端 500、
        // 令牌被吊销（401）、活已被取代（409）——一律当成功记 done，客户端一片安静，
        // 服务端那条任务仍是 claimed，15 分钟后被重领再采一遍。
        let resp = client
            .post(format!("{}/api/ingest/tasks", cfg.base))
            .header("x-beacon-ingest-token", &cfg.token)
            .json(&body)
            .send()
            .await;
        match resp {
            Err(e) => return Err(format!("采完了但交不回去（{e}）；服务端会在租约到期后重派，这一轮先停")),
            Ok(r) if r.status().as_u16() == 401 => {
                // 令牌被吊销：登记文件留着只会让状态一直显示「已登记」。清掉，让顶部提示重新出现「允许」按钮。
                let _ = clear_config(app);
                set_status(app, |s| { s.registered = false; s.base = None; });
                return Err("采集令牌已被吊销，登记已解除。请在页面顶部重新点「允许」。".into());
            }
            Ok(r) if !r.status().is_success() => {
                let code = r.status().as_u16();
                let text = r.text().await.unwrap_or_default();
                let msg = serde_json::from_str::<serde_json::Value>(&text).ok()
                    .and_then(|v| v["error"].as_str().map(|x| x.to_string()))
                    .unwrap_or_else(|| text.chars().take(120).collect());
                // 409 = 这条活已被取代/取消/别人重领，结果不收——不是错，如实记一笔即可
                if code == 409 { set_status(app, |s| s.last_error = Some(format!("这条活服务端没收（{msg}）"))); continue; }
                return Err(format!("交活被拒（HTTP {code}）：{msg}"));
            }
            Ok(_) => {}
        }
        match outcome {
            Ok(_) => set_status(app, |s| s.done += 1),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// 保证**采集专用浏览器**带着调试端口在跑。
///
/// 【2026-09-04 改：不再用日常 Chrome】原先走 `launch_collect_browser`（日常 profile、9222），
/// 真机三次失败在同一句「Chrome 正开着但没打开调试端口，请先 ⌘Q」——而且就算他退出了也没用：
/// **Chrome ≥136 拒绝在默认 user-data-dir 上开调试端口**，他机器上是 152。
/// 现在起独立 profile 的采集浏览器（9223），与他日常的 Chrome 互不干扰，他什么都不用退出。
fn ensure_cdp(app: &AppHandle) -> Result<(), String> {
    crate::collect_browser::ensure(app).map(|_| ())
}

/// 页面上那圈「烽火台正在采集」的标识（2026-09-04，用户点名要）。
///
/// 【为什么要有】采集浏览器是我们替他开的，页面会自己跳转、滚动。没有标识的话，
/// 他分不清「这一页是烽火台在采」还是「我自己开的页出问题了」——真机上他就是这么困惑的。
/// 一圈边框 + 右上角一行字，`pointer-events:none` 保证不挡他任何操作（比如在登录页输账号）。
/// 采完 close() 会把页导航回 about:blank，标识随之消失；中途失败也不留残留。
const BADGE_ON: &str = r#"(() => {
  const ID = '__beacon_collect_badge__';
  if (document.getElementById(ID)) return true;
  const box = document.createElement('div');
  box.id = ID;
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647', 'pointer-events:none',
    'border:3px solid #f26b3a', 'box-shadow:inset 0 0 0 1px rgba(255,255,255,.6)',
  ].join(';');
  const tag = document.createElement('div');
  tag.textContent = '\u70fd\u706b\u53f0 \u00b7 \u6b63\u5728\u91c7\u96c6\u8fd9\u4e00\u9875\uff08\u53ea\u8bfb\uff09';
  tag.style.cssText = [
    'position:absolute', 'top:8px', 'right:8px', 'background:#f26b3a', 'color:#fff',
    'font:600 12px/1.6 -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif',
    'padding:4px 10px', 'border-radius:0 0 0 8px', 'letter-spacing:.3px',
  ].join(';');
  box.appendChild(tag);
  (document.body || document.documentElement).appendChild(box);
  return true;
})()"#;

/// 撞上登录墙时把标识换成「请在这一页登录」——同一圈边框，换一句话。
const BADGE_LOGIN: &str = r#"(() => {
  const ID = '__beacon_collect_badge__';
  const box = document.getElementById(ID);
  const t = box && box.firstChild;
  if (t) t.textContent = '\u70fd\u706b\u53f0 \u00b7 \u8bf7\u5728\u8fd9\u4e00\u9875\u767b\u5f55\uff0c\u767b\u5b8c\u5b83\u4f1a\u81ea\u5df1\u63a5\u7740\u91c7';
  return true;
})()"#;

enum Outcome {
    Parsed(serde_json::Value),
    Read(serde_json::Value),
}

async fn execute(app: &AppHandle, client: &reqwest::Client, cfg: &ExecutorConfig, task: &serde_json::Value) -> Result<Outcome, String> {
    let kind = task["kind"].as_str().unwrap_or("");
    let url = task["target"]["url"].as_str().ok_or("这条任务没带目标地址（服务端太旧？）")?.to_string();
    let platform = task["target"]["platform"].as_str().unwrap_or("").to_string();

    // 脚本每次现取：解析器在服务端修了，这里立刻跟上
    let scripts: serde_json::Value = client
        .get(format!("{}/api/ingest/executor?platform={}", cfg.base, platform))
        .header("x-beacon-ingest-token", &cfg.token)
        .send()
        .await
        .map_err(|e| format!("取不到解析脚本：{e}"))?
        .json()
        .await
        .map_err(|e| format!("解析脚本回应不是 JSON：{e}"))?;
    if scripts["ok"] != true {
        return Err(scripts["error"].as_str().unwrap_or("取不到解析脚本").to_string());
    }
    let login_wall = scripts["loginWall"].as_str().ok_or("脚本包里没有登录墙判据")?;
    let collect = scripts["collect"].as_str().ok_or("脚本包里没有采集函数")?;
    let read_text = scripts["readText"].as_str().ok_or("脚本包里没有读正文函数")?;

    let mut page = Cdp::open(app, &url).await?;
    let r = run_in_page(&mut page, &url, kind, login_wall, collect, read_text, &scripts).await;
    // 【让他去登录时绝不清页】否则我们一边说「窗口停在这一页请登录」，一边把它导航回 about:blank
    // ——2026-09-04 真机（小红书）撞到的正是这个。park=false 时页面原样留着，也不记进 parked，
    // 下次任务另开一页，绝不抢这一页。
    // 【要用户登录时：页面留着，但仍然记住它】2026-09-04 真机：等待超时后既不清页也不记录，
    // 于是下一个任务另开一页，登录页越堆越多（真机上堆到 5 个）。正确做法是页面原样留在登录页
    // 让他登，同时把 id 记下来——下次任务直接复用**这一页**（他多半就是在这一页登的，
    // 复用等于自动确认他登好了没），既不清掉他要登的东西，也不再堆新页。
    let needs_login = matches!(&r, Err(e) if e.contains("登录"));
    page.close_keeping(app, !needs_login).await;
    r
}

/// 摆出这一页、等用户在**这一页**登录完（两条判据路径共用）。
///
/// 【为什么必须共用】2026-09-04 真机（小红书）：硬信号那条会等，软信号（loggedOut）那条却
/// 直接返回错误，话里却写着「我已经把窗口停在这一页，请登录」——而 execute 收尾时
/// page.close() 又把这一页导航回了 about:blank。用户看到的是一个空白页和一句让他去登录的话。
/// 两条路都走这里，且**要用户登录时绝不清页**（见 close 的 park 参数）。
///
/// 返回 true = 他登上了（页面已重新导航回目标页、渲染完毕，可以接着采）。
async fn wait_for_login(page: &mut Cdp, page_url: &str, login_wall: &str) -> bool {
    let _ = page.call("Page.bringToFront", serde_json::json!({})).await;
    let _ = page.eval(BADGE_LOGIN, false).await;
    crate::collect_browser::focus_window();
    for _ in 0..LOGIN_WAIT_ROUNDS {
        tokio::time::sleep(Duration::from_secs(3)).await;
        // 登录成功后站点多半把他带去别处，每轮都回到目标页再判
        let _ = page.call("Page.navigate", serde_json::json!({ "url": page_url })).await;
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let _ = page.eval(BADGE_ON, false).await;
        let _ = page.eval(BADGE_LOGIN, false).await;
        if let Ok(w) = page.eval(&format!("({login_wall})()"), false).await {
            if w["walled"] != true {
                // 硬信号解除了，还要确认页面上真的有内容（软信号那条路靠它收尾）
                for _ in 0..30 {
                    let st = page.eval("document.readyState", false).await.unwrap_or_default();
                    if st.as_str() == Some("complete") { break; }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                tokio::time::sleep(Duration::from_millis(1500)).await;
                return true;
            }
        }
    }
    false
}

async fn run_in_page(
    page: &mut Cdp,
    page_url: &str,
    kind: &str,
    login_wall: &str,
    collect: &str,
    read_text: &str,
    scripts: &serde_json::Value,
) -> Result<Outcome, String> {
    page.call("Page.enable", serde_json::json!({})).await?;
    // 【先等执行上下文，再等 readyState】2026-09-04 真机：新开的页在头几秒里
    // Runtime.evaluate 会回「Cannot find default execution context」——页面进程还没把
    // 主世界建好。下面那个 readyState 循环用 unwrap_or_default 把这个错吞掉了，
    // 于是循环空转到超时，然后**登录墙那一行直接把它抛出去**，任务以一个
    // 与真实原因毫不相干的报错判死。判据要落在「上下文能用了」这件事本身上。
    let mut ctx_ready = false;
    for _ in 0..40 {
        if page.eval("1", false).await.is_ok() {
            ctx_ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    if !ctx_ready {
        return Err("页面一直没准备好（20 秒内拿不到执行上下文）".into());
    }
    // 让用户一眼看出这一页是烽火台在采（只读、不挡操作）
    let _ = page.eval(BADGE_ON, false).await;
    // 等文档到 complete，最多 15 秒；再给渲染 1.5 秒
    for _ in 0..30 {
        let st = page.eval("document.readyState", false).await.unwrap_or_default();
        if st.as_str() == Some("complete") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
    // 【等重定向落定再判登录墙】2026-09-04 真机（小红书）：主页会**整页跳转**到
    // /login?redirectPath=…，而跳转往往发生在第一次 readyState=complete 之后。
    // 不等的话，登录墙判据在旧地址上判，什么都判不出来，于是走到「采到 0 条」那条路，
    // 报出「这个号可能还没发过内容」——与事实完全不符（同一类误导今天已修过三次）。
    // 判据：地址连续 2 秒不再变化，最多再等 8 秒。
    {
        let mut last = page.eval("location.href", false).await.unwrap_or_default();
        let mut stable = 0;
        for _ in 0..8 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let now = page.eval("location.href", false).await.unwrap_or_default();
            if now == last { stable += 1; } else { stable = 0; last = now; }
            if stable >= 2 { break; }
        }
    }

    let wall = page.eval(&format!("({login_wall})()"), false).await?;
    if wall["walled"] == true {
        let why = wall["why"].as_str().unwrap_or("");
        if wall["kind"] == "login" {
            // 【碰到登录墙要等他登完，不是当场判失败】用户 2026-09-04 的话：「如果有碰到需要登录的时候，
            // 应该等待调试」。当场判死的话，他登完还得回来重新派一次——而登录窗口就是我们弹的，
            // 等在这里天经地义。把窗口摆到他面前，然后每 3 秒回头看一眼登录墙还在不在，最多等 5 分钟。
            // **只摆页面、只等待，密码永远他自己输**（红线不变）。
            // 两条判据路径共用同一套等待（见 wait_for_login 的说明）
            if !wait_for_login(page, page_url, login_wall).await {
                return Err(format!("等你在采集浏览器里登录这个平台（{why}），等了几分钟还没登上，这次先停了。那个窗口还停在登录页，登好之后再派一次即可，之后几个月都不用再登。我不会替你输入账号密码。"));
            }
        } else {
            return Err({
            format!("站点这次要求人机验证或提示访问过于频繁（{why}），过一阵再试。我们不会替你过验证码。")
            });
        }
    }

    if kind == "open_and_read" {
        let d = page.eval(&format!("({read_text})()"), false).await?;
        return Ok(Outcome::Read(d));
    }

    for s in scripts["scripts"].as_array().ok_or("脚本包里没有解析器")? {
        if let Some(src) = s.as_str() {
            page.eval_script(src).await?;
        }
    }
    let r = page.eval(&format!("({collect})({{ deep: true }})"), true).await?;
    if let Some(e) = r.get("error").and_then(|e| e.as_str()) {
        return Err(match e {
            "no_handle" => "解析器没在这一页认出账号主页（可能没加载完、或站点改版了）".to_string(),
            "parser_missing" => "解析器没装载上".to_string(),
            // 2026-09-04：X 把页面上的语义锚点（data-testid / lang / time / role=group）全拆了，
            // 解析器认得出有推文、却取不到任何一条的内容。如实说「站点改版」，
            // 而不是让上层含混地报「这个号可能还没发过内容」。
            "parser_stale" => "解析器取不到内容：页面上能看到作品，但读不出正文与数据。最常见的原因是**采集浏览器还没登录这个平台**（X 未登录时给的是精简页面，没有可读的结构）——请在「烽火台采集浏览器」窗口里登录一次再派；已经登录仍这样的话，就是站点改版了，等解析器更新（服务端修好当天生效，客户端不用重装）。".to_string(),
            other => other.to_string(),
        });
    }
    let payload = r.get("payload").cloned().ok_or_else(|| "解析器没返回结果".to_string())?;

    // 【一条都没取到时，先问一句「是不是没登录」】2026-09-04 真机：采集浏览器是全新 profile，
    // 没登录过 X。X 的个人主页在未登录时既没有密码框、地址也不是 /login，登录墙判据因此放行，
    // 解析器取到 0 条，服务端回一句「可能没加载完，或这个号还没发过内容」——
    // 与事实完全不符，而真正该做的事（去采集浏览器里登一次）一个字都没提。
    //
    // 这个软信号只在「本来就没东西可采」时才问，误伤不了任何一次成功的采集（见 LOGGED_OUT_FN 的说明）。
    let empty = payload.get("posts").and_then(|p| p.as_array()).map(|a| a.is_empty()).unwrap_or(false);
    if empty {
        if let Some(logged_out) = scripts["loggedOut"].as_str() {
            if let Ok(v) = page.eval(&format!("({logged_out})()"), false).await {
                if v["loggedOut"] == true {
                    let why = v["why"].as_str().unwrap_or("");
                    // 软信号也要等他登完（用户 2026-09-04：「碰到需要登录的时候应该等待」）。
                    // 登上之后重跑一遍解析，别让他白登一次还要再派。
                    if wait_for_login(page, page_url, login_wall).await {
                        for src in scripts["scripts"].as_array().into_iter().flatten() {
                            if let Some(code) = src.as_str() { let _ = page.eval_script(code).await; }
                        }
                        if let Ok(again) = page.eval(&format!("({collect})({{ deep: true }})"), true).await {
                            if let Some(p2) = again.get("payload").cloned() {
                                return Ok(Outcome::Parsed(p2));
                            }
                        }
                    }
                    return Err(format!(
                        "采集浏览器还没登录这个平台（{why}），所以读不到你的内容。那个「烽火台采集浏览器」窗口**还停在这一页**——请在它里面登录（不是你日常的 Chrome），登完再派一次即可，之后几个月都不用再登。我不会替你输入账号密码。"
                    ));
                }
            }
        }
    }
    Ok(Outcome::Parsed(payload))
}

/// 极简 CDP 会话：只用到 Page.enable / Runtime.evaluate 两个方法，不引整套客户端库。
struct Cdp {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    target_id: String,
    next: u64,
}

impl Cdp {
    /// 拿到一页并导航到 url：**复用上次留下的空白页**，没有才新开。
    ///
    /// 【为什么复用而不是每次新开（2026-09-04 真机）】原先每个任务 PUT /json/new 开一页、
    /// 采完 /json/close 关掉——关的是最后一页时整个窗口跟着没了，下个任务再拉起浏览器，
    /// 用户看到的就是「采集浏览器反复开、关、开」。对目标平台来说，同一台机器一个新窗口接一个
    /// 新窗口地打开同一主页，也正是最像脚本的行为。
    /// 现在：采完把这一页导航到 about:blank 留着；下次先在 /json/list 里找这页 about:blank 复用。
    ///
    /// 【关于「绝不枚举已有标签」】那条红线说的是**用户日常的 Chrome**（里面是他的隐私）。
    /// 这里 list 的是我们自己起的采集专用浏览器（独立 profile、只有我们开的页），
    /// 而且只挑 url 恰好是 about:blank 的那一页——用户自己在这个浏览器里开的登录页等一律不碰。
    async fn open(app: &AppHandle, url: &str) -> Result<Cdp, String> {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
        // ① 只找**我们自己上次留下的那一页**，而且它必须仍停在 about:blank。
        //    绝不按 url 去认领任意一个空白页——用户为了登录平台就在这个浏览器里操作，
        //    抢走他正在用的标签会让他永远登不完（2026-09-04 真机，见 ExecutorState::parked）。
        let want = app
            .try_state::<ExecutorState>()
            .and_then(|st| st.parked.lock().ok().and_then(|g| g.clone()));
        let mut picked: Option<serde_json::Value> = None;
        if let Some(id) = want.as_deref() {
            if let Ok(resp) = client.get(format!("{CDP_HTTP}/json/list")).send().await {
                if let Ok(list) = resp.json::<serde_json::Value>().await {
                    if let Some(arr) = list.as_array() {
                        // 只按 id 认自己那一页；不再要求它停在 about:blank——
                        // 让用户登录时我们会把它留在登录页上，下次正该复用它（他就是在这一页登的）。
                        picked = arr.iter().find(|t| t["type"] == "page" && t["id"] == id).cloned();
                    }
                }
            }
        }
        // ② 没有就新开一页（PUT /json/new 是 Chrome ≥ 96 的写法；GET 会被拒）
        let v: serde_json::Value = match picked {
            Some(v) => v,
            None => client
                .put(format!("{CDP_HTTP}/json/new?about:blank"))
                .send()
                .await
                .map_err(|e| format!("连不上本机浏览器（{CDP_HTTP}）：{e}"))?
                .json()
                .await
                .map_err(|e| format!("浏览器回应不是 JSON：{e}"))?,
        };
        let ws_url = v["webSocketDebuggerUrl"].as_str().ok_or("浏览器没给调试通道")?.to_string();
        let target_id = v["id"].as_str().unwrap_or("").to_string();
        let (ws, _) = tokio_tungstenite::connect_async(&ws_url).await.map_err(|e| format!("连不上页面的调试通道：{e}"))?;
        let mut page = Cdp { ws, target_id, next: 0 };
        // 【必须看 errorText】CDP 的 Page.navigate 在导航失败时返回的仍是一个**成功的命令响应**，
        // 失败藏在 result.errorText 里（net::ERR_NAME_NOT_RESOLVED / ERR_CONNECTION_TIMED_OUT …）。
        // 丢掉它的话，「这台机器根本连不上目标站点」会一路走到解析那一步，
        // 最后报成「解析器认不出这一页 / 站点改版了」——与真实原因毫不相干（2026-09-04 审计查出）。
        let r = page.call("Page.navigate", serde_json::json!({ "url": url })).await?;
        if let Some(err) = r.get("errorText").and_then(|e| e.as_str()) {
            if !err.is_empty() {
                return Err(format!("打不开这个网址（{err}）。多半是这台电脑连不上该站点（网络/代理/DNS），与采集本身无关。"));
            }
        }
        Ok(page)
    }

    async fn call(&mut self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        self.next += 1;
        let id = self.next;
        let msg = serde_json::json!({ "id": id, "method": method, "params": params });
        self.ws.send(Message::Text(msg.to_string().into())).await.map_err(|e| format!("发不出调试命令：{e}"))?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
        loop {
            let next = tokio::time::timeout_at(deadline, self.ws.next()).await.map_err(|_| format!("{method} 45 秒没回应"))?;
            let Some(frame) = next else { return Err("调试通道断了".into()) };
            let frame = frame.map_err(|e| format!("调试通道出错：{e}"))?;
            let Message::Text(t) = frame else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else { continue };
            if v["id"] == id {
                if let Some(e) = v.get("error") {
                    return Err(format!("{method} 失败：{}", e["message"].as_str().unwrap_or("?")));
                }
                return Ok(v["result"].clone());
            }
            // 其它都是事件，忽略
        }
    }

    /// 求值并把结果按值取回；await_promise 给异步的采集函数用。页面抛异常 → Err。
    async fn eval(&mut self, expression: &str, await_promise: bool) -> Result<serde_json::Value, String> {
        let r = self
            .call(
                "Runtime.evaluate",
                serde_json::json!({ "expression": expression, "returnByValue": true, "awaitPromise": await_promise }),
            )
            .await?;
        if let Some(ex) = r.get("exceptionDetails") {
            let text = ex["exception"]["description"].as_str().or(ex["text"].as_str()).unwrap_or("页面脚本抛了异常");
            return Err(text.chars().take(200).collect());
        }
        Ok(r["result"]["value"].clone())
    }

    /// 注入一段脚本（解析器）：不取返回值，只看有没有抛。
    async fn eval_script(&mut self, src: &str) -> Result<(), String> {
        let r = self
            .call("Runtime.evaluate", serde_json::json!({ "expression": src, "returnByValue": false }))
            .await?;
        if let Some(ex) = r.get("exceptionDetails") {
            let text = ex["exception"]["description"].as_str().or(ex["text"].as_str()).unwrap_or("解析器脚本抛了异常");
            return Err(format!("注入解析器失败：{}", text.chars().take(200).collect::<String>()));
        }
        Ok(())
    }

    /// 用完不关页：导航到 about:blank 留着给下次复用（见 open 的说明），再断开调试通道。
    /// 页留着窗口就在，浏览器不会「采一次关一次」。
    /// park=true：把页导航回 about:blank 停靠；park=false：页面原样留着（用户要在上面登录）。
    /// **两种情况都把这一页记下来**——下次任务复用它。留着登录页不记的话，下一个任务会另开一页，
    /// 登录页越堆越多（2026-09-04 真机堆到 5 个）。
    async fn close_keeping(mut self, app: &AppHandle, park: bool) {
        if park {
            let _ = self.call("Page.navigate", serde_json::json!({ "url": "about:blank" })).await;
        }
        if let Some(st) = app.try_state::<ExecutorState>() {
            if let Ok(mut g) = st.parked.lock() {
                *g = Some(self.target_id.clone());
            }
        }
        let _ = self.ws.close(None).await;
    }
}
