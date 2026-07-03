//! milim desktop shell.
//!
//! The app hosts the milim server **in-process** (milim's model: the
//! app *is* the server), so launching the desktop app starts the backend on
//! `127.0.0.1:<port>` automatically - the web UI then talks to it over HTTP.
//!
//! Backend priority: a configured remote (`MILIM_REMOTE_BASE_URL`) -> an
//! explicit unavailable backend. The desktop provider registry routes Ollama,
//! LM Studio, and other OpenAI-compatible local runtimes above that fallback.

#[cfg(feature = "computer-use")]
mod computer_tools;
mod host_tools;

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::net::{SocketAddr, TcpListener};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use toml::Value as TomlValue;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use milim_core::config::ServerConfiguration;
use milim_core::paths::Paths;
use milim_core::{Error, Result};
use milim_inference::{remote::RemoteBackend, unavailable::UnavailableBackend, SharedService};
use milim_sandbox::{DockerBackend, RunOpts};
use milim_server::AppState;
use milim_storage::{Database, DatabaseOptions, JournalMode};
use milim_tools::{Tool, ToolRegistry};

/// Simple Rust/JS bridge example.
#[tauri::command]
fn health() -> String {
    "ok".to_string()
}

struct DesktopApiToken(String);

struct DesktopApiBaseUrl(String);

struct MobileRelayLocalTarget(String);

struct UserDataState(Arc<milim_storage::UserDataStore>);

const TAILSCALE_SERVE_PORT: u16 = 10000;
const TAILSCALE_COMMAND_TIMEOUT_SECS: u64 = 12;
const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_OPEN_ID: &str = "open";
const TRAY_QUIT_ID: &str = "quit";
const MAX_ATTACHMENT_BYTES: u64 = 128 * 1024;
const MAX_ARTIFACT_PREVIEW_BYTES: usize = 256 * 1024;
// ponytail: bounded scan, add an index if very large workspaces need complete matching.
const MAX_WORKSPACE_FILE_SUGGESTION_SCAN: usize = 5_000;
const ARTIFACT_DIFF_CONTEXT_LINES: usize = 2;
const ARTIFACT_DIFF_LCS_CELL_LIMIT: usize = 2_000_000;

#[derive(serde::Serialize)]
struct AttachmentFilePayload {
    name: String,
    size: u64,
    content: String,
    truncated: bool,
}

#[derive(serde::Serialize, Debug)]
struct WorkspaceFileSuggestion {
    path: String,
    full_path: String,
    name: String,
    size: u64,
}

#[derive(serde::Serialize, Debug)]
struct SavedArtifactFilePayload {
    path: String,
    bytes: usize,
    overwritten: bool,
}

#[derive(serde::Serialize, Debug)]
struct ArtifactFileStatusPayload {
    path: String,
    exists: bool,
    is_file: bool,
    is_dir: bool,
    bytes: Option<u64>,
}

#[derive(serde::Serialize, Debug)]
struct ArtifactWritePreviewPayload {
    path: String,
    exists: bool,
    changed: bool,
    old_content: Option<String>,
    new_content: String,
    old_bytes: Option<usize>,
    new_bytes: usize,
    diff: String,
    truncated: bool,
}

#[derive(serde::Serialize, Debug)]
struct HarnessImportPreview {
    mcps: Vec<HarnessMcpCandidate>,
    skills: Vec<HarnessSkillCandidate>,
}

#[derive(serde::Serialize, Debug)]
struct HarnessMcpCandidate {
    harness: String,
    name: String,
    command: String,
    args: Vec<String>,
    source_path: String,
}

#[derive(serde::Serialize, Debug)]
struct HarnessSkillCandidate {
    harness: String,
    name: String,
    path: String,
    skill_md: String,
}

#[derive(Clone, Copy, Debug)]
enum ArtifactOpenTarget {
    File,
    Folder,
}

#[derive(Debug)]
struct ArtifactOpenCommandSpec {
    program: String,
    args: Vec<String>,
}

#[derive(serde::Serialize, Debug)]
struct MobileTailscaleStatus {
    installed: bool,
    logged_in: bool,
    serve_configured: bool,
    public_url: Option<String>,
    local_target: String,
    message: Option<String>,
}

#[tauri::command]
fn api_token(token: tauri::State<'_, DesktopApiToken>) -> String {
    token.0.clone()
}

#[tauri::command]
fn api_base_url(base: tauri::State<'_, DesktopApiBaseUrl>) -> String {
    base.0.clone()
}

#[tauri::command]
async fn mobile_tailscale_status(
    target: tauri::State<'_, MobileRelayLocalTarget>,
) -> std::result::Result<MobileTailscaleStatus, String> {
    let local_target = target.0.clone();
    tokio::task::spawn_blocking(move || mobile_tailscale_status_blocking(local_target))
        .await
        .map_err(|e| format!("tailscale status task failed: {e}"))
}

#[tauri::command]
async fn configure_mobile_tailscale_relay(
    target: tauri::State<'_, MobileRelayLocalTarget>,
) -> std::result::Result<MobileTailscaleStatus, String> {
    let local_target = target.0.clone();
    tokio::task::spawn_blocking(move || configure_mobile_tailscale_relay_blocking(local_target))
        .await
        .map_err(|e| format!("tailscale setup task failed: {e}"))
}

#[tauri::command]
async fn disable_mobile_tailscale_relay(
    target: tauri::State<'_, MobileRelayLocalTarget>,
) -> std::result::Result<MobileTailscaleStatus, String> {
    let local_target = target.0.clone();
    tokio::task::spawn_blocking(move || disable_mobile_tailscale_relay_blocking(local_target))
        .await
        .map_err(|e| format!("tailscale disable task failed: {e}"))
}

