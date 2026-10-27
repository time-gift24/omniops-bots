#[path = "credentials.rs"]
mod credentials;
#[path = "data_root.rs"]
mod data_root;
#[path = "error.rs"]
pub(crate) mod error;
#[cfg(all(target_os = "macos", feature = "native-browser"))]
#[path = "native_browser.rs"]
pub(crate) mod native_browser;
#[cfg(all(target_os = "windows", feature = "native-browser"))]
#[path = "native_browser_windows.rs"]
pub(crate) mod native_browser;
#[path = "updater.rs"]
mod updater;

use error::{Error, IpcError};
#[cfg(all(
    feature = "native-browser",
    any(target_os = "macos", target_os = "windows")
))]
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    ShellExt,
    process::{CommandChild, CommandEvent},
};
use tokio::sync::{Semaphore, oneshot};

type Reply = Result<Value, IpcError>;

fn runtime_request_line(id: u64, method: &str, params: &Value) -> Result<Vec<u8>, Error> {
    let mut message = json!({"id": id, "method": method});
    if !params.is_null() {
        message["params"] = params.clone();
    }
    let mut line = serde_json::to_vec(&message)?;
    line.push(b'\n');
    if line.len() > 40 * 1024 * 1024 {
        return Err(Error::InvalidInput("Request is too large"));
    }
    Ok(line)
}

struct Runtime {
    inner: Arc<Mutex<Inner>>,
    next_id: AtomicU64,
    credential_slots: Arc<Semaphore>,
    credential_gate: Arc<Semaphore>,
}

struct Inner {
    child: Option<CommandChild>,
    ready: bool,
    error: Option<IpcError>,
    pending: HashMap<u64, oneshot::Sender<Reply>>,
    starting: HashSet<u64>,
    preparing: HashSet<String>,
    task_active: bool,
    shutting_down: bool,
    exit_allowed: bool,
}

