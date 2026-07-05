use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;

use milim_core::{Error, Result};

const MAX_LOG_LINES: usize = 500;
const INSTALL_MARKER_FILE: &str = ".milim-install-ok";
#[cfg(not(test))]
const PREVIEW_READY_QUIET_MS: u64 = 1_000;
#[cfg(test)]
const PREVIEW_READY_QUIET_MS: u64 = 10;
#[cfg(not(test))]
const PREVIEW_READY_PROBE_TIMEOUT_MS: u64 = 10_000;
#[cfg(test)]
const PREVIEW_READY_PROBE_TIMEOUT_MS: u64 = 100;
#[cfg(not(test))]
const PREVIEW_READY_PROBE_INTERVAL_MS: u64 = 250;
#[cfg(test)]
const PREVIEW_READY_PROBE_INTERVAL_MS: u64 = 5;
#[cfg(not(test))]
const PREVIEW_READY_REQUEST_TIMEOUT_MS: u64 = 1_000;
#[cfg(test)]
const PREVIEW_READY_REQUEST_TIMEOUT_MS: u64 = 50;

#[derive(Debug, Clone, Serialize)]
pub struct PreviewAppLog {
    pub ts: u64,
    pub stream: String,
    pub line: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewAppStatus {
    pub thread_id: String,
    pub status: String,
    pub cwd: String,
    pub url: Option<String>,
    pub pid: Option<u32>,
    pub command: Option<String>,
    pub message: Option<String>,
    pub logs: Vec<PreviewAppLog>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PreviewAppFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PreviewAppStageRequest {
    #[serde(default)]
    pub files: Vec<PreviewAppFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PreviewAppStartRequest {
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Default)]
struct PreviewAppEntry {
    cwd: Option<PathBuf>,
    status: String,
    url: Option<String>,
    pid: Option<u32>,
    command: Option<String>,
    message: Option<String>,
    logs: VecDeque<PreviewAppLog>,
}

pub struct PreviewRuntimeManager {
    root: PathBuf,
    entries: Mutex<HashMap<String, PreviewAppEntry>>,
}

impl PreviewRuntimeManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn status(&self, thread_id: &str) -> Result<PreviewAppStatus> {
        let thread_id = safe_thread_id(thread_id)?;
        Ok(self.status_for(&thread_id))
    }

    pub fn logs(&self, thread_id: &str) -> Result<Vec<PreviewAppLog>> {
        let thread_id = safe_thread_id(thread_id)?;
        let entries = self
            .entries
            .lock()
            .map_err(|_| Error::Other("preview runtime state lock poisoned".to_string()))?;
        Ok(entries
            .get(&thread_id)
            .map(|entry| entry.logs.iter().cloned().collect())
            .unwrap_or_default())
    }

    pub fn stage(&self, thread_id: &str, files: &[PreviewAppFile]) -> Result<PreviewAppStatus> {
        let thread_id = safe_thread_id(thread_id)?;
        if files.is_empty() {
            return Err(Error::InvalidRequest(
                "preview app staging requires at least one file".to_string(),
            ));
        }
        let dir = self.app_dir(&thread_id);
        if self.running_status(&thread_id, &dir)?.is_some() {
            return Err(Error::InvalidRequest(
                "stop the preview app before staging new files".to_string(),
            ));
        }
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        std::fs::create_dir_all(&dir)?;
        for file in files {
            let rel = safe_relative_path(&file.path)?;
            let target = dir.join(rel);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(target, file.content.as_bytes())?;
        }
        self.set_entry(&thread_id, |entry| {
            entry.cwd = Some(dir.clone());
            if entry.pid.is_none() {
                entry.status = "staged".to_string();
            }
            entry.message = Some(format!("Staged {} file(s).", files.len()));
            push_log(entry, "system", &format!("staged {} file(s)", files.len()));
        })?;
        Ok(self.status_for(&thread_id))
    }

    pub fn start(self: &Arc<Self>, thread_id: &str, cwd: Option<&str>) -> Result<PreviewAppStatus> {
        let thread_id = safe_thread_id(thread_id)?;
        let target = self.start_target(&thread_id, cwd)?;
        let dir = target.dir;
        if let Some(status) = self.running_status(&thread_id, &dir)? {
            return Ok(status);
        }
        if !dir.join("package.json").is_file() {
            return Err(Error::InvalidRequest(
                "preview app requires package.json".to_string(),
            ));
        }
        let package = preview_package(&dir)?;
        if !package.has_dev_script {
            return Err(Error::InvalidRequest(
                "preview app package.json requires scripts.dev".to_string(),
            ));
        }
        let vite_setup_logs = if target.managed {
            ensure_vite_setup(&dir, &package)?
        } else {
            Vec::new()
        };
        let port = free_port()?;
        let url = format!("http://127.0.0.1:{port}/");
        let command = package.dev_label(port);
        self.set_entry(&thread_id, |entry| {
            entry.cwd = Some(dir.clone());
            entry.status = "installing".to_string();
            entry.url = Some(url.clone());
            entry.pid = None;
            entry.command = Some(command.clone());
            entry.message = Some("Installing dependencies.".to_string());
            push_log(entry, "system", "starting preview app");
            for log in vite_setup_logs {
                push_log(entry, "system", &log);
            }
        })?;
        tokio::spawn(run_preview_app(
            self.clone(),
            thread_id.clone(),
            dir,
            port,
            package,
            target.managed,
        ));
        Ok(self.status_for(&thread_id))
    }

    pub async fn stop(&self, thread_id: &str) -> Result<PreviewAppStatus> {
        let thread_id = safe_thread_id(thread_id)?;
        let pid = {
            let entries = self
                .entries
                .lock()
                .map_err(|_| Error::Other("preview runtime state lock poisoned".to_string()))?;
            entries.get(&thread_id).and_then(|entry| entry.pid)
        };
        if let Some(pid) = pid {
            kill_process_tree(pid).await?;
        }
        self.set_entry(&thread_id, |entry| {
            entry.status = "stopped".to_string();
            entry.pid = None;
            entry.message = Some("Stopped.".to_string());
            push_log(entry, "system", "stopped preview app");
        })?;
        Ok(self.status_for(&thread_id))
    }

    pub async fn restart(
        self: &Arc<Self>,
        thread_id: &str,
        cwd: Option<&str>,
    ) -> Result<PreviewAppStatus> {
        let thread_id = safe_thread_id(thread_id)?;
        let _ = self.stop(&thread_id).await;
        self.start(&thread_id, cwd)
    }

    fn app_dir(&self, thread_id: &str) -> PathBuf {
        self.root.join(thread_id)
    }

    fn start_target(&self, thread_id: &str, cwd: Option<&str>) -> Result<PreviewAppTarget> {
        let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(PreviewAppTarget {
                dir: self.app_dir(thread_id),
                managed: true,
            });
        };
        let dir = PathBuf::from(cwd);
        if !dir.is_absolute() {
            return Err(Error::InvalidRequest(format!(
                "preview app cwd must be absolute: {cwd}"
            )));
        }
        if !dir.is_dir() {
            return Err(Error::InvalidRequest(format!(
                "preview app cwd is not a directory: {cwd}"
            )));
        }
        Ok(PreviewAppTarget {
            dir,
            managed: false,
        })
    }

