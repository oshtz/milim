//! `milim-mcp-client` — a Model Context Protocol **client**.
//!
//! milim already speaks MCP as a *server* (exposing its own tools). This
//! crate is the other direction: it spawns external MCP servers (filesystem,
//! GitHub, Brave-search, …) over stdio, lists their tools, and wraps each one
//! as an [`milim_tools::Tool`] so the agent loop can call them like any builtin.
//!
//! Transport: newline-delimited JSON-RPC 2.0 over the child's stdin/stdout
//! (the MCP stdio transport). A background reader task demuxes responses by id.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use milim_core::{Error, Result};
use milim_tools::Tool;

const PROTOCOL_VERSION: &str = "2025-06-18";

/// How long to wait for a single JSON-RPC response.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A configured external MCP server (persisted to `mcp.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// Executable to spawn (e.g. `npx`, `uvx`, an absolute path).
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Public, serializable view of a server's state for the UI.
#[derive(Debug, Clone, Serialize)]
pub struct McpServerInfo {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub enabled: bool,
    pub connected: bool,
    pub tool_count: usize,
    pub capabilities: McpCapabilities,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct McpCapabilities {
    pub tools: bool,
    pub resources: bool,
    pub prompts: bool,
}

fn capabilities_from_initialize(result: &Value) -> McpCapabilities {
    let caps = &result["capabilities"];
    McpCapabilities {
        tools: caps.get("tools").is_some(),
        resources: caps.get("resources").is_some(),
        prompts: caps.get("prompts").is_some(),
    }
}

// ----- Client -----

/// A live stdio connection to one MCP server.
pub struct McpClient {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_id: AtomicI64,
    capabilities: McpCapabilities,
    // Held so the child stays alive; `kill_on_drop` cleans it up with the client.
    _child: Mutex<Child>,
}

impl McpClient {
    /// Spawn `command args…` and complete the MCP `initialize` handshake.
    pub async fn connect(command: &str, args: &[String]) -> Result<Arc<McpClient>> {
        // On Windows, route through `cmd /C` so PATHEXT shims (npx.cmd, uvx.cmd)
        // resolve; elsewhere spawn the executable directly.
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(command);
            c
        } else {
            Command::new(command)
        };
        cmd.args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        // Don't flash a console window when spawning the server on Windows.
        #[cfg(windows)]
        cmd.creation_flags(milim_core::proc::CREATE_NO_WINDOW);

        let mut child = cmd
            .spawn()
            .map_err(|e| Error::Other(format!("failed to spawn MCP server '{command}': {e}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::Other("MCP child has no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Other("MCP child has no stdout".into()))?;

        let stdin = Arc::new(Mutex::new(stdin));
        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Reader task: demux responses to their waiting callers by id.
        let pending_r = pending.clone();
        let stdin_r = stdin.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = msg.get("id").and_then(Value::as_i64) {
                    if let Some(tx) = pending_r.lock().await.remove(&id) {
                        let _ = tx.send(msg);
                    } else if msg.get("method").is_some() {
                        let response = server_request_response(&msg);
                        let _ = write_json(&stdin_r, &response).await;
                    }
                }
                // Server-initiated notifications don't need responses.
            }
            let err = json!({ "error": { "message": "MCP connection closed" } });
            for tx in pending_r.lock().await.drain().map(|(_, tx)| tx) {
                let _ = tx.send(err.clone());
            }
        });

