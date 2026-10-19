//! Windows CEF Alloy child HWND; the application UI remains in WebView2.
//! Start through CEF's sandbox bootstrap.exe + application DLL, never a second helper EXE.
use super::error::Error;
use cef::*;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    net::{Ipv4Addr, TcpListener},
    sync::{LazyLock, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HWND, RECT},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
        Threading::{GetCurrentProcess, GetCurrentThreadId},
    },
    UI::{
        HiDpi::GetDpiForWindow,
        Input::KeyboardAndMouse::{EnableWindow, GetFocus},
        WindowsAndMessaging::{
            DestroyWindow, GetClientRect, GetWindowThreadProcessId, HWND_TOP, IsChild, IsWindow,
            KillTimer, SW_HIDE, SWP_NOACTIVATE, SWP_SHOWWINDOW, SetTimer, SetWindowPos, ShowWindow,
            WS_VISIBLE,
        },
    },
};

#[derive(Clone, Debug)]
pub struct Connection {
    pub endpoint: String,
    pub target_id: String,
}

pub enum Initialization {
    Ready,
    AlreadyRunning,
}

const MANUAL_PAGE: &str = "__manual__";

#[derive(Default)]
struct PageStatus {
    target_id: Option<String>,
    error: Option<String>,
    closing: bool,
    #[cfg(debug_assertions)]
    evaluation: Option<tokio::sync::oneshot::Sender<Result<serde_json::Value, Error>>>,
}

struct NativePage {
    browser: Browser,
    observer: Option<Registration>,
    applied_bounds: Option<PhysicalBounds>,
}

struct Shared {
    endpoint: String,
    pages: HashMap<String, PageStatus>,
    error: Option<String>,
    closing: bool,
    closed: bool,
}
static SHARED: LazyLock<Mutex<Shared>> = LazyLock::new(|| {
    Mutex::new(Shared {
        endpoint: String::new(),
        pages: HashMap::new(),
        error: None,
        closing: false,
        closed: true,
    })
});
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
static UI_THREAD: OnceLock<u32> = OnceLock::new();
// Intentionally retained until OS process teardown: closing our own job earlier kills us.
static PROCESS_JOB: OnceLock<usize> = OnceLock::new();
thread_local! {
    static SANDBOX_INFO: Cell<*mut u8> = const { Cell::new(std::ptr::null_mut()) };
    static INSTANCE: Cell<cef::sys::HINSTANCE> = const { Cell::new(cef::sys::HINSTANCE(std::ptr::null_mut())) };
    static PAGES: RefCell<HashMap<String, NativePage>> = RefCell::new(HashMap::new());
    static SELECTED_PAGE: RefCell<String> = RefCell::new(MANUAL_PAGE.to_owned());
    static PARENT: Cell<HWND> = const { Cell::new(std::ptr::null_mut()) };
    static DESTROY_WINDOWS: RefCell<Vec<HWND>> = const { RefCell::new(Vec::new()) };
    static TIMER: Cell<usize> = const { Cell::new(0) };
    static INITIALIZED: Cell<bool> = const { Cell::new(false) };
    static CONTEXT_READY: Cell<bool> = const { Cell::new(false) };
    static PUMPING: Cell<bool> = const { Cell::new(false) };
    static LAST_BOUNDS: Cell<Bounds> = const { Cell::new(Bounds { x:0., y:0., width:0., height:0., visible:false, interactive:false }) };
}

fn main_thread() -> Result<(), Error> {
    if UI_THREAD.get().copied() == Some(unsafe { GetCurrentThreadId() }) {
        Ok(())
    } else {
        Err("CEF operation must run on the Windows application thread".into())
    }
}

fn win_error(operation: &'static str) -> Error {
    Error::NativeIo {
        operation,
        source: std::io::Error::last_os_error(),
    }
}

fn fail(message: impl Into<Error>) {
    let message = message.into().to_string();
    let mut state = SHARED.lock().unwrap();
    if state.error.as_ref() != Some(&message) {
        state.error = Some(message);
    }
}

