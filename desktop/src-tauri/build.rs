fn main() {
    // 执行器的三个命令要能被**云端网页**（远程 origin）调用：capabilities/executor.json 里的 remote.urls 放行
    // 那几个站点，这里把命令登记进应用清单，好让 allow-register-executor 这几条权限生成出来。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["register_executor", "unregister_executor", "executor_status"]),
        ),
    )
    .expect("tauri-build 失败");
}