impl Runtime {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                child: None,
                ready: false,
                error: None,
                pending: HashMap::new(),
                starting: HashSet::new(),
                preparing: HashSet::new(),
                task_active: false,
                shutting_down: false,
                exit_allowed: false,
            })),
            next_id: AtomicU64::new(1),
            credential_slots: Arc::new(Semaphore::new(64)),
            // ponytail: one OS operation at a time avoids per-entry credential store races.
            credential_gate: Arc::new(Semaphore::new(1)),
        }
    }

    fn prepare_run(&self, run_id: String) -> Result<(), Error> {
        if run_id.trim().is_empty() || run_id.len() > 256 || run_id.chars().any(char::is_control) {
            return Err(Error::InvalidInput("Run ID is invalid"));
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.shutting_down {
            return Err(Error::Unavailable("Desktop is shutting down"));
        }
        if let Some(error) = &inner.error {
            return Err(Error::Remote(error.clone()));
        }
        if inner.preparing.len() >= 64 && !inner.preparing.contains(&run_id) {
            return Err(Error::Unavailable("Too many desktop preparations"));
        }
        inner.preparing.insert(run_id);
        Ok(())
    }

    fn release_run(&self, run_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.preparing.remove(run_id);
    }

    fn begin_shutdown(&self) -> Result<bool, Error> {
        let mut inner = self.inner.lock().unwrap();
        if inner.shutting_down || inner.exit_allowed {
            return Ok(false);
        }
        if !inner.preparing.is_empty() || !inner.starting.is_empty() || inner.task_active {
            return Err(Error::Unavailable("A task is still running"));
        }
        inner.shutting_down = true;
        Ok(true)
    }

    fn fail(&self, error: IpcError) {
        let mut inner = self.inner.lock().unwrap();
        inner.ready = false;
        inner.error = Some(error.clone());
        inner.starting.clear();
        inner.preparing.clear();
        inner.task_active = false;
        for (_, sender) in inner.pending.drain() {
            let _ = sender.send(Err(error.clone()));
        }
    }

    async fn wait_ready(&self) -> Result<(), Error> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            {
                let inner = self.inner.lock().unwrap();
                if inner.shutting_down {
                    return Err(Error::Unavailable("Desktop is shutting down"));
                }
                if let Some(error) = &inner.error {
                    return Err(Error::Remote(error.clone()));
                }
                if inner.ready {
                    return Ok(());
                }
            }
            if Instant::now() >= deadline {
                return Err(Error::Timeout);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, Error> {
        self.request_inner(method, params, timeout)
            .await
            .inspect_err(|error| {
                tracing::warn!(
                    component = "runtime",
                    phase = "ipc",
                    error_kind = error.diagnostic_kind()
                );
            })
    }

    async fn request_inner(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, Error> {
        if method != "shutdown" {
            self.wait_ready().await?;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.shutting_down && method != "shutdown" {
                return Err(Error::Unavailable("Desktop is shutting down"));
            }
            if inner.pending.len() >= 64 {
                return Err(Error::Unavailable("Too many desktop requests"));
            }
            let child = inner
                .child
                .as_mut()
                .ok_or(Error::Unavailable("Agent runtime is unavailable"))?;
            let line = runtime_request_line(id, method, &params)?;
            child.write(&line)?;
            if method == "chat_start" {
                if let Some(run_id) = params.get("runId").and_then(Value::as_str) {
                    inner.preparing.remove(run_id);
                }
                inner.starting.insert(id);
            }
            inner.pending.insert(id, sender);
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result.map_err(Error::Remote),
            Ok(Err(_)) => Err(Error::Unavailable("Agent runtime disconnected")),
            Err(_) => {
                // An IPC timeout does not prove that a queued start was never executed.
                self.inner.lock().unwrap().pending.remove(&id);
                Err(Error::Timeout)
            }
        }
    }

    fn receive(&self, line: &[u8]) -> Result<Option<Value>, Error> {
        if line.len() > 40 * 1024 * 1024 {
            return Err(Error::InvalidInput("Runtime response is too large"));
        }
        let message: Value = serde_json::from_slice(line)?;
        if message["event"] == "credential_request" {
            self.credential_request(message);
            return Ok(None);
        }
        if let Some(id) = message["id"].as_u64() {
            let mut inner = self.inner.lock().unwrap();
            inner.starting.remove(&id);
            if let Some(sender) = inner.pending.remove(&id) {
                let result = if let Some(error) = message.get("error") {
                    let error =
                        serde_json::from_value::<IpcError>(error.clone()).unwrap_or(IpcError {
                            kind: "runtime".into(),
                            message: "Agent runtime rejected the request".into(),
                        });
                    Err(error)
                } else {
                    Ok(message["result"].clone())
                };
                let _ = sender.send(result);
            }
            return Ok(None);
        }
        match message["event"].as_str() {
            Some("ready") => {
                let mut inner = self.inner.lock().unwrap();
                if !inner.ready {
                    tracing::info!(component = "runtime", phase = "ready");
                }
                inner.ready = true;
                Ok(Some(message))
            }
            Some("desktop_state") => {
                let tasks = message["state"]["tasks"]
                    .as_array()
                    .ok_or(Error::InvalidInput("Runtime task state is missing"))?;
                if tasks.iter().any(|task| {
                    !task.is_object()
                        || task["runId"].as_str().is_none()
                        || task["threadId"].as_str().is_none()
                }) {
                    return Err(Error::InvalidInput("Runtime task state is invalid"));
                }
                self.inner.lock().unwrap().task_active = !tasks.is_empty();
                Ok(Some(message))
            }
            Some("operations_browser_state" | "chat_event" | "runtime_exit" | "exit") => {
                Ok(Some(message))
            }
            _ => Ok(None),
        }
    }

    fn credential_request(&self, message: Value) {
        let Some(request_id) = credentials::request_id(&message) else {
            return;
        };
        let request = match credentials::Request::parse(message) {
            Ok(request) => request,
            Err(error) => {
                credential_reply(&self.inner, request_id, Err(error));
                return;
            }
        };
        let Ok(slot) = self.credential_slots.clone().try_acquire_owned() else {
            credential_reply(
                &self.inner,
                request_id,
                Err(Error::CredentialBoundary("系统凭据请求过多，请稍后重试。")),
            );
            return;
        };
        let inner = self.inner.clone();
        let gate = self.credential_gate.clone();
        tauri::async_runtime::spawn(async move {
            let operation = async {
                let permit = gate
                    .acquire_owned()
                    .await
                    .map_err(|_| Error::CredentialBoundary("系统凭据连接已关闭。"))?;
                let unavailable = {
                    let inner = inner.lock().unwrap();
                    inner.shutting_down || inner.child.is_none()
                };
                if unavailable {
                    return Err(Error::CredentialBoundary("系统凭据连接已关闭。"));
                }
                tauri::async_runtime::spawn_blocking(move || {
                    let _permit = permit;
                    request.execute()
                })
                .await
                .map_err(|_| Error::CredentialBoundary("系统凭据操作失败。"))?
            };
            let result = tokio::time::timeout(Duration::from_secs(15), operation)
                .await
                .unwrap_or(Err(Error::CredentialBoundary(
                    "系统凭据操作超时，请检查凭据库后重试。",
                )));
            credential_reply(&inner, request_id, result);
            drop(slot);
        });
    }

    fn terminated(&self) {
        let child = self.inner.lock().unwrap().child.take();
        if let Some(child) = child {
            kill_child(child);
        }
        self.fail(Error::Unavailable("Agent runtime stopped").into());
    }

    async fn shutdown_for_update(&self, deadline: Instant) -> Result<(), Error> {
        self.inner.lock().unwrap().shutting_down = true;
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(Error::Timeout)?;
        self.request_inner("shutdown", Value::Null, remaining)
            .await?;
        while self.inner.lock().unwrap().child.is_some() {
            if Instant::now() >= deadline {
                return Err(Error::Timeout);
            }
            tokio::time::sleep(
                Duration::from_millis(20).min(deadline.saturating_duration_since(Instant::now())),
            )
            .await;
        }
        Ok(())
    }

    async fn shutdown(&self, deadline: Instant) {
        if self.shutdown_for_update(deadline).await.is_err()
            && let Some(child) = self.inner.lock().unwrap().child.take()
        {
            kill_child(child);
        }
    }
}

fn credential_reply(inner: &Mutex<Inner>, request_id: u64, result: Result<Option<String>, Error>) {
    let message = match result {
        Ok(result) => json!({"event":"credential_reply", "requestId":request_id, "result":result}),
        Err(error) => {
            json!({"event":"credential_reply", "requestId":request_id, "error":IpcError::from(error)})
        }
    };
    let mut inner = inner.lock().unwrap();
    if let Some(child) = inner.child.as_mut()
        && let Ok(mut line) = serde_json::to_vec(&message)
    {
        line.push(b'\n');
        // Credential replies only travel to the private child, never the WebView or logs.
        let _ = child.write(&line);
    }
}

#[tauri::command]
fn runtime_prepare_run(run_id: String, runtime: State<'_, Arc<Runtime>>) -> Result<(), IpcError> {
    runtime.prepare_run(run_id).map_err(Into::into)
}

#[tauri::command]
fn runtime_release_run(run_id: String, runtime: State<'_, Arc<Runtime>>) {
    runtime.release_run(&run_id);
}

fn kill_child(child: CommandChild) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(child.pid()) {
        // Only the private sidecar's process group is eligible for forced cleanup.
        unsafe {
            let group = libc::getpgid(pid);
            let exited =
                group == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
            if pid > 1 && (group == pid || exited) {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    let _ = child.kill();
}

fn validate_method(method: &str) -> Result<(), Error> {
    if method.is_empty()
        || method.len() > 80
        || !method
            .bytes()
            .all(|value| value.is_ascii_lowercase() || value == b'_')
        || method == "shutdown"
    {
        return Err(Error::InvalidInput("Runtime method is not permitted"));
    }
    Ok(())
}

#[tauri::command]
async fn runtime_request(method: String, params: Value, runtime: State<'_, Arc<Runtime>>) -> Reply {
    validate_method(&method)
        .inspect_err(|error| {
            tracing::warn!(
                component = "runtime",
                phase = "ipc",
                error_kind = error.diagnostic_kind()
            );
        })
        .map_err(IpcError::from)?;
    runtime
        .request(&method, params, Duration::from_secs(300))
        .await
        .map_err(Into::into)
}

#[cfg(all(
    feature = "native-browser",
    any(target_os = "macos", target_os = "windows")
))]
#[derive(Clone, Deserialize)]
struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    interactive: bool,
    #[serde(rename = "pageId")]
    page_id: Option<String>,
}

