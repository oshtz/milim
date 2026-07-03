//! Host filesystem + shell tools, rooted to the GUI's selected working folder.
//!
//! Unlike `milim-tools`'s fixed-root fs tools (and the Docker-sandboxed
//! `run_command`), these operate on the **real** machine inside the folder the
//! user picks via the desktop "Folder" chip - the workspace cell shared with
//! `milim_server::AppState::workspace`. They refuse to run until a folder is set.
//! Wiring these to the agent loop is what turns milim into a coding agent.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use serde_json::{json, Value};

use milim_core::{Error, Result};
use milim_tools::Tool;

/// A cell holding the active working folder (shared with the server state).
pub type Workspace = Arc<RwLock<Option<PathBuf>>>;

/// Max bytes returned by `read_file`.
const MAX_READ: u64 = 1024 * 1024;

/// The current workspace root, or an error if the user hasn't picked a folder.
fn root_of(ws: &Workspace) -> Result<PathBuf> {
    ws.read().ok().and_then(|g| g.clone()).ok_or_else(|| {
        Error::InvalidRequest(
            "no working folder selected - pick one with the Folder chip first".into(),
        )
    })
}

/// Resolve `rel` under the workspace root, rejecting `..` and absolute paths.
fn safe_join(ws: &Workspace, rel: &str) -> Result<PathBuf> {
    let mut out = root_of(ws)?;
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(Error::InvalidRequest("'..' is not allowed in paths".into()))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(Error::InvalidRequest(
                    "absolute paths are not allowed".into(),
                ))
            }
        }
    }
    Ok(out)
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::InvalidRequest(format!("missing string argument: {key}")))
}

/// All host tools bound to the shared workspace cell.
pub fn host_tools(ws: Workspace) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(ReadFileTool { ws: ws.clone() }),
        Arc::new(ReadFileAnchorsTool { ws: ws.clone() }),
        Arc::new(ListDirTool { ws: ws.clone() }),
        Arc::new(WriteFileTool { ws: ws.clone() }),
        Arc::new(EditFileTool { ws: ws.clone() }),
        Arc::new(PatchFileTool { ws: ws.clone() }),
        Arc::new(ShellTool { ws }),
    ]
}

/// Read a UTF-8 file from the working folder.
pub struct ReadFileTool {
    ws: Workspace,
}
#[async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }
    fn description(&self) -> &str {
        "Read a UTF-8 text file from the working folder (path is relative to it)."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]})
    }
    async fn invoke(&self, args: Value) -> Result<Value> {
        let path = safe_join(&self.ws, arg_str(&args, "path")?)?;
        let meta = std::fs::metadata(&path)?;
        if meta.len() > MAX_READ {
            return Err(Error::InvalidRequest(format!(
                "file too large ({} bytes, max {MAX_READ})",
                meta.len()
            )));
        }
        Ok(json!({ "content": std::fs::read_to_string(&path)? }))
    }
}

fn line_hash(line: &str) -> u32 {
    line.as_bytes().iter().fold(0x811c9dc5, |hash, byte| {
        (hash ^ u32::from(*byte)).wrapping_mul(0x01000193)
    })
}

fn line_anchor(line_no: usize, line: &str) -> String {
    format!("{line_no}#{:08x}", line_hash(line))
}