    fn status_for(&self, thread_id: &str) -> PreviewAppStatus {
        let entries = self.entries.lock().ok();
        let entry = entries.as_ref().and_then(|items| items.get(thread_id));
        let cwd = entry
            .and_then(|entry| entry.cwd.clone())
            .unwrap_or_else(|| self.app_dir(thread_id))
            .to_string_lossy()
            .to_string();
        PreviewAppStatus {
            thread_id: thread_id.to_string(),
            status: entry
                .map(|entry| entry.status.clone())
                .unwrap_or_else(|| "idle".to_string()),
            cwd,
            url: entry.and_then(|entry| entry.url.clone()),
            pid: entry.and_then(|entry| entry.pid),
            command: entry.and_then(|entry| entry.command.clone()),
            message: entry.and_then(|entry| entry.message.clone()),
            logs: entry
                .map(|entry| entry.logs.iter().cloned().collect())
                .unwrap_or_default(),
        }
    }

    fn running_status(&self, thread_id: &str, dir: &Path) -> Result<Option<PreviewAppStatus>> {
        let entries = self
            .entries
            .lock()
            .map_err(|_| Error::Other("preview runtime state lock poisoned".to_string()))?;
        let Some(entry) = entries.get(thread_id) else {
            return Ok(None);
        };
        let running = entry.pid.is_some()
            || matches!(entry.status.as_str(), "installing" | "starting" | "running");
        if running && entry.cwd.as_deref().is_some_and(|current| current != dir) {
            return Err(Error::InvalidRequest(
                "stop the current preview app before starting another folder".to_string(),
            ));
        }
        let running = running.then_some(());
        drop(entries);
        Ok(running.map(|_| self.status_for(thread_id)))
    }

    fn set_entry(&self, thread_id: &str, update: impl FnOnce(&mut PreviewAppEntry)) -> Result<()> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| Error::Other("preview runtime state lock poisoned".to_string()))?;
        let entry = entries
            .entry(thread_id.to_string())
            .or_insert_with(|| PreviewAppEntry {
                status: "idle".to_string(),
                ..Default::default()
            });
        update(entry);
        Ok(())
    }
}

struct PreviewAppTarget {
    dir: PathBuf,
    managed: bool,
}