#[tauri::command]
async fn user_state_get(
    state: tauri::State<'_, UserDataState>,
    key: String,
) -> std::result::Result<Option<String>, String> {
    if key == "milim.sessions" {
        state.0.get_sessions_snapshot().map_err(|e| e.to_string())
    } else {
        state.0.get_json(&key).map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn user_state_set(
    state: tauri::State<'_, UserDataState>,
    key: String,
    value: String,
) -> std::result::Result<(), String> {
    if key == "milim.sessions" {
        state
            .0
            .set_sessions_snapshot(&value)
            .map_err(|e| e.to_string())
    } else {
        state.0.set_json(&key, &value).map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn user_state_delete(
    state: tauri::State<'_, UserDataState>,
    key: String,
) -> std::result::Result<bool, String> {
    if key == "milim.sessions" {
        state
            .0
            .delete_sessions_snapshot()
            .map_err(|e| e.to_string())
    } else {
        state.0.delete_json(&key).map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn user_sessions_get(
    state: tauri::State<'_, UserDataState>,
) -> std::result::Result<Option<String>, String> {
    state.0.get_sessions_snapshot().map_err(|e| e.to_string())
}

#[tauri::command]
async fn user_sessions_set(
    state: tauri::State<'_, UserDataState>,
    value: String,
) -> std::result::Result<(), String> {
    state
        .0
        .set_sessions_snapshot(&value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn user_sessions_delete(
    state: tauri::State<'_, UserDataState>,
) -> std::result::Result<bool, String> {
    state
        .0
        .delete_sessions_snapshot()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn user_state_import_legacy(
    state: tauri::State<'_, UserDataState>,
    entries: BTreeMap<String, String>,
) -> std::result::Result<(), String> {
    state
        .0
        .import_json_entries(entries)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn user_data_path() -> std::result::Result<String, String> {
    let paths = Paths::resolve();
    Ok(paths.user_db_file().to_string_lossy().to_string())
}

#[tauri::command]
async fn discover_harness_imports() -> std::result::Result<HarnessImportPreview, String> {
    tokio::task::spawn_blocking(discover_harness_imports_blocking)
        .await
        .map_err(|e| format!("harness import discovery failed: {e}"))?
}

fn discover_harness_imports_blocking() -> std::result::Result<HarnessImportPreview, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let mut preview = HarnessImportPreview {
        mcps: Vec::new(),
        skills: Vec::new(),
    };

    if let Some(home) = home.as_deref() {
        read_codex_mcp_config(&home.join(".codex").join("config.toml"), &mut preview.mcps);
        collect_skill_candidates(
            &home.join(".codex").join("skills"),
            "Codex",
            &mut preview.skills,
        );
        read_json_mcp_config(
            &home.join(".claude").join("settings.json"),
            "Claude",
            &mut preview.mcps,
        );
        collect_skill_candidates(
            &home.join(".claude").join("skills"),
            "Claude",
            &mut preview.skills,
        );
    }
    if let Some(appdata) = appdata.as_deref() {
        read_json_mcp_config(
            &appdata.join("Claude").join("claude_desktop_config.json"),
            "Claude Desktop",
            &mut preview.mcps,
        );
    }

    preview
        .mcps
        .sort_by(|a, b| a.harness.cmp(&b.harness).then_with(|| a.name.cmp(&b.name)));
    preview
        .skills
        .sort_by(|a, b| a.harness.cmp(&b.harness).then_with(|| a.name.cmp(&b.name)));
    preview.mcps.dedup_by(|a, b| {
        a.harness == b.harness && a.name == b.name && a.command == b.command && a.args == b.args
    });
    preview.skills.dedup_by(|a, b| a.path == b.path);

    Ok(preview)
}

fn read_json_mcp_config(path: &Path, harness: &str, out: &mut Vec<HarnessMcpCandidate>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(root) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return;
    };
    for (name, cfg) in servers {
        let Some(command) = cfg.get("command").and_then(Value::as_str) else {
            continue;
        };
        let args = cfg
            .get("args")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        if !command.trim().is_empty() {
            out.push(HarnessMcpCandidate {
                harness: harness.to_string(),
                name: name.to_string(),
                command: command.to_string(),
                args,
                source_path: path.to_string_lossy().to_string(),
            });
        }
    }
}

#[cfg(test)]
mod tailscale_tests {
    use super::*;

    #[test]
    fn tailscale_status_json_reports_dns_url() {
        let raw = r#"{"BackendState":"Running","Self":{"DNSName":"milim-box.tailnet.ts.net."}}"#;
        let (logged_in, dns_name, peer_count) = parse_tailscale_status_json(raw);
        assert!(logged_in);
        assert_eq!(dns_name.as_deref(), Some("milim-box.tailnet.ts.net"));
        assert_eq!(peer_count, 0);
    }

    #[test]
    fn tailscale_status_json_classifies_logged_out() {
        let (logged_in, dns_name, peer_count) =
            parse_tailscale_status_json(r#"{"BackendState":"NeedsLogin"}"#);
        assert!(!logged_in);
        assert!(dns_name.is_none());
        assert_eq!(peer_count, 0);
    }

    #[test]
    fn tailscale_status_json_reports_peer_count() {
        let raw = r#"{"BackendState":"Running","Peer":{"node-a":{},"node-b":{}}}"#;
        let (logged_in, _, peer_count) = parse_tailscale_status_json(raw);
        assert!(logged_in);
        assert_eq!(peer_count, 2);
    }

    #[test]
    fn tailscale_serve_json_reports_http_url() {
        let raw = r#"{
          "TCP": { "10000": { "HTTP": true } },
          "Web": {
            "milim-box.tailnet.ts.net:10000": {
              "Handlers": { "/": { "Proxy": "http://127.0.0.1:12345" } }
            }
          }
        }"#;
        assert_eq!(
            parse_tailscale_serve_url(raw, "http://127.0.0.1:12345", "milim-box.tailnet.ts.net")
                .as_deref(),
            Some("http://milim-box.tailnet.ts.net:10000")
        );
    }

    #[test]
    fn tailscale_serve_json_reports_https_url() {
        let raw = r#"{
          "Web": {
            "milim-box.tailnet.ts.net:10000": {
              "Handlers": { "/": { "Proxy": "http://127.0.0.1:12345" } }
            }
          }
        }"#;
        assert_eq!(
            parse_tailscale_serve_url(raw, "http://127.0.0.1:12345", "milim-box.tailnet.ts.net")
                .as_deref(),
            Some("https://milim-box.tailnet.ts.net:10000")
        );
    }

    #[test]
    fn tailscale_missing_cli_status_is_actionable() {
        let status = tailscale_not_found_status("http://127.0.0.1:12345".to_string());
        assert!(!status.installed);
        assert!(!status.logged_in);
        assert_eq!(status.local_target, "http://127.0.0.1:12345");
        assert!(status.message.unwrap().contains("Tailscale CLI not found"));
    }
}

fn read_codex_mcp_config(path: &Path, out: &mut Vec<HarnessMcpCandidate>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(root) = text.parse::<TomlValue>() else {
        return;
    };
    let Some(servers) = root.get("mcp_servers").and_then(TomlValue::as_table) else {
        return;
    };

    for (name, cfg) in servers {
        let Some(table) = cfg.as_table() else {
            continue;
        };
        let Some(command) = table.get("command").and_then(TomlValue::as_str) else {
            continue;
        };
        if command.trim().is_empty() {
            continue;
        }
        let args = table
            .get("args")
            .and_then(TomlValue::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(TomlValue::as_str)
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        out.push(HarnessMcpCandidate {
            harness: "Codex".to_string(),
            name: name.to_string(),
            command: command.to_string(),
            args,
            source_path: path.to_string_lossy().to_string(),
        });
    }
}

fn collect_skill_candidates(root: &Path, harness: &str, out: &mut Vec<HarnessSkillCandidate>) {
    if !root.is_dir() {
        return;
    }
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if name == ".git" || name == "node_modules" || name == ".system" {
                    continue;
                }
                dirs.push(path);
            } else if name.eq_ignore_ascii_case("SKILL.md") {
                if out.len() >= 100 {
                    return;
                }
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                if metadata.len() > 512 * 1024 {
                    continue;
                }
                let Ok(skill_md) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let skill_name = path
                    .parent()
                    .and_then(Path::file_name)
                    .and_then(|value| value.to_str())
                    .unwrap_or("imported-skill")
                    .to_string();
                out.push(HarnessSkillCandidate {
                    harness: harness.to_string(),
                    name: skill_name,
                    path: path.to_string_lossy().to_string(),
                    skill_md,
                });
            }
        }
    }
}

#[tauri::command]
async fn read_attachment_file(
    path: String,
    max_bytes: Option<u64>,
) -> std::result::Result<AttachmentFilePayload, String> {
    tokio::task::spawn_blocking(
        move || -> std::result::Result<AttachmentFilePayload, String> {
            let path = PathBuf::from(path);
            let metadata = std::fs::metadata(&path)
                .map_err(|e| format!("failed to read attachment metadata: {e}"))?;
            if !metadata.is_file() {
                return Err("attachment path is not a file".to_string());
            }
            let limit = max_bytes
                .unwrap_or(MAX_ATTACHMENT_BYTES)
                .clamp(1, MAX_ATTACHMENT_BYTES);
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("attachment")
                .to_string();
            let mut file =
                File::open(&path).map_err(|e| format!("failed to open attachment file: {e}"))?;
            let mut bytes = Vec::new();
            file.by_ref()
                .take(limit + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| format!("failed to read attachment file: {e}"))?;
            let truncated = bytes.len() as u64 > limit;
            if truncated {
                bytes.truncate(limit as usize);
            }
            let content = String::from_utf8_lossy(&bytes).into_owned();
            Ok(AttachmentFilePayload {
                name,
                size: metadata.len(),
                content,
                truncated,
            })
        },
    )
    .await
    .map_err(|e| format!("attachment read task failed: {e}"))?
}

#[tauri::command]
async fn list_workspace_files(
    workspace: String,
    query: String,
    limit: Option<usize>,
) -> std::result::Result<Vec<WorkspaceFileSuggestion>, String> {
    tokio::task::spawn_blocking(move || list_workspace_files_blocking(&workspace, &query, limit))
        .await
        .map_err(|e| format!("workspace file list task failed: {e}"))?
}

fn list_workspace_files_blocking(
    workspace: &str,
    query: &str,
    limit: Option<usize>,
) -> std::result::Result<Vec<WorkspaceFileSuggestion>, String> {
    let root = workspace_root(workspace)?;
    let max = limit.unwrap_or(20).clamp(1, 50);
    let needle = query.trim().to_lowercase();
    let mut out = Vec::new();
    let mut scanned = 0usize;
    let mut dirs = vec![root.clone()];

    while let Some(dir) = dirs.pop() {
        let mut entries = match fs::read_dir(&dir) {
            Ok(entries) => entries.filter_map(|entry| entry.ok()).collect::<Vec<_>>(),
            Err(_) => continue,
        };
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            scanned += 1;
            if scanned > MAX_WORKSPACE_FILE_SUGGESTION_SCAN || out.len() >= max {
                return Ok(out);
            }

            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            if file_type.is_dir() {
                if !skip_workspace_suggestion_dir(&name) {
                    dirs.push(entry.path());
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let path = entry.path();
            let relative = workspace_relative_path(&root, &path);
            if !needle.is_empty() && !relative.to_lowercase().contains(&needle) {
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            out.push(WorkspaceFileSuggestion {
                path: relative,
                full_path: path.to_string_lossy().to_string(),
                name,
                size: metadata.len(),
            });
        }
    }

    Ok(out)
}

fn workspace_root(workspace: &str) -> std::result::Result<PathBuf, String> {
    let root = PathBuf::from(workspace.trim());
    if root.as_os_str().is_empty() {
        return Err("no working folder selected".to_string());
    }
    let metadata =
        fs::metadata(&root).map_err(|e| format!("failed to read working folder metadata: {e}"))?;
    if !metadata.is_dir() {
        return Err("working folder is not a directory".to_string());
    }
    Ok(root)
}

fn skip_workspace_suggestion_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".turbo"
    )
}

fn workspace_relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[tauri::command]
async fn save_artifact_file(
    workspace: String,
    path: String,
    content: String,
    overwrite: Option<bool>,
) -> std::result::Result<SavedArtifactFilePayload, String> {
    tokio::task::spawn_blocking(move || {
        save_artifact_file_blocking(workspace, path, content, overwrite.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("artifact save task failed: {e}"))?
}

fn save_artifact_file_blocking(
    workspace: String,
    path: String,
    content: String,
    overwrite: bool,
) -> std::result::Result<SavedArtifactFilePayload, String> {
    let target = resolve_artifact_target(&workspace, &path)?;
    let existed = target.exists();
    if existed && !overwrite {
        return Err(format!(
            "artifact file already exists: {}",
            target.display()
        ));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create artifact directory: {e}"))?;
    }
    std::fs::write(&target, content.as_bytes())
        .map_err(|e| format!("failed to write artifact file: {e}"))?;
    Ok(SavedArtifactFilePayload {
        path: target.to_string_lossy().to_string(),
        bytes: content.len(),
        overwritten: existed,
    })
}

fn resolve_artifact_target(workspace: &str, path: &str) -> std::result::Result<PathBuf, String> {
    let workspace = PathBuf::from(workspace.trim());
    if workspace.as_os_str().is_empty() {
        return Err("no working folder selected".to_string());
    }
    let metadata = std::fs::metadata(&workspace)
        .map_err(|e| format!("failed to read working folder metadata: {e}"))?;
    if !metadata.is_dir() {
        return Err("working folder is not a directory".to_string());
    }

    Ok(workspace.join(safe_artifact_relative_path(path)?))
}

fn safe_artifact_relative_path(path: &str) -> std::result::Result<PathBuf, String> {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("artifact path is required".to_string());
    }
    let mut out = PathBuf::new();
    for comp in Path::new(&normalized).components() {
        match comp {
            Component::Normal(part) => {
                let value = part.to_string_lossy();
                if value.contains(':') {
                    return Err("artifact paths must be relative".to_string());
                }
                out.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir => return Err("'..' is not allowed in artifact paths".to_string()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("artifact paths must be relative".to_string())
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("artifact path is required".to_string());
    }
    Ok(out)
}

#[tauri::command]
async fn preview_artifact_file(
    workspace: String,
    path: String,
    content: String,
) -> std::result::Result<ArtifactWritePreviewPayload, String> {
    tokio::task::spawn_blocking(move || preview_artifact_file_blocking(workspace, path, content))
        .await
        .map_err(|e| format!("artifact preview task failed: {e}"))?
}

fn preview_artifact_file_blocking(
    workspace: String,
    path: String,
    content: String,
) -> std::result::Result<ArtifactWritePreviewPayload, String> {
    let target = resolve_artifact_target(&workspace, &path)?;
    let mut truncated = false;
    let (exists, old_content, old_bytes) = match std::fs::metadata(&target) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err("artifact target is not a file".to_string());
            }
            let mut bytes = std::fs::read(&target)
                .map_err(|e| format!("failed to read artifact target: {e}"))?;
            let original_len = bytes.len();
            if bytes.len() > MAX_ARTIFACT_PREVIEW_BYTES {
                bytes.truncate(MAX_ARTIFACT_PREVIEW_BYTES);
                truncated = true;
            }
            (
                true,
                Some(String::from_utf8_lossy(&bytes).into_owned()),
                Some(original_len),
            )
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, None, None),
        Err(e) => return Err(format!("failed to read artifact target metadata: {e}")),
    };
    let diff = artifact_line_diff(old_content.as_deref().unwrap_or(""), &content);
    Ok(ArtifactWritePreviewPayload {
        path: target.to_string_lossy().to_string(),
        exists,
        changed: old_content.as_deref() != Some(content.as_str()),
        old_content,
        new_content: content.clone(),
        old_bytes,
        new_bytes: content.len(),
        diff,
        truncated,
    })
}

#[derive(Clone, Copy)]
enum ArtifactDiffKind {
    Equal,
    Delete,
    Insert,
}

struct ArtifactDiffLine<'a> {
    kind: ArtifactDiffKind,
    text: &'a str,
    old_before: usize,
    new_before: usize,
}

impl ArtifactDiffLine<'_> {
    fn consumes_old(&self) -> bool {
        matches!(
            self.kind,
            ArtifactDiffKind::Equal | ArtifactDiffKind::Delete
        )
    }

    fn consumes_new(&self) -> bool {
        matches!(
            self.kind,
            ArtifactDiffKind::Equal | ArtifactDiffKind::Insert
        )
    }

    fn is_change(&self) -> bool {
        !matches!(self.kind, ArtifactDiffKind::Equal)
    }
}

fn artifact_line_diff(old: &str, new: &str) -> String {
    if old == new {
        return "No changes.".to_string();
    }
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let mut diff = vec!["--- current".to_string(), "+++ generated".to_string()];

    let lines = artifact_diff_lines(&old_lines, &new_lines);
    let hunks = artifact_diff_hunks(&lines);
    let mut previous_end = 0;
    for (start, end) in hunks {
        let omitted = lines[previous_end..start]
            .iter()
            .filter(|line| matches!(line.kind, ArtifactDiffKind::Equal))
            .count();
        if previous_end > 0 && omitted > 0 {
            diff.push(format!("... {omitted} unchanged lines ..."));
        }
        let hunk = &lines[start..end];
        let old_start = hunk
            .iter()
            .find(|line| line.consumes_old())
            .map(|line| line.old_before + 1)
            .unwrap_or_else(|| hunk.first().map(|line| line.old_before + 1).unwrap_or(1));
        let new_start = hunk
            .iter()
            .find(|line| line.consumes_new())
            .map(|line| line.new_before + 1)
            .unwrap_or_else(|| hunk.first().map(|line| line.new_before + 1).unwrap_or(1));
        let old_count = hunk.iter().filter(|line| line.consumes_old()).count();
        let new_count = hunk.iter().filter(|line| line.consumes_new()).count();
        diff.push(format!(
            "@@ -{},{} +{},{} @@",
            old_start, old_count, new_start, new_count
        ));
        for line in hunk {
            let prefix = match line.kind {
                ArtifactDiffKind::Equal => ' ',
                ArtifactDiffKind::Delete => '-',
                ArtifactDiffKind::Insert => '+',
            };
            diff.push(format!("{prefix}{}", line.text));
        }
        previous_end = end;
    }
    diff.join("\n")
}

fn artifact_diff_lines<'a>(
    old_lines: &[&'a str],
    new_lines: &[&'a str],
) -> Vec<ArtifactDiffLine<'a>> {
    let cells = old_lines
        .len()
        .saturating_add(1)
        .saturating_mul(new_lines.len().saturating_add(1));
    if cells > ARTIFACT_DIFF_LCS_CELL_LIMIT {
        return artifact_positional_diff_lines(old_lines, new_lines);
    }

    let cols = new_lines.len() + 1;
    let mut table = vec![0usize; (old_lines.len() + 1) * cols];
    for i in (0..old_lines.len()).rev() {
        for j in (0..new_lines.len()).rev() {
            let value = if old_lines[i] == new_lines[j] {
                table[(i + 1) * cols + j + 1] + 1
            } else {
                table[(i + 1) * cols + j].max(table[i * cols + j + 1])
            };
            table[i * cols + j] = value;
        }
    }

    let mut lines = Vec::new();
    let mut old_index = 0;
    let mut new_index = 0;
    while old_index < old_lines.len() && new_index < new_lines.len() {
        if old_lines[old_index] == new_lines[new_index] {
            lines.push(ArtifactDiffLine {
                kind: ArtifactDiffKind::Equal,
                text: old_lines[old_index],
                old_before: old_index,
                new_before: new_index,
            });
            old_index += 1;
            new_index += 1;
        } else if table[(old_index + 1) * cols + new_index]
            >= table[old_index * cols + new_index + 1]
        {
            lines.push(ArtifactDiffLine {
                kind: ArtifactDiffKind::Delete,
                text: old_lines[old_index],
                old_before: old_index,
                new_before: new_index,
            });
            old_index += 1;
        } else {
            lines.push(ArtifactDiffLine {
                kind: ArtifactDiffKind::Insert,
                text: new_lines[new_index],
                old_before: old_index,
                new_before: new_index,
            });
            new_index += 1;
        }
    }
    while old_index < old_lines.len() {
        lines.push(ArtifactDiffLine {
            kind: ArtifactDiffKind::Delete,
            text: old_lines[old_index],
            old_before: old_index,
            new_before: new_index,
        });
        old_index += 1;
    }
    while new_index < new_lines.len() {
        lines.push(ArtifactDiffLine {
            kind: ArtifactDiffKind::Insert,
            text: new_lines[new_index],
            old_before: old_index,
            new_before: new_index,
        });
        new_index += 1;
    }
    lines
}

fn artifact_positional_diff_lines<'a>(
    old_lines: &[&'a str],
    new_lines: &[&'a str],
) -> Vec<ArtifactDiffLine<'a>> {
    let mut lines = Vec::new();
    let len = old_lines.len().max(new_lines.len());
    for index in 0..len {
        match (old_lines.get(index), new_lines.get(index)) {
            (Some(left), Some(right)) if left == right => lines.push(ArtifactDiffLine {
                kind: ArtifactDiffKind::Equal,
                text: left,
                old_before: index,
                new_before: index,
            }),
            (Some(left), Some(right)) => {
                lines.push(ArtifactDiffLine {
                    kind: ArtifactDiffKind::Delete,
                    text: left,
                    old_before: index,
                    new_before: index,
                });
                lines.push(ArtifactDiffLine {
                    kind: ArtifactDiffKind::Insert,
                    text: right,
                    old_before: index + 1,
                    new_before: index,
                });
            }
            (Some(left), None) => lines.push(ArtifactDiffLine {
                kind: ArtifactDiffKind::Delete,
                text: left,
                old_before: index,
                new_before: new_lines.len(),
            }),
            (None, Some(right)) => lines.push(ArtifactDiffLine {
                kind: ArtifactDiffKind::Insert,
                text: right,
                old_before: old_lines.len(),
                new_before: index,
            }),
            (None, None) => {}
        }
    }
    lines
}

fn artifact_diff_hunks(lines: &[ArtifactDiffLine<'_>]) -> Vec<(usize, usize)> {
    let mut hunks = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        if !lines[index].is_change() {
            index += 1;
            continue;
        }
        let change_start = index;
        let mut change_end = index + 1;
        while change_end < lines.len() && lines[change_end].is_change() {
            change_end += 1;
        }
        let start = change_start.saturating_sub(ARTIFACT_DIFF_CONTEXT_LINES);
        let end = (change_end + ARTIFACT_DIFF_CONTEXT_LINES).min(lines.len());
        if let Some((_, previous_end)) = hunks.last_mut() {
            if start <= *previous_end {
                *previous_end = end;
            } else {
                hunks.push((start, end));
            }
        } else {
            hunks.push((start, end));
        }
        index = change_end;
    }
    hunks
}

#[tauri::command]
async fn artifact_file_status(
    path: String,
) -> std::result::Result<ArtifactFileStatusPayload, String> {
    tokio::task::spawn_blocking(move || artifact_file_status_blocking(path))
        .await
        .map_err(|e| format!("artifact status task failed: {e}"))?
}

fn artifact_file_status_blocking(
    path: String,
) -> std::result::Result<ArtifactFileStatusPayload, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("artifact path is required".to_string());
    }
    let path = PathBuf::from(trimmed);
    match std::fs::metadata(&path) {
        Ok(metadata) => Ok(ArtifactFileStatusPayload {
            path: path.to_string_lossy().to_string(),
            exists: true,
            is_file: metadata.is_file(),
            is_dir: metadata.is_dir(),
            bytes: metadata.is_file().then_some(metadata.len()),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ArtifactFileStatusPayload {
            path: path.to_string_lossy().to_string(),
            exists: false,
            is_file: false,
            is_dir: false,
            bytes: None,
        }),
        Err(e) => Err(format!("failed to read artifact file status: {e}")),
    }
}

#[tauri::command]
async fn open_artifact_location(
    path: String,
    target: Option<String>,
) -> std::result::Result<(), String> {
    tokio::task::spawn_blocking(move || {
        open_artifact_location_blocking(path, target.unwrap_or_else(|| "file".to_string()))
    })
    .await
    .map_err(|e| format!("artifact open task failed: {e}"))?
}

fn open_artifact_location_blocking(
    path: String,
    target: String,
) -> std::result::Result<(), String> {
    let path = validate_artifact_open_path(Path::new(path.trim()))?;
    let target = parse_artifact_open_target(&target)?;
    let spec = artifact_open_command(&path, target)?;
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args);
    milim_core::proc::hide_console(&mut cmd)
        .spawn()
        .map_err(|e| format!("failed to open artifact: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn open_external_url(url: String) -> std::result::Result<(), String> {
    tokio::task::spawn_blocking(move || open_external_url_blocking(url))
        .await
        .map_err(|e| format!("URL open task failed: {e}"))?
}

fn open_external_url_blocking(url: String) -> std::result::Result<(), String> {
    let url = validate_external_url(&url)?;
    let spec = external_url_open_command(&url);
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args);
    milim_core::proc::hide_console(&mut cmd)
        .spawn()
        .map_err(|e| format!("failed to open URL: {e}"))?;
    Ok(())
}

fn validate_external_url(url: &str) -> std::result::Result<String, String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("https://") && !lower.starts_with("http://") {
        return Err("external URL must be http or https".to_string());
    }
    if url.chars().any(char::is_whitespace) {
        return Err("external URL must not contain whitespace".to_string());
    }
    Ok(url.to_string())
}

fn external_url_open_command(url: &str) -> ArtifactOpenCommandSpec {
    if cfg!(windows) {
        return ArtifactOpenCommandSpec {
            program: "rundll32".to_string(),
            args: vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()],
        };
    }
    if cfg!(target_os = "macos") {
        return ArtifactOpenCommandSpec {
            program: "open".to_string(),
            args: vec![url.to_string()],
        };
    }
    ArtifactOpenCommandSpec {
        program: "xdg-open".to_string(),
        args: vec![url.to_string()],
    }
}

fn mobile_tailscale_status_blocking(local_target: String) -> MobileTailscaleStatus {
    let Some(command) = find_tailscale_command() else {
        return tailscale_not_found_status(local_target);
    };
    let status_output = match run_tailscale(&command, &["status", "--json"]) {
        Ok(output) => output,
        Err(e) => {
            return MobileTailscaleStatus {
                installed: true,
                logged_in: false,
                serve_configured: false,
                public_url: None,
                local_target,
                message: Some(format!("Tailscale status failed: {e}")),
            }
        }
    };
    if !status_output.status.success() {
        return MobileTailscaleStatus {
            installed: true,
            logged_in: false,
            serve_configured: false,
            public_url: None,
            local_target,
            message: Some(first_output_line(
                &status_output,
                "Tailscale is not logged in.",
            )),
        };
    }

    let (logged_in, dns_name, peer_count) =
        parse_tailscale_status_json(&String::from_utf8_lossy(&status_output.stdout));
    let serve_url = if logged_in {
        dns_name
            .as_deref()
            .and_then(|dns_name| tailscale_serve_url(&command, &local_target, dns_name))
    } else {
        None
    };
    let serve_configured = serve_url.is_some();
    let public_url = serve_url.or_else(|| {
        dns_name
            .as_deref()
            .map(|dns_name| format!("https://{dns_name}:{TAILSCALE_SERVE_PORT}"))
    });
    let message = if logged_in {
        if public_url.is_none() {
            Some("Tailscale is running, but no DNS name was reported.".to_string())
        } else if serve_configured && peer_count == 0 {
            Some("Tailscale Serve is ready, but no other tailnet devices are visible. Open Tailscale on your iPhone and make sure it is connected to this same tailnet.".to_string())
        } else {
            None
        }
    } else {
        Some("Tailscale is not logged in.".to_string())
    };
    MobileTailscaleStatus {
        installed: true,
        logged_in,
        serve_configured,
        public_url,
        local_target,
        message,
    }
}

fn configure_mobile_tailscale_relay_blocking(local_target: String) -> MobileTailscaleStatus {
    let Some(command) = find_tailscale_command() else {
        return tailscale_not_found_status(local_target);
    };
    let status = mobile_tailscale_status_blocking(local_target.clone());
    if !status.logged_in || status.public_url.is_none() {
        return status;
    }
    if status
        .public_url
        .as_deref()
        .is_some_and(|url| status.serve_configured && url.starts_with("https://"))
    {
        return status;
    }

    let https = format!("--https={TAILSCALE_SERVE_PORT}");
    let https_result = run_tailscale(
        &command,
        &["serve", "--bg", &https, "--yes", local_target.as_str()],
    );
    if let Ok(output) = &https_result {
        if output.status.success() {
            let mut next = mobile_tailscale_status_blocking(local_target.clone());
            if next.serve_configured {
                if next.message.is_none() {
                    next.message = Some("Tailscale Serve is ready over HTTPS.".to_string());
                }
                return next;
            }
        }
    }

    let http = format!("--http={TAILSCALE_SERVE_PORT}");
    match run_tailscale(
        &command,
        &["serve", "--bg", &http, "--yes", local_target.as_str()],
    ) {
        Ok(output) if output.status.success() => {
            let mut next = mobile_tailscale_status_blocking(local_target);
            if next.message.is_none() {
                next.message = Some("Tailscale Serve is ready over tailnet HTTP.".to_string());
            }
            next
        }
        Ok(output) => MobileTailscaleStatus {
            message: Some(first_output_line(
                &output,
                "Tailscale Serve setup failed after HTTPS and HTTP attempts.",
            )),
            ..status
        },
        Err(e) => MobileTailscaleStatus {
            message: Some(format!(
                "Tailscale Serve setup failed: HTTPS attempt failed; HTTP fallback failed: {e}"
            )),
            ..status
        },
    }
}

fn disable_mobile_tailscale_relay_blocking(local_target: String) -> MobileTailscaleStatus {
    let Some(command) = find_tailscale_command() else {
        return tailscale_not_found_status(local_target);
    };
    let https = format!("--https={TAILSCALE_SERVE_PORT}");
    let http = format!("--http={TAILSCALE_SERVE_PORT}");
    let _ = run_tailscale(&command, &["serve", &https, "--yes", "off"]);
    let _ = run_tailscale(&command, &["serve", &http, "--yes", "off"]);
    mobile_tailscale_status_blocking(local_target)
}

fn find_tailscale_command() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("TAILSCALE_CLI").map(PathBuf::from) {
        if path.exists() {
            return Some(path);
        }
    }

    for path in tailscale_command_candidates() {
        if path.exists() {
            return Some(path);
        }
    }

    if run_tailscale(Path::new("tailscale"), &["version"]).is_ok() {
        return Some(PathBuf::from("tailscale"));
    }
    None
}