        let next_id = AtomicI64::new(1);
        let init = client_request(
            &stdin,
            &pending,
            &next_id,
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "milim", "version": env!("CARGO_PKG_VERSION") }
            }),
        )
        .await?;
        let capabilities = capabilities_from_initialize(&init);

        let client = Arc::new(McpClient {
            stdin,
            pending,
            next_id,
            capabilities,
            _child: Mutex::new(child),
        });
        client
            .notify("notifications/initialized", json!({}))
            .await?;

        Ok(client)
    }

    pub fn capabilities(&self) -> McpCapabilities {
        self.capabilities.clone()
    }

    /// Send a JSON-RPC request and await its response (or time out).
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        client_request(&self.stdin, &self.pending, &self.next_id, method, params).await
    }

    /// Send a JSON-RPC notification (no response expected).
    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let line = format!(
            "{}\n",
            serde_json::to_string(&json!({
                "jsonrpc": "2.0", "method": method, "params": params
            }))?
        );
        write_line(&self.stdin, &line).await
    }

    /// `tools/list` — enumerate the server's tools.
    pub async fn list_tools(&self) -> Result<Vec<McpToolDef>> {
        if !self.capabilities.tools {
            return Ok(Vec::new());
        }
        let tools = self.list_paged("tools/list", "tools").await?;
        Ok(tools
            .into_iter()
            .filter_map(|t| {
                let name = t.get("name").and_then(Value::as_str)?.to_string();
                Some(McpToolDef {
                    name,
                    description: t
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    input_schema: t
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({"type": "object"})),
                })
            })
            .collect())
    }

    /// `tools/call` — invoke a tool by its server-side name.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value> {
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }

    pub async fn list_resources(&self) -> Result<Vec<Value>> {
        if !self.capabilities.resources {
            return Ok(Vec::new());
        }
        self.list_paged("resources/list", "resources").await
    }

    pub async fn list_resource_templates(&self) -> Result<Vec<Value>> {
        if !self.capabilities.resources {
            return Ok(Vec::new());
        }
        self.list_paged("resources/templates/list", "resourceTemplates")
            .await
    }

    pub async fn read_resource(&self, uri: &str) -> Result<Value> {
        self.request("resources/read", json!({ "uri": uri })).await
    }

    pub async fn list_prompts(&self) -> Result<Vec<Value>> {
        if !self.capabilities.prompts {
            return Ok(Vec::new());
        }
        self.list_paged("prompts/list", "prompts").await
    }

    pub async fn get_prompt(&self, name: &str, arguments: Value) -> Result<Value> {
        self.request(
            "prompts/get",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }

    async fn list_paged(&self, method: &str, key: &str) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = cursor
                .as_ref()
                .map(|c| json!({ "cursor": c }))
                .unwrap_or_else(|| json!({}));
            let result = self.request(method, params).await?;
            out.extend(
                result
                    .get(key)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            );
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                return Ok(out);
            }
        }
    }
}

async fn client_request(
    stdin: &Arc<Mutex<ChildStdin>>,
    pending: &Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_id: &AtomicI64,
    method: &str,
    params: Value,
) -> Result<Value> {
    let id = next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    pending.lock().await.insert(id, tx);

    let line = format!(
        "{}\n",
        serde_json::to_string(&json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        }))?
    );
    write_line(stdin, &line).await?;

    let resp = tokio::time::timeout(REQUEST_TIMEOUT, rx)
        .await
        .map_err(|_| Error::Other(format!("MCP '{method}' timed out")))?
        .map_err(|_| Error::Other("MCP connection closed".into()))?;

    if let Some(err) = resp.get("error") {
        return Err(Error::Other(format!("MCP '{method}' error: {err}")));
    }
    Ok(resp.get("result").cloned().unwrap_or(Value::Null))
}

async fn write_json(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<()> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');
    write_line(stdin, &line).await
}

async fn write_line(stdin: &Arc<Mutex<ChildStdin>>, line: &str) -> Result<()> {
    let mut w = stdin.lock().await;
    w.write_all(line.as_bytes())
        .await
        .map_err(|e| Error::Other(format!("MCP write failed: {e}")))?;
    w.flush()
        .await
        .map_err(|e| Error::Other(format!("MCP flush failed: {e}")))?;
    Ok(())
}

fn server_request_response(req: &Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    match req.get("method").and_then(Value::as_str) {
        Some("ping") => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "method not found" }
        }),
    }
}

/// A tool definition as reported by an MCP server.
#[derive(Debug, Clone)]
pub struct McpToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// An [`milim_tools::Tool`] that proxies to a remote MCP tool. Exposed under a
/// prefixed name (`<server>__<tool>`) to avoid colliding with builtins; calls
/// use the original server-side name.
pub struct McpTool {
    client: Arc<McpClient>,
    exposed_name: String,
    remote_name: String,
    description: String,
    schema: Value,
}

