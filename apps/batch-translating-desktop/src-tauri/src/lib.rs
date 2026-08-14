//! Native desktop shell for Batch Translating.
//!
//! Lifecycle (mirrors the round-1 PowerShell launcher, minus the browser):
//!  1. If a server is already reachable on the fixed loopback port (started by
//!     this app or by the legacy launcher), reuse it and open the workbench.
//!  2. Otherwise spawn the engine (`batch-translating-engine.exe`, falling
//!     back to `kimi.exe` for dev builds) with
//!     `web --no-open --host 127.0.0.1 --port 58627`, watch stdout for the
//!     `Kimi server: <url>` ready line, record runtime state under
//!     %LOCALAPPDATA%\Batch Translating\runtime.json, and open the WebView at
//!     that URL (its fragment carries the bearer token).
//!  3. Closing the window keeps the engine running so long batch jobs continue
//!     in the background; double-clicking the app again reconnects to it.
//!     Use `Stop-BatchTranslating.ps1` (or the legacy Stop launcher) to shut
//!     the service down.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_single_instance::init as single_instance_init;

const SERVER_HOST: &str = "127.0.0.1";
const SERVER_PORT: u16 = 58627;
const SERVER_ADDRESS: &str = "127.0.0.1:58627";
const RUNTIME_DIR_NAME: &str = "Batch Translating";
const RUNTIME_FILE_NAME: &str = "runtime.json";
const DEFAULT_HOME_DIR_NAME: &str = ".batch-translating";
const SERVER_TOKEN_FILE: &str = "server.token";
const READY_LINE_PREFIX: &str = "Kimi server:";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
const REUSE_PROBE_TIMEOUT: Duration = Duration::from_millis(400);
const WINDOW_TITLE: &str = "Batch Translating";
/// Shipped engine name; `kimi.exe` remains the dev-build fallback.
const ENGINE_EXE_NAME: &str = "batch-translating-engine.exe";
const ENGINE_EXE_FALLBACK: &str = "kimi.exe";

