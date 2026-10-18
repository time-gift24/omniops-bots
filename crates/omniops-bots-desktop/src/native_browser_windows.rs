//! Windows CEF Alloy child HWND; the application UI remains in WebView2.
//! Start through CEF's sandbox bootstrap.exe + application DLL, never a second helper EXE.
use super::error::Error;
use cef::*;
use std::{
    cell::{Cell, RefCell},
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

struct Shared {
    endpoint: String,
    target_id: Option<String>,
    error: Option<String>,
    closing: bool,
    closed: bool,
}
static SHARED: LazyLock<Mutex<Shared>> = LazyLock::new(|| {
    Mutex::new(Shared {
        endpoint: String::new(),
        target_id: None,
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
    static BROWSER: RefCell<Option<Browser>> = const { RefCell::new(None) };
    static OBSERVER: RefCell<Option<Registration>> = const { RefCell::new(None) };
    static PARENT: Cell<HWND> = const { Cell::new(std::ptr::null_mut()) };
    static DESTROY_WINDOW: Cell<HWND> = const { Cell::new(std::ptr::null_mut()) };
    static TIMER: Cell<usize> = const { Cell::new(0) };
    static INITIALIZED: Cell<bool> = const { Cell::new(false) };
    static CONTEXT_READY: Cell<bool> = const { Cell::new(false) };
    static CREATE_PENDING: Cell<bool> = const { Cell::new(false) };
    static PUMPING: Cell<bool> = const { Cell::new(false) };
    static LAST_BOUNDS: Cell<Bounds> = const { Cell::new(Bounds { x:0., y:0., width:0., height:0., visible:false, interactive:false }) };
    static APPLIED_BOUNDS: Cell<Option<PhysicalBounds>> = const { Cell::new(None) };
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

wrap_dev_tools_message_observer! {
    struct TargetObserver;
    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self, _browser: Option<&mut Browser>, message_id: i32,
            success: i32, result: Option<&[u8]>) {
            if message_id != 1 { return; }
            let parsed = result.and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok());
            let target = parsed.as_ref().and_then(|value| value["targetInfo"]["targetId"].as_str());
            match (success, target.filter(|id| !id.is_empty())) {
                (1, Some(id)) => SHARED.lock().unwrap().target_id = Some(id.to_owned()),
                _ => fail("CEF did not return a DevTools target ID"),
            }
        }
    }
}

wrap_life_span_handler! {
    struct BrowserLife;
    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            CREATE_PENDING.set(false);
            let Some(browser) = browser else { fail("CEF created no browser"); return; };
            BROWSER.with(|slot| *slot.borrow_mut() = Some(browser.clone()));
            let Some(host) = browser.host() else { fail("CEF browser host unavailable"); return; };
            if SHARED.lock().unwrap().closing { host.close_browser(1); return; }
            host.set_accessibility_state(cef::State::ENABLED);
            if let Err(error) = apply_bounds(LAST_BOUNDS.get()) { fail(error); }
            let registration = host.add_dev_tools_message_observer(Some(&mut TargetObserver::new()));
            if registration.is_none() { fail("CEF DevTools observer registration failed"); return; }
            OBSERVER.with(|slot| *slot.borrow_mut() = registration);
            if host.execute_dev_tools_method(1, Some(&"Target.getTargetInfo".into()), None) != 1 {
                fail("CEF rejected the DevTools target query");
            }
        }
        fn do_close(&self, browser: Option<&mut Browser>) -> i32 {
            // CEF's default posts WM_CLOSE to GA_ROOT (the whole Tauri window).
            // Destroy only our child HWND, outside this callback, after accepting close.
            if let Some(host) = browser.and_then(|browser| browser.host()) {
                DESTROY_WINDOW.set(host.window_handle().0.cast());
            }
            1
        }
        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            DESTROY_WINDOW.set(std::ptr::null_mut());
            BROWSER.with(|slot| slot.borrow_mut().take());
            APPLIED_BOUNDS.set(None);
            let mut state = SHARED.lock().unwrap();
            state.target_id = None;
            state.closed = true;

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
    struct BrowserFocus;
    impl FocusHandler {
        fn on_set_focus(&self, _browser: Option<&mut Browser>, source: FocusSource) -> i32 {
            // Navigation must not steal focus from chat; native mouse/tab focus is allowed.
            i32::from(source == FocusSource::NAVIGATION || !LAST_BOUNDS.get().visible || !LAST_BOUNDS.get().interactive
                || SHARED.lock().unwrap().closing)
        }
        fn on_take_focus(&self, _browser: Option<&mut Browser>, _next: i32) {
            focus_application_webview();
        }
    }
}

wrap_client! {
    struct BrowserClient;
    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(BrowserLife::new()) }
        fn focus_handler(&self) -> Option<FocusHandler> { Some(BrowserFocus::new()) }
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
            let mut info = WindowInfo { runtime_style: RuntimeStyle::ALLOY, ..Default::default() }
                .set_as_child(cef::sys::HWND(PARENT.get().cast()), &Rect { x:0, y:0, width:1, height:1 });
            info.style &= !WS_VISIBLE;
            CREATE_PENDING.set(true);
            if browser_host_create_browser(Some(&info), Some(&mut BrowserClient::new()),
                Some(&"about:blank".into()), Some(&BrowserSettings::default()), None, None) != 1 {
                CREATE_PENDING.set(false);
                SHARED.lock().unwrap().closed = true;
                fail("CEF rejected native browser creation");
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
    let child = DESTROY_WINDOW.replace(std::ptr::null_mut());
    if !child.is_null() && unsafe { IsWindow(child) } != 0 && unsafe { DestroyWindow(child) } == 0 {
        fail(win_error("Destroy CEF child window"));
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
        target_id: None,
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
            if let Some(target_id) = &state.target_id {
                return Ok(Connection {
                    endpoint: state.endpoint.clone(),
                    target_id: target_id.clone(),
                });
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Native browser target readiness timed out".into());
        }
        tokio::time::sleep(remaining.min(Duration::from_millis(25))).await;
    }
}

pub fn begin_close() -> Result<(), Error> {
    main_thread()?;
    {
        let mut state = SHARED.lock().unwrap();
        if state.closing || state.closed {
            return Ok(());
        }
        state.closing = true;
    }
    let browser = BROWSER.with(|slot| slot.borrow().clone());
    if let Some(host) = browser.and_then(|browser| browser.host()) {
        host.close_browser(1);
    } else if CONTEXT_READY.get() && !CREATE_PENDING.get() {
        SHARED.lock().unwrap().closed = true;
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
    OBSERVER.with(|slot| slot.borrow_mut().take());
    BROWSER.with(|slot| slot.borrow_mut().take());
    cef::shutdown();
    PARENT.set(std::ptr::null_mut());
    SANDBOX_INFO.set(std::ptr::null_mut());
    Ok(())
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    interactive: bool,
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
    let browser = BROWSER.with(|slot| slot.borrow().clone());
    let Some(host) = browser.and_then(|browser| browser.host()) else {
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
    if APPLIED_BOUNDS.get() == Some(frame) {
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
    APPLIED_BOUNDS.set(Some(frame));
    Ok(())
}

pub async fn set_bounds(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    interactive: bool,
) -> Result<(), Error> {
    let bounds = Bounds {
        x,
        y,
        width,
        height,
        visible,
        interactive,
    };
    validate_bounds(bounds)?;
    if SHARED.lock().unwrap().closing {
        return Err("Native browser is closing".into());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = if SHARED.lock().unwrap().closing {
            Err("Native browser is closing".into())
        } else {
            apply_bounds(bounds)
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
