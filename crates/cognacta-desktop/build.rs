fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var_os("CARGO_FEATURE_NATIVE_BROWSER").is_some()
    {
        // CEF 154's sandbox bootstrap loads this DLL in every process. Delay the
        // same imports as CEF_SHARED_LINKER_FLAGS so UI libraries don't initialize
        // before CefExecuteProcess enters the renderer sandbox.
        // Source: CEF 14c5a089/cmake/cef_variables.cmake.in, CEF_DELAYLOAD_FLAGS.
        let libraries = "libcef.dll api-ms-win-core-synch-l1-2-0.dll
            api-ms-win-core-winrt-error-l1-1-0.dll api-ms-win-core-winrt-l1-1-0.dll
            api-ms-win-core-winrt-string-l1-1-0.dll advapi32.dll bcryptprimitives.dll
            comctl32.dll comdlg32.dll credui.dll cryptui.dll d3d11.dll d3d12.dll
            d3d9.dll dbghelp.dll dcomp.dll dwmapi.dll dxgi.dll dxva2.dll esent.dll
            fontsub.dll gdi32.dll hid.dll imagehlp.dll imm32.dll mmdevapi.dll
            msi.dll netapi32.dll ncrypt.dll ole32.dll oleacc.dll oleaut32.dll
            pdh.dll propsys.dll psapi.dll rpcrt4.dll rstrtmgr.dll setupapi.dll
            shell32.dll shlwapi.dll uiautomationcore.dll urlmon.dll user32.dll
            usp10.dll uxtheme.dll wer.dll wevtapi.dll wininet.dll winusb.dll
            wsock32.dll wtsapi32.dll crypt32.dll dhcpcsvc.dll dwrite.dll
            iphlpapi.dll secur32.dll userenv.dll winhttp.dll winmm.dll winspool.drv
            wintrust.dll ws2_32.dll";
        for library in libraries.split_whitespace() {
            println!("cargo:rustc-link-arg-cdylib=/DELAYLOAD:{library}");
        }
        // Tauri's Windows bindings also import COM directly through combase.
        println!("cargo:rustc-link-arg-cdylib=/DELAYLOAD:combase.dll");
        println!("cargo:rustc-link-arg-cdylib=delayimp.lib");
    }
}
