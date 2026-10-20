//! Optional macOS CEF child view; the application UI stays in WKWebView.
use super::error::Error;
use cef::*;
use objc2::{
    AnyThread, Encode, MainThreadMarker, define_class, ffi, msg_send,
    rc::Retained,
    runtime::{AnyObject, AnyProtocol, Bool as ObjcBool, Imp, Sel},
    sel,
};
use objc2_app_kit::{
    NSApplication, NSEvent, NSEventTrackingRunLoopMode, NSEventType, NSView, NSWindowStyleMask,
};
use objc2_foundation::{
    NSEdgeInsets, NSObject, NSObjectProtocol, NSPoint, NSRect, NSRunLoop, NSRunLoopCommonModes,
    NSSize, NSTimer,
};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ffi::CString,
    net::{Ipv4Addr, TcpListener},
    os::unix::fs::PermissionsExt,
    sync::{LazyLock, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;

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
static ORIGINAL_SEND_EVENT: OnceLock<Imp> = OnceLock::new();
thread_local! {
    static HANDLING_EVENT: Cell<ObjcBool> = const { Cell::new(ObjcBool::NO) };
    static PAGES: RefCell<HashMap<String, NativePage>> = RefCell::new(HashMap::new());
    static SELECTED_PAGE: RefCell<String> = RefCell::new(MANUAL_PAGE.to_owned());
    static PARENT: Cell<*mut NSView> = const { Cell::new(std::ptr::null_mut()) };
    static UI_VIEW: RefCell<Option<Retained<NSView>>> = const { RefCell::new(None) };
    static REMOVE_VIEWS: RefCell<Vec<Retained<NSView>>> = const { RefCell::new(Vec::new()) };
    static TIMER: RefCell<Option<Retained<NSTimer>>> = const { RefCell::new(None) };
    static INITIALIZED: Cell<bool> = const { Cell::new(false) };
    static CONTEXT_READY: Cell<bool> = const { Cell::new(false) };
    static PUMPING: Cell<bool> = const { Cell::new(false) };
    static LAST_BOUNDS: Cell<Bounds> = const { Cell::new(Bounds { x:0., y:0., width:0., height:0., visible:false, interactive:false }) };
}

fn main_thread() -> Result<(), Error> {
    MainThreadMarker::new()
        .map(|_| ())
        .ok_or_else(|| Error::Native("CEF operation must run on the macOS main thread".into()))
}

fn fail(message: impl Into<Error>) {
    let message = message.into().to_string();

    SHARED.lock().unwrap().error = Some(message);
}

unsafe extern "C-unwind" fn is_handling_event(_: &AnyObject, _: Sel) -> ObjcBool {
    HANDLING_EVENT.get()
}

unsafe extern "C-unwind" fn set_handling_event(_: &AnyObject, _: Sel, value: ObjcBool) {
    HANDLING_EVENT.set(value);
}

unsafe extern "C-unwind" fn request_termination(_: &AnyObject, _: Sel, _: *mut AnyObject) {
    // Cocoa's default terminate: calls exit(), bypassing CefShutdown. As in
    // cefsimple_mac.mm, return to the event loop so our async close handshake runs.
    if let Some(app) = APP_HANDLE.get() {
        app.exit(0);
    }
}

unsafe extern "C-unwind" fn send_event(app: &AnyObject, selector: Sel, event: &NSEvent) {
    // CEF is a native sibling of WKWebView, so DOM pointer-events cannot lock it.
    // Filter user input before AppKit hit testing; CDP events still reach CEF directly.
    if blocks_browser_input(event) {
        return;
    }
    struct Restore(ObjcBool);
    impl Drop for Restore {
        fn drop(&mut self) {
            HANDLING_EVENT.set(self.0);
        }
    }
    let _restore = Restore(HANDLING_EVENT.replace(ObjcBool::YES));
    let original: unsafe extern "C-unwind" fn(&AnyObject, Sel, &NSEvent) = unsafe {
        std::mem::transmute(*ORIGINAL_SEND_EVENT.get().expect("Tao sendEvent installed"))
    };
    unsafe { original(app, selector, event) };
}

fn has_browser_focus(view: &NSView) -> bool {
    view.window()
        .and_then(|window| window.firstResponder())
        .is_some_and(|responder| {
            responder
                .downcast_ref::<NSView>()
                .is_some_and(|focused| focused.isDescendantOf(view))
        })
}

fn release_browser_focus(view: &NSView, host: &BrowserHost) {
    if has_browser_focus(view) {
        host.set_focus(0);
        if let Some(window) = view.window() {
            UI_VIEW.with(|slot| {
                window.makeFirstResponder(slot.borrow().as_deref().map(|view| &**view));
            });
        }
    }
}

fn blocks_input(kind: NSEventType, browser_focused: bool, inside_browser: bool) -> bool {
    match kind {
        NSEventType::KeyDown | NSEventType::KeyUp | NSEventType::FlagsChanged => browser_focused,
        NSEventType::AppKitDefined
        | NSEventType::SystemDefined
        | NSEventType::ApplicationDefined
        | NSEventType::Periodic => false,
        _ => inside_browser,
    }
}

fn blocks_browser_input(event: &NSEvent) -> bool {
    if LAST_BOUNDS.get().interactive {
        return false;
    }
    let browser = selected_browser();
    let Some(host) = browser.and_then(|browser| browser.host()) else {
        return false;
    };
    let Some(view) = (unsafe { Retained::<NSView>::retain(host.window_handle().cast()) }) else {
        return false;
    };
    let Some(window) = view.window() else {
        return false;
    };
    if event.windowNumber() != window.windowNumber() {
        return false;
    }
    let focused = has_browser_focus(&view);
    let point = view.convertPoint_fromView(event.locationInWindow(), None);
    let rect = view.bounds();
    let inside = !view.isHidden()
        && point.x >= rect.origin.x
        && point.y >= rect.origin.y
        && point.x < rect.origin.x + rect.size.width
        && point.y < rect.origin.y + rect.size.height;
    if blocks_input(event.r#type(), focused, inside) {
        release_browser_focus(&view, &host);
        true
    } else {
        false
    }
}

fn install_cef_application_protocol() -> Result<(), Error> {
    let mtm = MainThreadMarker::new().ok_or("CEF application must initialize on main thread")?;
    let app = NSApplication::sharedApplication(mtm);
    let class = app.class();
    // Patch only the already-created TaoApp, without replacing its
    // delegate, superclass or original sendEvent implementation. It is a narrow
    // native compatibility shim, not a supported Tauri extension API; retest on Tao upgrades.
    if class.name() != c"TaoApp" {
        return Err("expected Tauri 2 TaoApp".into());
    }
    let class_ptr = std::ptr::from_ref(class).cast_mut();
    let get_encoding = CString::new(format!("{}@:", ObjcBool::ENCODING))?;
    let set_encoding = CString::new(format!("v@:{}", ObjcBool::ENCODING))?;
    unsafe {
        // Add only to TaoApp; never replace NSApplication's inherited method.
        if !ffi::class_addMethod(
            class_ptr,
            sel!(terminate:),
            std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject), Imp>(
                request_termination,
            ),
            c"v@:@".as_ptr(),
        )
        .as_bool()
        {
            return Err("cannot add TaoApp terminate: override".into());
        }
        if !ffi::class_addMethod(
            class_ptr,
            sel!(isHandlingSendEvent),
            std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyObject, Sel) -> ObjcBool, Imp>(
                is_handling_event,
            ),
            get_encoding.as_ptr(),
        )
        .as_bool()
        {
            return Err("cannot add isHandlingSendEvent".into());
        }
        if !ffi::class_addMethod(
            class_ptr,
            sel!(setHandlingSendEvent:),
            std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyObject, Sel, ObjcBool), Imp>(
                set_handling_event,
            ),
            set_encoding.as_ptr(),
        )
        .as_bool()
        {
            return Err("cannot add setHandlingSendEvent".into());
        }
        for name in [c"CrAppProtocol", c"CrAppControlProtocol", c"CefAppProtocol"] {
            let Some(protocol) = AnyProtocol::get(name) else {
                // Like objc2's define_class, tolerate the marker protocol absent
                // from this CEF dylib. The two behavioral CrApp protocols are required.
                if name == c"CefAppProtocol" {
                    continue;
                }
                return Err(Error::Native(format!(
                    "CEF framework protocol {} unavailable",
                    name.to_string_lossy()
                )));
            };
            if !class.conforms_to(protocol)
                && !ffi::class_addProtocol(class_ptr, protocol).as_bool()
            {
                return Err("cannot attach CEF application protocol".into());
            }
        }
        let method = class
            .instance_method(sel!(sendEvent:))
            .ok_or("TaoApp sendEvent missing")?;
        ORIGINAL_SEND_EVENT
            .set(method.implementation())
            .map_err(|_| "sendEvent already installed")?;
        method.set_implementation(std::mem::transmute::<
            unsafe extern "C-unwind" fn(&AnyObject, Sel, &NSEvent),
            Imp,
        >(send_event));
    }
    Ok(())
}

