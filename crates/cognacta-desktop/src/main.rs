#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;

fn main() {
    let code = app::run().unwrap_or(1);
    std::process::exit(code);
}