async fn run_preview_app(
    manager: Arc<PreviewRuntimeManager>,
    thread_id: String,
    dir: PathBuf,
    port: u16,
    package: PreviewPackage,
    managed: bool,
) {
    if needs_dependency_install(&dir, managed) {
        let install = package.install_args();
        let install_label = package.install_label();
        let status = run_logged_command(
            manager.clone(),
            &thread_id,
            &dir,
            &install_label,
            package.manager.command_name(),
            &install,
        )
        .await;
        if let Err(error) = status {
            let _ = manager.set_entry(&thread_id, |entry| {
                entry.status = "error".to_string();
                entry.message = Some(error.to_string());
                push_log(entry, "system", &error.to_string());
            });
            return;
        }
        if managed {
            let _ = std::fs::write(dir.join(INSTALL_MARKER_FILE), b"ok");
        }
    } else {
        let _ = manager.set_entry(&thread_id, |entry| {
            push_log(
                entry,
                "system",
                "dependencies already installed; skipping npm install",
            );
        });
    }

    let command = package.dev_label(port);
    let dev_args = package.dev_args(port);
    let mut child = match preview_command(package.manager.command_name())
        .args(&dev_args)
        .current_dir(&dir)
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let _ = manager.set_entry(&thread_id, |entry| {
                entry.status = "error".to_string();
                entry.message = Some(error.to_string());
                push_log(
                    entry,
                    "system",
                    &format!("failed to start dev server: {error}"),
                );
            });
            return;
        }
    };
    let pid = child.id();
    let _ = manager.set_entry(&thread_id, |entry| {
        entry.status = "starting".to_string();
        entry.pid = pid;
        entry.command = Some(command);
        entry.message = Some("Starting dev server.".to_string());
        push_log(entry, "system", "preview app is starting");
    });
    pipe_child_logs(
        manager.clone(),
        thread_id.clone(),
        child.stdout.take(),
        "stdout",
    );
    pipe_child_logs(
        manager.clone(),
        thread_id.clone(),
        child.stderr.take(),
        "stderr",
    );
    match child.wait().await {
        Ok(status) => {
            let _ = manager.set_entry(&thread_id, |entry| {
                entry.pid = None;
                if entry.status != "stopped" {
                    entry.status = if status.success() { "stopped" } else { "error" }.to_string();
                    entry.message = Some(format!("Process exited with {status}."));
                    push_log(entry, "system", &format!("process exited with {status}"));
                }
            });
        }
        Err(error) => {
            let _ = manager.set_entry(&thread_id, |entry| {
                entry.pid = None;
                entry.status = "error".to_string();
                entry.message = Some(error.to_string());
                push_log(entry, "system", &format!("process wait failed: {error}"));
            });
        }
    }
}

async fn run_logged_command(
    manager: Arc<PreviewRuntimeManager>,
    thread_id: &str,
    dir: &Path,
    label: &str,
    command_name: &str,
    args: &[String],
) -> Result<()> {
    let _ = manager.set_entry(thread_id, |entry| {
        entry.status = "installing".to_string();
        entry.command = Some(label.to_string());
        entry.message = Some(label.to_string());
        push_log(entry, "system", label);
    });
    let mut child = preview_command(command_name)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    pipe_child_logs(
        manager.clone(),
        thread_id.to_string(),
        child.stdout.take(),
        "stdout",
    );
    pipe_child_logs(
        manager.clone(),
        thread_id.to_string(),
        child.stderr.take(),
        "stderr",
    );
    let status = child.wait().await?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Other(format!("{label} exited with {status}")))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

#[derive(Clone, Debug)]
struct PreviewPackage {
    manager: PackageManager,
    has_dev_script: bool,
    dev_script: String,
}

impl PackageManager {
    fn command_name(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
            Self::Yarn => "yarn",
            Self::Bun => "bun",
        }
    }
}

impl PreviewPackage {
    fn install_args(&self) -> Vec<String> {
        match self.manager {
            PackageManager::Npm => vec!["install", "--no-audit", "--no-fund"],
            PackageManager::Pnpm | PackageManager::Yarn | PackageManager::Bun => vec!["install"],
        }
        .into_iter()
        .map(str::to_string)
        .collect()
    }

    fn dev_args(&self, port: u16) -> Vec<String> {
        let port = port.to_string();
        let server_args = if self.is_next_dev() {
            vec!["--hostname", "127.0.0.1", "--port", &port]
        } else {
            vec!["--host", "127.0.0.1", "--port", &port]
        };
        let mut args = match self.manager {
            PackageManager::Yarn => vec!["run", "dev"],
            PackageManager::Npm | PackageManager::Pnpm | PackageManager::Bun => {
                vec!["run", "dev", "--"]
            }
        };
        args.extend(server_args);
        args.into_iter().map(str::to_string).collect()
    }

    fn install_label(&self) -> String {
        format!("{} install", self.manager.command_name())
    }

    fn dev_label(&self, port: u16) -> String {
        self.dev_args(port).into_iter().fold(
            self.manager.command_name().to_string(),
            |mut out, arg| {
                out.push(' ');
                out.push_str(&arg);
                out
            },
        )
    }

    fn is_next_dev(&self) -> bool {
        self.dev_script
            .split_whitespace()
            .any(|part| part == "next" || part.ends_with("/next"))
    }