fn page_fail(page_id: &str, message: impl Into<Error>) {
    if let Some(page) = SHARED.lock().unwrap().pages.get_mut(page_id) {
        page.error = Some(message.into().to_string());
    }
}

fn selected_browser() -> Option<Browser> {
    SELECTED_PAGE.with(|selected| {
        PAGES.with(|pages| {
            pages
                .borrow()
                .get(&*selected.borrow())
                .map(|page| page.browser.clone())
        })
    })
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
            if let Some(host) = browser.and_then(|browser| browser.host())
                && let Some(view) = unsafe { Retained::<NSView>::retain(host.window_handle().cast()) } {
                REMOVE_VIEWS.with(|views| views.borrow_mut().push(view));
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
            // CEF's default creates an unmanaged standalone Chrome window.
            // Queue Tauri work on a worker: its window methods may synchronously
            // dispatch to the UI thread and must not run inside a CEF callback.
            if !SHARED.lock().unwrap().closing
                && let Some(app) = APP_HANDLE.get().cloned() {
                    tauri::async_runtime::spawn(async move {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    });
            }
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
            // ponytail: a 16 ms main-thread tick bounds latency; replace with
            // cefclient's scheduled external pump before optimizing idle CPU.
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
                // Keep the dedicated automation profile independent of the user's login keychain.
                // Its directory is user-private; the CEF sandbox stays enabled.
                command_line.append_switch(Some(&"use-mock-keychain".into()));
                command_line.append_switch_with_value(Some(&"password-store".into()), Some(&"basic".into()));
            }
        }
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    struct OmniopsBotsCefPump;
    unsafe impl NSObjectProtocol for OmniopsBotsCefPump {}
    impl OmniopsBotsCefPump {
        #[unsafe(method(tick:))]
        fn tick(&self, _timer: &NSTimer) { pump_tick(); }
    }
);

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
    let views = REMOVE_VIEWS.with(|views| std::mem::take(&mut *views.borrow_mut()));
    for view in views {
        view.removeFromSuperview();
    }
    cef::do_message_loop_work();
}

