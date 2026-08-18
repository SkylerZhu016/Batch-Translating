//! Native desktop shell for Batch Translating.
//!
//! The engine owns its actual loopback port. The shell only reuses an engine
//! recorded in runtime.json when its PID is alive, /api/v1/meta returns the
//! same server_id, and the recorded engine fingerprint matches the engine
//! shipped with this installation. A busy preferred port is never evidence of
//! ownership and its occupant is never terminated.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{channel, RecvTimeoutError},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{
    menu::{Menu, MenuItem},
    path::BaseDirectory,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_single_instance::init as single_instance_init;

const SERVER_HOST: &str = "127.0.0.1";
const PREFERRED_SERVER_PORT: u16 = 58627;
const RUNTIME_DIR_NAME: &str = "Batch Translating";
const RUNTIME_FILE_NAME: &str = "runtime.json";
const DEFAULT_HOME_DIR_NAME: &str = ".batch-translating";
const SERVER_TOKEN_FILE: &str = "server.token";
const READY_LINE_PREFIX: &str = "Kimi server:";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
const REUSE_PROBE_TIMEOUT: Duration = Duration::from_millis(400);
const WINDOW_TITLE: &str = "Batch Translating";
const ENGINE_EXE_NAME: &str = "batch-translating-engine.exe";
const ENGINE_EXE_FALLBACK: &str = "kimi.exe";
const RAG_SERVICE_RESOURCE_DIR: &str = "translation-rag-service";
const RAG_SERVICE_ENTRY: &str = "src/translation_rag_service/server.py";
const RAG_SERVICE_ENV: &str = "BATCH_TRANSLATING_RAG_SERVICE_DIR";
const PRODUCT_CLI_ENV: &str = "BATCH_TRANSLATING_CLI";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_SUSPENDED: u32 = 0x0000_0004;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct RuntimeState {
    manager_pid: u32,
    server_pid: u32,
    server_id: String,
    engine_version: String,
    engine_fingerprint: String,
    origin: String,
    port: u16,
    started_at_unix: u64,
}

#[derive(Clone, Debug, PartialEq)]
struct MetaIdentity {
    server_id: String,
    server_version: String,
}

#[derive(Debug, PartialEq)]
enum ProbeResult {
    Reuse(MetaIdentity),
    Unknown,
}

/// Windows closes all process handles when the desktop shell exits, including
/// on `std::process::exit`. KILL_ON_JOB_CLOSE therefore covers both the normal
/// tray path and unexpected shell termination after the engine is attached.
/// Windows automatically associates descendants with the same job, so a RAG
/// Python process spawned by the engine has the same lifetime boundary.
#[cfg(windows)]
struct ProcessJob(usize);

#[cfg(windows)]
impl ProcessJob {
    fn attach(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "无法创建翻译引擎进程作业：{}",
                std::io::Error::last_os_error()
            ));
        }

        let mut limits = unsafe { std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(handle);
            }
            return Err(format!("无法配置翻译引擎进程作业：{error}"));
        }

        let job = Self(handle as usize);
        let assigned = unsafe { AssignProcessToJobObject(handle, child.as_raw_handle().cast()) };
        if assigned == 0 {
            let error = std::io::Error::last_os_error();
            drop(job);
            return Err(format!("无法托管翻译引擎进程树：{error}"));
        }
        if let Err(error) = resume_suspended_process(child.id()) {
            drop(job);
            return Err(error);
        }
        Ok(job)
    }

    fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            TerminateJobObject(self.0 as *mut std::ffi::c_void, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            CloseHandle(self.0 as *mut std::ffi::c_void);
        }
    }
}

#[cfg(windows)]
fn resume_suspended_process(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(format!(
            "无法枚举翻译引擎启动线程：{}",
            std::io::Error::last_os_error()
        ));
    }

    let mut entry = unsafe { std::mem::zeroed::<THREADENTRY32>() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    let mut resumed = false;
    while has_entry {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread.is_null() {
                let previous_suspend_count = unsafe { ResumeThread(thread) };
                unsafe {
                    CloseHandle(thread);
                }
                if previous_suspend_count != u32::MAX {
                    resumed = true;
                    break;
                }
            }
        }
        has_entry = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }

    if resumed {
        Ok(())
    } else {
        Err("无法恢复已安全托管的翻译引擎启动线程。".into())
    }
}

#[cfg(not(windows))]
struct ProcessJob;

#[cfg(not(windows))]
impl ProcessJob {
    fn attach(_child: &Child) -> Result<Self, String> {
        Ok(Self)
    }

    fn terminate(&self) {}
}

#[derive(Clone, Default)]
struct OwnedEngine {
    inner: Arc<Mutex<OwnedEngineInner>>,
    startup_complete: Arc<AtomicBool>,
    shutdown_requested: Arc<AtomicBool>,
}

#[derive(Default)]
struct OwnedEngineInner {
    child: Option<Child>,
    job: Option<ProcessJob>,
    reused: Option<RuntimeState>,
}

#[derive(Debug)]
enum OwnedEngineStatus {
    Running,
    Exited { pid: u32, status: ExitStatus },
    Missing,
}

impl OwnedEngine {
    fn mark_startup_complete(&self) {
        self.startup_complete.store(true, Ordering::Release);
    }

    fn startup_is_complete(&self) -> bool {
        self.startup_complete.load(Ordering::Acquire)
    }

