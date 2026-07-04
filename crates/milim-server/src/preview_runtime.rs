use std::collections::{HashMap, VecDeque};
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use milim_core::{Error, Result};

const MAX_LOG_LINES: usize = 500;

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

#[derive(Default)]
struct PreviewAppEntry {
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
        if self.running_status(&thread_id)?.is_some() {
            return Err(Error::InvalidRequest(
                "stop the preview app before staging new files".to_string(),
            ));
        }
        let dir = self.app_dir(&thread_id);
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
            if entry.pid.is_none() {
                entry.status = "staged".to_string();
            }
            entry.message = Some(format!("Staged {} file(s).", files.len()));
            push_log(entry, "system", &format!("staged {} file(s)", files.len()));
        })?;
        Ok(self.status_for(&thread_id))
    }

    pub fn start(self: &Arc<Self>, thread_id: &str) -> Result<PreviewAppStatus> {
        let thread_id = safe_thread_id(thread_id)?;
        let dir = self.app_dir(&thread_id);
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
        if let Some(status) = self.running_status(&thread_id)? {
            return Ok(status);
        }
        let port = free_port()?;
        let url = format!("http://127.0.0.1:{port}/");
        let command = package.dev_label(port);
        self.set_entry(&thread_id, |entry| {
            entry.status = "installing".to_string();
            entry.url = Some(url.clone());
            entry.pid = None;
            entry.command = Some(command.clone());
            entry.message = Some("Installing dependencies.".to_string());
            push_log(entry, "system", "starting preview app");
        })?;
        tokio::spawn(run_preview_app(
            self.clone(),
            thread_id.clone(),
            dir,
            port,
            package,
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

    pub async fn restart(self: &Arc<Self>, thread_id: &str) -> Result<PreviewAppStatus> {
        let thread_id = safe_thread_id(thread_id)?;
        let _ = self.stop(&thread_id).await;
        self.start(&thread_id)
    }

    fn app_dir(&self, thread_id: &str) -> PathBuf {
        self.root.join(thread_id)
    }

    fn status_for(&self, thread_id: &str) -> PreviewAppStatus {
        let cwd = self.app_dir(thread_id).to_string_lossy().to_string();
        let entries = self.entries.lock().ok();
        let entry = entries.as_ref().and_then(|items| items.get(thread_id));
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

    fn running_status(&self, thread_id: &str) -> Result<Option<PreviewAppStatus>> {
        let entries = self
            .entries
            .lock()
            .map_err(|_| Error::Other("preview runtime state lock poisoned".to_string()))?;
        let running = entries.get(thread_id).is_some_and(|entry| {
            matches!(entry.status.as_str(), "installing" | "starting" | "running")
        });
        drop(entries);
        Ok(running.then(|| self.status_for(thread_id)))
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

async fn run_preview_app(
    manager: Arc<PreviewRuntimeManager>,
    thread_id: String,
    dir: PathBuf,
    port: u16,
    package: PreviewPackage,
) {
    if !dir.join("node_modules").is_dir() {
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
    } else {
        let _ = manager.set_entry(&thread_id, |entry| {
            push_log(
                entry,
                "system",
                "node_modules already exists; skipping npm install",
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
        entry.status = "running".to_string();
        entry.pid = pid;
        entry.command = Some(command);
        entry.message = Some("Running.".to_string());
        push_log(entry, "system", "preview app is running");
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
            let _ = manager.set_entry(&thread_id, |entry| push_log(entry, stream, &line));
        }
    });
}

fn push_log(entry: &mut PreviewAppEntry, stream: &str, line: &str) {
    entry.logs.push_back(PreviewAppLog {
        ts: crate::now_unix(),
        stream: stream.to_string(),
        line: line.to_string(),
    });
    while entry.logs.len() > MAX_LOG_LINES {
        entry.logs.pop_front();
    }
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
        let result = manager.start("thread-1");
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
        let result = manager.start("thread-1");
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
        let _ = std::fs::remove_dir_all(root);
    }
}