    fn is_vite_dev(&self) -> bool {
        self.dev_script
            .split_whitespace()
            .any(|part| part == "vite" || part.ends_with("/vite"))
    }
}

fn preview_package(dir: &Path) -> Result<PreviewPackage> {
    let package_json = std::fs::read_to_string(dir.join("package.json"))?;
    let package: Value = serde_json::from_str(&package_json)?;
    let dev_script = package
        .get("scripts")
        .and_then(|scripts| scripts.get("dev"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    Ok(PreviewPackage {
        manager: package_manager_for(dir, &package),
        has_dev_script: !dev_script.is_empty(),
        dev_script,
    })
}

fn package_manager_for(dir: &Path, package: &Value) -> PackageManager {
    if let Some(manager) = package
        .get("packageManager")
        .and_then(Value::as_str)
        .and_then(package_manager_from_text)
    {
        return manager;
    }
    if dir.join("pnpm-lock.yaml").is_file() {
        return PackageManager::Pnpm;
    }
    if dir.join("yarn.lock").is_file() {
        return PackageManager::Yarn;
    }
    if dir.join("bun.lockb").is_file() || dir.join("bun.lock").is_file() {
        return PackageManager::Bun;
    }
    PackageManager::Npm
}

fn package_manager_from_text(value: &str) -> Option<PackageManager> {
    let name = value.split('@').next()?.trim().to_ascii_lowercase();
    match name.as_str() {
        "npm" => Some(PackageManager::Npm),
        "pnpm" => Some(PackageManager::Pnpm),
        "yarn" => Some(PackageManager::Yarn),
        "bun" => Some(PackageManager::Bun),
        _ => None,
    }
}

fn pipe_child_logs<T>(
    manager: Arc<PreviewRuntimeManager>,
    thread_id: String,
    pipe: Option<T>,
    stream: &'static str,
) where
    T: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let Some(pipe) = pipe else {
        return;
    };
    tokio::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let ready = is_preview_ready_log(&line);
            let _ = manager.set_entry(&thread_id, |entry| push_child_log(entry, stream, &line));
            if ready {
                schedule_preview_ready(manager.clone(), thread_id.clone());
            }
        }
    });
}

fn push_child_log(entry: &mut PreviewAppEntry, stream: &str, line: &str) {
    if is_preview_compile_error(line) {
        entry.status = "error".to_string();
        entry.message = Some("Preview app compile error. Check logs.".to_string());
    }
    push_log(entry, stream, line);
}

fn schedule_preview_ready(manager: Arc<PreviewRuntimeManager>, thread_id: String) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(PREVIEW_READY_QUIET_MS)).await;
        let status = match manager.status(&thread_id) {
            Ok(status) => status,
            Err(_) => return,
        };
        if status.status != "starting" || status.pid.is_none() {
            return;
        }
        let Some(url) = status.url else {
            return;
        };
        let probe = wait_for_preview_ready(&url).await;
        let _ = manager.set_entry(&thread_id, |entry| {
            if entry.status != "starting" || entry.pid.is_none() {
                return;
            }
            match probe {
                PreviewReadyProbe::Ready => {
                    entry.status = "running".to_string();
                    entry.message = Some("Running.".to_string());
                    push_log(entry, "system", "preview app is running");
                }
                PreviewReadyProbe::HttpError(code) => {
                    entry.status = "error".to_string();
                    entry.message = Some(format!("Preview URL returned HTTP {code}. Check logs."));
                    push_log(
                        entry,
                        "system",
                        &format!("preview URL returned HTTP {code}"),
                    );
                }
                PreviewReadyProbe::Unavailable => {
                    entry.status = "error".to_string();
                    entry.message =
                        Some("Preview URL did not become ready. Check logs.".to_string());
                    push_log(entry, "system", "preview URL did not become ready");
                }
            }
        });
    });
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PreviewReadyProbe {
    Ready,
    HttpError(u16),
    Unavailable,
}

async fn wait_for_preview_ready(url: &str) -> PreviewReadyProbe {
    let deadline =
        tokio::time::Instant::now() + Duration::from_millis(PREVIEW_READY_PROBE_TIMEOUT_MS);
    loop {
        match probe_preview_url(url).await {
            Some(code) if (200..400).contains(&code) => return PreviewReadyProbe::Ready,
            Some(code) if code >= 400 => return PreviewReadyProbe::HttpError(code),
            _ => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return PreviewReadyProbe::Unavailable;
        }
        tokio::time::sleep(Duration::from_millis(PREVIEW_READY_PROBE_INTERVAL_MS)).await;
    }
}

