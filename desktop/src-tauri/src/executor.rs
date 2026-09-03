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
//!   只新开一页（PUT /json/new），用完 /json/close 关掉，绝不枚举、绝不碰已开着的标签；
//!   端点只在 127.0.0.1:9222；不替用户杀浏览器（launch_collect_browser 那套规矩）；
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
const POLL_SECS: u64 = 60;
const MAX_TASKS_PER_WAKE: usize = 3;
const CDP_HTTP: &str = "http://127.0.0.1:9222";

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
}

#[derive(Default)]
pub struct ExecutorState {
    pub status: Mutex<ExecutorStatus>,
    pub busy: AtomicBool,
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

#[tauri::command]
pub fn executor_status(app: AppHandle) -> ExecutorStatus {
    let cfg = load_config(&app);
    let mut s = app
        .try_state::<ExecutorState>()
        .and_then(|st| st.status.lock().ok().map(|g| g.clone()))
        .unwrap_or_default();
    s.registered = cfg.is_some();
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
            return Err("采集令牌已失效（可能被吊销），请到「采集助手」页重新登记".into());
        }
        let v: serde_json::Value = res.json().await.map_err(|e| format!("领活回应不是 JSON：{e}"))?;
        let Some(task) = v.get("task").filter(|t| !t.is_null()) else { return Ok(()) };
        let task_id = task["id"].as_str().unwrap_or("").to_string();
        if task_id.is_empty() {
            return Ok(());
        }

        // 领到活了才去碰浏览器：没活的时候不要每分钟探一次 Chrome
        let outcome = match ensure_cdp(app) {
            Ok(()) => tokio::time::timeout(Duration::from_secs(120), execute(&client, cfg, task))
                .await
                .unwrap_or_else(|_| Err("这一页超过两分钟没跑完，放弃".into())),
            Err(e) => Err(e),
        };

        let body = match &outcome {
            Ok(Outcome::Parsed(p)) => serde_json::json!({ "taskId": task_id, "ok": true, "parsed": p }),
            Ok(Outcome::Read(d)) => serde_json::json!({ "taskId": task_id, "ok": true, "data": d }),
            Err(e) => serde_json::json!({ "taskId": task_id, "ok": false, "error": e.chars().take(300).collect::<String>() }),
        };
        let _ = client
            .post(format!("{}/api/ingest/tasks", cfg.base))
            .header("x-beacon-ingest-token", &cfg.token)
            .json(&body)
            .send()
            .await;
        match outcome {
            Ok(_) => set_status(app, |s| s.done += 1),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// 保证 Chrome 带着调试端口在跑：与托盘「启动采集浏览器」同一套规矩（先探端口、不杀浏览器）。
fn ensure_cdp(app: &AppHandle) -> Result<(), String> {
    crate::launch_collect_browser(app).map(|_| ())?;
    // 刚起的 Chrome 要一两秒才开始听端口
    for _ in 0..20 {
        if crate::debug_port_open() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    Err("Chrome 起了，但调试端口一直没通".into())
}

enum Outcome {
    Parsed(serde_json::Value),
    Read(serde_json::Value),
}

async fn execute(client: &reqwest::Client, cfg: &ExecutorConfig, task: &serde_json::Value) -> Result<Outcome, String> {
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

    let mut page = Cdp::open(&url).await?;
    let r = run_in_page(&mut page, kind, login_wall, collect, read_text, &scripts).await;
    page.close().await;
    r
}

async fn run_in_page(
    page: &mut Cdp,
    kind: &str,
    login_wall: &str,
    collect: &str,
    read_text: &str,
    scripts: &serde_json::Value,
) -> Result<Outcome, String> {
    page.call("Page.enable", serde_json::json!({})).await?;
    // 等文档到 complete，最多 15 秒；再给渲染 1.5 秒
    for _ in 0..30 {
        let st = page.eval("document.readyState", false).await.unwrap_or_default();
        if st.as_str() == Some("complete") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;

    let wall = page.eval(&format!("({login_wall})()"), false).await?;
    if wall["walled"] == true {
        let why = wall["why"].as_str().unwrap_or("");
        return Err(if wall["kind"] == "login" {
            format!("这个页面要求登录（{why}）。在你的 Chrome 里登录一次该平台再派；我不会替你输入账号密码。")
        } else {
            format!("站点这次要求人机验证或提示访问过于频繁（{why}），过一阵再试。我们不会替你过验证码。")
        });
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
            other => other.to_string(),
        });
    }
    r.get("payload").cloned().map(Outcome::Parsed).ok_or_else(|| "解析器没返回结果".to_string())
}

/// 极简 CDP 会话：只用到 Page.enable / Runtime.evaluate 两个方法，不引整套客户端库。
struct Cdp {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    target_id: String,
    next: u64,
}

impl Cdp {
    /// 新开一页（PUT /json/new 是 Chrome ≥ 96 的写法；GET 会被拒）。绝不 /json/list 去碰已有的标签。
    async fn open(url: &str) -> Result<Cdp, String> {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
        let v: serde_json::Value = client
            .put(format!("{CDP_HTTP}/json/new?{url}"))
            .send()
            .await
            .map_err(|e| format!("连不上本机浏览器（{CDP_HTTP}）：{e}"))?
            .json()
            .await
            .map_err(|e| format!("浏览器回应不是 JSON：{e}"))?;
        let ws_url = v["webSocketDebuggerUrl"].as_str().ok_or("浏览器没给调试通道")?.to_string();
        let target_id = v["id"].as_str().unwrap_or("").to_string();
        let (ws, _) = tokio_tungstenite::connect_async(&ws_url).await.map_err(|e| format!("连不上页面的调试通道：{e}"))?;
        Ok(Cdp { ws, target_id, next: 0 })
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

    /// 关掉我们自己开的这一页。关不掉不影响结论（页留着而已）。
    async fn close(mut self) {
        let _ = self.ws.close(None).await;
        if !self.target_id.is_empty() {
            let _ = reqwest::get(format!("{CDP_HTTP}/json/close/{}", self.target_id)).await;
        }
    }
}
