//! `milim mcp` — a stdio MCP server that bridges to the local HTTP server.
//!
//! Speaks newline-delimited JSON-RPC on stdin/stdout (the MCP stdio transport)
//! and proxies tool discovery/execution to this server's `/mcp/tools` +
//! `/mcp/call` endpoints, so any MCP client (Claude Desktop, etc.) can use
//! milim's tools.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

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
            let v = match get_json(client, &format!("{base}/mcp/tools?callable=true"), token).await
            {
                Ok(value) => value,
                Err(message) => return Some(error(id, -32603, &message)),
            };
            let tools: Vec<Value> = v["tools"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|tool| tool.get("effect").and_then(Value::as_str) == Some("read_only"))
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
                Ok(v) => mcp_tool_result(v.get("result").cloned().unwrap_or(Value::Null)),
                Err(message) => return Some(error(id, -32603, &message)),
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
    let client = Arc::new(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(std::io::Error::other)?,
    );
    let mut stdin = tokio::io::BufReader::new(tokio::io::stdin());
    let mut stdout = tokio::io::stdout();
    let (completed_tx, mut completed_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut tasks = HashMap::<String, tokio::task::AbortHandle>::new();

    loop {
        tokio::select! {
            line = read_bounded_line(&mut stdin) => {
                let Some(line) = line? else { break };
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let Ok(req) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                if req.get("method").and_then(Value::as_str) == Some("notifications/cancelled") {
                    if let Some(key) = req.pointer("/params/requestId").map(Value::to_string) {
                        if let Some(handle) = tasks.remove(&key) {
                            handle.abort();
                        }
                    }
                    continue;
                }
                let key = req.get("id").map(Value::to_string);
                let request = req.clone();
                let base = base.clone();
                let token = token.clone();
                let client = client.clone();
                let completed = completed_tx.clone();
                let completion_key = key.clone();
                let handle = tokio::spawn(async move {
                    let response = handle_request(&request, &base, token.as_deref(), &client).await;
                    let _ = completed.send((completion_key, response));
                });
                if let Some(key) = key {
                    tasks.insert(key, handle.abort_handle());
                }
            }
            completed = completed_rx.recv() => {
                let Some((key, response)) = completed else { break };
                if let Some(key) = key {
                    tasks.remove(&key);
                }
                if let Some(response) = response {
                    let mut encoded = serde_json::to_string(&response).unwrap_or_default();
                    encoded.push('\n');
                    stdout.write_all(encoded.as_bytes()).await?;
                    stdout.flush().await?;
                }
            }
        }
    }
    for (_, handle) in tasks {
        handle.abort();
    }
    Ok(())
}

async fn read_bounded_line<R>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    const MAX_LINE_BYTES: u64 = 8 * 1024 * 1024;
    let mut line = Vec::new();
    let read = reader
        .take(MAX_LINE_BYTES + 1)
        .read_until(b'\n', &mut line)
        .await?;
    if read == 0 {
        return Ok(None);
    }
    if line.len() as u64 > MAX_LINE_BYTES || !line.ends_with(b"\n") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "MCP request line exceeds 8 MiB",
        ));
    }
    Ok(Some(line))
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn mcp_tool_result(mut result: Value) -> Value {
    let image = result
        .as_object_mut()
        .and_then(|object| object.remove("image"));
    let mut content = vec![json!({ "type": "text", "text": result.to_string() })];
    if let Some(image) = image {
        if let (Some(data), Some(mime_type)) = (
            image.get("data").and_then(Value::as_str),
            image.get("mime").and_then(Value::as_str),
        ) {
            content.push(json!({ "type": "image", "data": data, "mimeType": mime_type }));
        }
    }
    json!({ "content": content, "isError": false })
}

async fn get_json(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
) -> Result<Value, String> {
    with_bearer(client.get(url), token)
        .send()
        .await
        .map_err(|error| format!("HTTP request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("HTTP request failed: {error}"))?
        .json()
        .await
        .map_err(|error| format!("invalid HTTP response: {error}"))
}

async fn post_json(
    client: &reqwest::Client,
    url: &str,
    body: &Value,
    token: Option<&str>,
) -> Result<Value, String> {
    with_bearer(client.post(url), token)
        .json(body)
        .send()
        .await
        .map_err(|error| format!("HTTP request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("HTTP request failed: {error}"))?
        .json()
        .await
        .map_err(|error| format!("invalid HTTP response: {error}"))
}

fn with_bearer(req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    match token.filter(|t| !t.trim().is_empty()) {
        Some(token) => req.bearer_auth(token.trim()),
        None => req,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_results_are_emitted_as_mcp_image_blocks() {
        let result = mcp_tool_result(json!({
            "ok": true,
            "image": {"mime":"image/png","data":"AAAA"}
        }));
        assert_eq!(result["content"][1]["type"], "image");
        assert_eq!(result["content"][1]["data"], "AAAA");
        assert!(!result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("AAAA"));
    }
}