/// The DLL's RunWinMain must call this before constructing Tauri.
/// `Some(code)` is a CEF sub-process: return that code immediately.
///
/// # Safety
/// Pass the original instance and sandbox_info from CEF's official bootstrap.
/// The bootstrap owns sandbox_info and must outlive initialize and shutdown.
pub unsafe fn prepare_bootstrap(
    instance: cef::sys::HINSTANCE,
    sandbox_info: *mut u8,
) -> Result<Option<i32>, Error> {
    if sandbox_info.is_null() || instance.0.is_null() {
        return Err("Windows native browser requires the CEF sandbox bootstrap".into());
    }
    UI_THREAD
        .set(unsafe { GetCurrentThreadId() })
        .map_err(|_| "CEF bootstrap was already initialized")?;
    if cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0).is_null() {
        return Err("Bundled CEF API version does not match the Rust bindings".into());
    }
    let code = cef::execute_process(Some(&MainArgs { instance }), None, sandbox_info);
    if code >= 0 {
        return Ok(Some(code));
    }
    INSTANCE.set(instance);
    SANDBOX_INFO.set(sandbox_info);
    Ok(None)
}

/// libcef.dll is an import dependency loaded alongside our DLL by bootstrap.exe.
/// Fail closed if launch bypassed that entry point or process-tree containment fails.
pub fn prepare_framework() -> Result<(), Error> {
    main_thread()?;
    if SANDBOX_INFO.get().is_null() {
        return Err("CEF sandbox bootstrap information is missing".into());
    }
    if PROCESS_JOB.get().is_some() {
        return Ok(());
    }
    unsafe {
        // NULL attributes make this handle non-inheritable. Child CEF/Node jobs
        // remain nested under this job on supported Windows 10/11 systems.
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(win_error("Create native browser process job"));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) == 0
        {
            let error = win_error("Configure native browser process job");
            CloseHandle(job);
            return Err(error);
        }
        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            let error = win_error("Contain native browser process tree");
            CloseHandle(job);
            return Err(error);
        }
        // Do not CloseHandle after successful assignment: the current process
        // belongs to this job too. OS teardown closes the last handle on exit/crash.
        let _ = PROCESS_JOB.set(job as usize);
    }
    Ok(())
}

fn focus_application_webview() {
    if SHARED.lock().unwrap().closing {
        return;
    }
    if let Some(app) = APP_HANDLE.get().cloned() {
        // Tauri focus can synchronously dispatch to its UI thread; never block
        // from a CEF callback or while a native window message is being handled.
        tauri::async_runtime::spawn(async move {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.as_ref().set_focus();
            }
        });
    }
}

fn page_fail(page_id: &str, message: impl Into<Error>) {
    if let Some(page) = SHARED.lock().unwrap().pages.get_mut(page_id) {
        page.error = Some(message.into().to_string());
    }
}

wrap_dev_tools_message_observer! {
    struct TargetObserver { page_id: String }
    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self, _browser: Option<&mut Browser>, message_id: i32,
            success: i32, result: Option<&[u8]>) {
            #[cfg(debug_assertions)]
            if message_id >= 2 {
                let sender = SHARED.lock().unwrap().pages.get_mut(&self.page_id)
                    .and_then(|page| page.evaluation.take());
                if let Some(sender) = sender {
                    let result = if success == 1 {
                        result.and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
                            .ok_or_else(|| Error::from("CEF smoke evaluation returned invalid JSON"))
                    } else { Err(Error::from("CEF smoke evaluation failed")) };
                    let _ = sender.send(result);
                }
                return;
            }
            if message_id != 1 { return; }
            let parsed = result.and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok());
            let target = parsed.as_ref().and_then(|value| value["targetInfo"]["targetId"].as_str());
            match (success, target.filter(|id| !id.is_empty())) {
                (1, Some(id)) => {
                    if let Some(page) = SHARED.lock().unwrap().pages.get_mut(&self.page_id) {
                        page.target_id = Some(id.to_owned());
                    }
                }
                _ => page_fail(&self.page_id, "CEF did not return a DevTools target ID"),
            }
        }
    }
}

