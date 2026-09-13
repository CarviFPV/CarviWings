//! The desktop shell.
//!
//! There is no game in here. The simulator is the same web application that
//! `npm run dev` serves, exported to a directory of static files and embedded
//! in this executable at compile time; all this does is open a window on it and
//! hand it a way to reach NOAA.
//!
//! That last part is the only reason there is any Rust at all. The web build
//! asks its own server for the weather, through `app/api/metar`. A packaged
//! application has no server, and aviationweather.gov sends no allow-origin
//! header, so a webview asking it directly is refused. The HTTP plugin makes
//! that one request from here instead, where CORS does not apply, scoped in
//! `capabilities/default.json` to that host and no other.

// Prevents an extra console window opening behind the game on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("CarviWings could not open a window");
}