fn tailscale_command_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if cfg!(windows) {
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(root) = std::env::var_os(key).map(PathBuf::from) {
                paths.push(root.join("Tailscale").join("tailscale.exe"));
            }
        }
        return paths;
    }
    paths.extend([
        PathBuf::from("/usr/local/bin/tailscale"),
        PathBuf::from("/opt/homebrew/bin/tailscale"),
        PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"),
        PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/tailscale"),
    ]);
    paths
}

fn run_tailscale(command: &Path, args: &[&str]) -> io::Result<Output> {
    let mut cmd = Command::new(command);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = milim_core::proc::hide_console(&mut cmd).spawn()?;
    let deadline = Instant::now() + Duration::from_secs(TAILSCALE_COMMAND_TIMEOUT_SECS);
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "tailscale {} timed out after {TAILSCALE_COMMAND_TIMEOUT_SECS}s",
                    args.join(" ")
                ),
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn parse_tailscale_status_json(raw: &str) -> (bool, Option<String>, usize) {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return (false, None, 0);
    };
    let backend = value
        .get("BackendState")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let dns = value
        .get("Self")
        .and_then(|self_node| self_node.get("DNSName"))
        .and_then(Value::as_str)
        .map(|value| value.trim_end_matches('.').to_string())
        .filter(|value| !value.is_empty());
    let logged_in = dns.is_some()
        || matches!(
            backend,
            "Running" | "Starting" | "NeedsMachineAuth" | "Stopped"
        );
    let peer_count = value
        .get("Peer")
        .and_then(Value::as_object)
        .map(|peers| peers.len())
        .unwrap_or(0);
    (logged_in, dns, peer_count)
}