wrap_life_span_handler! {
    struct BrowserLife { page_id: String }
    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser else { page_fail(&self.page_id, "CEF created no browser"); return; };
            PAGES.with(|pages| {
                pages.borrow_mut().insert(self.page_id.clone(), NativePage {
                    browser: browser.clone(), observer: None,
                    applied_bounds: None,
                });
            });
            let Some(host) = browser.host() else { page_fail(&self.page_id, "CEF browser host unavailable"); return; };
            let closing = {
                let state = SHARED.lock().unwrap();
                state.closing || state.pages.get(&self.page_id).is_none_or(|page| page.closing)
            };
            if closing { host.close_browser(1); return; }
            host.set_accessibility_state(cef::State::ENABLED);
            if let Err(error) = apply_bounds(LAST_BOUNDS.get()) { page_fail(&self.page_id, error); }
            let registration = host.add_dev_tools_message_observer(Some(&mut TargetObserver::new(self.page_id.clone())));
            if registration.is_none() { page_fail(&self.page_id, "CEF DevTools observer registration failed"); return; }
            PAGES.with(|pages| {
                if let Some(page) = pages.borrow_mut().get_mut(&self.page_id) { page.observer = registration; }
            });
            if host.execute_dev_tools_method(1, Some(&"Target.getTargetInfo".into()), None) != 1 {
                page_fail(&self.page_id, "CEF rejected the DevTools target query");
            }
        }
        fn do_close(&self, browser: Option<&mut Browser>) -> i32 {
            // CEF's default closes the parent application window. Remove only this child.
            if let Some(host) = browser.and_then(|browser| browser.host()) {
                DESTROY_WINDOWS.with(|windows| windows.borrow_mut().push(host.window_handle().0.cast()));
            }
            1
        }
        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            PAGES.with(|pages| pages.borrow_mut().remove(&self.page_id));
            let mut state = SHARED.lock().unwrap();
            state.pages.remove(&self.page_id);
            state.closed = state.closing && state.pages.is_empty();
        }
        fn on_before_popup(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>,
            _popup_id: i32, _target_url: Option<&CefString>, _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition, _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>, _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>, _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>, _no_javascript_access: Option<&mut i32>) -> i32 {
            1
        }
    }
}

wrap_focus_handler! {
    struct BrowserFocus { page_id: String }
    impl FocusHandler {
        fn on_set_focus(&self, _browser: Option<&mut Browser>, source: FocusSource) -> i32 {
            // Only the selected, explicitly unlocked page can receive native input.
            i32::from(source == FocusSource::NAVIGATION || !LAST_BOUNDS.get().visible
                || !LAST_BOUNDS.get().interactive || SHARED.lock().unwrap().closing
                || SELECTED_PAGE.with(|selected| *selected.borrow() != self.page_id))
        }
        fn on_take_focus(&self, _browser: Option<&mut Browser>, _next: i32) {
            focus_application_webview();
        }
    }
}

wrap_client! {
    struct BrowserClient { page_id: String }
    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(BrowserLife::new(self.page_id.clone())) }
        fn focus_handler(&self) -> Option<FocusHandler> { Some(BrowserFocus::new(self.page_id.clone())) }
    }
}

wrap_browser_process_handler! {
    struct BrowserProcess;
    impl BrowserProcessHandler {
        fn on_already_running_app_relaunch(&self, _command_line: Option<&mut CommandLine>,
            _current_directory: Option<&CefString>) -> i32 {
            if !SHARED.lock().unwrap().closing && let Some(app) = APP_HANDLE.get().cloned() {
                tauri::async_runtime::spawn(async move {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            }
            // Suppress CEF's unmanaged standalone Chrome window on duplicate launch.
            1
        }
        fn on_context_initialized(&self) {
            CONTEXT_READY.set(true);
            if SHARED.lock().unwrap().closing {
                SHARED.lock().unwrap().closed = true;
                return;
            }
            if let Err(error) = create_page_on_main(MANUAL_PAGE) {
                SHARED.lock().unwrap().closed = true;
                fail(error);
            }
        }
        fn on_schedule_message_pump_work(&self, _delay_ms: i64) {
            // shortcut: 16 ms UI-thread timer; use CEF's scheduled pump when optimizing idle CPU.
        }
    }
}

wrap_app! {
    struct BrowserApp;
    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> { Some(BrowserProcess::new()) }
        fn on_before_command_line_processing(&self, _process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            if let Some(command_line) = command_line {
                command_line.append_switch_with_value(Some(&"remote-debugging-address".into()), Some(&"127.0.0.1".into()));
            }
        }
    }
}

unsafe extern "system" fn timer_tick(_window: HWND, _message: u32, _id: usize, _time: u32) {
    pump_tick();
}

fn pump_tick() {
    if !INITIALIZED.get() || PUMPING.replace(true) {
        return;
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            PUMPING.set(false);
        }
    }
    let _reset = Reset;
    let children = DESTROY_WINDOWS.with(|windows| std::mem::take(&mut *windows.borrow_mut()));
    for child in children {
        if !child.is_null()
            && unsafe { IsWindow(child) } != 0
            && unsafe { DestroyWindow(child) } == 0
        {
            fail(win_error("Destroy CEF child window"));
        }
    }
    // A monitor DPI change may leave the DOM's CSS rect unchanged. Re-read native
    // metrics; apply_bounds skips SetWindowPos when the physical rectangle is unchanged.
    if !SHARED.lock().unwrap().closing
        && let Err(error) = apply_bounds(LAST_BOUNDS.get())
    {
        fail(error);
    }
    cef::do_message_loop_work();
}