async fn probe_preview_url(url: &str) -> Option<u16> {
    let port = preview_url_port(url)?;
    let mut stream = tokio::time::timeout(
        Duration::from_millis(PREVIEW_READY_REQUEST_TIMEOUT_MS),
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .ok()?
    .ok()?;
    let request = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    tokio::time::timeout(
        Duration::from_millis(PREVIEW_READY_REQUEST_TIMEOUT_MS),
        stream.write_all(request.as_bytes()),
    )
    .await
    .ok()?
    .ok()?;
    let mut response = [0_u8; 256];
    let len = tokio::time::timeout(
        Duration::from_millis(PREVIEW_READY_REQUEST_TIMEOUT_MS),
        stream.read(&mut response),
    )
    .await
    .ok()?
    .ok()?;
    let head = std::str::from_utf8(&response[..len]).ok()?;
    head.split_whitespace().nth(1)?.parse().ok()
}

fn preview_url_port(url: &str) -> Option<u16> {
    url.trim()
        .strip_prefix("http://127.0.0.1:")?
        .split(['/', '?', '#'])
        .next()?
        .parse()
        .ok()
}

fn push_log(entry: &mut PreviewAppEntry, stream: &str, line: &str) {
    let line = strip_ansi_control_sequences(line);
    entry.logs.push_back(PreviewAppLog {
        ts: crate::now_unix(),
        stream: stream.to_string(),
        line: line.into_owned(),
    });
    while entry.logs.len() > MAX_LOG_LINES {
        entry.logs.pop_front();
    }
}

fn is_preview_compile_error(line: &str) -> bool {
    let line = strip_ansi_control_sequences(line);
    line.contains("[vite] Pre-transform error")
        || line.contains("[vite] Internal server error")
        || line.contains("Failed to scan for dependencies from entries:")
        || line.contains("Unexpected closing")
        || line.contains("does not match opening")
        || line.contains("Plugin: vite:")
}

fn is_preview_ready_log(line: &str) -> bool {
    let line = strip_ansi_control_sequences(line);
    line.contains("Local:") && (line.contains("http://") || line.contains("https://"))
}

fn strip_ansi_control_sequences(value: &str) -> Cow<'_, str> {
    if !value.as_bytes().contains(&0x1b) {
        return Cow::Borrowed(value);
    }
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            out.push(ch);
            continue;
        }
        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                for code in chars.by_ref() {
                    if ('@'..='~').contains(&code) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                let mut escaped = false;
                for code in chars.by_ref() {
                    if code == '\x07' || escaped && code == '\\' {
                        break;
                    }
                    escaped = code == '\x1b';
                }
            }
            Some('@'..='_') => {
                chars.next();
            }
            _ => {}
        }
    }
    Cow::Owned(out)
}

fn needs_dependency_install(dir: &Path, managed: bool) -> bool {
    !dir.join("node_modules").is_dir() || managed && !dir.join(INSTALL_MARKER_FILE).is_file()
}

fn ensure_vite_setup(dir: &Path, package: &PreviewPackage) -> Result<Vec<String>> {
    if !package.is_vite_dev() {
        return Ok(Vec::new());
    }
    let mut logs = Vec::new();
    if let Some(log) = ensure_vite_entry(dir)? {
        logs.push(log);
    }
    if let Some(log) = ensure_tailwind_config(dir)? {
        logs.push(log);
    }
    Ok(logs)
}

fn ensure_vite_entry(dir: &Path) -> Result<Option<String>> {
    if dir.join("index.html").is_file() {
        return ensure_vite_index_styles(dir);
    }
    if let Some(html) = first_root_html(dir)? {
        std::fs::copy(dir.join(&html), dir.join("index.html"))?;
        return Ok(Some(format!(
            "created Vite index.html from {}",
            vite_path(&html)
        )));
    }
    if let Some(entry) = first_existing(
        dir,
        &["src/main.tsx", "src/main.jsx", "src/main.ts", "src/main.js"],
    ) {
        std::fs::write(
            dir.join("index.html"),
            vite_index_html(&entry, &vite_style_paths(dir)),
        )?;
        return Ok(Some(format!(
            "created Vite index.html for {}",
            vite_path(&entry)
        )));
    }
    if let Some(app) = first_existing(dir, &["src/App.tsx", "src/App.jsx", "App.tsx", "App.jsx"]) {
        let main = app.with_file_name(
            if app.extension().and_then(|ext| ext.to_str()) == Some("jsx") {
                "main.jsx"
            } else {
                "main.tsx"
            },
        );
        if !dir.join(&main).is_file() {
            if let Some(parent) = dir.join(&main).parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(dir.join(&main), react_main_source(&app))?;
        }
        std::fs::write(
            dir.join("index.html"),
            vite_index_html(&main, &vite_style_paths(dir)),
        )?;
        return Ok(Some(format!(
            "created Vite index.html and {}",
            vite_path(&main)
        )));
    }
    Ok(None)
}