fn start_pump() {
    let target: Retained<OmniopsBotsCefPump> =
        unsafe { msg_send![OmniopsBotsCefPump::alloc(), init] };
    let timer = unsafe {
        NSTimer::timerWithTimeInterval_target_selector_userInfo_repeats(
            0.016,
            &target,
            sel!(tick:),
            None,
            true,
        )
    };
    let run_loop = NSRunLoop::mainRunLoop();
    unsafe {
        run_loop.addTimer_forMode(&timer, NSRunLoopCommonModes);
        run_loop.addTimer_forMode(&timer, NSEventTrackingRunLoopMode);
    }
    TIMER.with(|slot| *slot.borrow_mut() = Some(timer));
}

/// Run before constructing Tauri, from a complete app bundle with CEF helpers.
pub fn prepare_framework() -> Result<(), Error> {
    main_thread()?;
    let exe = std::env::current_exe()?;
    let framework = exe
        .parent()
        .ok_or("application executable has no parent")?
        .join("../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework");
    if !framework.is_file() {
        return Err(
            "Bundled CEF framework is missing; build the native-browser app bundle first".into(),
        );
    }
    let loader = cef::library_loader::LibraryLoader::new(&exe, false);
    if !loader.load() {
        return Err("Could not load the bundled CEF framework".into());
    }
    // Objective-C registrations remain live until process exit, even after CefShutdown.
    std::mem::forget(loader);
    if cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0).is_null() {
        return Err("Bundled CEF API version does not match the Rust bindings".into());
    }
    Ok(())
}