fn start_pump() -> Result<(), Error> {
    // NULL HWND gives a unique thread timer; Tao DispatchMessage invokes TIMERPROC.
    let timer = unsafe { SetTimer(std::ptr::null_mut(), 0, 16, Some(timer_tick)) };
    if timer == 0 {
        return Err(win_error("Start CEF message pump"));
    }
    TIMER.set(timer);
    Ok(())
}

fn stop_pump() {
    let timer = TIMER.replace(0);
    if timer != 0 {
        unsafe {
            KillTimer(std::ptr::null_mut(), timer);
        }
    }
}

pub fn initialize(window: &tauri::WebviewWindow) -> Result<Initialization, Error> {
    main_thread()?;
    if INITIALIZED.get() {
        return Err("Native browser is already initialized".into());
    }
    if SANDBOX_INFO.get().is_null() {
        return Err("CEF sandbox bootstrap information is missing".into());
    }
    APP_HANDLE
        .set(window.app_handle().clone())
        .map_err(|_| "Native browser application handle is already set")?;
    let parent = window.hwnd()?.0;
    if unsafe { GetWindowThreadProcessId(parent, std::ptr::null_mut()) }
        != unsafe { GetCurrentThreadId() }
    {
        return Err("Tauri and CEF must share the same Windows UI thread".into());
    }
    PARENT.set(parent);
    let cache_dir = window.app_handle().path().app_data_dir()?;
    let root_cache = if std::env::var_os("OMNIOPS_BOTS_SMOKE_REPORT").is_some() {
        std::env::var_os("OMNIOPS_BOTS_SMOKE_DATA_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or(cache_dir)
    } else {
        cache_dir
    }
    .join("cef");
    let profile = root_cache.join("browser-profile");
    std::fs::create_dir_all(&profile)?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    *SHARED.lock().unwrap() = Shared {
        endpoint: format!("http://127.0.0.1:{port}"),
        pages: HashMap::new(),
        error: None,
        closing: false,
        closed: false,
    };
    // CEF cannot inherit this socket. Node attaches only to the exact target ID,
    // so a failure to claim the port fails closed instead of selecting another page.
    drop(listener);
    let settings = Settings {
        no_sandbox: 0,
        external_message_pump: 1,
        multi_threaded_message_loop: 0,
        command_line_args_disabled: 1,
        remote_debugging_port: i32::from(port),
        root_cache_path: root_cache.to_string_lossy().as_ref().into(),
        cache_path: profile.to_string_lossy().as_ref().into(),
        persist_session_cookies: 1,
        log_severity: LogSeverity::DISABLE,
        // Sandbox requires the same bootstrap executable for browser and subprocesses.
        ..Default::default()
    };
    start_pump()?;
    if cef::initialize(
        Some(&MainArgs {
            instance: INSTANCE.get(),
        }),
        Some(&settings),
        Some(&mut BrowserApp::new()),
        SANDBOX_INFO.get(),
    ) != 1
    {
        stop_pump();
        let code = cef::get_exit_code();
        SHARED.lock().unwrap().closed = true;
        if code == Resultcode::NORMAL_EXIT_PROCESS_NOTIFIED.get_raw() as i32 {
            return Ok(Initialization::AlreadyRunning);
        }
        let error = format!("CEF initialization failed with exit code {code}");
        fail(error.clone());
        return Err(error.into());
    }
    INITIALIZED.set(true);
    Ok(Initialization::Ready)
}

pub async fn wait_ready(timeout: Duration) -> Result<Connection, Error> {
    wait_page(MANUAL_PAGE, timeout).await
}

fn validate_page_id(page_id: &str) -> Result<(), Error> {
    if page_id.trim().is_empty() || page_id.len() > 256 || page_id.chars().any(char::is_control) {
        return Err(Error::InvalidInput("Browser page ID is invalid"));
    }
    Ok(())
}

fn create_page_on_main(page_id: &str) -> Result<bool, Error> {
    main_thread()?;
    {
        let mut state = SHARED.lock().unwrap();
        if state.closing || !CONTEXT_READY.get() {
            return Err("Native browser is unavailable".into());
        }
        if let Some(page) = state.pages.get(page_id) {
            return if page.closing {
                Err("Browser page is closing".into())
            } else {
                Ok(false)
            };
        }
        state
            .pages
            .insert(page_id.to_owned(), PageStatus::default());
    }
    let mut info = WindowInfo {
        runtime_style: RuntimeStyle::ALLOY,
        ..Default::default()
    }
    .set_as_child(
        cef::sys::HWND(PARENT.get().cast()),
        &Rect {
            x: 0,
            y: 0,
            width: 1280,
            height: 800,
        },
    );
    info.style &= !WS_VISIBLE;
    // The default CEF RequestContext shares the dedicated profile's login state.
    if browser_host_create_browser(
        Some(&info),
        Some(&mut BrowserClient::new(page_id.to_owned())),
        Some(&"about:blank".into()),
        Some(&BrowserSettings::default()),
        None,
        None,
    ) != 1
    {
        SHARED.lock().unwrap().pages.remove(page_id);
        return Err("CEF rejected native browser page creation".into());
    }
    Ok(true)
}

async fn wait_page(page_id: &str, timeout: Duration) -> Result<Connection, Error> {
    let deadline = Instant::now() + timeout;
    loop {
        {
            let state = SHARED.lock().unwrap();
            if let Some(error) = &state.error {
                return Err(Error::Native(error.clone()));
            }
            if state.closing || state.closed {
                return Err("Native browser is closing or unavailable".into());
            }
            if let Some(page) = state.pages.get(page_id) {
                if let Some(error) = &page.error {
                    return Err(Error::Native(error.clone()));
                }
                if page.closing {
                    return Err("Browser page is closing".into());
                }
                if let Some(target_id) = &page.target_id {
                    return Ok(Connection {
                        endpoint: state.endpoint.clone(),
                        target_id: target_id.clone(),
                    });
                }
            } else if page_id != MANUAL_PAGE {
                return Err("Browser page is unavailable".into());
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Native browser target readiness timed out".into());
        }
        tokio::time::sleep(remaining.min(Duration::from_millis(25))).await;
    }
}

pub async fn create_page(app: tauri::AppHandle, page_id: String) -> Result<Connection, Error> {
    validate_page_id(&page_id)?;
    let requested = page_id.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(create_page_on_main(&requested));
    })?;
    let created = rx
        .await
        .map_err(|_| "Native browser page callback was cancelled".to_owned())??;
    match wait_page(&page_id, Duration::from_secs(15)).await {
        Ok(connection) => Ok(connection),
        Err(error) => {
            if created && page_id != MANUAL_PAGE {
                let _ = release_page(app, page_id).await;
            }
            Err(error)
        }
    }
}