    fn request_shutdown(&self) {
        self.shutdown_requested.store(true, Ordering::Release);
    }

    fn shutdown_is_requested(&self) -> bool {
        self.shutdown_requested.load(Ordering::Acquire)
    }

    fn remember_reused(&self, state: RuntimeState) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reused = Some(state);
    }

    fn reused_snapshot(&self) -> Option<RuntimeState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reused
            .clone()
    }

    fn install(&self, mut child: Child) -> Result<u32, String> {
        let pid = child.id();
        let job = match ProcessJob::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                terminate_owned_process_tree(pid);
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let mut owned = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if owned.child.is_some() {
            job.terminate();
            terminate_owned_process_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            return Err("桌面壳已拥有另一个翻译引擎进程。".into());
        }
        owned.child = Some(child);
        owned.job = Some(job);
        Ok(pid)
    }

    fn pid(&self) -> Option<u32> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .child
            .as_ref()
            .map(Child::id)
    }

    fn take_output(&self) -> (Option<ChildStdout>, Option<ChildStderr>) {
        let mut owned = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match owned.child.as_mut() {
            Some(child) => (child.stdout.take(), child.stderr.take()),
            None => (None, None),
        }
    }

    fn write_runtime_if_active(&self, state: &RuntimeState) -> Result<(), String> {
        let owned = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.shutdown_is_requested() || owned.child.is_none() {
            return Err("桌面壳正在退出，翻译引擎启动已取消。".into());
        }
        write_runtime_state(state)
    }

    fn try_wait(&self) -> Result<OwnedEngineStatus, String> {
        let mut owned = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(child) = owned.child.as_mut() else {
            return Ok(OwnedEngineStatus::Missing);
        };
        let pid = child.id();
        match child
            .try_wait()
            .map_err(|error| format!("无法监控翻译引擎：{error}"))?
        {
            Some(status) => {
                if let Some(job) = owned.job.take() {
                    job.terminate();
                }
                owned.child.take();
                Ok(OwnedEngineStatus::Exited { pid, status })
            }
            None => Ok(OwnedEngineStatus::Running),
        }
    }

    /// Take exclusive ownership before termination so the monitor and exit
    /// paths can never wait on or kill the same Child concurrently.
    fn terminate_and_reap(&self) -> Option<u32> {
        let (mut child, job) = {
            let mut owned = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let child = owned.child.take()?;
            (child, owned.job.take())
        };
        let pid = child.id();
        if let Some(job) = job {
            job.terminate();
        }
        terminate_owned_process_tree(pid);
        let _ = child.kill();
        let _ = child.wait();
        clear_runtime_state_for_pid(pid);
        Some(pid)
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(OwnedEngine::default())
        .plugin(single_instance_init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
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
            let owned_engine = app.state::<OwnedEngine>().inner().clone();
            let rag_service_dir = resolve_rag_service_dir(app.handle());
            tauri::async_runtime::spawn(async move {
                let outcome = start_engine_and_wait(&owned_engine, rag_service_dir.as_deref());
                owned_engine.mark_startup_complete();
                let main_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || match outcome {
                    Ok((url, owns_engine)) => match open_window(&main_handle, &url) {
                        Ok(()) if owns_engine => monitor_owned_engine(owned_engine),
                        Ok(()) => {}
                        Err(message) => {
                            if owns_engine {
                                owned_engine.terminate_and_reap();
                            }
                            show_error_box(WINDOW_TITLE, &message);
                            std::process::exit(1);
                        }
                    },
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

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

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
            "exit" if confirm_exit() => request_engine_shutdown(app),
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

#[cfg(windows)]
fn confirm_exit() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONWARNING, MB_YESNO,
    };
    let title: Vec<u16> = WINDOW_TITLE
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let message: Vec<u16> = "确定要退出吗？这会终止翻译引擎与正在运行的所有翻译任务。"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONWARNING,
        ) == IDYES
    }
}

#[cfg(not(windows))]
fn confirm_exit() -> bool {
    true
}

/// An engine spawned by this shell is controlled through the retained Child
/// handle even when runtime metadata or HTTP probing is unavailable. Reused
/// engines remain subject to PID plus authenticated server identity checks.
fn request_engine_shutdown(app: &AppHandle) {
    let owned_engine = app.state::<OwnedEngine>().inner().clone();
    owned_engine.request_shutdown();
    std::thread::spawn(move || {
        // If the user confirms exit during startup, wait until the suspended
        // child has either been placed under ownership or startup has safely
        // completed. This closes the spawn-to-attach race.
        while owned_engine.pid().is_none() && !owned_engine.startup_is_complete() {
            std::thread::sleep(Duration::from_millis(10));
        }
        if let Some(owned_pid) = owned_engine.pid() {
            if let (Some(state), Some(token)) = (read_runtime_state(), read_server_token()) {
                if state.server_pid == owned_pid && runtime_identity_matches(&state, &token) {
                    post_shutdown(&state.origin, &token);
                    let deadline = Instant::now() + Duration::from_secs(10);
                    while Instant::now() < deadline {
                        match owned_engine.try_wait() {
                            Ok(OwnedEngineStatus::Exited { pid, .. }) => {
                                clear_runtime_state_for_pid(pid);
                                std::process::exit(0);
                            }
                            Ok(OwnedEngineStatus::Missing) => std::process::exit(0),
                            Ok(OwnedEngineStatus::Running) | Err(_) => {
                                std::thread::sleep(Duration::from_millis(200));
                            }
                        }
                    }
                }
            }

            // The retained Child is authoritative proof of ownership. This
            // fallback is deliberately independent of runtime.json, token
            // availability, and transient HTTP health.
            owned_engine.terminate_and_reap();
            std::process::exit(0);
        }

        shutdown_reused_engine(owned_engine.reused_snapshot());
    });
}

/// Reused engines have no Child handle in this process. Send only an
/// authenticated graceful-shutdown request and never force-terminate them.
fn shutdown_reused_engine(reused: Option<RuntimeState>) -> ! {
    // The target is the immutable identity snapshot accepted at startup.
    // Re-reading runtime.json here would let later file replacement redirect
    // shutdown to a different process.
    let state = match reused {
        Some(state) => state,
        None => std::process::exit(0),
    };
    let token = match read_server_token() {
        Some(token) => token,
        None => std::process::exit(0),
    };
    if !runtime_identity_matches(&state, &token) {
        std::process::exit(0);
    }

    post_shutdown(&state.origin, &token);
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        let address = match origin_address(&state.origin) {
            Some(address) => address,
            None => std::process::exit(0),
        };
        if TcpStream::connect_timeout(&address, REUSE_PROBE_TIMEOUT).is_err() {
            clear_runtime_state_for_pid(state.server_pid);
            std::process::exit(0);
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    // The authenticated service is still reachable after the graceful
    // shutdown deadline. It is externally owned, so leave both the process and
    // its runtime record intact for a later verified reuse.
    std::process::exit(0);
}

fn post_shutdown(origin: &str, token: &str) {
    let address = match origin_address(origin) {
        Some(address) => address,
        None => return,
    };
    let host_port = address.to_string();
    let mut stream = match TcpStream::connect_timeout(&address, REUSE_PROBE_TIMEOUT) {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let _ = stream.set_read_timeout(Some(REUSE_PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(REUSE_PROBE_TIMEOUT));
    let request = format!(
        "POST /api/v1/shutdown HTTP/1.1\r\nHost: {host_port}\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(request.as_bytes());
    let _ = stream.read_to_string(&mut String::new());
}

fn open_window(app: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = url
        .parse::<Url>()
        .map_err(|_| "翻译引擎返回了无效的工作台地址。".to_string())?;
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title(WINDOW_TITLE)
        .inner_size(1280.0, 860.0)
        .min_inner_size(920.0, 620.0)
        .center()
        .build()
        .map_err(|error| format!("无法打开工作台窗口：{error}"))?;
    let _ = window.set_focus();
    Ok(())
}

fn monitor_owned_engine(owned_engine: OwnedEngine) {
    std::thread::spawn(move || loop {
        match owned_engine.try_wait() {
            Ok(OwnedEngineStatus::Exited { pid, .. }) => {
                clear_runtime_state_for_pid(pid);
                std::process::exit(0);
            }
            Ok(OwnedEngineStatus::Missing) => return,
            Ok(OwnedEngineStatus::Running) | Err(_) => {
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    });
}

fn start_engine_and_wait(
    owned_engine: &OwnedEngine,
    rag_service_dir: Option<&Path>,
) -> Result<(String, bool), String> {
    let engine = find_engine_path()?;
    let engine_fingerprint = fingerprint_engine(&engine)?;
    if let Some((url, state)) = try_reuse_running_server(&engine_fingerprint) {
        owned_engine.remember_reused(state);
        return Ok((url, false));
    }

    let child = spawn_engine(&engine, rag_service_dir)?;
    owned_engine.install(child)?;
    let (stdout, stderr) = owned_engine.take_output();
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
        std::thread::spawn(
            move || {
                for _line in BufReader::new(err).lines().map_while(Result::ok) {}
            },
        );
    }

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        match line_receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(line) => {
                if let Some(url) = extract_ready_url(&line) {
                    let origin = match origin_from_ready_url(&url) {
                        Some(origin) => origin,
                        None => {
                            owned_engine.terminate_and_reap();
                            return Err("翻译引擎返回了非本机或无效的工作台地址。".into());
                        }
                    };
                    let token = match read_server_token() {
                        Some(token) => token,
                        None => {
                            owned_engine.terminate_and_reap();
                            return Err("翻译引擎已启动，但无法读取本机认证 token。".into());
                        }
                    };
                    let identity = match wait_for_meta(&origin, &token) {
                        Some(identity) => identity,
                        None => {
                            owned_engine.terminate_and_reap();
                            return Err(
                                "翻译引擎已报告就绪，但身份检查失败；为安全起见未连接。".into()
                            );
                        }
                    };
                    let server_pid = match owned_engine.pid() {
                        Some(pid) => pid,
                        None => return Err("翻译引擎在身份检查期间意外退出。".into()),
                    };
                    let state = RuntimeState {
                        manager_pid: std::process::id(),
                        server_pid,
                        server_id: identity.server_id,
                        engine_version: identity.server_version,
                        engine_fingerprint: engine_fingerprint.clone(),
                        port: origin_address(&origin)
                            .map(|address| address.port())
                            .unwrap_or(0),
                        origin,
                        started_at_unix: unix_now(),
                    };
                    if let Err(error) = owned_engine.write_runtime_if_active(&state) {
                        owned_engine.terminate_and_reap();
                        return Err(error);
                    }
                    return Ok((url, true));
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                match owned_engine.try_wait() {
                    Ok(OwnedEngineStatus::Exited { status, .. }) => {
                        return Err(format!(
                            "翻译引擎在就绪前退出（退出码 {}）。",
                            status
                                .code()
                                .map_or_else(|| "unknown".into(), |code| code.to_string())
                        ));
                    }
                    Ok(OwnedEngineStatus::Missing) => {
                        return Err("翻译引擎在就绪前已被终止。".into());
                    }
                    Ok(OwnedEngineStatus::Running) => {}
                    Err(error) => {
                        owned_engine.terminate_and_reap();
                        return Err(error);
                    }
                }
                if Instant::now() >= deadline {
                    owned_engine.terminate_and_reap();
                    return Err("翻译引擎在 90 秒内未就绪。".into());
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                owned_engine.terminate_and_reap();
                return Err("翻译引擎在就绪前停止输出。".into());
            }
        }
    }
}

fn try_reuse_running_server(expected_engine_fingerprint: &str) -> Option<(String, RuntimeState)> {
    let mut state = read_runtime_state()?;
    if state.engine_fingerprint != expected_engine_fingerprint {
        clear_runtime_state_for_pid(state.server_pid);
        return None;
    }
    if !pid_is_alive(state.server_pid) {
        clear_runtime_state_for_pid(state.server_pid);
        return None;
    }
    let token = match read_server_token() {
        Some(token) => token,
        None => {
            clear_runtime_state_for_pid(state.server_pid);
            return None;
        }
    };
    if !runtime_identity_matches(&state, &token) {
        clear_runtime_state_for_pid(state.server_pid);
        return None;
    }
    state.manager_pid = std::process::id();
    let _ = write_runtime_state(&state);
    Some((workbench_url(&state.origin, &token), state))
}

fn runtime_identity_matches(state: &RuntimeState, token: &str) -> bool {
    match probe_server(&state.origin, token) {
        ProbeResult::Reuse(identity) => {
            identity.server_id == state.server_id
                && identity.server_version == state.engine_version
                && origin_address(&state.origin).map(|address| address.port()) == Some(state.port)
        }
        ProbeResult::Unknown => false,
    }
}

fn wait_for_meta(origin: &str, token: &str) -> Option<MetaIdentity> {
    for _ in 0..25 {
        if let ProbeResult::Reuse(identity) = probe_server(origin, token) {
            return Some(identity);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

fn probe_server(origin: &str, token: &str) -> ProbeResult {
    let address = match origin_address(origin) {
        Some(address) => address,
        None => return ProbeResult::Unknown,
    };
    let host_port = address.to_string();
    let mut stream = match TcpStream::connect_timeout(&address, REUSE_PROBE_TIMEOUT) {
        Ok(stream) => stream,
        Err(_) => return ProbeResult::Unknown,
    };
    let _ = stream.set_read_timeout(Some(REUSE_PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(REUSE_PROBE_TIMEOUT));
    let request = format!(
        "GET /api/v1/meta HTTP/1.1\r\nHost: {host_port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return ProbeResult::Unknown;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return ProbeResult::Unknown;
    }
    parse_meta_response(&response)
        .map(ProbeResult::Reuse)
        .unwrap_or(ProbeResult::Unknown)
}

fn parse_meta_response(response: &str) -> Option<MetaIdentity> {
    let (headers, body) = response.split_once("\r\n\r\n")?;
    let status = headers.lines().next()?.split_whitespace().nth(1)?;
    if !status.starts_with('2') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    let data = value.get("data")?;
    Some(MetaIdentity {
        server_id: data.get("server_id")?.as_str()?.to_string(),
        server_version: data.get("server_version")?.as_str()?.to_string(),
    })
}

fn extract_ready_url(line: &str) -> Option<String> {
    let index = line.find(READY_LINE_PREFIX)?;
    let candidate = line[index + READY_LINE_PREFIX.len()..]
        .trim()
        .split_whitespace()
        .next()?;
    origin_from_ready_url(candidate)?;
    Some(candidate.to_string())
}

fn origin_from_ready_url(value: &str) -> Option<String> {
    let parsed = value.parse::<Url>().ok()?;
    if parsed.scheme() != "http" || parsed.host_str()? != SERVER_HOST {
        return None;
    }
    let port = parsed.port_or_known_default()?;
    (port > 0).then(|| format!("http://{SERVER_HOST}:{port}"))
}

fn origin_address(origin: &str) -> Option<SocketAddr> {
    let parsed = origin.parse::<Url>().ok()?;
    if parsed.scheme() != "http" || parsed.host_str()? != SERVER_HOST {
        return None;
    }
    let port = parsed.port_or_known_default()?;
    if port == 0 {
        return None;
    }
    format!("{SERVER_HOST}:{port}").parse().ok()
}

fn workbench_url(origin: &str, token: &str) -> String {
    format!(
        "{}/#token={}",
        origin.trim_end_matches('/'),
        percent_encode(token)
    )
}

fn find_engine_path() -> Result<PathBuf, String> {
    if let Ok(configured) = std::env::var("BATCH_TRANSLATING_KIMI_EXE") {
        if !configured.trim().is_empty() {
            let path = PathBuf::from(configured.trim());
            if path.is_file() {
                return Ok(path);
            }
            return Err(format!(
                "BATCH_TRANSLATING_KIMI_EXE 指向不存在的文件：{}",
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
        "未在程序旁找到 batch-translating-engine.exe；请重新安装或设置 BATCH_TRANSLATING_KIMI_EXE。"
            .into(),
    )
}

/// Resolve the packaged Python service without treating its absence as an
/// engine-start failure. The no-BGE quality policy remains available when the
/// packaged resource is missing or damaged. Development repository probing is
/// compiled out of release builds and no discovered path is persisted.
fn resolve_rag_service_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut diagnostics = Vec::new();
    match app
        .path()
        .resolve(RAG_SERVICE_RESOURCE_DIR, BaseDirectory::Resource)
    {
        Ok(candidate) => match validate_rag_service_dir(&candidate) {
            Ok(validated) => return Some(validated),
            Err(error) => diagnostics.push(format!("packaged resource: {error}")),
        },
        Err(error) => diagnostics.push(format!("resource resolver: {error}")),
    }

    #[cfg(debug_assertions)]
    if let Some(candidate) = find_development_rag_service_dir() {
        eprintln!(
            "Batch Translating RAG: packaged resource unavailable; using a validated development repository resource"
        );
        return Some(candidate);
    }

    eprintln!(
        "Batch Translating RAG unavailable; continuing in no-BGE mode: {}",
        diagnostics.join("; ")
    );
    None
}

fn validate_rag_service_dir(candidate: &Path) -> Result<PathBuf, String> {
    if !candidate.is_dir() {
        return Err("service directory is missing".into());
    }
    let root = std::fs::canonicalize(candidate)
        .map_err(|_| "service directory cannot be resolved".to_string())?;
    let entry = root.join(RAG_SERVICE_ENTRY);
    if !entry.is_file() {
        return Err(format!("required entry {RAG_SERVICE_ENTRY} is missing"));
    }
    let resolved_entry = std::fs::canonicalize(&entry)
        .map_err(|_| format!("required entry {RAG_SERVICE_ENTRY} cannot be resolved"))?;
    if !resolved_entry.starts_with(&root) {
        return Err("service entry resolves outside the resource directory".into());
    }
    Ok(root)
}

#[cfg(debug_assertions)]
fn find_development_rag_service_dir() -> Option<PathBuf> {
    let mut seeds = Vec::new();
    if let Ok(directory) = std::env::current_dir() {
        seeds.push(directory);
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            seeds.push(directory.to_path_buf());
        }
    }
    for seed in seeds {
        for base in seed.ancestors().take(10) {
            let candidate = base.join("packages/translation-rag/service");
            if let Ok(validated) = validate_rag_service_dir(&candidate) {
                return Some(validated);
            }
        }
    }
    None
}

fn fingerprint_engine(engine: &PathBuf) -> Result<String, String> {
    let mut file = std::fs::File::open(engine)
        .map_err(|error| format!("无法读取翻译引擎以验证安装身份：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("无法验证翻译引擎安装身份：{error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn spawn_engine(engine: &PathBuf, rag_service_dir: Option<&Path>) -> Result<Child, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let engine = std::fs::canonicalize(engine)
            .map_err(|_| "无法解析已验证翻译引擎的启动路径。".to_string())?;
        let mut command = Command::new(&engine);
        let product_home = product_home_dir();
        command.env("BATCH_TRANSLATING_HOME", &product_home);
        command.env("KIMI_CODE_HOME", &product_home);
        command.env("CHOKIDAR_USEPOLLING", "1");
        // Never inherit an arbitrary caller-provided service path. Only the
        // Tauri resource resolver (or debug-only repository fallback) may set
        // this environment variable for the child engine.
        command.env_remove(RAG_SERVICE_ENV);
        command.env_remove(PRODUCT_CLI_ENV);
        command.env(PRODUCT_CLI_ENV, &engine);
        if let Some(service_dir) = rag_service_dir {
            command.env(RAG_SERVICE_ENV, service_dir);
        }
        command
            .args([
                "web",
                "--no-open",
                "--host",
                SERVER_HOST,
                "--port",
                &PREFERRED_SERVER_PORT.to_string(),
                "--log-level",
                "info",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        return command
            .spawn()
            .map_err(|error| format!("无法启动翻译引擎：{error}"));
    }
    #[cfg(not(windows))]
    {
        let _ = (engine, rag_service_dir);
        Err("当前桌面壳只支持 Windows。".into())
    }
}

fn read_runtime_state() -> Option<RuntimeState> {
    let text = std::fs::read_to_string(runtime_path()).ok()?;
    let state: RuntimeState = serde_json::from_str(&text).ok()?;
    if state.port == 0
        || origin_address(&state.origin).map(|address| address.port()) != Some(state.port)
        || state.server_id.trim().is_empty()
        || state.engine_version.trim().is_empty()
        || !valid_engine_fingerprint(&state.engine_fingerprint)
    {
        return None;
    }
    Some(state)
}

fn valid_engine_fingerprint(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn write_runtime_state(state: &RuntimeState) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state)
        .map_err(|error| format!("无法编码引擎运行状态：{error}"))?;
    debug_assert!(!text.contains("#token="));
    let dir = runtime_dir();
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建运行状态目录：{error}"))?;
    std::fs::write(dir.join(RUNTIME_FILE_NAME), text)
        .map_err(|error| format!("无法写入引擎运行状态：{error}"))
}

fn clear_runtime_state_for_pid(server_pid: u32) {
    let should_remove = read_runtime_state()
        .map(|state| state.server_pid == server_pid)
        .unwrap_or(true);
    if should_remove {
        let _ = std::fs::remove_file(runtime_path());
    }
}

fn runtime_path() -> PathBuf {
    runtime_dir().join(RUNTIME_FILE_NAME)
}

fn runtime_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("TEMP"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join(RUNTIME_DIR_NAME)
}

fn read_server_token() -> Option<String> {
    let token = std::fs::read_to_string(product_home_dir().join(SERVER_TOKEN_FILE)).ok()?;
    let token = token.trim().to_string();
    (!token.is_empty()).then_some(token)
}

fn product_home_dir() -> PathBuf {
    non_empty_env_path("BATCH_TRANSLATING_HOME")
        .or_else(|| non_empty_env_path("KIMI_CODE_HOME"))
        .unwrap_or_else(|| {
            non_empty_env_path("USERPROFILE")
                .unwrap_or_default()
                .join(DEFAULT_HOME_DIR_NAME)
        })
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    let value = std::env::var(name).ok()?;
    (!value.trim().is_empty()).then(|| PathBuf::from(value))
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(windows)]
fn pid_is_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    let filter = format!("PID eq {pid}");
    let output = match Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(output) => output,
        Err(_) => return false,
    };
    String::from_utf8_lossy(&output.stdout).contains(&format!(",\"{pid}\","))
}

#[cfg(not(windows))]
fn pid_is_alive(_pid: u32) -> bool {
    true
}

#[cfg(windows)]
fn terminate_registered_pid(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
fn terminate_registered_pid(_pid: u32) {}

#[cfg(windows)]
fn terminate_owned_process_tree(pid: u32) {
    terminate_registered_pid(pid);
}

#[cfg(not(windows))]
fn terminate_owned_process_tree(_pid: u32) {}

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
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
fn show_error_box(title: &str, message: &str) {
    eprintln!("{title}: {message}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    };

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn with_home_env<T>(
        batch: Option<&str>,
        kimi: Option<&str>,
        userprofile: Option<&str>,
        local_app_data: Option<&str>,
        action: impl FnOnce() -> T,
    ) -> T {
        let _guard = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let names = [
            "BATCH_TRANSLATING_HOME",
            "KIMI_CODE_HOME",
            "USERPROFILE",
            "LOCALAPPDATA",
        ];
        let previous = names
            .iter()
            .map(|name| (*name, std::env::var_os(name)))
            .collect::<Vec<_>>();
        for (name, value) in [
            ("BATCH_TRANSLATING_HOME", batch),
            ("KIMI_CODE_HOME", kimi),
            ("USERPROFILE", userprofile),
            ("LOCALAPPDATA", local_app_data),
        ] {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }

        let result = catch_unwind(AssertUnwindSafe(action));
        for (name, value) in previous {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
        match result {
            Ok(value) => value,
            Err(payload) => std::panic::resume_unwind(payload),
        }
    }

    #[test]
    fn product_home_ignores_empty_environment_values_and_keeps_priority() {
        with_home_env(
            Some(""),
            Some("D:\\kimi-home"),
            Some("D:\\user-home"),
            None,
            || assert_eq!(product_home_dir(), PathBuf::from("D:\\kimi-home")),
        );
        with_home_env(Some(""), Some(""), Some("D:\\user-home"), None, || {
            assert_eq!(
                product_home_dir(),
                PathBuf::from("D:\\user-home").join(DEFAULT_HOME_DIR_NAME)
            )
        });
        with_home_env(
            Some("D:\\batch-home"),
            Some("D:\\kimi-home"),
            Some("D:\\user-home"),
            None,
            || assert_eq!(product_home_dir(), PathBuf::from("D:\\batch-home")),
        );
        with_home_env(Some(""), Some(""), Some(""), None, || {
            assert_eq!(product_home_dir(), PathBuf::from(DEFAULT_HOME_DIR_NAME));
        });
    }

    #[test]
    fn read_server_token_uses_the_same_selected_home_as_product_home() {
        let root = std::env::temp_dir().join(format!(
            "batch-translating-desktop-home-test-{}-{}",
            std::process::id(),
            unix_now()
        ));
        let batch_home = root.join("batch");
        let kimi_home = root.join("kimi");
        let user_home = root.join("user");
        std::fs::create_dir_all(&batch_home).unwrap();
        std::fs::create_dir_all(&kimi_home).unwrap();
        std::fs::create_dir_all(&user_home).unwrap();
        std::fs::write(batch_home.join(SERVER_TOKEN_FILE), "batch-token\n").unwrap();
        std::fs::write(kimi_home.join(SERVER_TOKEN_FILE), "kimi-token\n").unwrap();
        std::fs::create_dir_all(user_home.join(DEFAULT_HOME_DIR_NAME)).unwrap();
        std::fs::write(
            user_home
                .join(DEFAULT_HOME_DIR_NAME)
                .join(SERVER_TOKEN_FILE),
            "user-token\n",
        )
        .unwrap();

        with_home_env(
            Some(batch_home.to_str().unwrap()),
            Some(kimi_home.to_str().unwrap()),
            Some(user_home.to_str().unwrap()),
            None,
            || assert_eq!(read_server_token().as_deref(), Some("batch-token")),
        );
        with_home_env(
            Some(""),
            Some(kimi_home.to_str().unwrap()),
            Some(user_home.to_str().unwrap()),
            None,
            || assert_eq!(read_server_token().as_deref(), Some("kimi-token")),
        );
        with_home_env(
            Some(""),
            Some(""),
            Some(user_home.to_str().unwrap()),
            None,
            || assert_eq!(read_server_token().as_deref(), Some("user-token")),
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn clear_runtime_state_only_removes_the_matching_server_pid() {
        let root = std::env::temp_dir().join(format!(
            "batch-translating-desktop-runtime-test-{}-{}",
            std::process::id(),
            unix_now()
        ));
        let local_app_data = root.join("localappdata");
        std::fs::create_dir_all(&local_app_data).unwrap();
        let state = RuntimeState {
            manager_pid: 10,
            server_pid: 20,
            server_id: "server-1".into(),
            engine_version: "0.33.0".into(),
            engine_fingerprint:
                "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
            origin: "http://127.0.0.1:58631".into(),
            port: 58631,
            started_at_unix: 30,
        };
        with_home_env(
            None,
            None,
            Some(root.to_str().unwrap()),
            Some(local_app_data.to_str().unwrap()),
            || {
                write_runtime_state(&state).unwrap();
                clear_runtime_state_for_pid(21);
                assert_eq!(read_runtime_state(), Some(state.clone()));
                clear_runtime_state_for_pid(20);
                assert_eq!(read_runtime_state(), None);
            },
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn runtime_write_is_rejected_after_shutdown_is_requested() {
        let root = std::env::temp_dir().join(format!(
            "batch-translating-desktop-shutdown-write-test-{}-{}",
            std::process::id(),
            unix_now()
        ));
        let local_app_data = root.join("localappdata");
        std::fs::create_dir_all(&local_app_data).unwrap();
        with_home_env(
            None,
            None,
            Some(root.to_str().unwrap()),
            Some(local_app_data.to_str().unwrap()),
            || {
                let child = Command::new("cmd.exe")
                    .args(["/C", "ping 127.0.0.1 -n 20 > nul"])
                    .spawn()
                    .unwrap();
                let engine = OwnedEngine::default();
                let child_pid = engine.install(child).unwrap();
                let state = RuntimeState {
                    manager_pid: std::process::id(),
                    server_pid: child_pid,
                    server_id: "server-write".into(),
                    engine_version: "0.33.0".into(),
                    engine_fingerprint:
                        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                            .into(),
                    origin: "http://127.0.0.1:58631".into(),
                    port: 58631,
                    started_at_unix: unix_now(),
                };
                engine.write_runtime_if_active(&state).unwrap();
                assert_eq!(read_runtime_state(), Some(state.clone()));
                engine.request_shutdown();
                assert!(engine.write_runtime_if_active(&state).is_err());
                assert_eq!(read_runtime_state(), Some(state));
                engine.terminate_and_reap();
                assert_eq!(read_runtime_state(), None);
            },
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reused_identity_recheck_failure_preserves_runtime_for_later_validation() {
        const CHILD_ENV: &str = "BATCH_TRANSLATING_REUSED_IDENTITY_CHILD";
        if std::env::var_os(CHILD_ENV).is_some() {
            let port = std::env::var("BATCH_TRANSLATING_REUSED_IDENTITY_PORT")
                .unwrap()
                .parse::<u16>()
                .unwrap();
            let state = RuntimeState {
                manager_pid: std::process::id(),
                server_pid: 515_151,
                server_id: "server-snapshot".into(),
                engine_version: "0.33.0".into(),
                engine_fingerprint:
                    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
                origin: format!("http://127.0.0.1:{port}"),
                port,
                started_at_unix: unix_now(),
            };
            shutdown_reused_engine(Some(state));
        }

        let root = std::env::temp_dir().join(format!(
            "batch-translating-desktop-reuse-identity-test-{}-{}",
            std::process::id(),
            unix_now()
        ));
        let home = root.join("home");
        let local_app_data = root.join("localappdata");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&local_app_data).unwrap();
        std::fs::write(home.join(SERVER_TOKEN_FILE), "smoke-token\n").unwrap();

        let listener = std::net::TcpListener::bind((SERVER_HOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            let body = r#"{"data":{"server_id":"server-other","server_version":"0.33.0"}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        with_home_env(
            Some(home.to_str().unwrap()),
            Some(""),
            Some(root.to_str().unwrap()),
            Some(local_app_data.to_str().unwrap()),
            || {
                let state = RuntimeState {
                    manager_pid: std::process::id(),
                    server_pid: 515_151,
                    server_id: "server-snapshot".into(),
                    engine_version: "0.33.0".into(),
                    engine_fingerprint:
                        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                            .into(),
                    origin: format!("http://127.0.0.1:{port}"),
                    port,
                    started_at_unix: unix_now(),
                };
                write_runtime_state(&state).unwrap();
                let executable = std::env::current_exe().unwrap();
                let child = std::process::Command::new(executable)
                    .args([
                        "--exact",
                        "tests::reused_identity_recheck_failure_preserves_runtime_for_later_validation",
                        "--nocapture",
                    ])
                    .env(CHILD_ENV, "1")
                    .env("BATCH_TRANSLATING_REUSED_IDENTITY_PORT", port.to_string())
                    .spawn()
                    .unwrap();
                let output = child.wait_with_output().unwrap();
                assert!(
                    output.status.success(),
                    "child identity recheck failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert_eq!(read_runtime_state(), Some(state));
            },
        );
        server_thread.join().unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reused_shutdown_timeout_preserves_runtime_for_later_reuse() {
        const CHILD_ENV: &str = "BATCH_TRANSLATING_REUSED_TIMEOUT_CHILD";
        if std::env::var_os(CHILD_ENV).is_some() {
            let port = std::env::var("BATCH_TRANSLATING_REUSED_TIMEOUT_PORT")
                .unwrap()
                .parse::<u16>()
                .unwrap();
            let state = RuntimeState {
                manager_pid: std::process::id(),
                server_pid: 424_242,
                server_id: "server-reuse".into(),
                engine_version: "0.33.0".into(),
                engine_fingerprint:
                    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
                origin: format!("http://127.0.0.1:{port}"),
                port,
                started_at_unix: unix_now(),
            };
            shutdown_reused_engine(Some(state));
        }

        let root = std::env::temp_dir().join(format!(
            "batch-translating-desktop-reuse-timeout-test-{}-{}",
            std::process::id(),
            unix_now()
        ));
        let home = root.join("home");
        let local_app_data = root.join("localappdata");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&local_app_data).unwrap();
        std::fs::write(home.join(SERVER_TOKEN_FILE), "smoke-token\n").unwrap();

        let listener = std::net::TcpListener::bind((SERVER_HOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_running = std::sync::Arc::new(AtomicBool::new(true));
        let server_running_thread = server_running.clone();
        let server_thread = std::thread::spawn(move || {
            while server_running_thread.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0_u8; 2048];
                        let _ = stream.read(&mut request);
                        let body =
                            r#"{"data":{"server_id":"server-reuse","server_version":"0.33.0"}}"#;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });

        with_home_env(
            Some(home.to_str().unwrap()),
            Some(""),
            Some(root.to_str().unwrap()),
            Some(local_app_data.to_str().unwrap()),
            || {
                let state = RuntimeState {
                    manager_pid: std::process::id(),
                    server_pid: 424_242,
                    server_id: "server-reuse".into(),
                    engine_version: "0.33.0".into(),
                    engine_fingerprint:
                        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                            .into(),
                    origin: format!("http://127.0.0.1:{port}"),
                    port,
                    started_at_unix: unix_now(),
                };
                write_runtime_state(&state).unwrap();
                let executable = std::env::current_exe().unwrap();
                let child = std::process::Command::new(executable)
                    .args([
                        "--exact",
                        "tests::reused_shutdown_timeout_preserves_runtime_for_later_reuse",
                        "--nocapture",
                    ])
                    .env(CHILD_ENV, "1")
                    .env("BATCH_TRANSLATING_REUSED_TIMEOUT_PORT", port.to_string())
                    .spawn()
                    .unwrap();
                let output = child.wait_with_output().unwrap();
                assert!(
                    output.status.success(),
                    "child shutdown failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert_eq!(read_runtime_state(), Some(state));
            },
        );
        server_running.store(false, Ordering::Release);
        let _ = std::net::TcpStream::connect((SERVER_HOST, port));
        server_thread.join().unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ready_url_accepts_only_loopback_http_and_keeps_dynamic_port() {
        assert_eq!(
            extract_ready_url(
                "info Kimi server: http://127.0.0.1:58631/#token=do-not-persist ready"
            ),
            Some("http://127.0.0.1:58631/#token=do-not-persist".into())
        );
        assert_eq!(
            origin_from_ready_url("http://127.0.0.1:58631/#token=secret"),
            Some("http://127.0.0.1:58631".into())
        );
        assert_eq!(
            origin_from_ready_url("http://example.com:58631/#token=x"),
            None
        );
        assert_eq!(
            origin_from_ready_url("https://127.0.0.1:58631/#token=x"),
            None
        );
    }

    #[test]
    fn meta_response_requires_success_and_identity_fields() {
        let response = concat!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n",
            "{\"code\":0,\"data\":{\"server_id\":\"server-1\",\"server_version\":\"0.33.0\"}}"
        );
        assert_eq!(
            parse_meta_response(response),
            Some(MetaIdentity {
                server_id: "server-1".into(),
                server_version: "0.33.0".into(),
            })
        );
        assert_eq!(
            parse_meta_response("HTTP/1.1 401 Unauthorized\r\n\r\n{}"),
            None
        );
    }

    #[test]
    fn runtime_state_never_serializes_token_or_ready_url() {
        let state = RuntimeState {
            manager_pid: 10,
            server_pid: 20,
            server_id: "server-1".into(),
            engine_version: "0.33.0".into(),
            engine_fingerprint:
                "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
            origin: "http://127.0.0.1:58631".into(),
            port: 58631,
            started_at_unix: 30,
        };
        let text = serde_json::to_string(&state).unwrap();
        assert!(!text.contains("token"));
        assert!(!text.contains('#'));
        assert!(!text.contains("\"url\""));
        assert_eq!(serde_json::from_str::<RuntimeState>(&text).unwrap(), state);
    }

    #[test]
    fn workbench_url_percent_encodes_token_only_in_memory() {
        assert_eq!(
            workbench_url("http://127.0.0.1:58631", "a b/#"),
            "http://127.0.0.1:58631/#token=a%20b%2F%23"
        );
    }
}