#[cfg(all(
    feature = "native-browser",
    any(target_os = "macos", target_os = "windows")
))]
#[tauri::command]
async fn browser_set_bounds(app: tauri::AppHandle, bounds: BrowserBounds) -> Result<(), IpcError> {
    let page_id = bounds.page_id.unwrap_or_else(|| "__manual__".to_owned());
    if page_id != "__manual__" {
        return Err(Error::InvalidInput("Only the manual browser can be embedded").into());
    }
    native_browser::set_bounds(
        app,
        page_id,
        native_browser::Bounds {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            visible: bounds.visible,
            interactive: bounds.interactive,
        },
    )
    .await
    .inspect_err(|error| {
        tracing::warn!(
            component = "browser",
            phase = "ipc",
            error_kind = error.diagnostic_kind()
        );
    })
    .map_err(Into::into)
}

#[tauri::command]
fn host_copy_text(app: tauri::AppHandle, text: String) -> Result<(), IpcError> {
    app.clipboard()
        .write_text(text)
        .map_err(Error::from)
        .inspect_err(|error| {
            tracing::warn!(
                component = "clipboard",
                phase = "ipc",
                error_kind = error.diagnostic_kind()
            );
        })
        .map_err(Into::into)
}

fn external_url(value: &str) -> Result<url::Url, Error> {
    let url = url::Url::parse(value).map_err(|_| Error::InvalidInput("External URL is invalid"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::InvalidInput(
            "Only HTTP(S) links without credentials can be opened",
        ));
    }
    Ok(url)
}

