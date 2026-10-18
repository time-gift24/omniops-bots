#[path = "error.rs"]
pub(crate) mod error;
#[cfg(all(target_os = "macos", feature = "native-browser"))]
#[path = "native_browser.rs"]
pub(crate) mod native_browser;
#[cfg(all(target_os = "windows", feature = "native-browser"))]
#[path = "native_browser_windows.rs"]
pub(crate) mod native_browser;

use error::{Error, IpcError};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
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
use tokio::sync::oneshot;

type Reply = Result<Value, IpcError>;

struct Runtime {
    inner: Mutex<Inner>,
    next_id: AtomicU64,
}

struct Inner {
    child: Option<CommandChild>,
    ready: bool,
    error: Option<IpcError>,
    pending: HashMap<u64, oneshot::Sender<Reply>>,
    starting: Option<u64>,
    preparing: Option<String>,
    task_active: bool,
    shutting_down: bool,
    exit_allowed: bool,
}

impl Runtime {
    fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                child: None,
                ready: false,
                error: None,
                pending: HashMap::new(),
                starting: None,
                preparing: None,
                task_active: false,
                shutting_down: false,
                exit_allowed: false,
            }),
            next_id: AtomicU64::new(1),
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
        if inner.task_active
            || inner.starting.is_some()
            || inner.preparing.as_ref().is_some_and(|id| id != &run_id)
        {
            return Err(Error::Unavailable("Another task is still running"));
        }
        inner.preparing = Some(run_id);
        Ok(())
    }

    fn release_run(&self, run_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner.preparing.as_deref() == Some(run_id) {
            inner.preparing = None;
        }
    }

    fn begin_shutdown(&self) -> Result<bool, Error> {
        let mut inner = self.inner.lock().unwrap();
        if inner.shutting_down || inner.exit_allowed {
            return Ok(false);
        }
        if inner.preparing.is_some() || inner.starting.is_some() || inner.task_active {
            return Err(Error::Unavailable("A task is still running"));
        }
        inner.shutting_down = true;
        Ok(true)
    }

    fn fail(&self, error: IpcError) {
        let mut inner = self.inner.lock().unwrap();
        inner.ready = false;
        inner.error = Some(error.clone());
        inner.starting = None;
        inner.preparing = None;
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
            if method == "chat_start"
                && (inner.task_active
                    || inner.starting.is_some()
                    || inner.preparing.as_deref().is_some_and(|run_id| {
                        params.get("runId").and_then(Value::as_str) != Some(run_id)
                    }))
            {
                return Err(Error::Unavailable("Another task is still running"));
            }
            let child = inner
                .child
                .as_mut()
                .ok_or(Error::Unavailable("Agent runtime is unavailable"))?;
            let mut line =
                serde_json::to_vec(&json!({"id": id, "method": method, "params": params}))?;
            line.push(b'\n');
            if line.len() > 40 * 1024 * 1024 {
                return Err(Error::InvalidInput("Request is too large"));
            }
            child.write(&line)?;
            if method == "chat_start" {
                inner.preparing = None;
                inner.starting = Some(id);
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
        if let Some(id) = message["id"].as_u64() {
            let mut inner = self.inner.lock().unwrap();
            if inner.starting == Some(id) {
                inner.starting = None;
            }
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
                let task = message["state"]
                    .get("task")
                    .ok_or(Error::InvalidInput("Runtime task state is missing"))?;
                if !task.is_null() && !task.is_object() {
                    return Err(Error::InvalidInput("Runtime task state is invalid"));
                }
                self.inner.lock().unwrap().task_active = !task.is_null();
                Ok(Some(message))
            }
            Some("chat_event" | "runtime_exit" | "exit") => Ok(Some(message)),
            _ => Ok(None),
        }
    }

    fn terminated(&self) {
        let child = self.inner.lock().unwrap().child.take();
        if let Some(child) = child {
            kill_child(child);
        }
        self.fail(Error::Unavailable("Agent runtime stopped").into());
    }

    async fn shutdown(&self) {
        self.inner.lock().unwrap().shutting_down = true;
        let graceful = async {
            let _ = self
                .request("shutdown", Value::Null, Duration::from_millis(11_500))
                .await;
            while self.inner.lock().unwrap().child.is_some() {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        };
        if tokio::time::timeout(Duration::from_secs(12), graceful)
            .await
            .is_err()
        {
            if let Some(child) = self.inner.lock().unwrap().child.take() {
                kill_child(child);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
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

#[derive(Clone, Copy, Deserialize)]
struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    interactive: bool,
}

#[tauri::command]
async fn browser_set_bounds(app: tauri::AppHandle, bounds: BrowserBounds) -> Result<(), IpcError> {
    native_browser::set_bounds(
        app,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        bounds.visible,
        bounds.interactive,
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
    connection: native_browser::Connection,
) -> Result<(), Error> {
    let script = app.path().resource_dir()?.join("runtime/main.mjs");
    if !script.is_file() {
        return Err(Error::Unavailable("Bundled agent runtime is missing"));
    }
    let (mut receiver, child) = app
        .shell()
        .sidecar("omniops-bots-node")?
        .arg(script)
        .env("OMNIOPS_BOTS_DATA_DIR", data_dir)
        .env("OMNIOPS_BOTS_BROWSER_CDP_ENDPOINT", connection.endpoint)
        .env("OMNIOPS_BOTS_BROWSER_TARGET_ID", connection.target_id)
        .set_process_group(true)
        .spawn()?;
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

async fn close_native_browser(app: &tauri::AppHandle) {
    let (sender, receiver) = oneshot::channel();
    if app
        .run_on_main_thread(move || {
            let _ = sender.send(native_browser::begin_close());
        })
        .is_err()
    {
        return;
    }
    if !matches!(receiver.await, Ok(Ok(()))) {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    while !native_browser::is_closed() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
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
    native_browser::prepare_framework().inspect_err(|error| {
        tracing::warn!(
            component = "browser",
            phase = "startup",
            error_kind = error.diagnostic_kind()
        );
    })?;
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            runtime_request,
            runtime_prepare_run,
            runtime_release_run,
            browser_set_bounds,
            host_copy_text,
            host_open_external,
            host_confirm
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let runtime = Arc::new(Runtime::new());
            app.manage(runtime.clone());
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
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = match native_browser::wait_ready(Duration::from_secs(15)).await {
                    Ok(connection) => start_runtime(&handle, runtime.clone(), data_dir, connection),
                    Err(error) => Err(error),
                };
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
                    runtime.shutdown().await;
                    close_native_browser(&app).await;
                    runtime.inner.lock().unwrap().exit_allowed = true;
                    app.exit(code.unwrap_or(0));
                });
            }
            RunEvent::Exit => {
                let needs_shutdown = !runtime.inner.lock().unwrap().exit_allowed;
                if needs_shutdown {
                    tauri::async_runtime::block_on(runtime.shutdown());
                }
            }
            _ => {}
        }
    });
    native_browser::finish_shutdown()?;
    Ok(exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_preparation_and_shutdown_cannot_both_acquire_the_host() {
        let runtime = Runtime::new();
        runtime.prepare_run("preparing".into()).unwrap();
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
    fn exit_waits_for_start_acknowledgement_and_backend_task_cleanup() {
        let runtime = Runtime::new();
        // A lost/timed-out RPC receiver must not make an unacknowledged start safe to exit.
        runtime.inner.lock().unwrap().starting = Some(1);
        assert!(runtime.begin_shutdown().is_err());
        runtime
            .receive(br#"{"event":"desktop_state","state":{"task":{"runId":"run"}}}"#)
            .unwrap();
        runtime
            .receive(br#"{"id":1,"result":{"runId":"run"}}"#)
            .unwrap();
        assert!(runtime.begin_shutdown().is_err());
        runtime
            .receive(br#"{"event":"desktop_state","state":{"task":null}}"#)
            .unwrap();
        assert!(runtime.begin_shutdown().unwrap());

        let runtime = Runtime::new();
        runtime.inner.lock().unwrap().starting = Some(2);
        runtime
            .receive(br#"{"event":"desktop_state","state":{"task":null}}"#)
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
    }
}