fn tailscale_serve_url(command: &Path, local_target: &str, dns_name: &str) -> Option<String> {
    run_tailscale(command, &["serve", "status", "--json"])
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            parse_tailscale_serve_url(
                &String::from_utf8_lossy(&output.stdout),
                local_target,
                dns_name,
            )
        })
}

fn parse_tailscale_serve_url(raw: &str, local_target: &str, dns_name: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    let port = TAILSCALE_SERVE_PORT.to_string();
    let host = format!("{dns_name}:{port}");
    let handler = value
        .get("Web")?
        .get(&host)?
        .get("Handlers")?
        .as_object()?
        .values()
        .find(|handler| {
            handler
                .get("Proxy")
                .and_then(Value::as_str)
                .is_some_and(|proxy| proxy.eq_ignore_ascii_case(local_target))
        })?;
    let _ = handler;
    let is_http = value
        .get("TCP")
        .and_then(|tcp| tcp.get(&port))
        .and_then(|config| config.get("HTTP"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(format!(
        "{}://{host}",
        if is_http { "http" } else { "https" }
    ))
}

fn first_output_line(output: &std::process::Output, fallback: &str) -> String {
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn tailscale_not_found_status(local_target: String) -> MobileTailscaleStatus {
    MobileTailscaleStatus {
        installed: false,
        logged_in: false,
        serve_configured: false,
        public_url: None,
        local_target,
        message: Some("Tailscale CLI not found. Install Tailscale and sign in first.".to_string()),
    }
}

fn validate_artifact_open_path(path: &Path) -> std::result::Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("artifact path is required".to_string());
    }
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("artifact path is not available: {e}"))?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("artifact path must be a file or directory".to_string());
    }
    Ok(path.to_path_buf())
}