#[async_trait]
impl Tool for McpTool {
    fn name(&self) -> &str {
        &self.exposed_name
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn input_schema(&self) -> Value {
        self.schema.clone()
    }
    async fn invoke(&self, args: Value) -> Result<Value> {
        let result = self.client.call_tool(&self.remote_name, args).await?;
        Ok(lift_mcp_image(result))
    }
}

struct McpListResourcesTool {
    client: Arc<McpClient>,
    name: String,
}

#[async_trait]
impl Tool for McpListResourcesTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "List resources and resource templates exposed by this MCP server."
    }

    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{},"additionalProperties":false})
    }

    async fn invoke(&self, _args: Value) -> Result<Value> {
        let resources = self.client.list_resources().await.unwrap_or_default();
        let resource_templates = self
            .client
            .list_resource_templates()
            .await
            .unwrap_or_default();
        Ok(json!({ "resources": resources, "resourceTemplates": resource_templates }))
    }
}

struct McpReadResourceTool {
    client: Arc<McpClient>,
    name: String,
}

#[async_trait]
impl Tool for McpReadResourceTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "Read a resource from this MCP server by URI."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type":"object",
            "properties":{"uri":{"type":"string","description":"Resource URI to read."}},
            "required":["uri"],
            "additionalProperties":false
        })
    }

    async fn invoke(&self, args: Value) -> Result<Value> {
        let uri = args
            .get("uri")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::InvalidRequest("uri is required".into()))?;
        self.client.read_resource(uri).await
    }
}

struct McpListPromptsTool {
    client: Arc<McpClient>,
    name: String,
}

#[async_trait]
impl Tool for McpListPromptsTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "List prompts exposed by this MCP server."
    }

    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{},"additionalProperties":false})
    }

    async fn invoke(&self, _args: Value) -> Result<Value> {
        Ok(json!({ "prompts": self.client.list_prompts().await? }))
    }
}

struct McpGetPromptTool {
    client: Arc<McpClient>,
    name: String,
}

#[async_trait]
impl Tool for McpGetPromptTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "Get a prompt from this MCP server by name."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type":"object",
            "properties":{
                "name":{"type":"string","description":"Prompt name."},
                "arguments":{"type":"object","description":"Prompt arguments.","additionalProperties":true}
            },
            "required":["name"],
            "additionalProperties":false
        })
    }

    async fn invoke(&self, args: Value) -> Result<Value> {
        let name = args
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::InvalidRequest("name is required".into()))?;
        let arguments = args.get("arguments").cloned().unwrap_or_else(|| json!({}));
        self.client.get_prompt(name, arguments).await
    }
}

/// If an MCP tool result carries an image content block
/// (`{type:"image", data, mimeType}`), surface it as a top-level `image` field
/// so the agent loop forwards it to vision models (same path as `screenshot`).
fn lift_mcp_image(mut result: Value) -> Value {
    let img = result
        .get("content")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find_map(|it| {
                if it.get("type").and_then(Value::as_str) == Some("image") {
                    let data = it.get("data").and_then(Value::as_str)?;
                    let mime = it
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .unwrap_or("image/png");
                    Some(json!({ "mime": mime, "data": data }))
                } else {
                    None
                }
            })
        });
    if let (Some(img), Some(obj)) = (img, result.as_object_mut()) {
        obj.insert("image".to_string(), img);
    }
    result
}

/// Lowercase a server name to a safe tool-name prefix (`[a-z0-9_]`).
fn prefix_for(cfg: &McpServerConfig) -> String {
    let base = if cfg.name.trim().is_empty() {
        &cfg.id
    } else {
        &cfg.name
    };
    let p: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    p.trim_matches('_').to_string()
}

fn exposed_name(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}__{name}")
    }
}

// ----- Hub -----

struct HubState {
    configs: Vec<McpServerConfig>,
    clients: HashMap<String, Arc<McpClient>>,
    tools: HashMap<String, Vec<Arc<dyn Tool>>>,
    errors: HashMap<String, String>,
}