fn newline_separator(content: &str) -> &str {
    if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn anchored_content(content: &str) -> String {
    let sep = newline_separator(content);
    let mut out = content
        .lines()
        .enumerate()
        .map(|(i, line)| format!("{}:{line}", line_anchor(i + 1, line)))
        .collect::<Vec<_>>()
        .join(sep);
    if content.ends_with('\n') && !out.is_empty() {
        out.push_str(sep);
    }
    out
}

fn parse_anchor(anchor: &str) -> Result<(usize, u32)> {
    let (line, hash) = anchor
        .split_once('#')
        .ok_or_else(|| Error::InvalidRequest(format!("invalid anchor: {anchor}")))?;
    let line = line
        .parse::<usize>()
        .map_err(|_| Error::InvalidRequest(format!("invalid anchor line: {anchor}")))?;
    if line == 0 {
        return Err(Error::InvalidRequest(format!(
            "invalid anchor line: {anchor}"
        )));
    }
    let hash = u32::from_str_radix(hash, 16)
        .map_err(|_| Error::InvalidRequest(format!("invalid anchor hash: {anchor}")))?;
    Ok((line, hash))
}

fn nearby_anchors(lines: &[String], index: usize) -> String {
    let start = index.saturating_sub(2);
    let end = lines.len().min(index + 3);
    lines[start..end]
        .iter()
        .enumerate()
        .map(|(offset, line)| {
            let line_no = start + offset + 1;
            format!("{}:{line}", line_anchor(line_no, line))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn validate_anchor(lines: &[String], anchor: &str) -> Result<usize> {
    let (line_no, hash) = parse_anchor(anchor)?;
    let index = line_no - 1;
    let Some(line) = lines.get(index) else {
        return Err(Error::InvalidRequest(format!(
            "anchor out of range: {anchor}; nearby anchors:\n{}",
            nearby_anchors(lines, lines.len().saturating_sub(1))
        )));
    };
    if line_hash(line) != hash {
        return Err(Error::InvalidRequest(format!(
            "stale anchor: {anchor}; nearby anchors:\n{}",
            nearby_anchors(lines, index)
        )));
    }
    Ok(index)
}

fn patch_lines(content: &str) -> Vec<String> {
    content.lines().map(ToString::to_string).collect()
}

struct ResolvedPatch {
    start: usize,
    end: usize,
    lines: Vec<String>,
}

fn required_obj<'a>(value: &'a Value, name: &str) -> Result<&'a serde_json::Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| Error::InvalidRequest(format!("{name} must be an object")))
}

fn optional_str<'a>(obj: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str)
}

fn required_str<'a>(obj: &'a serde_json::Map<String, Value>, key: &str) -> Result<&'a str> {
    optional_str(obj, key)
        .ok_or_else(|| Error::InvalidRequest(format!("missing string argument: {key}")))
}

fn resolve_patch_op(lines: &[String], op: &Value) -> Result<ResolvedPatch> {
    let obj = required_obj(op, "patch op")?;
    match required_str(obj, "op")? {
        "replace_range" => {
            let start = validate_anchor(lines, required_str(obj, "start")?)?;
            let end = validate_anchor(lines, required_str(obj, "end")?)? + 1;
            if start >= end {
                return Err(Error::InvalidRequest(
                    "replace_range start must be before end".into(),
                ));
            }
            Ok(ResolvedPatch {
                start,
                end,
                lines: patch_lines(required_str(obj, "content")?),
            })
        }
        "delete_range" => {
            let start = validate_anchor(lines, required_str(obj, "start")?)?;
            let end = validate_anchor(lines, required_str(obj, "end")?)? + 1;
            if start >= end {
                return Err(Error::InvalidRequest(
                    "delete_range start must be before end".into(),
                ));
            }
            Ok(ResolvedPatch {
                start,
                end,
                lines: Vec::new(),
            })
        }
        "insert_before" => {
            let start = validate_anchor(lines, required_str(obj, "anchor")?)?;
            Ok(ResolvedPatch {
                start,
                end: start,
                lines: patch_lines(required_str(obj, "content")?),
            })
        }
        "insert_after" => {
            let start = validate_anchor(lines, required_str(obj, "anchor")?)? + 1;
            Ok(ResolvedPatch {
                start,
                end: start,
                lines: patch_lines(required_str(obj, "content")?),
            })
        }
        other => Err(Error::InvalidRequest(format!("unknown patch op: {other}"))),
    }
}

/// Read a UTF-8 file with line-numbered content-hash anchors.
pub struct ReadFileAnchorsTool {
    ws: Workspace,
}
#[async_trait]
impl Tool for ReadFileAnchorsTool {
    fn name(&self) -> &str {
        "read_file_anchors"
    }
    fn description(&self) -> &str {
        "Read a UTF-8 text file with line-numbered hash anchors for patch_file."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]})
    }
    async fn invoke(&self, args: Value) -> Result<Value> {
        let path = safe_join(&self.ws, arg_str(&args, "path")?)?;
        let meta = std::fs::metadata(&path)?;
        if meta.len() > MAX_READ {
            return Err(Error::InvalidRequest(format!(
                "file too large ({} bytes, max {MAX_READ})",
                meta.len()
            )));
        }
        let content = std::fs::read_to_string(&path)?;
        Ok(json!({ "content": anchored_content(&content) }))
    }
}