fn ensure_tailwind_config(dir: &Path) -> Result<Option<String>> {
    if !vite_style_paths(dir)
        .iter()
        .any(|path| css_uses_tailwind(&dir.join(path)))
    {
        return Ok(None);
    }
    let mut changed = false;
    if !has_any_file(
        dir,
        &[
            "postcss.config.js",
            "postcss.config.cjs",
            "postcss.config.mjs",
            "postcss.config.ts",
        ],
    ) {
        std::fs::write(
            dir.join("postcss.config.cjs"),
            "module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };\n",
        )?;
        changed = true;
    }
    if !has_any_file(
        dir,
        &[
            "tailwind.config.js",
            "tailwind.config.cjs",
            "tailwind.config.mjs",
            "tailwind.config.ts",
        ],
    ) {
        std::fs::write(
            dir.join("tailwind.config.cjs"),
            "module.exports = { content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'], theme: { extend: {} }, plugins: [] };\n",
        )?;
        changed = true;
    }
    Ok(changed.then(|| "created Tailwind preview config".to_string()))
}

fn first_root_html(dir: &Path) -> Result<Option<PathBuf>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_file()
            && path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("html"))
        {
            if let Some(name) = path.file_name() {
                files.push(PathBuf::from(name));
            }
        }
    }
    files.sort();
    Ok(files.into_iter().next())
}

fn first_existing(dir: &Path, paths: &[&str]) -> Option<PathBuf> {
    paths
        .iter()
        .map(PathBuf::from)
        .find(|path| dir.join(path).is_file())
}

fn has_any_file(dir: &Path, paths: &[&str]) -> bool {
    paths.iter().any(|path| dir.join(path).is_file())
}

fn css_uses_tailwind(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|css| css.contains("@tailwind") || css.contains("@apply"))
        .unwrap_or(false)
}

fn vite_style_paths(dir: &Path) -> Vec<PathBuf> {
    [
        "src/index.css",
        "src/main.css",
        "src/App.css",
        "src/style.css",
        "src/styles.css",
        "index.css",
        "style.css",
        "styles.css",
        "App.css",
    ]
    .into_iter()
    .map(PathBuf::from)
    .filter(|path| dir.join(path).is_file())
    .collect()
}

fn ensure_vite_index_styles(dir: &Path) -> Result<Option<String>> {
    let styles = vite_style_paths(dir);
    if styles.is_empty() {
        return Ok(None);
    }
    let index_path = dir.join("index.html");
    let index = std::fs::read_to_string(&index_path)?;
    if index.contains("rel=\"stylesheet\"") || index.contains("rel='stylesheet'") {
        return Ok(None);
    }
    let links = vite_style_links(&styles);
    let updated = if let Some(head) = find_ascii_case_insensitive(&index, "<head>") {
        let insert_at = head + "<head>".len();
        format!(
            "{}{}\n{}",
            &index[..insert_at],
            links.trim_end(),
            &index[insert_at..]
        )
    } else {
        format!("{links}{index}")
    };
    std::fs::write(index_path, updated)?;
    Ok(Some("added Vite CSS links to index.html".to_string()))
}

fn vite_index_html(entry: &Path, styles: &[PathBuf]) -> String {
    let links = vite_style_links(styles);
    format!(
        r#"{links}<div id="root"></div>
<script type="module" src="{}"></script>
"#,
        vite_path(entry)
    )
}

fn vite_style_links(styles: &[PathBuf]) -> String {
    let links = styles
        .iter()
        .map(|path| format!(r#"<link rel="stylesheet" href="{}">"#, vite_path(path)))
        .collect::<Vec<_>>()
        .join("\n");
    if links.is_empty() {
        String::new()
    } else {
        format!("{links}\n")
    }
}

fn react_main_source(app: &Path) -> String {
    let import_path = app
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| format!("./{stem}"))
        .unwrap_or_else(|| "./App".to_string());
    format!(
        r#"import React from "react";
import {{ createRoot }} from "react-dom/client";
import * as AppModule from "{}";

const App = AppModule.default ?? AppModule.App;
createRoot(document.getElementById("root")!).render(<App />);
"#,
        import_path
    )
}

fn vite_path(path: &Path) -> String {
    format!("/{}", path.to_string_lossy().replace('\\', "/"))
}

fn find_ascii_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn free_port() -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn safe_thread_id(value: &str) -> Result<String> {
    let id = value.trim();
    if id.is_empty()
        || id == "."
        || id == ".."
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
    {
        return Err(Error::InvalidRequest(
            "invalid preview app thread id".to_string(),
        ));
    }
    Ok(id.to_string())
}

fn safe_relative_path(value: &str) -> Result<PathBuf> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err(Error::InvalidRequest(
            "empty preview app file path".to_string(),
        ));
    }
    let path = Path::new(&normalized);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                if part.is_empty() || part.contains(':') {
                    return Err(Error::InvalidRequest(format!(
                        "unsafe preview app file path: {value}"
                    )));
                }
                out.push(part.as_ref());
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(Error::InvalidRequest(format!(
                    "unsafe preview app file path: {value}"
                )));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err(Error::InvalidRequest(
            "empty preview app file path".to_string(),
        ));
    }
    Ok(out)
}