pub async fn select_page(app: tauri::AppHandle, page_id: String) -> Result<(), Error> {
    validate_page_id(&page_id)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            let state = SHARED.lock().unwrap();
            let page = state
                .pages
                .get(&page_id)
                .ok_or("Browser page is unavailable")?;
            if state.closing || page.closing || page.target_id.is_none() {
                return Err("Browser page is unavailable".into());
            }
            drop(state);
            SELECTED_PAGE.with(|selected| *selected.borrow_mut() = page_id);
            // A bounds update from the new page must explicitly unlock native input.
            apply_bounds(Bounds {
                interactive: false,
                ..LAST_BOUNDS.get()
            })
        })();
        let _ = tx.send(result);
    })?;
    rx.await
        .map_err(|_| "Native browser selection callback was cancelled".to_owned())?
}

pub async fn release_page(app: tauri::AppHandle, page_id: String) -> Result<(), Error> {
    validate_page_id(&page_id)?;
    if page_id == MANUAL_PAGE {
        return Err(Error::InvalidInput(
            "The manual browser page cannot be released",
        ));
    }
    let released = page_id.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = {
            {
                let mut state = SHARED.lock().unwrap();
                if let Some(page) = state.pages.get_mut(&page_id) {
                    page.closing = true;
                }
            }
            if SELECTED_PAGE.with(|selected| *selected.borrow() == page_id) {
                SELECTED_PAGE.with(|selected| *selected.borrow_mut() = MANUAL_PAGE.to_owned());
            }
            let browser = PAGES.with(|pages| {
                pages
                    .borrow()
                    .get(&page_id)
                    .map(|page| page.browser.clone())
            });
            if let Some(host) = browser.and_then(|browser| browser.host()) {
                host.close_browser(1);
            }
            apply_bounds(LAST_BOUNDS.get())
        };
        let _ = tx.send(result);
    })?;
    rx.await
        .map_err(|_| "Native browser release callback was cancelled".to_owned())??;
    let deadline = Instant::now() + Duration::from_secs(5);
    while SHARED.lock().unwrap().pages.contains_key(&released) {
        if Instant::now() >= deadline {
            return Err("Native browser page release timed out".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(())
}

#[cfg(debug_assertions)]
pub async fn smoke_navigate(
    app: tauri::AppHandle,
    page_id: String,
    url: String,
) -> Result<(), Error> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            let frame = PAGES
                .with(|pages| {
                    pages
                        .borrow()
                        .get(&page_id)
                        .and_then(|page| page.browser.main_frame())
                })
                .ok_or_else(|| Error::from("Smoke page frame is unavailable"))?;
            frame.load_url(Some(&url.as_str().into()));
            Ok(())
        })();
        let _ = tx.send(result);
    })?;
    rx.await
        .map_err(|_| Error::from("Smoke navigation callback was cancelled"))?
}