/// Manages the set of configured MCP servers, their live connections, and the
/// merged set of proxy tools. Persists configs to `<dir>/mcp.json`.
pub struct McpHub {
    path: PathBuf,
    inner: RwLock<HubState>,
}

impl McpHub {
    /// Open the hub, loading any persisted server configs (does not connect).
    pub fn open(dir: impl AsRef<Path>) -> Self {
        let path = dir.as_ref().join("mcp.json");
        let configs = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| {
                serde_json::from_value::<Vec<McpServerConfig>>(v.get("servers")?.clone()).ok()
            })
            .unwrap_or_default();
        Self {
            path,
            inner: RwLock::new(HubState {
                configs,
                clients: HashMap::new(),
                tools: HashMap::new(),
                errors: HashMap::new(),
            }),
        }
    }

    /// Connect every enabled configured server, populating tools. Per-server
    /// failures are recorded (not fatal) so one bad server can't block startup.
    pub async fn connect_all(&self) {
        let configs: Vec<McpServerConfig> = {
            let st = self.inner.read().expect("mcp hub poisoned");
            st.configs.iter().filter(|c| c.enabled).cloned().collect()
        };
        for cfg in configs {
            self.connect_into_state(&cfg).await;
        }
    }

    /// Connect one config and store the client+tools (or its error) in state.
    async fn connect_into_state(&self, cfg: &McpServerConfig) {
        match connect_one(cfg).await {
            Ok((client, tools)) => {
                let mut st = self.inner.write().expect("mcp hub poisoned");
                st.clients.insert(cfg.id.clone(), client);
                st.tools.insert(cfg.id.clone(), tools);
                st.errors.remove(&cfg.id);
            }
            Err(e) => {
                tracing::warn!("MCP server '{}' failed to connect: {e}", cfg.name);
                let mut st = self.inner.write().expect("mcp hub poisoned");
                st.clients.remove(&cfg.id);
                st.tools.remove(&cfg.id);
                st.errors.insert(cfg.id.clone(), e.to_string());
            }
        }
    }

    /// Add or update a server (by id), reconnecting it, then persist.
    pub async fn upsert(&self, mut cfg: McpServerConfig) -> Result<McpServerConfig> {
        if cfg.id.trim().is_empty() {
            cfg.id = format!("mcp-{}", uuid::Uuid::new_v4().simple());
        }
        let mut configs = {
            let st = self.inner.read().expect("mcp hub poisoned");
            st.configs
                .iter()
                .filter(|c| c.id != cfg.id)
                .cloned()
                .collect::<Vec<_>>()
        };
        configs.push(cfg.clone());
        self.save_configs(&configs)?;

        // Drop any prior connection/tools for this id first.
        {
            let mut st = self.inner.write().expect("mcp hub poisoned");
            st.configs = configs;
            st.clients.remove(&cfg.id);
            st.tools.remove(&cfg.id);
            st.errors.remove(&cfg.id);
        }
        if cfg.enabled {
            self.connect_into_state(&cfg).await;
        }
        Ok(cfg)
    }

    /// Remove a server (dropping its connection, which kills the child).
    pub fn remove(&self, id: &str) -> Result<bool> {
        let (had, configs) = {
            let st = self.inner.read().expect("mcp hub poisoned");
            let had = st.configs.iter().any(|c| c.id == id);
            if !had {
                return Ok(false);
            }
            let configs = st
                .configs
                .iter()
                .filter(|c| c.id != id)
                .cloned()
                .collect::<Vec<_>>();
            (had, configs)
        };
        self.save_configs(&configs)?;
        let had = {
            let mut st = self.inner.write().expect("mcp hub poisoned");
            st.configs = configs;
            st.clients.remove(id);
            st.tools.remove(id);
            st.errors.remove(id);
            had
        };
        Ok(had)
    }

    /// All currently-available proxy tools across connected servers.
    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.inner
            .read()
            .expect("mcp hub poisoned")
            .tools
            .values()
            .flatten()
            .cloned()
            .collect()
    }

    /// UI view of every configured server.
    pub fn list(&self) -> Vec<McpServerInfo> {
        let st = self.inner.read().expect("mcp hub poisoned");
        st.configs
            .iter()
            .map(|c| {
                let client = st.clients.get(&c.id);
                McpServerInfo {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    command: c.command.clone(),
                    args: c.args.clone(),
                    enabled: c.enabled,
                    connected: client.is_some(),
                    tool_count: st.tools.get(&c.id).map(Vec::len).unwrap_or(0),
                    capabilities: client.map(|c| c.capabilities()).unwrap_or_default(),
                    error: st.errors.get(&c.id).cloned(),
                }
            })
            .collect()
    }

    fn save_configs(&self, configs: &[McpServerConfig]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_vec_pretty(&json!({ "servers": configs }))?;
        std::fs::write(&self.path, data)?;
        Ok(())
    }
}

