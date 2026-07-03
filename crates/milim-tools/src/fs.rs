//! Sandboxed filesystem tools (milim's "folder" tools).
//!
//! Each tool is rooted at a working directory and rejects any path that would
//! escape it (absolute paths or `..` components), so an agent can read/list/write
//! within a workspace without touching the rest of the machine.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use milim_core::{Error, Result};

use crate::Tool;

/// Max bytes returned by `read_file`.
const MAX_READ: u64 = 1024 * 1024;

/// Resolve `rel` under `root`, rejecting absolute paths and `..` traversal.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = Path::new(rel);
    let mut out = root.to_path_buf();
    for comp in rel.components() {
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

/// Build the sandboxed filesystem tools rooted at `root`.
pub fn fs_tools(root: impl Into<PathBuf>) -> Vec<Arc<dyn Tool>> {
    let root = Arc::new(root.into());
    vec![
        Arc::new(ReadFileTool { root: root.clone() }),
        Arc::new(ListDirTool { root: root.clone() }),
        Arc::new(WriteFileTool { root }),
    ]
}

/// Read a UTF-8 file within the workspace.
pub struct ReadFileTool {
    root: Arc<PathBuf>,
}

#[async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }
    fn description(&self) -> &str {
        "Read a UTF-8 text file from the workspace."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]})
    }
    async fn invoke(&self, args: Value) -> Result<Value> {
        let path = safe_join(&self.root, arg_str(&args, "path")?)?;
        let meta = std::fs::metadata(&path)?;
        if meta.len() > MAX_READ {
            return Err(Error::InvalidRequest(format!(
                "file too large ({} bytes, max {MAX_READ})",
                meta.len()
            )));
        }
        let content = std::fs::read_to_string(&path)?;
        Ok(json!({ "content": content }))
    }
}

/// List directory entries within the workspace.
pub struct ListDirTool {
    root: Arc<PathBuf>,
}

#[async_trait]
impl Tool for ListDirTool {
    fn name(&self) -> &str {
        "list_dir"
    }
    fn description(&self) -> &str {
        "List entries of a directory in the workspace (path defaults to root)."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"path":{"type":"string"}}})
    }
    async fn invoke(&self, args: Value) -> Result<Value> {
        let rel = args.get("path").and_then(Value::as_str).unwrap_or("");
        let dir = safe_join(&self.root, rel)?;
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

/// Write a UTF-8 file within the workspace (creating parent dirs).
pub struct WriteFileTool {
    root: Arc<PathBuf>,
}

#[async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }
    fn description(&self) -> &str {
        "Write a UTF-8 text file into the workspace (overwrites)."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]})
    }
    async fn invoke(&self, args: Value) -> Result<Value> {
        let path = safe_join(&self.root, arg_str(&args, "path")?)?;
        let content = arg_str(&args, "content")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, content)?;
        Ok(json!({ "written": content.len() }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        // Unique per call (process id + atomic counter) so concurrently-running
        // tests don't share a dir and wipe each other's files.
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "milim-fs-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn write_read_list_round_trip() {
        let root = tmp();
        let tools = fs_tools(root.clone());
        let by = |n: &str| tools.iter().find(|t| t.name() == n).unwrap().clone();

        by("write_file")
            .invoke(json!({"path":"notes/a.txt","content":"hello"}))
            .await
            .unwrap();
        let read = by("read_file")
            .invoke(json!({"path":"notes/a.txt"}))
            .await
            .unwrap();
        assert_eq!(read["content"], "hello");

        let list = by("list_dir")
            .invoke(json!({"path":"notes"}))
            .await
            .unwrap();
        let names: Vec<&str> = list["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["name"].as_str())
            .collect();
        assert!(names.contains(&"a.txt"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn rejects_path_traversal() {
        let root = tmp();
        let tools = fs_tools(root.clone());
        let read = tools.iter().find(|t| t.name() == "read_file").unwrap();
        assert!(read.invoke(json!({"path":"../secret"})).await.is_err());
        assert!(read.invoke(json!({"path":"/etc/passwd"})).await.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