/// Run in Tauri setup, on the main thread, after prepare_framework.
/// AlreadyRunning means CEF forwarded this launch to the existing instance;
/// this process must exit normally without starting Node or a second browser.
pub fn initialize(window: &tauri::WebviewWindow) -> Result<Initialization, Error> {
    main_thread()?;
    if INITIALIZED.get() {
        return Err("Native browser is already initialized".into());
    }
    APP_HANDLE
        .set(window.app_handle().clone())
        .map_err(|_| "Native browser application handle is already set")?;
    install_cef_application_protocol()?;
    PARENT.set(window.ns_view()?.cast());
    let cache_dir = window.app_handle().path().app_data_dir()?;
    let root_cache = std::env::var_os("OMNIOPS_BOTS_SMOKE_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or(cache_dir)
        .join("cef");
    let profile = root_cache.join("browser-profile");
    std::fs::create_dir_all(&profile)?;
    for directory in [&root_cache, &profile] {
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let endpoint = format!("http://127.0.0.1:{port}");
    *SHARED.lock().unwrap() = Shared {
        endpoint,
        pages: HashMap::new(),
        error: None,
        closing: false,
        closed: false,
    };
    // CEF owns its listener and cannot inherit this socket. The Node CDP attach
    // must fail closed if the selected port cannot be claimed by CEF.
    drop(listener);
    let settings = Settings {
        no_sandbox: 0,
        external_message_pump: 1,
        multi_threaded_message_loop: 0,
        remote_debugging_port: i32::from(port),
        root_cache_path: root_cache.to_string_lossy().as_ref().into(),
        cache_path: profile.to_string_lossy().as_ref().into(),
        persist_session_cookies: 1,
        log_severity: LogSeverity::DISABLE,
        command_line_args_disabled: 1,
        ..Default::default()
    };
    let args = cef::args::Args::new();
    if cef::initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut BrowserApp::new()),
        std::ptr::null_mut(),
    ) != 1
    {
        let exit_code = cef::get_exit_code();
        SHARED.lock().unwrap().closed = true;
        if exit_code == Resultcode::NORMAL_EXIT_PROCESS_NOTIFIED.get_raw() as i32 {
            return Ok(Initialization::AlreadyRunning);
        }
        let error = format!("CEF initialization failed with exit code {exit_code}");
        fail(error.clone());
        return Err(error.into());
    }
    INITIALIZED.set(true);
    start_pump();
    Ok(Initialization::Ready)
}

/// Safe from an async worker; never waits on the CEF UI thread.
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
        PARENT.get().cast(),
        &Rect {
            x: 0,
            y: 0,
            width: 1280,
            height: 800,
        },
    );
    info.hidden = 1;
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

#[cfg(debug_assertions)]
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

#[cfg(debug_assertions)]
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

#[cfg(debug_assertions)]
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

/// Run after App::run_return. Native termination may bypass ExitRequested.
pub fn finish_shutdown() -> Result<(), Error> {
    main_thread()?;
    if !INITIALIZED.get() {
        return Ok(());
    }
    if !is_closed() {
        begin_close()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while !is_closed() && Instant::now() < deadline {
            // Tauri's loop has returned; finish CEF's close handshake on its UI thread.
            pump_tick();
            std::thread::sleep(Duration::from_millis(10));
        }
        if !is_closed() {
            return Err("CEF shutdown refused before on_before_close".into());
        }
    }
    TIMER.with(|slot| {
        if let Some(timer) = slot.borrow_mut().take() {
            timer.invalidate();
        }
    });
    INITIALIZED.set(false);
    PAGES.with(|pages| pages.borrow_mut().clear());
    cef::shutdown();
    UI_VIEW.with(|slot| slot.borrow_mut().take());
    PARENT.set(std::ptr::null_mut());
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Bounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) visible: bool,
    pub(crate) interactive: bool,
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

