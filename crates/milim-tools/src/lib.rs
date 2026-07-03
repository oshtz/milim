//! `milim-tools` — the tool registry and built-in tools.
//!
//! A [`Tool`] is an async function with a JSON schema; the [`ToolRegistry`]
//! holds them and is exposed two ways:
//!   - to MCP/HTTP clients via the server's `/mcp/tools` + `/mcp/call`,
//!   - to the agent loop for autonomous tool use.

mod builtins;
mod fs;

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};

use milim_core::{Error, Result};

pub use builtins::{CurrentTimeTool, EchoTool, HttpFetchTool};
pub use fs::{fs_tools, ListDirTool, ReadFileTool, WriteFileTool};

/// A callable tool exposed to agents and MCP clients.
#[async_trait]
pub trait Tool: Send + Sync {
    /// Unique tool name (the call identifier).
    fn name(&self) -> &str;
    /// One-line description for the model.
    fn description(&self) -> &str;
    /// JSON Schema for the tool's arguments.
    fn input_schema(&self) -> Value;
    /// Execute with the given arguments.
    async fn invoke(&self, args: Value) -> Result<Value>;
}

/// A serializable description of a tool (for `/mcp/tools` and tool listings).
#[derive(Debug, Clone, Serialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// A name-indexed set of tools.
#[derive(Default, Clone)]
pub struct ToolRegistry {
    tools: BTreeMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// A registry pre-populated with the built-in tools.
    pub fn with_builtins() -> Self {
        let mut r = Self::new();
        r.register(Arc::new(EchoTool));
        r.register(Arc::new(CurrentTimeTool));
        r.register(Arc::new(HttpFetchTool));
        r
    }

    /// Add (or replace) a tool.
    pub fn register(&mut self, tool: Arc<dyn Tool>) -> &mut Self {
        self.tools.insert(tool.name().to_string(), tool);
        self
    }

    /// Register the sandboxed filesystem tools rooted at `root`.
    pub fn register_fs(&mut self, root: impl Into<PathBuf>) -> &mut Self {
        for tool in fs::fs_tools(root) {
            self.register(tool);
        }
        self
    }

    /// Number of registered tools.
    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// Whether a tool with `name` is registered.
    pub fn contains(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    /// Return a registry containing only the named tools. An empty allow-list
    /// preserves the current "all tools" behavior used by existing agents.
    pub fn filtered(&self, allowed: &[String]) -> Self {
        if allowed.is_empty() {
            return self.clone();
        }
        let allowed: HashSet<&str> = allowed.iter().map(String::as_str).collect();
        Self {
            tools: self
                .tools
                .iter()
                .filter(|(name, _)| allowed.contains(name.as_str()))
                .map(|(name, tool)| (name.clone(), tool.clone()))
                .collect(),
        }
    }

    /// Return a registry excluding the named tools.
    pub fn without(&self, denied: &[&str]) -> Self {
        if denied.is_empty() {
            return self.clone();
        }
        let denied: HashSet<&str> = denied.iter().copied().collect();
        Self {
            tools: self
                .tools
                .iter()
                .filter(|(name, _)| !denied.contains(name.as_str()))
                .map(|(name, tool)| (name.clone(), tool.clone()))
                .collect(),
        }
    }

    /// Specs for all tools, ordered by name.
    pub fn list(&self) -> Vec<ToolSpec> {
        self.tools
            .values()
            .map(|t| ToolSpec {
                name: t.name().to_string(),
                description: t.description().to_string(),
                input_schema: t.input_schema(),
            })
            .collect()
    }

    /// The same list shaped as OpenAI `tools` (`{type:function, function:{…}}`).
    pub fn as_openai_tools(&self) -> Vec<Value> {
        self.tools
            .values()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name(),
                        "description": t.description(),
                        "parameters": t.input_schema(),
                    }
                })
            })
            .collect()
    }

    /// Invoke a tool by name.
    pub async fn call(&self, name: &str, args: Value) -> Result<Value> {
        let tool = self
            .tools
            .get(name)
            .ok_or_else(|| Error::InvalidRequest(format!("unknown tool: {name}")))?
            .clone();
        tool.invoke(args).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn registry_lists_and_calls() {
        let reg = ToolRegistry::with_builtins();
        let names: Vec<String> = reg.list().into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["current_time", "echo", "http_fetch"]); // BTreeMap → sorted

        let out = reg.call("echo", json!({"text": "hi"})).await.unwrap();
        assert_eq!(out["echoed"]["text"], "hi");

        let t = reg.call("current_time", json!({})).await.unwrap();
        assert!(t["unix"].as_u64().unwrap() > 0);
    }

    #[tokio::test]
    async fn unknown_tool_errors() {
        let reg = ToolRegistry::with_builtins();
        assert!(reg.call("nope", json!({})).await.is_err());
    }

    #[test]
    fn openai_tool_shape() {
        let reg = ToolRegistry::with_builtins();
        let tools = reg.as_openai_tools();
        assert_eq!(tools[0]["type"], "function");
        assert!(tools[0]["function"]["name"].is_string());
    }

    #[test]
    fn registry_can_exclude_tools() {
        let reg = ToolRegistry::with_builtins();
        assert!(reg.contains("echo"));

        let filtered = reg.without(&["echo"]);
        let names: Vec<String> = filtered.list().into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["current_time", "http_fetch"]);
        assert!(!filtered.contains("echo"));
    }
}
