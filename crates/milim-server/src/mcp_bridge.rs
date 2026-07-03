//! `milim mcp` — a stdio MCP server that bridges to the local HTTP server.
//!
//! Speaks newline-delimited JSON-RPC on stdin/stdout (the MCP stdio transport)
//! and proxies tool discovery/execution to this server's `/mcp/tools` +
//! `/mcp/call` endpoints, so any MCP client (Claude Desktop, etc.) can use
//! milim's tools.

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

const PROTOCOL_VERSION: &str = "2025-06-18";

/// Handle a single JSON-RPC request, returning a response (or `None` for
/// notifications, which get no reply).
pub async fn handle_request(
    req: &Value,
    base: &str,
    token: Option<&str>,
    client: &reqwest::Client,
) -> Option<Value> {
    let method = req.get("method")?.as_str()?;
    let id = req.get("id").cloned().unwrap_or(Value::Null);

    let result: Value = match method {
        "initialize" => json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "milim", "version": env!("CARGO_PKG_VERSION") }
        }),
        "tools/list" => {
            let v = get_json(client, &format!("{base}/mcp/tools"), token).await?;
            let tools: Vec<Value> = v["tools"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|t| {
                    json!({
                        "name": t["name"],
                        "description": t["description"],
                        "inputSchema": t["input_schema"],
                    })
                })
                .collect();
            json!({ "tools": tools })
        }
        "tools/call" => {
            let name = req["params"]["name"].clone();
            let arguments = req["params"]["arguments"].clone();
            let body = json!({ "name": name, "arguments": arguments });
            match post_json(client, &format!("{base}/mcp/call"), &body, token).await {
                Some(v) => json!({
                    "content": [{ "type": "text", "text": v["result"].to_string() }],
                    "isError": false
                }),
                None => {
                    return Some(error(id, -32603, "tool call failed"));
                }
            }
        }
        "ping" => json!({}),
        "notifications/initialized" | "initialized" | "notifications/cancelled" => return None,
        _ => return Some(error(id, -32601, "method not found")),
    };

    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// Run the stdio loop until EOF.
pub async fn run_mcp_stdio(base: String, token: Option<String>) -> std::io::Result<()> {
    let client = reqwest::Client::new();
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(resp) = handle_request(&req, &base, token.as_deref(), &client).await {
            let mut s = serde_json::to_string(&resp).unwrap_or_default();
            s.push('\n');
            stdout.write_all(s.as_bytes()).await?;
            stdout.flush().await?;
        }
    }
    Ok(())
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn get_json(client: &reqwest::Client, url: &str, token: Option<&str>) -> Option<Value> {
    with_bearer(client.get(url), token)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()
}

async fn post_json(
    client: &reqwest::Client,
    url: &str,
    body: &Value,
    token: Option<&str>,
) -> Option<Value> {
    with_bearer(client.post(url), token)
        .json(body)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()
}

fn with_bearer(req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    match token.filter(|t| !t.trim().is_empty()) {
        Some(token) => req.bearer_auth(token.trim()),
        None => req,
    }
}