/// Connect a config and build its prefixed proxy tools.
async fn connect_one(cfg: &McpServerConfig) -> Result<(Arc<McpClient>, Vec<Arc<dyn Tool>>)> {
    let client = McpClient::connect(&cfg.command, &cfg.args).await?;
    let defs = client.list_tools().await?;
    let prefix = prefix_for(cfg);
    let tools: Vec<Arc<dyn Tool>> = defs
        .into_iter()
        .map(|d| {
            let tool_name = exposed_name(&prefix, &d.name);
            Arc::new(McpTool {
                client: client.clone(),
                exposed_name: tool_name,
                remote_name: d.name,
                description: d.description,
                schema: d.input_schema,
            }) as Arc<dyn Tool>
        })
        .collect();
    let mut tools = tools;
    let caps = client.capabilities();
    if caps.resources {
        tools.push(Arc::new(McpListResourcesTool {
            client: client.clone(),
            name: exposed_name(&prefix, "list_resources"),
        }));
        tools.push(Arc::new(McpReadResourceTool {
            client: client.clone(),
            name: exposed_name(&prefix, "read_resource"),
        }));
    }
    if caps.prompts {
        tools.push(Arc::new(McpListPromptsTool {
            client: client.clone(),
            name: exposed_name(&prefix, "list_prompts"),
        }));
        tools.push(Arc::new(McpGetPromptTool {
            client: client.clone(),
            name: exposed_name(&prefix, "get_prompt"),
        }));
    }
    Ok((client, tools))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_sanitizes() {
        let cfg = McpServerConfig {
            id: "x".into(),
            name: "GitHub MCP!".into(),
            command: "npx".into(),
            args: vec![],
            enabled: true,
        };
        assert_eq!(prefix_for(&cfg), "github_mcp");
    }

    #[test]
    fn parses_server_capabilities() {
        let caps = capabilities_from_initialize(&json!({
            "capabilities": {
                "tools": {},
                "resources": { "listChanged": true },
                "prompts": {}
            }
        }));
        assert!(caps.tools);
        assert!(caps.resources);
        assert!(caps.prompts);
    }

    #[test]
    fn exposed_name_uses_prefix_when_present() {
        assert_eq!(exposed_name("github", "search"), "github__search");
        assert_eq!(exposed_name("", "search"), "search");
    }

    #[test]
    fn answers_server_ping_and_rejects_unadvertised_requests() {
        let ping = server_request_response(&json!({"jsonrpc":"2.0","id":7,"method":"ping"}));
        assert_eq!(ping["result"], json!({}));

        let roots = server_request_response(&json!({"jsonrpc":"2.0","id":8,"method":"roots/list"}));
        assert_eq!(roots["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn stdio_client_reads_tools_resources_and_prompts() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }

        let script = r#"const readline=require('readline');const rl=readline.createInterface({input:process.stdin});function send(id,result){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n')}function error(id){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32601,message:'not found'}})+'\n')}rl.on('line',line=>{const msg=JSON.parse(line);if(msg.id===undefined)return;if(msg.method==='initialize')return send(msg.id,{protocolVersion:'2025-06-18',capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:'mock',version:'1'}});if(msg.method==='tools/list')return send(msg.id,{tools:[{name:'echo',description:'Echo',inputSchema:{type:'object'}}]});if(msg.method==='tools/call')return send(msg.id,{content:[{type:'text',text:'ok'}]});if(msg.method==='resources/list')return send(msg.id,{resources:[{uri:'mock://note',name:'note',mimeType:'text/plain'}]});if(msg.method==='resources/templates/list')return send(msg.id,{resourceTemplates:[{uriTemplate:'mock://{name}',name:'template'}]});if(msg.method==='resources/read')return send(msg.id,{contents:[{uri:msg.params.uri,mimeType:'text/plain',text:'hello'}]});if(msg.method==='prompts/list')return send(msg.id,{prompts:[{name:'review',description:'Review'}]});if(msg.method==='prompts/get')return send(msg.id,{messages:[{role:'user',content:{type:'text',text:'review '+(msg.params.arguments.code||'')}}]});error(msg.id)});"#;

        let args = vec!["-e".to_string(), script.to_string()];
        let client = McpClient::connect("node", &args).await.unwrap();

        let caps = client.capabilities();
        assert!(caps.tools);
        assert!(caps.resources);
        assert!(caps.prompts);
        assert_eq!(client.list_tools().await.unwrap()[0].name, "echo");
        assert_eq!(
            client.list_resources().await.unwrap()[0]["uri"],
            "mock://note"
        );
        assert_eq!(
            client.list_resource_templates().await.unwrap()[0]["uriTemplate"],
            "mock://{name}"
        );
        assert_eq!(
            client.read_resource("mock://note").await.unwrap()["contents"][0]["text"],
            "hello"
        );
        assert_eq!(client.list_prompts().await.unwrap()[0]["name"], "review");
        assert_eq!(
            client
                .get_prompt("review", json!({ "code": "x" }))
                .await
                .unwrap()["messages"][0]["content"]["text"],
            "review x"
        );
        assert_eq!(
            client.call_tool("echo", json!({})).await.unwrap()["content"][0]["text"],
            "ok"
        );
    }

    #[test]
    fn lifts_mcp_image_content() {
        let result = json!({"content":[
            {"type":"text","text":"hi"},
            {"type":"image","data":"AAAA","mimeType":"image/png"}
        ]});
        let lifted = lift_mcp_image(result);
        assert_eq!(lifted["image"]["data"], "AAAA");
        assert_eq!(lifted["image"]["mime"], "image/png");
    }

    #[test]
    fn lift_mcp_image_noop_without_image() {
        let lifted = lift_mcp_image(json!({"content":[{"type":"text","text":"hi"}]}));
        assert!(lifted.get("image").is_none());
    }

    #[test]
    fn open_missing_is_empty() {
        let dir = std::env::temp_dir().join(format!("milim-mcp-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let hub = McpHub::open(&dir);
        assert!(hub.list().is_empty());
        assert!(hub.tools().is_empty());
    }

    #[tokio::test]
    async fn upsert_reports_save_failure_without_mutating_state() {
        let blocker =
            std::env::temp_dir().join(format!("milim-mcp-blocker-{}", uuid::Uuid::new_v4()));
        std::fs::write(&blocker, b"not a directory").unwrap();
        let hub = McpHub::open(&blocker);
        let err = hub
            .upsert(McpServerConfig {
                id: "broken".into(),
                name: "Broken".into(),
                command: "node".into(),
                args: Vec::new(),
                enabled: false,
            })
            .await
            .unwrap_err();

        assert_eq!(err.code(), "io_error");
        assert!(hub.list().is_empty());
        let _ = std::fs::remove_file(&blocker);
    }

    #[tokio::test]
    async fn remove_reports_save_failure_without_mutating_state() {
        let dir =
            std::env::temp_dir().join(format!("milim-mcp-remove-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let hub = McpHub::open(&dir);
        hub.upsert(McpServerConfig {
            id: "keep".into(),
            name: "Keep".into(),
            command: "node".into(),
            args: Vec::new(),
            enabled: false,
        })
        .await
        .unwrap();
        let path = dir.join("mcp.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();

        let err = hub.remove("keep").unwrap_err();

        assert_eq!(err.code(), "io_error");
        assert!(hub.list().iter().any(|server| server.id == "keep"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