fn parse_artifact_open_target(target: &str) -> std::result::Result<ArtifactOpenTarget, String> {
    match target {
        "file" => Ok(ArtifactOpenTarget::File),
        "folder" => Ok(ArtifactOpenTarget::Folder),
        _ => Err("artifact open target must be file or folder".to_string()),
    }
}

fn artifact_open_command(
    path: &Path,
    target: ArtifactOpenTarget,
) -> std::result::Result<ArtifactOpenCommandSpec, String> {
    let path_string = path.to_string_lossy().to_string();
    if cfg!(windows) {
        let args = match target {
            ArtifactOpenTarget::File => vec![path_string],
            ArtifactOpenTarget::Folder => {
                if path.is_file() {
                    vec![format!("/select,{path_string}")]
                } else {
                    vec![path_string]
                }
            }
        };
        return Ok(ArtifactOpenCommandSpec {
            program: "explorer".to_string(),
            args,
        });
    }
    if cfg!(target_os = "macos") {
        let args = match target {
            ArtifactOpenTarget::File => vec![path_string],
            ArtifactOpenTarget::Folder if path.is_file() => vec!["-R".to_string(), path_string],
            ArtifactOpenTarget::Folder => vec![path_string],
        };
        return Ok(ArtifactOpenCommandSpec {
            program: "open".to_string(),
            args,
        });
    }
    let target_path = match target {
        ArtifactOpenTarget::File => path.to_path_buf(),
        ArtifactOpenTarget::Folder if path.is_file() => path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| path.to_path_buf()),
        ArtifactOpenTarget::Folder => path.to_path_buf(),
    };
    Ok(ArtifactOpenCommandSpec {
        program: "xdg-open".to_string(),
        args: vec![target_path.to_string_lossy().to_string()],
    })
}

#[cfg(feature = "computer-use")]
#[tauri::command]
async fn voice_type_text(text: String) -> std::result::Result<usize, String> {
    let len = text.len();
    if text.is_empty() {
        return Ok(0);
    }
    tokio::task::spawn_blocking(move || {
        computer_tools::type_text_input(&text).map_err(|e| format!("voice_type_text: {e}"))?;
        Ok(len)
    })
    .await
    .map_err(|e| format!("input task failed: {e}"))?
}

#[cfg(not(feature = "computer-use"))]
#[tauri::command]
async fn voice_type_text(_text: String) -> std::result::Result<usize, String> {
    Err("Active-app dictation requires the desktop app to be built with computer-use.".to_string())
}

const UPDATE_DIR_NAME: &str = "milim-updates";
const UPDATE_RECOVERY_ERROR_NAME: &str = "install-error.txt";

fn update_dir(app: &tauri::AppHandle) -> std::result::Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("could not resolve app local data directory: {e}"))?;
    Ok(data_dir.join(UPDATE_DIR_NAME))
}

fn update_recovery_error_file(app: &tauri::AppHandle) -> std::result::Result<PathBuf, String> {
    Ok(update_dir(app)?.join(UPDATE_RECOVERY_ERROR_NAME))
}