/// List directory entries within the working folder.
pub struct ListDirTool {
    ws: Workspace,
}
#[async_trait]
impl Tool for ListDirTool {
    fn name(&self) -> &str {
        "list_dir"
    }
    fn description(&self) -> &str {
        "List entries of a directory in the working folder (path defaults to the root)."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"path":{"type":"string"}}})
    }
    async fn invoke(&self, args: Value) -> Result<Value> {
        let rel = args.get("path").and_then(Value::as_str).unwrap_or("");
        let dir = safe_join(&self.ws, rel)?;
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            entries.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "is_dir": entry.file_type().map(|t| t.is_dir()).unwrap_or(false),
            }));
        }
        Ok(json!({ "entries": entries }))
    }
}

/// Create or overwrite a UTF-8 file in the working folder.
pub struct WriteFileTool {
    ws: Workspace,
}
#[async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }
    fn description(&self) -> &str {
        "Create or overwrite a UTF-8 text file in the working folder."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]})
    }
    async fn invoke(&self, args: Value) -> Result<Value> {
        let path = safe_join(&self.ws, arg_str(&args, "path")?)?;
        let content = arg_str(&args, "content")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, content)?;
        Ok(json!({ "written": content.len() }))
    }
}

/// Exact-string replacement in a file (a surgical code edit). The `old` text
/// must occur exactly once, mirroring an editor's find/replace.
pub struct EditFileTool {
    ws: Workspace,
}
#[async_trait]
impl Tool for EditFileTool {
    fn name(&self) -> &str {
        "edit_file"
    }
    fn description(&self) -> &str {
        "Replace an exact text snippet in a file in the working folder. 'old' must appear exactly once."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{
            "path":{"type":"string"},
            "old":{"type":"string","description":"exact text to replace (must be unique in the file)"},
            "new":{"type":"string","description":"replacement text"}
        },"required":["path","old","new"]})
    }
    async fn invoke(&self, args: Value) -> Result<Value> {
        let path = safe_join(&self.ws, arg_str(&args, "path")?)?;
        let old = arg_str(&args, "old")?;
        let new = arg_str(&args, "new")?;
        let content = std::fs::read_to_string(&path)?;
        let count = content.matches(old).count();
        if count == 0 {
            return Err(Error::InvalidRequest("'old' text not found in file".into()));
        }
        if count > 1 {
            return Err(Error::InvalidRequest(format!(
                "'old' text is not unique ({count} matches) - include more surrounding context"
            )));
        }
        let updated = content.replacen(old, new, 1);
        std::fs::write(&path, &updated)?;
        Ok(json!({ "replaced": 1, "bytes": updated.len() }))
    }
}

/// Apply line-anchored edits produced from `read_file_anchors`.
pub struct PatchFileTool {
    ws: Workspace,
}
#[async_trait]
impl Tool for PatchFileTool {
    fn name(&self) -> &str {
        "patch_file"
    }
    fn description(&self) -> &str {
        "Patch a UTF-8 text file using LINE#HASH anchors from read_file_anchors."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{
            "path":{"type":"string"},
            "ops":{"type":"array","items":{"type":"object","properties":{
                "op":{"type":"string","enum":["replace_range","insert_before","insert_after","delete_range"]},
                "anchor":{"type":"string","description":"LINE#HASH anchor for insert ops"},
                "start":{"type":"string","description":"LINE#HASH anchor for range start"},
                "end":{"type":"string","description":"LINE#HASH anchor for range end"},
                "content":{"type":"string","description":"replacement or inserted text"}
            },"required":["op"]}}
        },"required":["path","ops"]})
    }
    async fn invoke(&self, args: Value) -> Result<Value> {
        let path = safe_join(&self.ws, arg_str(&args, "path")?)?;
        let ops = args
            .get("ops")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::InvalidRequest("missing array argument: ops".into()))?;
        if ops.is_empty() {
            return Err(Error::InvalidRequest("ops must not be empty".into()));
        }

        let content = std::fs::read_to_string(&path)?;
        let sep = newline_separator(&content);
        let keep_trailing_newline = content.ends_with('\n');
        let mut lines = content.lines().map(ToString::to_string).collect::<Vec<_>>();
        let mut patches = ops
            .iter()
            .map(|op| resolve_patch_op(&lines, op))
            .collect::<Result<Vec<_>>>()?;
        patches.sort_by(|a, b| b.start.cmp(&a.start).then_with(|| b.end.cmp(&a.end)));

        let mut next_lower_start = usize::MAX;
        for patch in &patches {
            if patch.end > next_lower_start {
                return Err(Error::InvalidRequest(
                    "patch ranges must not overlap".into(),
                ));
            }
            next_lower_start = patch.start;
        }

        let added: usize = patches.iter().map(|patch| patch.lines.len()).sum();
        let removed: usize = patches.iter().map(|patch| patch.end - patch.start).sum();
        for patch in patches {
            lines.splice(patch.start..patch.end, patch.lines);
        }

        // ponytail: preserve the existing newline style; byte-exact hunk control can wait.
        let mut updated = lines.join(sep);
        if keep_trailing_newline && !updated.is_empty() {
            updated.push_str(sep);
        }
        std::fs::write(&path, &updated)?;
        Ok(
            json!({ "patched": ops.len(), "added": added, "removed": removed, "bytes": updated.len() }),
        )
    }
}