fn preview_command(name: &str) -> Command {
    #[cfg(windows)]
    let command = {
        let binary = if name == "bun" {
            "bun.exe".to_string()
        } else {
            format!("{name}.cmd")
        };
        let mut command = Command::new(binary);
        command.creation_flags(0x08000000);
        command
    };
    #[cfg(not(windows))]
    let command = Command::new(name);
    command
}

#[cfg(windows)]
async fn kill_process_tree(pid: u32) -> Result<()> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Other(format!("taskkill failed for pid {pid}")))
    }
}

#[cfg(not(windows))]
async fn kill_process_tree(pid: u32) -> Result<()> {
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Other(format!("kill failed for pid {pid}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "milim-preview-app-test-{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn preview_app_stage_rejects_unsafe_paths() {
        let root = test_root();
        let manager = PreviewRuntimeManager::new(root.clone());
        let result = manager.stage(
            "thread-1",
            &[PreviewAppFile {
                path: "../package.json".to_string(),
                content: "{}".to_string(),
            }],
        );
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn preview_app_stage_writes_safe_relative_files() {
        let root = test_root();
        let manager = PreviewRuntimeManager::new(root.clone());
        manager
            .stage(
                "thread-1",
                &[PreviewAppFile {
                    path: "src/App.tsx".to_string(),
                    content: "export function App() { return null; }".to_string(),
                }],
            )
            .unwrap();
        assert!(root.join("thread-1").join("src").join("App.tsx").is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn preview_app_start_requires_package_json() {
        let root = test_root();
        let manager = Arc::new(PreviewRuntimeManager::new(root.clone()));
        manager
            .stage(
                "thread-1",
                &[PreviewAppFile {
                    path: "src/App.tsx".to_string(),
                    content: "export function App() { return null; }".to_string(),
                }],
            )
            .unwrap();
        let result = manager.start("thread-1", None);
        assert!(matches!(result, Err(Error::InvalidRequest(_))));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn preview_app_start_requires_dev_script() {
        let root = test_root();
        let manager = Arc::new(PreviewRuntimeManager::new(root.clone()));
        manager
            .stage(
                "thread-1",
                &[PreviewAppFile {
                    path: "package.json".to_string(),
                    content: r#"{"scripts":{"build":"vite build"}}"#.to_string(),
                }],
            )
            .unwrap();
        let result = manager.start("thread-1", None);
        assert!(matches!(result, Err(Error::InvalidRequest(_))));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn preview_app_detects_package_manager() {
        let root = test_root();
        std::fs::create_dir_all(&root).unwrap();
        let package = serde_json::json!({"packageManager":"pnpm@9.0.0","scripts":{"dev":"vite"}});
        assert_eq!(package_manager_for(&root, &package), PackageManager::Pnpm);

        let package = serde_json::json!({"scripts":{"dev":"vite"}});
        std::fs::write(root.join("yarn.lock"), "").unwrap();
        assert_eq!(package_manager_for(&root, &package), PackageManager::Yarn);
        std::fs::remove_file(root.join("yarn.lock")).unwrap();

        std::fs::write(root.join("bun.lockb"), "").unwrap();
        assert_eq!(package_manager_for(&root, &package), PackageManager::Bun);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn preview_app_reinstalls_incomplete_node_modules() {
        let root = test_root();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        assert!(needs_dependency_install(&root, true));
        assert!(!needs_dependency_install(&root, false));

        std::fs::write(root.join(INSTALL_MARKER_FILE), "ok").unwrap();
        assert!(!needs_dependency_install(&root, true));
        assert!(!needs_dependency_install(&root, false));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn preview_app_project_folder_does_not_need_install_marker() {
        let root = test_root();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        assert!(!needs_dependency_install(&root, false));
        assert!(needs_dependency_install(&root, true));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn preview_app_strips_ansi_from_logs() {
        let mut entry = PreviewAppEntry::default();
        push_log(
            &mut entry,
            "stdout",
            "\x1b[32m\u{279c}\x1b[39m  \x1b[1mLocal\x1b[22m: \x1b[36mhttp://127.0.0.1:59993/\x1b[39m",
        );
        assert_eq!(
            entry.logs.back().unwrap().line,
            "\u{279c}  Local: http://127.0.0.1:59993/"
        );
    }

    #[test]
    fn preview_app_marks_vite_compile_errors() {
        let mut entry = PreviewAppEntry {
            status: "running".to_string(),
            pid: Some(123),
            ..Default::default()
        };
        push_child_log(
            &mut entry,
            "stderr",
            "5:10:14 PM [vite] Pre-transform error: src/App.tsx: Expected corresponding JSX closing tag for <svg>.",
        );
        assert_eq!(entry.status, "error");
        assert_eq!(
            entry.message.as_deref(),
            Some("Preview app compile error. Check logs.")
        );
        assert_eq!(entry.pid, Some(123));
    }

    #[tokio::test]
    async fn preview_app_waits_before_running_from_ready_log() {
        let root = test_root();
        let manager = Arc::new(PreviewRuntimeManager::new(root.clone()));
        manager
            .set_entry("thread-1", |entry| {
                entry.status = "starting".to_string();
                entry.pid = Some(123);
            })
            .unwrap();
        schedule_preview_ready(manager.clone(), "thread-1".to_string());
        manager
            .set_entry("thread-1", |entry| {
                push_child_log(
                    entry,
                    "stderr",
                    "5:24:38 PM [vite] Pre-transform error: src/App.tsx: Expected corresponding JSX closing tag for <svg>.",
                );
            })
            .unwrap();
        tokio::time::sleep(Duration::from_millis(
            PREVIEW_READY_QUIET_MS + PREVIEW_READY_PROBE_TIMEOUT_MS + 20,
        ))
        .await;
        assert_eq!(manager.status("thread-1").unwrap().status, "error");

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 512];
            let _ = socket.read(&mut request).await;
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
                .await;
        });
        manager
            .set_entry("thread-2", |entry| {
                entry.status = "starting".to_string();
                entry.pid = Some(456);
                entry.url = Some(format!("http://127.0.0.1:{port}/"));
            })
            .unwrap();
        schedule_preview_ready(manager.clone(), "thread-2".to_string());
        tokio::time::sleep(Duration::from_millis(
            PREVIEW_READY_QUIET_MS + PREVIEW_READY_PROBE_TIMEOUT_MS + 20,
        ))
        .await;
        let status = manager.status("thread-2").unwrap();
        assert_eq!(status.status, "running");
        assert!(status
            .logs
            .iter()
            .any(|log| log.line == "preview app is running"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn preview_app_adds_missing_vite_index() {
        let package = PreviewPackage {
            manager: PackageManager::Npm,
            has_dev_script: true,
            dev_script: "vite".to_string(),
        };

        let root = test_root();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("main.tsx"), "render()").unwrap();
        std::fs::write(
            root.join("src").join("index.css"),
            "@tailwind base; .glass { @apply bg-white/5; }",
        )
        .unwrap();
        assert!(!ensure_vite_setup(&root, &package).unwrap().is_empty());
        let index = std::fs::read_to_string(root.join("index.html")).unwrap();
        assert!(index.contains("/src/main.tsx"));
        assert!(index.contains("/src/index.css"));
        assert!(root.join("postcss.config.cjs").is_file());
        assert!(root.join("tailwind.config.cjs").is_file());
        let _ = std::fs::remove_dir_all(root);

        let root = test_root();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src").join("App.tsx"),
            "export default function App() { return null; }",
        )
        .unwrap();
        std::fs::write(root.join("styles.css"), "body { color: blue; }").unwrap();
        assert!(!ensure_vite_setup(&root, &package).unwrap().is_empty());
        assert!(root.join("src").join("main.tsx").is_file());
        let index = std::fs::read_to_string(root.join("index.html")).unwrap();
        assert!(index.contains("/src/main.tsx"));
        assert!(index.contains("/styles.css"));
        let _ = std::fs::remove_dir_all(root);

        let root = test_root();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("index.html"),
            r#"<!DOCTYPE html>
<html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
"#,
        )
        .unwrap();
        std::fs::write(root.join("style.css"), "body { color: green; }").unwrap();
        assert!(!ensure_vite_setup(&root, &package).unwrap().is_empty());
        let index = std::fs::read_to_string(root.join("index.html")).unwrap();
        assert!(index.starts_with("<!DOCTYPE html>"));
        assert!(index.contains("<head><link rel=\"stylesheet\" href=\"/style.css\">"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn preview_app_uses_next_dev_flags() {
        let package = PreviewPackage {
            manager: PackageManager::Npm,
            has_dev_script: true,
            dev_script: "next dev".to_string(),
        };
        let args = package.dev_args(3000);
        assert!(args.contains(&"--hostname".to_string()));
        assert!(!args.contains(&"--host".to_string()));
    }

    #[test]
    fn preview_app_stage_rejects_running_runtime() {
        let root = test_root();
        let manager = PreviewRuntimeManager::new(root.clone());
        manager
            .set_entry("thread-1", |entry| {
                entry.status = "running".to_string();
                entry.pid = Some(123);
            })
            .unwrap();
        let result = manager.stage(
            "thread-1",
            &[PreviewAppFile {
                path: "package.json".to_string(),
                content: "{}".to_string(),
            }],
        );
        assert!(matches!(result, Err(Error::InvalidRequest(_))));

        manager
            .set_entry("thread-2", |entry| {
                entry.status = "error".to_string();
                entry.pid = Some(456);
            })
            .unwrap();
        let result = manager.stage(
            "thread-2",
            &[PreviewAppFile {
                path: "package.json".to_string(),
                content: "{}".to_string(),
            }],
        );
        assert!(matches!(result, Err(Error::InvalidRequest(_))));
        let _ = std::fs::remove_dir_all(root);
    }
}