#[tauri::command]
fn host_open_external(app: tauri::AppHandle, url: String) -> Result<(), IpcError> {
    let url = external_url(&url)
        .inspect_err(|error| {
            tracing::warn!(
                component = "opener",
                phase = "ipc",
                error_kind = error.diagnostic_kind()
            );
        })
        .map_err(IpcError::from)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(Error::from)
        .inspect_err(|error| {
            tracing::warn!(
                component = "opener",
                phase = "ipc",
                error_kind = error.diagnostic_kind()
            );
        })
        .map_err(Into::into)
}

#[tauri::command]
async fn host_confirm(app: tauri::AppHandle, message: String) -> Result<bool, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title("omniops-bots")
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show()
    })
    .await
    .inspect_err(|_| {
        tracing::warn!(
            component = "dialog",
            phase = "ipc",
            error_kind = "unavailable"
        );
    })
    .map_err(|_| Error::Unavailable("Confirmation dialog was interrupted").into())
}

fn start_runtime(
    app: &tauri::AppHandle,
    runtime: Arc<Runtime>,
    data_dir: PathBuf,
    manual_connection: Option<(String, String)>,
    local_root: PathBuf,
    diagnostics_only: bool,
) -> Result<(), Error> {
    let script = app.path().resource_dir()?.join("runtime/main.ts");
    if !script.is_file() {
        return Err(Error::Unavailable("Bundled agent runtime is missing"));
    }
    let mut command = app
        .shell()
        .sidecar("omniops-bots-node")?
        .arg(script)
        .env("OMNIOPS_BOTS_DATA_DIR", data_dir)
        .env("OMNIOPS_BOTS_LOCAL_ROOT", local_root)
        .env(
            "OMNIOPS_BOTS_DIAGNOSTICS_ONLY",
            if diagnostics_only { "1" } else { "0" },
        )
        .set_process_group(true);
    if let Some((endpoint, target_id)) = manual_connection {
        command = command
            .env("OMNIOPS_BOTS_MANUAL_BROWSER_CDP_ENDPOINT", endpoint)
            .env("OMNIOPS_BOTS_MANUAL_BROWSER_TARGET_ID", target_id);
    }
    let (mut receiver, child) = command.spawn()?;
    {
        let mut inner = runtime.inner.lock().unwrap();
        if inner.shutting_down {
            kill_child(child);
            return Err(Error::Unavailable("Desktop is shutting down"));
        }
        inner.child = Some(child);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(line) => match runtime.receive(&line) {
                    Ok(Some(message)) => {
                        let _ = app.emit_to("main", "runtime-event", message);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        tracing::warn!(
                            component = "runtime",
                            phase = "ipc",
                            error_kind = error.diagnostic_kind()
                        );
                        let error = IpcError::from(error);
                        runtime.terminated();
                        runtime.fail(error.clone());
                        let _ = app.emit_to(
                            "main",
                            "runtime-event",
                            json!({"event": "runtime_exit", "error": error}),
                        );
                    }
                },
                CommandEvent::Terminated(payload) => {
                    tracing::info!(component = "runtime", phase = "exit");
                    runtime.terminated();
                    let _ = app.emit_to(
                        "main",
                        "runtime-event",
                        json!({"event": "runtime_exit", "code": payload.code}),
                    );
                    return;
                }
                CommandEvent::Error(_) => {
                    tracing::warn!(
                        component = "runtime",
                        phase = "ipc",
                        error_kind = "transport"
                    );
                    let error =
                        IpcError::from(Error::Unavailable("Agent runtime transport failed"));
                    runtime.terminated();
                    runtime.fail(error.clone());
                    let _ = app.emit_to(
                        "main",
                        "runtime-event",
                        json!({"event": "runtime_exit", "error": error}),
                    );
                }
                // stderr may contain user content or credentials. Never copy it into host logs.
                CommandEvent::Stderr(_) => {}
                _ => {}
            }
        }
        tracing::info!(component = "runtime", phase = "exit");
        runtime.terminated();
        let _ = app.emit_to("main", "runtime-event", json!({"event":"runtime_exit"}));
    });
    Ok(())
}

