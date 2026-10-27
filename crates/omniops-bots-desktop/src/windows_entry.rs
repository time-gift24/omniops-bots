#![cfg(all(target_os = "windows", feature = "native-browser"))]

mod app;

// CEF's signed bootstrap owns sandbox_info until this call returns.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn RunWinMain(
    instance: cef::sys::HINSTANCE,
    _command_line: *mut u16,
    _command_show: i32,
    sandbox_info: *mut u8,
    _version_info: *mut std::ffi::c_void,
) -> i32 {
    std::panic::catch_unwind(|| {
        if app::diagnostics_only() {
            return app::run().unwrap_or(1);
        }
        match unsafe { app::native_browser::prepare_bootstrap(instance, sandbox_info) } {
            Ok(Some(code)) => code,
            Ok(None) => app::run().unwrap_or(1),
            Err(_) => 1,
        }
    })
    .unwrap_or(1)
}