/// Debug-only real CEF check; no browser/model service or external network is required.
#[cfg(debug_assertions)]
pub async fn smoke_evaluate(
    app: tauri::AppHandle,
    page_id: String,
    expression: String,
) -> Result<serde_json::Value, Error> {
    static NEXT_ID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(2);
    let message_id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result: Result<(), Error> = (|| {
            let browser = PAGES
                .with(|pages| {
                    pages
                        .borrow()
                        .get(&page_id)
                        .map(|page| page.browser.clone())
                })
                .ok_or("Smoke browser page is unavailable")?;
            let host = browser.host().ok_or("Smoke browser host is unavailable")?;
            {
                let mut state = SHARED.lock().unwrap();
                state
                    .pages
                    .get_mut(&page_id)
                    .ok_or("Smoke page state is unavailable")?
                    .evaluation = Some(tx);
            }
            let mut params = dictionary_value_create()
                .ok_or("CEF smoke evaluation parameters are unavailable")?;
            params.set_string(
                Some(&"expression".into()),
                Some(&expression.as_str().into()),
            );
            params.set_bool(Some(&"returnByValue".into()), 1);
            let assigned = host.execute_dev_tools_method(
                message_id,
                Some(&"Runtime.evaluate".into()),
                Some(&mut params),
            );
            if assigned != message_id {
                return Err(format!(
                    "CEF rejected smoke evaluation: expected {message_id}, assigned {assigned}"
                )
                .into());
            }
            Ok(())
        })();
        let _ = started_tx.send(result);
    })?;
    started_rx
        .await
        .map_err(|_| Error::from("CEF smoke callback was cancelled"))??;
    let result = tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .map_err(|_| {
            Error::from(format!(
                "CEF smoke evaluation response timed out (request {message_id})"
            ))
        })?
        .map_err(|_| Error::from("CEF smoke evaluation was cancelled"))??;
    if result.get("exceptionDetails").is_some() {
        return Err("CEF smoke JavaScript failed".into());
    }
    Ok(result["result"]["value"].clone())
}

/// Run on the main thread after Node and its CDP clients have disconnected.
pub fn begin_close() -> Result<(), Error> {
    main_thread()?;
    {
        let mut state = SHARED.lock().unwrap();
        if state.closing || state.closed {
            return Ok(());
        }
        state.closing = true;
        for page in state.pages.values_mut() {
            page.closing = true;
        }
        state.closed = CONTEXT_READY.get() && state.pages.is_empty();
    }
    let browsers: Vec<_> = PAGES.with(|pages| {
        pages
            .borrow()
            .values()
            .map(|page| page.browser.clone())
            .collect()
    });
    for browser in browsers {
        if let Some(host) = browser.host() {
            host.close_browser(1);
        }
    }
    Ok(())
}