#[cfg(all(
    debug_assertions,
    feature = "native-browser",
    any(target_os = "macos", target_os = "windows")
))]
async fn smoke_native_pages(app: tauri::AppHandle) -> Result<Value, Error> {
    let first = native_browser::create_page(app.clone(), "smoke-a".into()).await?;
    let second = native_browser::create_page(app.clone(), "smoke-b".into()).await?;
    if first.target_id == second.target_id {
        return Err("CEF smoke pages share a target".into());
    }
    native_browser::select_page(app.clone(), "smoke-a".into()).await?;
    native_browser::set_bounds(
        app.clone(),
        "smoke-a".into(),
        native_browser::Bounds {
            x: 400.,
            y: 100.,
            width: 640.,
            height: 480.,
            visible: true,
            interactive: false,
        },
    )
    .await?;
    native_browser::smoke_navigate(
        app.clone(),
        "smoke-b".into(),
        "data:text/html,<title>hidden-b</title><p>page-b</p>".into(),
    )
    .await?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let hidden = loop {
        let value = native_browser::smoke_evaluate(app.clone(), "smoke-b".into(),
            "({title:document.title,text:document.body?.textContent,width:innerWidth,height:innerHeight,visibility:document.visibilityState})".into()).await?;
        if value["title"] == "hidden-b" && value["text"] == "page-b" {
            break value;
        }
        if Instant::now() >= deadline {
            return Err("CEF hidden page did not load".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    if hidden["width"].as_u64().unwrap_or(0) == 0 || hidden["height"].as_u64().unwrap_or(0) == 0 {
        return Err("CEF hidden page viewport is empty".into());
    }
    native_browser::select_page(app.clone(), "smoke-b".into()).await?;
    native_browser::set_bounds(
        app.clone(),
        "smoke-b".into(),
        native_browser::Bounds {
            x: 400.,
            y: 100.,
            width: 640.,
            height: 480.,
            visible: true,
            interactive: false,
        },
    )
    .await?;
    let isolated = native_browser::smoke_evaluate(
        app.clone(),
        "smoke-a".into(),
        "({title:document.title,url:location.href})".into(),
    )
    .await?;
    if isolated["title"] == "hidden-b" || isolated["url"] != "about:blank" {
        return Err("CEF smoke pages are not isolated".into());
    }
    native_browser::release_page(app.clone(), "smoke-a".into()).await?;
    let remaining =
        native_browser::smoke_evaluate(app.clone(), "smoke-b".into(), "document.title".into())
            .await?;
    if remaining != "hidden-b" {
        return Err("Releasing one CEF page affected its sibling".into());
    }
    native_browser::release_page(app.clone(), "smoke-b".into()).await?;
    native_browser::select_page(app, "__manual__".into()).await?;
    Ok(
        json!({"firstTarget":first.target_id,"secondTarget":second.target_id,
        "hiddenPage":hidden,"isolatedPage":isolated,"remainingTitle":remaining,"released":true}),
    )
}

#[cfg(all(
    feature = "native-browser",
    any(target_os = "macos", target_os = "windows")
))]
async fn close_native_browser_for_update(
    app: &tauri::AppHandle,
    deadline: Instant,
) -> Result<(), Error> {
    tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), async {
        let (sender, receiver) = oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(native_browser::begin_close());
        })?;
        receiver
            .await
            .map_err(|_| Error::Unavailable("浏览器关闭被中断。"))??;
        while !native_browser::is_closed() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let (sender, receiver) = oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(native_browser::finish_shutdown());
        })?;
        receiver
            .await
            .map_err(|_| Error::Unavailable("浏览器清理被中断。"))?
    })
    .await
    .map_err(|_| Error::Timeout)?
}

pub(crate) fn diagnostics_only() -> bool {
    std::env::args_os().any(|argument| argument == "--diagnostics")
        || std::env::var_os("OMNIOPS_BOTS_DIAGNOSTICS_ONLY").is_some_and(|value| value == "1")
}

pub(crate) fn run() -> Result<i32, Error> {
    let collector = omniops_bots_collector::Collector::init_from_env("omniops-bots-desktop");
    if collector.is_err() {
        tracing::warn!(
            component = "collector",
            phase = "startup",
            error_kind = "initialization"
        );
    }
    tracing::info!(component = "desktop", phase = "startup");
    let result = run_app();
    tracing::info!(
        component = "desktop",
        phase = "exit",
        error_kind = result.as_ref().err().map_or("none", Error::diagnostic_kind)
    );
    if let Ok(collector) = collector {
        // One total budget for every exporter and bounded local stderr output.
        // Telemetry failure never replaces the application's result or triggers retries.
        let _ = collector.shutdown(Duration::from_millis(500));
    }
    result
}