/// CREATE_NO_WINDOW so the engine never flashes a console.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn run() {
    tauri::Builder::default()
        .plugin(single_instance_init(|app, _args, _cwd| {
            // A second launch while the first window is still open simply
            // brings it to the front; the startup path always focuses the
            // window it creates, so a still-starting instance needs nothing.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // Closing the window (the X button) hides the shell to the tray
        // instead of quitting: the engine keeps running for long batch jobs,
        // and the user can restore the window from the tray icon.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            if let Err(error) = build_tray(app.handle()) {
                eprintln!("could not create the tray icon: {error}");
            }
            let handle = app.handle().clone();
            // Engine startup blocks on the ready line (up to 90 s), so it runs
            // off the main thread; the window itself is created back on the
            // main thread where Tauri requires it.
            tauri::async_runtime::spawn(async move {
                let outcome = start_engine_and_wait();
                let main_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || match outcome {
                    Ok((url, engine)) => {
                        open_window(&main_handle, &url);
                        // When this shell spawned the engine itself, exit with
                        // it: the workbench's "Exit app" flow (or the tray's
                        // Exit action) shuts the engine down, and that is what
                        // closes the shell for good.
                        if let Some(mut engine) = engine {
                            std::thread::spawn(move || {
                                let _ = engine.wait();
                                std::process::exit(0);
                            });
                        }
                    }
                    Err(message) => {
                        show_error_box(WINDOW_TITLE, &message);
                        std::process::exit(1);
                    }
                });
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Batch Translating desktop shell");
}

/// Show (and unminimize + focus) the main window — used by the tray icon.
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// System tray icon with a two-item menu (show / exit). Left-clicking the
/// icon restores the window; Exit asks for confirmation, gracefully stops
/// the engine (POST /shutdown, taskkill fallback) and quits the shell.
fn build_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "显示 Batch Translating", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &exit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("no default window icon")?;

    TrayIconBuilder::with_id("batch-translating-tray")
        .icon(icon)
        .tooltip("Batch Translating")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "exit" => {
                if confirm_exit() {
                    request_engine_shutdown(app);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Native confirmation before the tray's Exit action.
#[cfg(windows)]
fn confirm_exit() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONWARNING, MB_YESNO, IDYES,
    };
    let title: Vec<u16> = WINDOW_TITLE.encode_utf16().chain(std::iter::once(0)).collect();
    let message: Vec<u16> = "确定要退出吗？这会终止翻译引擎与正在运行的所有翻译任务。"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe { MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONWARNING) == IDYES }
}

#[cfg(not(windows))]
fn confirm_exit() -> bool {
    true
}

/// Stop the engine (graceful POST /shutdown, then taskkill fallback) and quit
/// the shell. The exit-watch thread also quits when the engine dies — this is
/// the explicit path for a user-initiated full exit.
fn request_engine_shutdown(_app: &AppHandle) {
    std::thread::spawn(move || {
        let origin = read_runtime_origin().unwrap_or_else(|| format!("http://{SERVER_ADDRESS}"));
        let token = read_server_token().unwrap_or_default();
        post_shutdown(&origin, &token);
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if TcpStream::connect_timeout(&SERVER_ADDRESS.parse().unwrap(), REUSE_PROBE_TIMEOUT).is_err() {
                // The engine is gone — the exit-watch thread (if this shell
                // spawned it) also quits; exit here for the reused-engine case.
                std::process::exit(0);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        kill_port_occupant();
        std::thread::sleep(Duration::from_millis(500));
        std::process::exit(0);
    });
}

/// Minimal HTTP/1.1 POST /api/v1/shutdown over loopback (best-effort).
fn post_shutdown(origin: &str, token: &str) {
    let host_port = match origin.strip_prefix("http://") {
        Some(rest) => rest.trim_end_matches('/'),
        None => return,
    };
    let address: std::net::SocketAddr = match host_port.parse() {
        Ok(address) => address,
        Err(_) => return,
    };
    let mut stream = match TcpStream::connect_timeout(&address, REUSE_PROBE_TIMEOUT) {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let request = format!(
        "POST /api/v1/shutdown HTTP/1.1\r\nHost: {host_port}\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(request.as_bytes());
    let _ = stream.read_to_string(&mut String::new());
}

fn open_window(app: &AppHandle, url: &str) {
    let parsed = match url.parse::<Url>() {
        Ok(parsed) => parsed,
        Err(_) => {
            show_error_box(WINDOW_TITLE, &format!("The engine reported an invalid URL: {url}"));
            return;
        }
    };
    match WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title(WINDOW_TITLE)
        .inner_size(1280.0, 860.0)
        .min_inner_size(920.0, 620.0)
        .center()
        .build()
    {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(error) => {
            show_error_box(WINDOW_TITLE, &format!("Could not open the workbench window: {error}"));
        }
    }
}

/// Reuse a running server or start `kimi.exe`; returns the ready workbench URL
/// and, when this shell spawned the engine, the child handle (so the shell can
/// exit when the engine does).
fn start_engine_and_wait() -> Result<(String, Option<Child>), String> {
    if let Some(url) = try_reuse_running_server() {
        return Ok((url, None));
    }
    let engine = find_engine_path()?;
    let mut child = spawn_engine(&engine)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (line_sender, line_receiver) = channel::<String>();
    if let Some(out) = stdout {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if line_sender.send(line).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(err) = stderr {
        // Engine logs are intentionally not surfaced in the shell UI.
        std::thread::spawn(move || {
            for _line in BufReader::new(err).lines().map_while(Result::ok) {}
        });
    }

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        match line_receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(line) => {
                if let Some(url) = extract_ready_url(&line) {
                    write_runtime_state(&child, &url);
                    return Ok((url, Some(child)));
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(status) = child.try_wait().map_err(|error| {
                    format!("Failed to watch the translation engine: {error}")
                })? {
                    return Err(format!(
                        "The translation engine exited before becoming ready (code {}).",
                        status.code().map_or_else(|| "unknown".into(), |code| code.to_string())
                    ));
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    return Err("The translation engine did not become ready within 90 seconds.".into());
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err("The translation engine stopped writing output before becoming ready.".into());
            }
        }
    }
}

fn find_engine_path() -> Result<PathBuf, String> {
    if let Ok(configured) = std::env::var("BATCH_TRANSLATING_KIMI_EXE") {
        if !configured.trim().is_empty() {
            let path = PathBuf::from(configured.trim());
            if path.is_file() {
                return Ok(path);
            }
            return Err(format!(
                "BATCH_TRANSLATING_KIMI_EXE points to a missing file: {}",
                path.display()
            ));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in [ENGINE_EXE_NAME, ENGINE_EXE_FALLBACK] {
                let path = dir.join(name);
                if path.is_file() {
                    return Ok(path);
                }
            }
        }
    }
    Err(
        "The translation engine (batch-translating-engine.exe) was not found next to this application. \
         Reinstall the app or set BATCH_TRANSLATING_KIMI_EXE to the engine path."
            .into(),
    )
}

fn spawn_engine(engine: &PathBuf) -> Result<Child, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(engine);
        let default_home = std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join(DEFAULT_HOME_DIR_NAME);
        if std::env::var("BATCH_TRANSLATING_HOME").is_err() && std::env::var("KIMI_CODE_HOME").is_err() {
            command.env("BATCH_TRANSLATING_HOME", &default_home);
            command.env("KIMI_CODE_HOME", &default_home);
        }
        command
            .args([
                "web",
                "--no-open",
                "--host",
                SERVER_HOST,
                "--port",
                &SERVER_PORT.to_string(),
                "--log-level",
                "info",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW);
        return command
            .spawn()
            .map_err(|error| format!("Could not start the translation engine: {error}"));
    }
    #[cfg(not(windows))]
    {
        let _ = engine;
        Err("This desktop shell currently supports Windows only.".into())
    }
}

fn extract_ready_url(line: &str) -> Option<String> {
    let index = line.find(READY_LINE_PREFIX)?;
    let rest = &line[index + READY_LINE_PREFIX.len()..];
    let candidate = rest.trim();
    let url = candidate.split_whitespace().next()?;
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url.to_string())
    } else {
        None
    }
}

/// Outcome of probing the server already listening on the fixed port.
#[derive(PartialEq)]
enum ProbeResult {
    /// Same-generation engine reachable with our token — safe to reuse.
    Reuse,
    /// Port answers with a kimi-style HTTP envelope but rejects our token —
    /// a stale engine from an older build/home. It must be terminated so the
    /// fresh engine can bind the port.
    StaleKimi,
    /// Port is open but the service is not a kimi HTTP server — leave it alone.
    Unknown,
}

/// A server started earlier (by this app or the legacy launcher) is reused
/// only when it answers the meta probe with our token. A stale engine (old
/// `.kimi-code` home or an older build) would otherwise be reused forever and
/// keep serving its outdated UI — detect it, terminate it, and start fresh.
fn try_reuse_running_server() -> Option<String> {
    if TcpStream::connect_timeout(&SERVER_ADDRESS.parse().ok()?, REUSE_PROBE_TIMEOUT).is_err() {
        return None;
    }
    let origin = read_runtime_origin()
        .unwrap_or_else(|| format!("http://{SERVER_ADDRESS}"));
    let token = read_server_token()?;
    match probe_server(&origin, &token) {
        ProbeResult::Reuse => Some(format!("{origin}/#token={}", percent_encode(&token))),
        ProbeResult::StaleKimi => {
            kill_port_occupant();
            // Give the terminated engine a moment to release the port so the
            // fresh engine can bind it.
            for _ in 0..50 {
                if TcpStream::connect_timeout(&SERVER_ADDRESS.parse().unwrap(), REUSE_PROBE_TIMEOUT)
                    .is_err()
                {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            None
        }
        ProbeResult::Unknown => None,
    }
}

/// Minimal HTTP/1.1 GET over loopback (no TLS needed). Classifies the reply
/// as Reuse / StaleKimi / Unknown.
fn probe_server(origin: &str, token: &str) -> ProbeResult {
    let host_port = match origin.strip_prefix("http://") {
        Some(rest) => rest.trim_end_matches('/').to_string(),
        None => return ProbeResult::Unknown,
    };
    let address: std::net::SocketAddr = match host_port.parse() {
        Ok(address) => address,
        Err(_) => return ProbeResult::Unknown,
    };
    let mut stream = match TcpStream::connect_timeout(&address, REUSE_PROBE_TIMEOUT) {
        Ok(stream) => stream,
        Err(_) => return ProbeResult::Unknown,
    };
    use std::io::{Read, Write};
    let request = format!(
        "GET /api/v1/meta HTTP/1.1\r\nHost: {host_port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return ProbeResult::Unknown;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    if response.starts_with("HTTP/1.1 200") && response.contains("server_version") {
        return ProbeResult::Reuse;
    }
    if response.contains("Unauthorized") || response.contains("40101") || response.contains("server_version") {
        return ProbeResult::StaleKimi;
    }
    ProbeResult::Unknown
}

/// Terminate whatever process is LISTENING on the fixed port (netstat + taskkill).
#[cfg(windows)]
fn kill_port_occupant() {
    let output = match Command::new("netstat").args(["-ano", "-p", "tcp"]).output() {
        Ok(output) => output,
        Err(_) => return,
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let needle = format!(":{SERVER_PORT}");
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        if parts.next().map(|part| part.eq_ignore_ascii_case("tcp")) != Some(true) {
            continue;
        }
        if parts.next().map(|part| part.contains(&needle)) != Some(true) {
            continue;
        }
        let _ = parts.next(); // foreign address
        if parts.next().map(|part| part.eq_ignore_ascii_case("listening")) != Some(true) {
            continue;
        }
        let pid = match parts.next().and_then(|part| part.parse::<u32>().ok()) {
            Some(pid) => pid,
            None => continue,
        };
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
    }
}

#[cfg(not(windows))]
fn kill_port_occupant() {}

fn read_runtime_origin() -> Option<String> {
    let path = runtime_dir().join(RUNTIME_FILE_NAME);
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("origin")?.as_str().map(str::to_string)
}

fn read_server_token() -> Option<String> {
    let home = std::env::var("BATCH_TRANSLATING_HOME")
        .or_else(|_| std::env::var("KIMI_CODE_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(DEFAULT_HOME_DIR_NAME)
        });
    let token = std::fs::read_to_string(home.join(SERVER_TOKEN_FILE)).ok()?;
    let token = token.trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn runtime_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("TEMP"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join(RUNTIME_DIR_NAME)
}

fn write_runtime_state(child: &Child, url: &str) {
    // The ready URL is `{origin}/#token=...`; the origin is everything before
    // the `/#` fragment marker.
    let origin = url
        .split("/#")
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(url)
        .to_string();
    let started_at_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let state = serde_json::json!({
        "manager_pid": std::process::id(),
        "server_pid": child.id(),
        "url": url,
        "origin": origin,
        "started_at_unix": started_at_unix,
    });
    let dir = runtime_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_string_pretty(&state) {
        let _ = std::fs::write(dir.join(RUNTIME_FILE_NAME), text);
    }
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(windows)]
fn show_error_box(title: &str, message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let title: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let message: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn show_error_box(_title: &str, _message: &str) {
    eprintln!("{_title}: {_message}");
}