fn clipped_frame(bounds: Bounds, parent_width: f64, parent_height: f64, flipped: bool) -> Bounds {
    let left = bounds.x.clamp(0., parent_width);
    let top = bounds.y.clamp(0., parent_height);
    let right = (bounds.x + bounds.width).clamp(left, parent_width);
    let bottom = (bounds.y + bounds.height).clamp(top, parent_height);
    Bounds {
        x: left,
        y: if flipped { top } else { parent_height - bottom },
        width: right - left,
        height: bottom - top,
        visible: bounds.visible && right > left && bottom > top,
        interactive: bounds.interactive,
    }
}

fn inset_content_rect(bounds: NSRect, insets: NSEdgeInsets, flipped: bool) -> NSRect {
    let left = insets.left.clamp(0., bounds.size.width);
    let right = insets.right.clamp(0., bounds.size.width - left);
    let top = insets.top.clamp(0., bounds.size.height);
    let bottom = insets.bottom.clamp(0., bounds.size.height - top);
    NSRect::new(
        NSPoint::new(
            bounds.origin.x + left,
            bounds.origin.y + if flipped { top } else { bottom },
        ),
        NSSize::new(
            bounds.size.width - left - right,
            bounds.size.height - top - bottom,
        ),
    )
}

fn webview_content_rect(view: &NSView) -> NSRect {
    let bounds = view.bounds();
    // WKWebView's DOM viewport excludes its automatic title-bar content inset,
    // while its NSView bounds do not. This public getter is available on macOS 26+.
    let insets = if view.respondsToSelector(sel!(obscuredContentInsets)) {
        unsafe { msg_send![view, obscuredContentInsets] }
    } else {
        let mut insets = NSEdgeInsets {
            top: 0.,
            left: 0.,
            bottom: 0.,
            right: 0.,
        };
        // Match WebKit PageClientImpl::computeAutomaticTopObscuredInset on older
        // systems; do not use a fixed title-bar height or private WK selectors.
        if let Some(window) = view.window()
            && window
                .styleMask()
                .contains(NSWindowStyleMask::FullSizeContentView)
            && !window.titlebarAppearsTransparent()
            && view.enclosingScrollView().is_none()
        {
            let layout = view.convertRect_fromView(window.contentLayoutRect(), None);
            insets.top = if view.isFlipped() {
                layout.origin.y - bounds.origin.y
            } else {
                bounds.origin.y + bounds.size.height - layout.origin.y - layout.size.height
            }
            .max(0.);
        }
        insets
    };
    inset_content_rect(bounds, insets, view.isFlipped())
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

fn apply_page_bounds(browser: Browser, bounds: Bounds) -> Result<(), Error> {
    let Some(host) = browser.host() else {
        return Ok(());
    };
    let view = unsafe { Retained::<NSView>::retain(host.window_handle().cast()) }
        .ok_or("Native browser view is unavailable")?;
    if !bounds.interactive || !bounds.visible {
        release_browser_focus(&view, &host);
    }
    if !bounds.visible {
        view.setHidden(true);
        return Ok(());
    }
    let ui_view = UI_VIEW
        .with(|slot| slot.borrow().clone())
        .ok_or("Application webview is unavailable")?;
    let parent = unsafe { view.superview() }.ok_or("Native browser parent is unavailable")?;
    let content = webview_content_rect(&ui_view);
    let frame = clipped_frame(
        bounds,
        content.size.width,
        content.size.height,
        ui_view.isFlipped(),
    );
    if frame.visible {
        // First map DOM coordinates into WK's content viewport, then let AppKit
        // convert between the WK and CEF parent views (including flipped axes).
        let local = NSRect::new(
            NSPoint::new(content.origin.x + frame.x, content.origin.y + frame.y),
            NSSize::new(frame.width, frame.height),
        );
        let native = ui_view.convertRect_toView(local, Some(&parent));
        view.setFrame(native);
    }
    view.setHidden(!frame.visible);
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
    app.get_webview_window("main")
        .ok_or("Application window is unavailable")?
        .with_webview(move |platform| {
            // Tauri supplies the actual WKWebView on its UI thread.
            UI_VIEW.with(|slot| {
                *slot.borrow_mut() = unsafe { Retained::<NSView>::retain(platform.inner().cast()) };
            });
            let result = if SELECTED_PAGE.with(|selected| *selected.borrow() == page_id) {
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
    fn task_input_lock_blocks_browser_but_preserves_chat_and_system_events() {
        for kind in [
            NSEventType::LeftMouseDown,
            NSEventType::RightMouseDown,
            NSEventType::ScrollWheel,
            NSEventType::Magnify,
            NSEventType::MouseMoved,
        ] {
            assert!(blocks_input(kind, false, true));
            assert!(!blocks_input(kind, false, false));
        }
        for kind in [
            NSEventType::KeyDown,
            NSEventType::KeyUp,
            NSEventType::FlagsChanged,
        ] {
            assert!(blocks_input(kind, true, false));
            assert!(!blocks_input(kind, false, true));
        }
        assert!(!blocks_input(NSEventType::AppKitDefined, true, true));
    }
    #[test]
    fn dom_bounds_exclude_wk_titlebar_content_inset() {
        let wk = NSRect::new(NSPoint::new(0., 0.), NSSize::new(1249., 860.));
        let insets = NSEdgeInsets {
            top: 32.,
            left: 0.,
            bottom: 0.,
            right: 0.,
        };
        let bounds = Bounds {
            x: 797.5,
            y: 84.,
            width: 451.5,
            height: 744.,
            visible: true,
            interactive: true,
        };
        for flipped in [false, true] {
            let content = inset_content_rect(wk, insets, flipped);
            assert_eq!(content.size, NSSize::new(1249., 828.));
            let frame = clipped_frame(bounds, content.size.width, content.size.height, flipped);
            let local_y = content.origin.y + frame.y;
            let native_y = if flipped {
                wk.size.height - local_y - frame.height
            } else {
                local_y
            };
            assert_eq!(native_y, 0., "browser must reach the native content bottom");
            assert_eq!(
                wk.size.height - native_y - frame.height,
                116.,
                "browser starts below system inset and both app toolbars"
            );
        }
        assert_eq!(
            inset_content_rect(
                wk,
                NSEdgeInsets {
                    top: 0.,
                    left: 0.,
                    bottom: 0.,
                    right: 0.
                },
                false
            ),
            wk
        );
    }

    #[test]
    fn bounds_use_css_points_clip_to_parent_and_flip_cocoa_y() {
        let bounds = Bounds {
            x: 620.5,
            y: 84.,
            width: 599.5,
            height: 640.,
            visible: true,
            interactive: true,
        };
        let native = clipped_frame(bounds, 1220., 800., false);
        assert_eq!(native, Bounds { y: 76., ..bounds });
        assert_eq!(clipped_frame(bounds, 1220., 800., true), bounds);
        let partial = clipped_frame(
            Bounds {
                x: -20.,
                y: 750.,
                width: 100.,
                height: 100.,
                visible: true,
                interactive: true,
            },
            1220.,
            800.,
            false,
        );
        assert_eq!(
            partial,
            Bounds {
                x: 0.,
                y: 0.,
                width: 80.,
                height: 50.,
                visible: true,
                interactive: true
            }
        );
        assert!(
            !clipped_frame(
                Bounds {
                    width: 0.,
                    ..bounds
                },
                1220.,
                800.,
                false
            )
            .visible
        );
        assert!(
            !clipped_frame(
                Bounds {
                    visible: false,
                    ..bounds
                },
                1220.,
                800.,
                false
            )
            .visible
        );
    }
    #[test]
    fn bounds_reject_non_finite_and_negative_dimensions() {
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