fn run_app() -> Result<i32, Error> {
    let diagnostics_only = diagnostics_only();
    let (_data_lock, local_root, startup_error) =
        match data_root::local_root().and_then(|root| data_root::DataRootLock::acquire(&root)) {
            Ok(lock) => {
                let directory = lock.directory.clone();
                (Some(lock), Some(directory), None)
            }
            Err(error) => (None, None, Some(IpcError::from(error))),
        };

    #[cfg(all(
        feature = "native-browser",
        any(target_os = "macos", target_os = "windows")
    ))]
    if !diagnostics_only && startup_error.is_none() {
        native_browser::prepare_framework().inspect_err(|error| {
            tracing::warn!(
                component = "browser",
                phase = "startup",
                error_kind = error.diagnostic_kind()
            );
        })?;
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            runtime_request,
            runtime_prepare_run,
            runtime_release_run,
            #[cfg(all(
                feature = "native-browser",
                any(target_os = "macos", target_os = "windows")
            ))]
            browser_set_bounds,
            host_copy_text,
            host_open_external,
            host_confirm,
            updater::updater_status,
            updater::updater_check,
            updater::updater_download,
            updater::updater_install
        ])
        .setup(move |app| {
            let data_dir = std::env::var_os("OMNIOPS_BOTS_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            if !data_dir.is_absolute() {
                return Err(Error::InvalidInput("应用数据目录必须为绝对路径。").into());
            }
            std::fs::create_dir_all(&data_dir)?;
            let runtime = Arc::new(Runtime::new());
            app.manage(runtime.clone());
            app.manage(updater::Updater::new(
                app.package_info().version.to_string(),
                diagnostics_only,
            ));
            if let Some(error) = startup_error.clone() {
                runtime.fail(error);
                return Ok(());
            }
            let local_root = local_root
                .clone()
                .ok_or(Error::Unavailable("本地数据目录不可用。"))?;
            #[cfg(all(
                feature = "native-browser",
                any(target_os = "macos", target_os = "windows")
            ))]
            if !diagnostics_only {
                let window = app
                    .get_webview_window("main")
                    .ok_or(Error::Unavailable("Main window is missing"))?;
                if let native_browser::Initialization::AlreadyRunning =
                    native_browser::initialize(&window)?
                {
                    runtime.inner.lock().unwrap().exit_allowed = true;
                    window.hide()?;
                    app.handle().exit(0);
                    return Ok(());
                }
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                #[cfg(all(
                    debug_assertions,
                    feature = "native-browser",
                    any(target_os = "macos", target_os = "windows")
                ))]
                if let Some(report_path) = std::env::var_os("OMNIOPS_BOTS_BROWSER_SMOKE_REPORT")
                    .filter(|_| !diagnostics_only)
                {
                    let result = match native_browser::wait_ready(Duration::from_secs(15)).await {
                        Ok(_) => smoke_native_pages(handle.clone()).await,
                        Err(error) => Err(error),
                    };
                    let (code, report) = match result {
                        Ok(report) => (0, json!({"ok":true,"report":report})),
                        Err(error) => (1, json!({"ok":false,"error":IpcError::from(error)})),
                    };
                    let written = serde_json::to_vec_pretty(&report)
                        .ok()
                        .is_some_and(|bytes| std::fs::write(report_path, bytes).is_ok());
                    handle.exit(if written { code } else { 1 });
                    return;
                }
                let result = async {
                    #[cfg(all(
                        feature = "native-browser",
                        any(target_os = "macos", target_os = "windows")
                    ))]
                    let manual_connection = if diagnostics_only {
                        None
                    } else {
                        let connection =
                            native_browser::wait_ready(Duration::from_secs(15)).await?;
                        Some((connection.endpoint, connection.target_id))
                    };
                    #[cfg(not(all(
                        feature = "native-browser",
                        any(target_os = "macos", target_os = "windows")
                    )))]
                    let manual_connection = None;
                    start_runtime(
                        &handle,
                        runtime.clone(),
                        data_dir,
                        manual_connection,
                        local_root,
                        diagnostics_only,
                    )
                }
                .await;
                if let Err(error) = result {
                    tracing::warn!(
                        component = "runtime",
                        phase = "startup",
                        error_kind = error.diagnostic_kind()
                    );
                    let error = IpcError::from(error);
                    runtime.fail(error.clone());
                    let _ = handle.emit_to(
                        "main",
                        "runtime-event",
                        json!({"event": "runtime_exit", "error": error}),
                    );
                }
                #[cfg(debug_assertions)]
                if let Ok(delay) = std::env::var("OMNIOPS_BOTS_SMOKE_EXIT_MS")
                    .unwrap_or_default()
                    .parse::<u64>()
                {
                    let ready = runtime.wait_ready().await.is_ok();
                    tokio::time::sleep(Duration::from_millis(delay.min(60_000))).await;
                    handle.exit(if ready { 0 } else { 1 });
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .inspect_err(|_| {
            tracing::warn!(
                component = "desktop",
                phase = "startup",
                error_kind = "host"
            );
        })?;
    let exit_code = app.run_return(move |app, event| {
        let runtime = app.state::<Arc<Runtime>>();
        match event {
            RunEvent::WindowEvent {
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                api.prevent_close();
                app.exit(0);
            }
            RunEvent::ExitRequested { api, code, .. } => {
                if runtime.inner.lock().unwrap().exit_allowed {
                    return;
                }
                api.prevent_exit();
                match runtime.begin_shutdown() {
                    Ok(false) => return,
                    Err(_) => {
                        let _ =
                            app.emit_to("main", "runtime-event", json!({"event":"exit_blocked"}));
                        return;
                    }
                    Ok(true) => {}
                }
                let runtime = runtime.inner().clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let deadline = Instant::now() + Duration::from_secs(10);
                    runtime.shutdown(deadline).await;
                    #[cfg(all(
                        feature = "native-browser",
                        any(target_os = "macos", target_os = "windows")
                    ))]
                    if !diagnostics_only {
                        let _ = close_native_browser_for_update(&app, deadline).await;
                    }
                    runtime.inner.lock().unwrap().exit_allowed = true;
                    app.exit(code.unwrap_or(0));
                });
            }
            RunEvent::Exit => {
                let needs_shutdown = !runtime.inner.lock().unwrap().exit_allowed;
                if needs_shutdown {
                    tauri::async_runtime::block_on(
                        runtime.shutdown(Instant::now() + Duration::from_secs(10)),
                    );
                }
            }
            _ => {}
        }
    });
    #[cfg(all(
        feature = "native-browser",
        any(target_os = "macos", target_os = "windows")
    ))]
    if !diagnostics_only {
        if !native_browser::is_closed() {
            return Err(Error::Unavailable("浏览器清理未在退出期限内完成。"));
        }
        native_browser::finish_shutdown()?;
    }
    Ok(exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_request_serialization_omits_absent_params_for_node_ipc() {
        let shutdown = runtime_request_line(7, "shutdown", &Value::Null).unwrap();
        assert_eq!(shutdown.last(), Some(&b'\n'));
        assert_eq!(
            serde_json::from_slice::<Value>(&shutdown).unwrap(),
            json!({"id": 7, "method": "shutdown"})
        );
        let params = json!({"threadId": "thread-1", "limit": 10});
        let request = runtime_request_line(8, "diagnostic_threads", &params).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&request).unwrap(),
            json!({"id": 8, "method": "diagnostic_threads", "params": params})
        );
    }

    #[cfg(all(
        feature = "native-browser",
        any(target_os = "macos", target_os = "windows")
    ))]
    #[test]
    fn browser_bounds_require_explicit_input_ownership() {
        let mut value = serde_json::json!({
            "x": 0, "y": 0, "width": 500, "height": 600, "visible": true,
        });
        assert!(serde_json::from_value::<BrowserBounds>(value.clone()).is_err());
        value["interactive"] = Value::Bool(false);
        assert!(
            !serde_json::from_value::<BrowserBounds>(value)
                .unwrap()
                .interactive
        );
    }

    #[test]
    fn task_preparation_and_shutdown_cannot_both_acquire_the_host() {
        let runtime = Runtime::new();
        runtime.prepare_run("preparing".into()).unwrap();
        runtime.prepare_run("parallel".into()).unwrap();
        assert!(runtime.begin_shutdown().is_err());
        runtime.release_run("parallel");
        assert!(runtime.begin_shutdown().is_err());
        runtime.release_run("stale");
        assert!(runtime.begin_shutdown().is_err());
        runtime.release_run("preparing");
        assert!(runtime.begin_shutdown().unwrap());
        assert!(runtime.prepare_run("too-late".into()).is_err());
        assert!(!runtime.begin_shutdown().unwrap());

        let runtime = Arc::new(Runtime::new());
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let preparing = {
            let runtime = runtime.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                runtime.prepare_run("concurrent".into()).is_ok()
            })
        };
        barrier.wait();
        let closing = runtime.begin_shutdown().is_ok_and(|started| started);
        assert_ne!(preparing.join().unwrap(), closing);
    }

    #[test]
    fn operations_browser_updates_reach_frontend_without_changing_task_lifecycle() {
        let runtime = Runtime::new();
        runtime.inner.lock().unwrap().task_active = true;
        let message = json!({
            "event": "operations_browser_state",
            "state": {
                "url": "https://example.com/",
                "title": "Example Domain",
                "status": "ready",
                "canGoBack": false,
                "canGoForward": false,
            },
        });
        assert_eq!(
            runtime
                .receive(&serde_json::to_vec(&message).unwrap())
                .unwrap(),
            Some(message)
        );
        assert!(runtime.begin_shutdown().is_err());
    }

    #[test]
    fn exit_waits_for_start_acknowledgement_and_backend_task_cleanup() {
        let runtime = Runtime::new();
        // A lost/timed-out RPC receiver must not make an unacknowledged start safe to exit.
        runtime.inner.lock().unwrap().starting.insert(1);
        assert!(runtime.begin_shutdown().is_err());
        runtime
            .receive(br#"{"event":"desktop_state","state":{"task":null,"tasks":[{"runId":"run","threadId":"thread"}]}}"#)
            .unwrap();
        runtime
            .receive(br#"{"id":1,"result":{"runId":"run"}}"#)
            .unwrap();
        assert!(runtime.begin_shutdown().is_err());
        runtime
            .receive(br#"{"event":"desktop_state","state":{"task":null,"tasks":[]}}"#)
            .unwrap();
        assert!(runtime.begin_shutdown().unwrap());

        let runtime = Runtime::new();
        runtime.inner.lock().unwrap().starting.insert(2);
        runtime
            .receive(br#"{"event":"desktop_state","state":{"task":null,"tasks":[]}}"#)
            .unwrap();
        assert!(runtime.begin_shutdown().is_err());
        runtime
            .receive(br#"{"id":2,"result":{"runId":"run"}}"#)
            .unwrap();
        assert!(runtime.begin_shutdown().unwrap());

        let runtime = Runtime::new();
        runtime.prepare_run("failed".into()).unwrap();
        runtime.fail(Error::Unavailable("Runtime stopped").into());
        assert!(runtime.begin_shutdown().unwrap());
    }

    #[test]
    fn runtime_diagnostics_preserve_errors_and_exclude_untrusted_content() {
        use std::io::Write;
        #[derive(Clone)]
        struct Output(Arc<Mutex<Vec<u8>>>);
        impl Write for Output {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let output = Output(Arc::new(Mutex::new(Vec::new())));
        let writer = output.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let exercise = || {
            let runtime = Runtime::new();
            let ready = br#"{"event":"ready","private":"SECRET_READY"}"#;
            assert!(runtime.receive(ready).unwrap().is_some());
            assert!(runtime.receive(ready).unwrap().is_some());
            runtime.fail(IpcError {
                kind: "SECRET_REMOTE_KIND".into(),
                message: "SECRET_REMOTE_MESSAGE".into(),
            });
            let executor = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            let error = executor
                .block_on(runtime.request(
                    "SECRET_METHOD",
                    json!({"private":"SECRET_PARAMS"}),
                    Duration::ZERO,
                ))
                .unwrap_err();
            let Error::Remote(remote) = error else {
                panic!("original runtime error must be retained");
            };
            assert_eq!(remote.kind, "SECRET_REMOTE_KIND");
            assert_eq!(remote.message, "SECRET_REMOTE_MESSAGE");
        };
        // No subscriber and an installed subscriber must produce identical IPC outcomes.
        tracing::subscriber::with_default(tracing::subscriber::NoSubscriber::default(), exercise);
        tracing::subscriber::with_default(subscriber, exercise);
        let logs = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
        assert_eq!(logs.matches("phase=\"ready\"").count(), 1);
        assert!(logs.contains("phase=\"ipc\""));
        assert!(logs.contains("error_kind=\"runtime\""));
        assert!(!logs.contains("SECRET"));
    }

    #[test]
    fn privileged_runtime_methods_never_cross_ui_boundary() {
        assert!(validate_method("shutdown").is_err());
        assert!(validate_method("conversation_run").is_ok());
        assert!(validate_method("../unsafe").is_err());
    }

    #[test]
    fn external_links_reject_local_files_and_credentials() {
        assert!(external_url("https://example.com/path").is_ok());
        for value in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:secret@example.com",
        ] {
            assert!(external_url(value).is_err());
        }
    }

    #[test]
    fn runtime_routes_replies_and_keeps_user_data_out_of_unknown_errors() {
        let runtime = Runtime::new();
        let (sender, receiver) = oneshot::channel();
        runtime.inner.lock().unwrap().pending.insert(1, sender);
        runtime
            .receive(br#"{"id":1,"error":"private content"}"#)
            .unwrap();
        let error = receiver.blocking_recv().unwrap().unwrap_err();
        assert_eq!(error.message, "Agent runtime rejected the request");
        assert!(runtime.receive(br#"{"event":"ready"}"#).unwrap().is_some());
        assert!(runtime.inner.lock().unwrap().ready);
        assert!(
            runtime
                .receive(br#"{"event":"untrusted"}"#)
                .unwrap()
                .is_none()
        );
        assert!(
            runtime
                .receive(br#"{"event":"browser_host_request","id":1,"method":"create","pageId":"agent"}"#)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn credential_requests_never_reach_webview_or_consume_ui_replies() {
        let runtime = Runtime::new();
        let (sender, _receiver) = oneshot::channel();
        runtime.inner.lock().unwrap().pending.insert(1, sender);
        let request = json!({
            "event":"credential_request", "requestId":1, "id":1,
            "operation":"set", "reference":"../../other-app", "secret":"FIXTURE_PRIVATE_SECRET"
        });
        assert!(
            runtime
                .receive(&serde_json::to_vec(&request).unwrap())
                .unwrap()
                .is_none()
        );
        assert!(runtime.inner.lock().unwrap().pending.contains_key(&1));
        assert!(runtime.receive(br#"{"event":"credential_reply","requestId":1,"result":"FIXTURE_PRIVATE_SECRET"}"#).unwrap().is_none());
    }
}
