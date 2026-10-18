#[cfg(target_os = "macos")]
fn main() {
    use cef::{args::Args, library_loader::LibraryLoader, sandbox::Sandbox};
    let args = Args::new();
    let mut sandbox = Sandbox::new();
    sandbox.initialize(args.as_main_args());
    let Ok(executable) = std::env::current_exe() else {
        std::process::exit(1)
    };
    let loader = LibraryLoader::new(&executable, true);
    if !loader.load() || cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0).is_null() {
        std::process::exit(1);
    }
    let result = cef::execute_process(Some(args.as_main_args()), None, std::ptr::null_mut());
    std::mem::forget(loader);
    std::process::exit(result);
}

#[cfg(not(target_os = "macos"))]
fn main() {}