#[tauri::command]
fn take_update_recovery_error(
    app: tauri::AppHandle,
) -> std::result::Result<Option<String>, String> {
    let marker = update_recovery_error_file(&app)?;
    match fs::read_to_string(&marker) {
        Ok(contents) => {
            let _ = fs::remove_file(marker);
            let message = contents.trim();
            Ok((!message.is_empty()).then(|| message.to_string()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn validate_update_archive_name(file_name: &str) -> std::result::Result<(), String> {
    if file_name.trim().is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.starts_with('.')
    {
        return Err("Invalid update file name.".to_string());
    }
    let lower = file_name.to_ascii_lowercase();
    if !(lower.ends_with(".exe") || lower.ends_with(".app.zip")) {
        return Err("Unsupported update file type.".to_string());
    }
    Ok(())
}

fn validate_install_source_name(file_name: &str) -> std::result::Result<(), String> {
    if file_name.trim().is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.starts_with('.')
    {
        return Err("Invalid update source name.".to_string());
    }
    let lower = file_name.to_ascii_lowercase();

    #[cfg(target_os = "windows")]
    if lower.ends_with(".exe") {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    if lower.ends_with(".app") {
        return Ok(());
    }

    Err("Unsupported update source type.".to_string())
}

fn canonical_update_source(
    app: &tauri::AppHandle,
    update_path: &str,
) -> std::result::Result<PathBuf, String> {
    let update_root = update_dir(app)?;
    let canonical_root = fs::canonicalize(&update_root).map_err(|e| e.to_string())?;
    let canonical_source = fs::canonicalize(Path::new(update_path)).map_err(|e| e.to_string())?;
    if !canonical_source.starts_with(&canonical_root) {
        return Err("Update source must be inside the app update directory.".to_string());
    }
    let file_name = canonical_source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid update source path")?;
    validate_install_source_name(file_name)?;
    Ok(canonical_source)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn canonical_update_archive(
    app: &tauri::AppHandle,
    update_path: &str,
) -> std::result::Result<PathBuf, String> {
    let update_root = update_dir(app)?;
    let canonical_root = fs::canonicalize(&update_root).map_err(|e| e.to_string())?;
    let canonical_archive = fs::canonicalize(Path::new(update_path)).map_err(|e| e.to_string())?;
    if !canonical_archive.starts_with(&canonical_root) {
        return Err("Update archive must be inside the app update directory.".to_string());
    }
    let file_name = canonical_archive
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid update archive path")?;
    validate_update_archive_name(file_name)?;
    Ok(canonical_archive)
}

#[tauri::command]
fn get_update_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

#[tauri::command]
fn write_update_file(
    app: tauri::AppHandle,
    file_name: String,
    contents: Vec<u8>,
) -> std::result::Result<String, String> {
    validate_update_archive_name(&file_name)?;
    let update_root = update_dir(&app)?;
    fs::create_dir_all(&update_root).map_err(|e| e.to_string())?;
    let update_file = update_root.join(file_name);
    fs::write(&update_file, contents).map_err(|e| e.to_string())?;
    Ok(update_file.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
fn escape_powershell_literal(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn windows_update_replacement_path(current_exe: &Path) -> PathBuf {
    let file_name = current_exe
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("milim.exe");
    current_exe.with_file_name(format!("{file_name}.update"))
}

#[cfg(target_os = "windows")]
fn windows_update_backup_path(current_exe: &Path) -> PathBuf {
    let file_name = current_exe
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("milim.exe");
    current_exe.with_file_name(format!("{file_name}.previous"))
}

#[cfg(target_os = "windows")]
fn build_windows_update_script(
    pid: u32,
    source: &Path,
    replacement: &Path,
    target: &Path,
    backup: &Path,
    log: &Path,
    error_marker: &Path,
    script: &Path,
) -> String {
    let template = r#"
param([switch]$Elevated)
$ErrorActionPreference = 'Stop'
$procId = __PID__
$source = '__SOURCE__'
$replacement = '__REPLACEMENT__'
$target = '__TARGET__'
$backup = '__BACKUP__'
$log = '__LOG__'
$errorMarker = '__ERROR_MARKER__'
$script = '__SCRIPT__'

function Write-UpdateLog([string]$message) {
  try {
    $timestamp = (Get-Date).ToString('s')
    Add-Content -LiteralPath $log -Value "$timestamp $message"
  } catch {}
}

Write-UpdateLog "Waiting for process $procId to exit."
while (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
  Start-Sleep -Milliseconds 200
}

for ($attempt = 1; $attempt -le 120; $attempt++) {
  try {
    if (Test-Path -LiteralPath $backup) {
      Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $source)) {
      throw "Downloaded update is missing: $source"
    }

    Copy-Item -LiteralPath $source -Destination $replacement -Force
    if ((Get-Item -LiteralPath $source).Length -ne (Get-Item -LiteralPath $replacement).Length) {
      throw "Staged update size did not match the downloaded update."
    }

    Move-Item -LiteralPath $target -Destination $backup -Force
    Move-Item -LiteralPath $replacement -Destination $target -Force
    Write-UpdateLog "Installed update on attempt $attempt."
    Start-Process -FilePath $target
    Start-Sleep -Seconds 2

    if (Test-Path -LiteralPath $backup) {
      Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    }
    exit 0
  } catch {
    Write-UpdateLog "Attempt $attempt failed: $($_.Exception.Message)"
    if ((-not (Test-Path -LiteralPath $target)) -and (Test-Path -LiteralPath $backup)) {
      try {
        Move-Item -LiteralPath $backup -Destination $target -Force
        Write-UpdateLog "Restored previous executable after failed attempt $attempt."
      } catch {
        Write-UpdateLog "Failed to restore previous executable: $($_.Exception.Message)"
      }
    }
    Start-Sleep -Milliseconds 500
  }
}

if (-not $Elevated) {
  try {
    Write-UpdateLog "Retrying update with elevation."
    Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script, "-Elevated")
    exit 0
  } catch {
    Write-UpdateLog "Elevation failed: $($_.Exception.Message)"
  }
}

Write-UpdateLog "Update failed after retries."
try {
  Set-Content -LiteralPath $errorMarker -Value "The last update failed after milim closed. The previous version was restored. See $log for details."
} catch {}
try {
  if ((-not (Test-Path -LiteralPath $target)) -and (Test-Path -LiteralPath $backup)) {
    Move-Item -LiteralPath $backup -Destination $target -Force
  }
  if (Test-Path -LiteralPath $target) {
    Start-Process -FilePath $target
  }
} catch {
  Write-UpdateLog "Failed to relaunch after update failure: $($_.Exception.Message)"
}
exit 1
"#;

    template
        .replace("__PID__", &pid.to_string())
        .replace(
            "__SOURCE__",
            &escape_powershell_literal(&source.to_string_lossy()),
        )
        .replace(
            "__REPLACEMENT__",
            &escape_powershell_literal(&replacement.to_string_lossy()),
        )
        .replace(
            "__TARGET__",
            &escape_powershell_literal(&target.to_string_lossy()),
        )
        .replace(
            "__BACKUP__",
            &escape_powershell_literal(&backup.to_string_lossy()),
        )
        .replace(
            "__LOG__",
            &escape_powershell_literal(&log.to_string_lossy()),
        )
        .replace(
            "__ERROR_MARKER__",
            &escape_powershell_literal(&error_marker.to_string_lossy()),
        )
        .replace(
            "__SCRIPT__",
            &escape_powershell_literal(&script.to_string_lossy()),
        )
}

#[cfg(target_os = "macos")]
fn escape_bash_literal(value: &str) -> String {
    value.replace('\'', "'\\''")
}

#[tauri::command]
fn apply_update(app: tauri::AppHandle, update_path: String) -> std::result::Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Auto-update is disabled in dev builds.".to_string());
    }

    let update_file = canonical_update_source(&app, &update_path)?;
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let pid = std::process::id();

    #[cfg(target_os = "windows")]
    {
        let update_root = update_dir(&app)?;
        fs::create_dir_all(&update_root).map_err(|e| e.to_string())?;
        let replacement = windows_update_replacement_path(&current_exe);
        let backup = windows_update_backup_path(&current_exe);
        let log = update_root.join("install.log");
        let error_marker = update_root.join(UPDATE_RECOVERY_ERROR_NAME);
        let script_path = update_root.join("apply-update.ps1");
        let script = build_windows_update_script(
            pid,
            &update_file,
            &replacement,
            &current_exe,
            &backup,
            &log,
            &error_marker,
            &script_path,
        );
        fs::write(&script_path, script).map_err(|e| e.to_string())?;
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
                &script_path.to_string_lossy(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        let update_root = update_dir(&app)?;
        fs::create_dir_all(&update_root).map_err(|e| e.to_string())?;
        let error_marker = update_root.join(UPDATE_RECOVERY_ERROR_NAME);
        let app_bundle = current_exe
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .ok_or("Could not determine app bundle path")?;
        let backup = app_bundle.with_extension("app.previous");
        let script = format!(
            r#"set -e
pid={}
source='{}'
target='{}'
backup='{}'
error_marker='{}'
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
trap 'echo "The last update failed after milim closed. The previous app was restored." > "$error_marker"; if [ ! -e "$target" ] && [ -e "$backup" ]; then mv "$backup" "$target"; open "$target"; fi' ERR
rm -rf "$backup"
mv "$target" "$backup"
mv "$source" "$target"
open "$target"
rm -rf "$backup"
"#,
            pid,
            escape_bash_literal(&update_file.to_string_lossy()),
            escape_bash_literal(&app_bundle.to_string_lossy()),
            escape_bash_literal(&backup.to_string_lossy()),
            escape_bash_literal(&error_marker.to_string_lossy()),
        );
        Command::new("bash")
            .args(["-c", &script])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        return Err("Auto-update is not supported on this platform.".to_string());
    }

    app.exit(0);
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn extract_app_zip(app: tauri::AppHandle, zip_path: String) -> std::result::Result<String, String> {
    let zip_file = canonical_update_archive(&app, &zip_path)?;
    let parent = zip_file.parent().ok_or("Invalid zip path")?;
    let app_path = parent.join("milim.app");
    if app_path.exists() {
        fs::remove_dir_all(&app_path).map_err(|e| e.to_string())?;
    }
    let status = Command::new("ditto")
        .arg("-xk")
        .arg(zip_file.as_os_str())
        .arg(parent.as_os_str())
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Failed to extract update".to_string());
    }
    if !app_path.exists() {
        return Err("Extracted app not found".to_string());
    }
    let _ = fs::remove_file(zip_file);
    Ok(app_path.to_string_lossy().to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn extract_app_zip(_zip_path: String) -> std::result::Result<String, String> {
    Err("This command is only available on macOS".to_string())
}

fn desktop_config() -> ServerConfiguration {
    ServerConfiguration {
        allowed_origins: vec![
            "http://localhost:5180".to_string(),
            "http://127.0.0.1:5180".to_string(),
            "http://tauri.localhost".to_string(),
            "https://tauri.localhost".to_string(),
            "tauri://localhost".to_string(),
        ],
        ..ServerConfiguration::default()
    }
}

fn open_user_data_store_at(path: &Path) -> Result<Arc<milim_storage::UserDataStore>> {
    let db = Database::open_with_options(
        path,
        DatabaseOptions {
            journal_mode: JournalMode::Delete,
        },
    )?;
    milim_storage::UserDataStore::new(db).map(Arc::new)
}

fn open_user_data_store() -> Result<Arc<milim_storage::UserDataStore>> {
    let paths = Paths::resolve();
    open_user_data_store_at(&paths.user_db_file())
}

/// Build the embedded server state (backend + tools). Returns the MCP hub too
/// so the caller can connect persisted servers on the async runtime (connecting
/// spawns child processes).
fn build_state(
    api_key: String,
) -> (
    AppState,
    SocketAddr,
    Arc<milim_mcp_client::McpHub>,
    Arc<milim_server::providers::ProviderRegistry>,
) {
    let config = desktop_config();
    let addr: SocketAddr = format!("127.0.0.1:{}", config.port)
        .parse()
        .expect("valid loopback address");

    let paths = Paths::resolve();

    let mut tools = ToolRegistry::with_builtins();
    tools.register(Arc::new(RunCommandTool::default()));

    // Host filesystem + shell tools, rooted to the GUI's working folder. The
    // same cell is shared with AppState so `POST /workspace` (the Folder chip)
    // updates the root the tools operate within.
    let workspace: host_tools::Workspace = Arc::new(RwLock::new(None));
    for tool in host_tools::host_tools(workspace.clone()) {
        tools.register(tool);
    }

    // Computer-use tools (screen capture + mouse/keyboard). Registered when
    // built with the feature; dormant until the runtime gate is enabled.
    #[cfg(feature = "computer-use")]
    let computer_gate = {
        let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
        for tool in computer_tools::computer_tools(gate.clone(), paths.root().join("captures")) {
            tools.register(tool);
        }
        gate
    };

    // The default backend (configured remote / explicit unavailable) is the
    // fallback; configured providers route by model on top of it.
    let local = pick_backend();
    let registry = Arc::new(milim_server::providers::ProviderRegistry::open(
        paths.root(),
        local.clone(),
    ));

    // External MCP servers (their tools merge into the agent registry per-run).
    let mcp = Arc::new(milim_mcp_client::McpHub::open(paths.root()));

    // Outbound privacy gate: shared between the provider router (enforcement)
    // and the `/privacy/mode` endpoint (the desktop's active thread setting).
    let privacy = Arc::new(milim_server::privacy::PrivacyGate::from_env());
    let mobile_companion = Arc::new(milim_server::companion::MobileCompanionBridge::persistent(
        paths.config_dir().join("mobile-companion.json"),
    ));
    let service: SharedService = Arc::new(registry.router(privacy.clone()));

    let mut state = AppState::new(service.clone(), config)
        .with_tools(tools)
        .with_providers(registry.clone())
        .with_workspace(workspace)
        .with_mcp(mcp.clone())
        .with_privacy(privacy)
        .with_mobile_companion(mobile_companion)
        .with_api_keys([api_key])
        .with_loopback_trust(false);
    state = attach_whisper_transcriber(state);
    state = attach_native_vad(state);

    #[cfg(feature = "computer-use")]
    {
        state = state.with_computer_use(computer_gate);
    }

    // Persisted named-agent store (best-effort; chat works without it).
    let agents_db = paths.root().join("agents.db");
    match milim_storage::Database::open(&agents_db).and_then(milim_agents::AgentStore::new) {
        Ok(agent_store) => state = state.with_agents(agent_store),
        Err(e) => eprintln!("agent store unavailable: {e}"),
    }

    // Persisted child-thread supervisor used by parent agent runs.
    let threads_db = paths.root().join("threads.db");
    match milim_storage::Database::open(&threads_db).and_then(milim_agents::ThreadStore::new) {
        Ok(thread_store) => {
            state = state.with_threads(milim_server::threads::ThreadSupervisor::new(thread_store))
        }
        Err(e) => eprintln!("child threads unavailable: {e}"),
    }

    // Persisted SKILL.md instructions used by both simple chat and workbench.
    let skills_db = paths.root().join("skills.db");
    match milim_storage::Database::open(&skills_db).and_then(milim_skills::SkillStore::new) {
        Ok(skill_store) => {
            if let Err(e) = skill_store.import_global_skills() {
                eprintln!("global skills import failed: {e}");
            }
            state = state.with_skills(skill_store)
        }
        Err(e) => eprintln!("skills unavailable: {e}"),
    }

    // Embedding memory/RAG store (best-effort; embeds through the active router).
    let memory_db = paths.user_db_file();
    match milim_storage::Database::open_with_options(
        &memory_db,
        DatabaseOptions {
            journal_mode: JournalMode::Delete,
        },
    )
    .and_then(|db| milim_memory::MemoryStore::new(db, service.clone()))
    {
        Ok(memory) => state = state.with_memory(memory),
        Err(e) => eprintln!("memory store unavailable: {e}"),
    }

    // Persisted cron schedules, shared by the Schedules sheet and the agent
    // schedule tools used for chat-created automations.
    let schedules_db = paths.root().join("schedules.db");
    match milim_storage::Database::open(&schedules_db)
        .and_then(milim_automation::ScheduleStore::new)
    {
        Ok(schedule_store) => state = state.with_schedules(schedule_store),
        Err(e) => eprintln!("schedules unavailable: {e}"),
    }

    (state, addr, mcp, registry)
}

fn bind_desktop_server_listener(
    preferred_addr: SocketAddr,
) -> std::io::Result<(TcpListener, SocketAddr)> {
    let listener = match TcpListener::bind(preferred_addr) {
        Ok(listener) => listener,
        Err(e) if preferred_addr.port() != 0 => {
            eprintln!(
                "embedded milim server could not bind {preferred_addr}: {e}; falling back to a free loopback port"
            );
            TcpListener::bind(SocketAddr::new(preferred_addr.ip(), 0))?
        }
        Err(e) => return Err(e),
    };
    listener.set_nonblocking(true)?;
    let addr = listener.local_addr()?;
    Ok((listener, addr))
}

#[cfg(feature = "whisper")]
fn attach_whisper_transcriber(mut state: AppState) -> AppState {
    state = state.with_transcriber_factory(Arc::new(|path: String| {
        milim_voice::WhisperTranscriber::from_model_file(path)
            .map(|transcriber| Arc::new(transcriber) as Arc<dyn milim_voice::Transcriber>)
    }));

    match milim_voice::WhisperTranscriber::from_default_env() {
        Ok(Some(transcriber)) => {
            eprintln!("voice transcription enabled via MILIM_WHISPER_MODEL");
            state = state.with_transcriber(Arc::new(transcriber));
        }
        Ok(None) => {}
        Err(e) => eprintln!("voice transcription unavailable: {e}"),
    }

    state
}

#[cfg(not(feature = "whisper"))]
fn attach_whisper_transcriber(state: AppState) -> AppState {
    if non_empty_env("MILIM_WHISPER_MODEL").is_some() {
        eprintln!(
            "MILIM_WHISPER_MODEL is set, but the desktop app was built without the `whisper` feature"
        );
    }

    state
}

#[cfg(feature = "native-vad")]
fn attach_native_vad(mut state: AppState) -> AppState {
    state = state.with_vad_factory(Arc::new(|path: String| {
        milim_voice::NativeSileroVoiceActivityDetector::new(path)
            .map(|detector| Arc::new(detector) as Arc<dyn milim_voice::VoiceActivityDetector>)
    }));
    state
}

#[cfg(not(feature = "native-vad"))]
fn attach_native_vad(state: AppState) -> AppState {
    state
}

/// Choose the inference backend: a configured remote, else an explicit
/// unavailable backend.
fn pick_backend() -> SharedService {
    if let Some(base) = non_empty_env("MILIM_REMOTE_BASE_URL") {
        let key = non_empty_env("MILIM_REMOTE_API_KEY");
        return Arc::new(RemoteBackend::new("remote", base, key));
    }
    Arc::new(UnavailableBackend::new())
}

/// A tool that runs a shell command inside an isolated Docker sandbox
/// (`milim-sandbox`). Exposed to the agent loop so models can execute code/CLI
/// safely - this is how the GUI's Sandbox toggle is honored. Requires Docker.
struct RunCommandTool {
    backend: DockerBackend,
    image: String,
}

impl Default for RunCommandTool {
    fn default() -> Self {
        Self {
            backend: DockerBackend::new(),
            image: non_empty_env("MILIM_SANDBOX_IMAGE").unwrap_or_else(|| "alpine".to_string()),
        }
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

#[async_trait]
impl Tool for RunCommandTool {
    fn name(&self) -> &str {
        "run_command"
    }
    fn description(&self) -> &str {
        "Run a shell command inside an isolated Docker sandbox (no network). Use to execute code or CLI tools safely."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "command": { "type": "string", "description": "Shell command to run" } },
            "required": ["command"]
        })
    }
    async fn invoke(&self, args: Value) -> Result<Value> {
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::InvalidRequest("missing string argument: command".into()))?;
        let out = self
            .backend
            .run(
                &self.image,
                &["sh".to_string(), "-c".to_string(), command.to_string()],
                &RunOpts::default(),
            )
            .await?;
        Ok(json!({ "stdout": out.stdout, "stderr": out.stderr, "exit_code": out.exit_code }))
    }
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, TRAY_OPEN_ID, "Open milim", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit milim", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let mut tray = TrayIconBuilder::with_id(MAIN_WINDOW_LABEL)
        .tooltip("milim")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN_ID => show_main_window(app),
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let api_key = milim_server::gen_id("desktop");
    let (state, preferred_addr, mcp, providers) = build_state(api_key.clone());
    let (server_listener, addr) =
        bind_desktop_server_listener(preferred_addr).expect("bind embedded milim server");
    let (mobile_listener, mobile_addr) = bind_desktop_server_listener(
        "127.0.0.1:0"
            .parse()
            .expect("valid mobile relay loopback address"),
    )
    .expect("bind embedded mobile relay server");
    let api_base = format!("http://{addr}");
    let mobile_local_target = format!("http://{mobile_addr}");
    let mobile_state = state.clone();
    let mobile_startup_companion = state.mobile_companion.clone();
    let mobile_startup_target = mobile_local_target.clone();
    let user_data = open_user_data_store().expect("initialize user data store");

    tauri::Builder::default()
        .manage(DesktopApiToken(api_key))
        .manage(DesktopApiBaseUrl(api_base))
        .manage(MobileRelayLocalTarget(mobile_local_target))
        .manage(UserDataState(user_data))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Persist + restore window size/position/maximized across restarts.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            setup_tray(app.handle())?;
            // Connect any persisted MCP servers in the background (best-effort).
            tauri::async_runtime::spawn(async move {
                mcp.connect_all().await;
            });
            // Refresh enabled providers' model lists so they populate on launch.
            tauri::async_runtime::spawn(async move {
                providers.refresh_all().await;
            });
            if state.schedules.is_some() {
                let scheduler_state = state.clone();
                tauri::async_runtime::spawn(async move {
                    milim_server::scheduler_loop(scheduler_state).await;
                });
            }
            // Run the HTTP server on Tauri's async runtime for the app's lifetime.
            tauri::async_runtime::spawn(async move {
                match tokio::net::TcpListener::from_std(server_listener) {
                    Ok(listener) => {
                        if let Err(e) = milim_server::serve_listener(state, listener).await {
                            eprintln!("embedded milim server error: {e}");
                        }
                    }
                    Err(e) => eprintln!("embedded milim server listener error: {e}"),
                }
            });
            // Separate phone-facing server. Tailscale Serve targets this, not the full API.
            tauri::async_runtime::spawn(async move {
                match tokio::net::TcpListener::from_std(mobile_listener) {
                    Ok(listener) => {
                        if let Err(e) =
                            milim_server::serve_mobile_companion_listener(mobile_state, listener)
                                .await
                        {
                            eprintln!("embedded mobile relay server error: {e}");
                        }
                    }
                    Err(e) => eprintln!("embedded mobile relay listener error: {e}"),
                }
            });
            if let Some(companion) = mobile_startup_companion {
                tauri::async_runtime::spawn(async move {
                    if companion.status(milim_server::now_unix()).enabled {
                        let status = tokio::task::spawn_blocking(move || {
                            configure_mobile_tailscale_relay_blocking(mobile_startup_target)
                        })
                        .await;
                        match status {
                            Ok(status) if status.serve_configured => {}
                            Ok(status) => {
                                if let Some(message) = status.message {
                                    eprintln!(
                                        "mobile relay Tailscale startup unavailable: {message}"
                                    );
                                }
                            }
                            Err(e) => eprintln!("mobile relay Tailscale startup task failed: {e}"),
                        }
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW_LABEL {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            health,
            api_base_url,
            api_token,
            mobile_tailscale_status,
            configure_mobile_tailscale_relay,
            disable_mobile_tailscale_relay,
            user_state_get,
            user_state_set,
            user_state_delete,
            user_sessions_get,
            user_sessions_set,
            user_sessions_delete,
            user_state_import_legacy,
            user_data_path,
            read_attachment_file,
            list_workspace_files,
            save_artifact_file,
            preview_artifact_file,
            artifact_file_status,
            open_artifact_location,
            open_external_url,
            discover_harness_imports,
            voice_type_text,
            get_update_platform,
            take_update_recovery_error,
            write_update_file,
            extract_app_zip,
            apply_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running milim desktop");
}

#[cfg(test)]
mod artifact_save_tests {
    use super::*;

    #[test]
    fn workspace_file_suggestions_match_relative_paths() {
        let root = std::env::temp_dir().join(format!(
            "milim-workspace-files-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("Composer.tsx"), "composer").unwrap();
        fs::write(root.join("README.md"), "readme").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules").join("skip.js"), "skip").unwrap();

        let matches =
            list_workspace_files_blocking(root.to_str().unwrap(), "comp", Some(10)).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "src/Composer.tsx");

        let all = list_workspace_files_blocking(root.to_str().unwrap(), "", Some(10)).unwrap();
        assert!(!all.iter().any(|file| file.path.contains("node_modules")));

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn updater_rejects_nested_or_unexpected_archive_names() {
        assert!(validate_update_archive_name("milim-0.1.30.exe").is_ok());
        assert!(validate_update_archive_name("milim-0.1.30.app.zip").is_ok());
        assert!(validate_update_archive_name("../milim.exe").is_err());
        assert!(validate_update_archive_name("updates/milim.exe").is_err());
        assert!(validate_update_archive_name("milim.zip").is_err());
        assert!(validate_update_archive_name(".milim.exe").is_err());
    }

    #[test]
    fn updater_rejects_install_sources_for_other_platforms() {
        #[cfg(target_os = "windows")]
        {
            assert!(validate_install_source_name("milim.exe").is_ok());
            assert!(validate_install_source_name("milim.app").is_err());
        }

        #[cfg(target_os = "macos")]
        {
            assert!(validate_install_source_name("milim.app").is_ok());
            assert!(validate_install_source_name("milim.exe").is_err());
        }

        assert!(validate_install_source_name("nested/milim.exe").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_updater_uses_staged_and_backup_paths_next_to_target() {
        let current_exe = PathBuf::from(r"C:\Apps\milim\milim_0.1.29_x64-portable.exe");

        assert_eq!(
            windows_update_replacement_path(&current_exe),
            PathBuf::from(r"C:\Apps\milim\milim_0.1.29_x64-portable.exe.update")
        );
        assert_eq!(
            windows_update_backup_path(&current_exe),
            PathBuf::from(r"C:\Apps\milim\milim_0.1.29_x64-portable.exe.previous")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_update_script_retries_replaces_elevates_then_relaunches() {
        let script = build_windows_update_script(
            1234,
            Path::new(r"C:\Users\USER\AppData\Local\milim\milim-updates\milim-0.1.30.exe"),
            Path::new(r"C:\Apps\milim\milim.exe.update"),
            Path::new(r"C:\Apps\milim\milim.exe"),
            Path::new(r"C:\Apps\milim\milim.exe.previous"),
            Path::new(r"C:\Users\O'Brien\AppData\Local\milim\install.log"),
            Path::new(r"C:\Users\O'Brien\AppData\Local\milim\install-error.txt"),
            Path::new(r"C:\Users\O'Brien\AppData\Local\milim\apply-update.ps1"),
        );

        assert!(script.contains("$ErrorActionPreference = 'Stop'"));
        assert!(script.contains("for ($attempt = 1; $attempt -le 120; $attempt++)"));
        assert!(script.contains("Copy-Item -LiteralPath $source -Destination $replacement -Force"));
        assert!(script.contains("Move-Item -LiteralPath $target -Destination $backup -Force"));
        assert!(script.contains("Move-Item -LiteralPath $replacement -Destination $target -Force"));
        assert!(script.contains("Start-Process -FilePath $target"));
        assert!(script.contains("-Verb RunAs"));
        assert!(script.contains(r"C:\Users\O''Brien\AppData\Local\milim\install.log"));
        assert!(script.contains("Set-Content -LiteralPath $errorMarker"));
        assert!(script.contains(r"C:\Users\O''Brien\AppData\Local\milim\install-error.txt"));
    }

    #[test]
    fn harness_import_reads_codex_mcp_servers() {
        let root = std::env::temp_dir().join(format!(
            "milim-harness-import-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let config = root.join("config.toml");
        std::fs::write(
            &config,
            r#"
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]

[mcp_servers.filesystem.env]
SECRET = "ignored"

[mcp_servers.filesystem.tools.read_file]
approval_mode = "approve"

[mcp_servers.docs]
url = "https://example.com/mcp"

[mcp_servers.local]
command='uvx'
args=['mcp-obsidian']
"#,
        )
        .unwrap();

        let mut out = Vec::new();
        read_codex_mcp_config(&config, &mut out);

        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "filesystem");
        assert_eq!(out[0].command, "npx");
        assert_eq!(out[0].args[1], "@modelcontextprotocol/server-filesystem");
        assert_eq!(out[1].name, "local");
        assert_eq!(out[1].command, "uvx");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn artifact_save_rejects_absolute_paths() {
        assert!(safe_artifact_relative_path("/tmp/out.txt").is_err());
        assert!(safe_artifact_relative_path("C:\\tmp\\out.txt").is_err());
    }

    #[test]
    fn artifact_save_rejects_parent_traversal() {
        assert!(safe_artifact_relative_path("../secret.txt").is_err());
        assert!(safe_artifact_relative_path("src/../../secret.txt").is_err());
    }

    #[test]
    fn artifact_save_writes_nested_file_and_blocks_overwrite() {
        let root = std::env::temp_dir().join(format!(
            "milim-artifact-save-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let first = save_artifact_file_blocking(
            root.to_string_lossy().to_string(),
            "src/generated.txt".to_string(),
            "hello".to_string(),
            false,
        )
        .unwrap();
        assert_eq!(first.bytes, 5);
        assert!(!first.overwritten);
        assert_eq!(
            std::fs::read_to_string(root.join("src").join("generated.txt")).unwrap(),
            "hello"
        );

        let blocked = save_artifact_file_blocking(
            root.to_string_lossy().to_string(),
            "src/generated.txt".to_string(),
            "updated".to_string(),
            false,
        )
        .unwrap_err();
        assert!(blocked.contains("already exists"));

        let overwritten = save_artifact_file_blocking(
            root.to_string_lossy().to_string(),
            "src/generated.txt".to_string(),
            "updated".to_string(),
            true,
        )
        .unwrap();
        assert!(overwritten.overwritten);
        assert_eq!(
            std::fs::read_to_string(root.join("src").join("generated.txt")).unwrap(),
            "updated"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn artifact_preview_reports_existing_file_diff() {
        let root = std::env::temp_dir().join(format!(
            "milim-artifact-preview-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("src").join("generated.ts"),
            "export const value = false;\n",
        )
        .unwrap();

        let preview = preview_artifact_file_blocking(
            root.to_string_lossy().to_string(),
            "src/generated.ts".to_string(),
            "export const value = true;\n".to_string(),
        )
        .unwrap();

        assert!(preview.exists);
        assert!(preview.changed);
        assert!(preview.diff.contains("-export const value = false;"));
        assert!(preview.diff.contains("+export const value = true;"));
        assert_eq!(preview.old_bytes, Some(28));
        assert_eq!(preview.new_bytes, 27);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn artifact_preview_diff_uses_unified_hunks_and_elides_middle_context() {
        let old = [
            "line 01", "line 02", "line 03", "line 04", "line 05", "line 06", "line 07", "line 08",
            "line 09", "line 10", "line 11", "line 12", "line 13",
        ]
        .join("\n");
        let new = old
            .replace("line 02", "line 02 changed")
            .replace("line 12", "line 12 changed");

        let diff = artifact_line_diff(&old, &new);

        assert!(diff.contains("@@ -1,4 +1,4 @@"));
        assert!(diff.contains("@@ -10,4 +10,4 @@"));
        assert!(diff.contains("-line 02"));
        assert!(diff.contains("+line 02 changed"));
        assert!(diff.contains("-line 12"));
        assert!(diff.contains("+line 12 changed"));
        assert!(diff.contains("... 5 unchanged lines ..."));
        assert!(!diff.contains(" line 07\n"));
    }

    #[test]
    fn artifact_open_rejects_missing_path() {
        let missing = std::env::temp_dir().join(format!(
            "milim-missing-artifact-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert!(validate_artifact_open_path(&missing).is_err());
    }

    #[test]
    fn artifact_status_reports_missing_and_existing_file() {
        let root = std::env::temp_dir().join(format!(
            "milim-artifact-status-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("status-target.txt");

        let missing = artifact_file_status_blocking(path.to_string_lossy().to_string()).unwrap();
        assert!(!missing.exists);
        assert!(!missing.is_file);
        assert!(!missing.is_dir);
        assert_eq!(missing.bytes, None);

        std::fs::write(&path, "hello").unwrap();
        let existing = artifact_file_status_blocking(path.to_string_lossy().to_string()).unwrap();
        assert!(existing.exists);
        assert!(existing.is_file);
        assert!(!existing.is_dir);
        assert_eq!(existing.bytes, Some(5));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn artifact_open_command_uses_existing_file_as_arg() {
        let root = std::env::temp_dir().join(format!(
            "milim-open-artifact-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("open-target.txt");
        std::fs::write(&path, "hello").unwrap();
        let spec = artifact_open_command(&path, ArtifactOpenTarget::File).unwrap();
        assert!(!spec.program.is_empty());
        assert!(
            spec.args.iter().any(|arg| arg.contains("open-target.txt")),
            "open command must pass the file path as a process argument"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn external_url_open_rejects_non_web_urls() {
        assert!(validate_external_url("file:///C:/secret.txt").is_err());
        assert!(validate_external_url("https://example.com/login").is_ok());
    }

    #[test]
    fn external_url_open_command_passes_url_as_arg() {
        let spec = external_url_open_command("https://example.com/login");
        assert!(spec
            .args
            .iter()
            .any(|arg| arg == "https://example.com/login"));
    }

    #[test]
    fn user_data_store_opens_syncable_database() {
        let root = std::env::temp_dir().join(format!(
            "milim-storage-user-data-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db_path = root.join("milim.db");

        let store = open_user_data_store_at(&db_path).unwrap();
        store
            .set_json("milim.sessions", r#"{"state":{"sessions":[]},"version":0}"#)
            .unwrap();
        assert_eq!(
            store.get_json("milim.sessions").unwrap().as_deref(),
            Some(r#"{"state":{"sessions":[]},"version":0}"#)
        );
        assert!(!db_path.with_extension("db-wal").exists());

        let _ = std::fs::remove_dir_all(root);
    }
}