pub fn is_closed() -> bool {
    SHARED.lock().unwrap().closed
}

pub fn finish_shutdown() -> Result<(), Error> {
    main_thread()?;
    if !INITIALIZED.get() {
        return Ok(());
    }
    if !is_closed() {
        begin_close()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while !is_closed() && Instant::now() < deadline {
            pump_tick();
            std::thread::sleep(Duration::from_millis(10));
        }
        if !is_closed() {
            return Err("CEF shutdown refused before on_before_close".into());
        }
    }
    stop_pump();
    INITIALIZED.set(false);
    PAGES.with(|pages| pages.borrow_mut().clear());
    cef::shutdown();
    PARENT.set(std::ptr::null_mut());
    SANDBOX_INFO.set(std::ptr::null_mut());
    Ok(())
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Bounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) visible: bool,
    pub(crate) interactive: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PhysicalBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    visible: bool,
    interactive: bool,
}

fn validate_bounds(bounds: Bounds) -> Result<(), Error> {
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|value| value.is_finite() && value.abs() <= 100_000.)
        || bounds.width < 0.
        || bounds.height < 0.
    {
        return Err("Browser bounds must be finite CSS pixels with non-negative dimensions".into());
    }
    Ok(())
}

fn physical_bounds(
    bounds: Bounds,
    dpi: u32,
    client_width: i32,
    client_height: i32,
) -> PhysicalBounds {
    let scale = f64::from(dpi) / 96.;
    let left = (bounds.x * scale)
        .round()
        .clamp(0., f64::from(client_width.max(0))) as i32;
    let top = (bounds.y * scale)
        .round()
        .clamp(0., f64::from(client_height.max(0))) as i32;
    let right = ((bounds.x + bounds.width) * scale)
        .round()
        .clamp(f64::from(left), f64::from(client_width.max(0))) as i32;
    let bottom = ((bounds.y + bounds.height) * scale)
        .round()
        .clamp(f64::from(top), f64::from(client_height.max(0))) as i32;
    PhysicalBounds {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        visible: bounds.visible && right > left && bottom > top,
        interactive: bounds.interactive,
    }
}

fn apply_bounds(bounds: Bounds) -> Result<(), Error> {
    main_thread()?;
    LAST_BOUNDS.set(bounds);
    let selected = SELECTED_PAGE.with(|selected| selected.borrow().clone());
    let pages: Vec<_> = PAGES.with(|pages| {
        pages
            .borrow()
            .iter()
            .map(|(id, page)| (id.clone(), page.browser.clone()))
            .collect()
    });
    for (id, browser) in pages {
        let owned = id == selected;
        apply_page_bounds(
            &id,
            browser,
            Bounds {
                visible: bounds.visible && owned,
                interactive: bounds.interactive && owned,
                ..bounds
            },
        )?;
    }
    Ok(())
}