/// Run a command in the host terminal, in the working folder. PowerShell on
/// Windows, `sh -c` elsewhere. Executes on the real machine - the agentic
/// counterpart to the Docker-sandboxed `run_command`.
pub struct ShellTool {
    ws: Workspace,
}
#[async_trait]
impl Tool for ShellTool {
    fn name(&self) -> &str {
        "shell"
    }
    fn description(&self) -> &str {
        if cfg!(windows) {
            "Run a PowerShell command on the host, in the working folder. Returns stdout/stderr/exit_code."
        } else {
            "Run a shell command (sh -c) on the host, in the working folder. Returns stdout/stderr/exit_code."
        }
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"command":{"type":"string"}},"required":["command"]})
    }
    async fn invoke(&self, args: Value) -> Result<Value> {
        let cwd = root_of(&self.ws)?;
        let command = arg_str(&args, "command")?.to_string();
        tokio::task::spawn_blocking(move || run_shell(&cwd, &command))
            .await
            .map_err(|e| Error::Other(format!("shell task failed: {e}")))?
    }
}

fn run_shell(cwd: &Path, command: &str) -> Result<Value> {
    use std::process::Command;
    let output = if cfg!(windows) {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", command])
            .current_dir(cwd);
        milim_core::proc::hide_console(&mut cmd).output()?
    } else {
        Command::new("sh")
            .args(["-c", command])
            .current_dir(cwd)
            .output()?
    };
    Ok(json!({
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr),
        "exit_code": output.status.code(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;

    fn block_on<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn temp_workspace() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "milim-host-tools-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn tool(tools: &[Arc<dyn Tool>], name: &str) -> Arc<dyn Tool> {
        tools
            .iter()
            .find(|tool| tool.name() == name)
            .unwrap_or_else(|| panic!("missing tool: {name}"))
            .clone()
    }

    #[test]
    fn read_file_anchors_and_patch_file_round_trip() {
        let root = temp_workspace();
        let path = root.join("notes.txt");
        std::fs::write(&path, "one\ntwo\nthree\n").unwrap();
        let ws = Arc::new(RwLock::new(Some(root.clone())));
        let tools = host_tools(ws);

        let anchored =
            block_on(tool(&tools, "read_file_anchors").invoke(json!({"path":"notes.txt"})))
                .unwrap();
        let anchored = anchored["content"].as_str().unwrap();
        assert!(anchored.contains(&format!("{}:one", line_anchor(1, "one"))));
        assert!(anchored.contains(&format!("{}:two", line_anchor(2, "two"))));

        block_on(tool(&tools, "patch_file").invoke(json!({
            "path": "notes.txt",
            "ops": [
                {"op":"insert_after","anchor":line_anchor(1, "one"),"content":"one point five"},
                {"op":"replace_range","start":line_anchor(2, "two"),"end":line_anchor(2, "two"),"content":"TWO"},
                {"op":"delete_range","start":line_anchor(3, "three"),"end":line_anchor(3, "three")}
            ]
        })))
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "one\none point five\nTWO\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn patch_file_rejects_stale_anchor() {
        let root = temp_workspace();
        std::fs::write(root.join("notes.txt"), "one\ntwo\n").unwrap();
        let ws = Arc::new(RwLock::new(Some(root.clone())));
        let tools = host_tools(ws);

        let err = block_on(tool(&tools, "patch_file").invoke(json!({
            "path": "notes.txt",
            "ops": [
                {"op":"replace_range","start":"2#00000000","end":"2#00000000","content":"TWO"}
            ]
        })))
        .unwrap_err()
        .to_string();

        assert!(err.contains("stale anchor"), "unexpected error: {err}");
        let _ = std::fs::remove_dir_all(root);
    }
}