fn apply_page_bounds(page_id: &str, browser: Browser, bounds: Bounds) -> Result<(), Error> {
    let Some(host) = browser.host() else {
        return Ok(());
    };
    let child: HWND = host.window_handle().0.cast();
    if child.is_null() || unsafe { IsWindow(child) } == 0 {
        return Err("Native browser HWND is unavailable".into());
    }
    let parent = PARENT.get();
    let mut client: RECT = unsafe { std::mem::zeroed() };
    if unsafe { GetClientRect(parent, &mut client) } == 0 {
        return Err(win_error("Read application client bounds"));
    }
    let dpi = unsafe { GetDpiForWindow(parent) };
    if dpi == 0 {
        return Err("Application window DPI is unavailable".into());
    }
    let frame = physical_bounds(
        bounds,
        dpi,
        client.right - client.left,
        client.bottom - client.top,
    );
    if PAGES.with(|pages| {
        pages
            .borrow()
            .get(page_id)
            .and_then(|page| page.applied_bounds)
    }) == Some(frame)
    {
        return Ok(());
    }
    let focus = unsafe { GetFocus() };
    let held_focus = focus == child || unsafe { IsChild(child, focus) } != 0;
    // Disable the real child HWND (and its descendants), not just the WebView toolbar.
    unsafe {
        EnableWindow(child, i32::from(frame.interactive && frame.visible));
    }
    if held_focus && (!frame.interactive || !frame.visible) {
        host.set_focus(0);
        focus_application_webview();
    }
    if frame.visible {
        // Native child coordinates are physical client pixels; CSS is logical at
        // WebView2's default zoom. Win32 client space already excludes the title bar.
        if unsafe {
            SetWindowPos(
                child,
                HWND_TOP,
                frame.x,
                frame.y,
                frame.width,
                frame.height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        } == 0
        {
            return Err(win_error("Position CEF child window"));
        }
    } else {
        unsafe {
            ShowWindow(child, SW_HIDE);
        }
    }
    PAGES.with(|pages| {
        if let Some(page) = pages.borrow_mut().get_mut(page_id) {
            page.applied_bounds = Some(frame);
        }
    });
    Ok(())
}

pub(crate) async fn set_bounds(
    app: tauri::AppHandle,
    page_id: String,
    bounds: Bounds,
) -> Result<(), Error> {
    validate_page_id(&page_id)?;
    validate_bounds(bounds)?;
    if SHARED.lock().unwrap().closing {
        return Err("Native browser is closing".into());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = if SHARED.lock().unwrap().closing {
            Err("Native browser is closing".into())
        } else if SELECTED_PAGE.with(|selected| *selected.borrow() == page_id) {
            apply_bounds(bounds)
        } else {
            Ok(())
        };
        let _ = tx.send(result);
    })?;
    rx.await
        .map_err(|_| "Native browser bounds callback was cancelled".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_page_ids_are_validated_at_the_host_boundary() {
        assert!(validate_page_id(MANUAL_PAGE).is_ok());
        assert!(validate_page_id("thread-a").is_ok());
        for page_id in ["", " ", "thread\nother"] {
            assert!(validate_page_id(page_id).is_err());
        }
        assert!(validate_page_id(&"x".repeat(257)).is_err());
    }

    #[test]
    fn css_bounds_scale_to_physical_client_pixels_without_titlebar_offset() {
        let bounds = Bounds {
            x: 797.5,
            y: 84.,
            width: 451.5,
            height: 744.,
            visible: true,
            interactive: true,
        };
        assert_eq!(
            physical_bounds(bounds, 96, 1249, 828),
            PhysicalBounds {
                x: 798,
                y: 84,
                width: 451,
                height: 744,
                visible: true,
                interactive: true
            }
        );
        assert_eq!(
            physical_bounds(bounds, 144, 1874, 1242),
            PhysicalBounds {
                x: 1196,
                y: 126,
                width: 678,
                height: 1116,
                visible: true,
                interactive: true
            }
        );
        assert_eq!(
            physical_bounds(bounds, 192, 2498, 1656),
            PhysicalBounds {
                x: 1595,
                y: 168,
                width: 903,
                height: 1488,
                visible: true,
                interactive: true
            }
        );
    }

    #[test]
    fn clips_edges_and_hides_empty_or_occluded_views() {
        let bounds = Bounds {
            x: -20.,
            y: 750.,
            width: 100.,
            height: 100.,
            visible: true,
            interactive: true,
        };
        assert_eq!(
            physical_bounds(bounds, 144, 1800, 1200),
            PhysicalBounds {
                x: 0,
                y: 1125,
                width: 120,
                height: 75,
                visible: true,
                interactive: true
            }
        );
        assert!(
            !physical_bounds(
                Bounds {
                    visible: false,
                    ..bounds
                },
                144,
                1800,
                1200
            )
            .visible
        );
        assert!(!physical_bounds(bounds, 144, 0, 0).visible);
        assert!(!physical_bounds(Bounds { x: 1300., ..bounds }, 144, 1800, 1200).visible);
    }

    #[test]
    fn rejects_invalid_ipc_bounds() {
        let bounds = Bounds {
            x: 0.,
            y: 0.,
            width: 1.,
            height: 1.,
            visible: true,
            interactive: true,
        };
        assert!(validate_bounds(bounds).is_ok());
        assert!(
            validate_bounds(Bounds {
                x: f64::NAN,
                ..bounds
            })
            .is_err()
        );
        assert!(
            validate_bounds(Bounds {
                height: f64::INFINITY,
                ..bounds
            })
            .is_err()
        );
        assert!(
            validate_bounds(Bounds {
                width: -1.,
                ..bounds
            })
            .is_err()
        );
    }
}
