//! Built-in tools available out of the box.

use async_trait::async_trait;
use serde_json::{json, Value};

use milim_core::{Error, Result};

use crate::Tool;

/// Max characters returned by `http_fetch`.
const MAX_FETCH_CHARS: usize = 100_000;

/// Echoes its arguments back — deterministic, handy for testing tool loops.
pub struct EchoTool;

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        "echo"
    }

    fn description(&self) -> &str {
        "Echo the provided arguments back to the caller."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "text": { "type": "string", "description": "Text to echo." } },
            "additionalProperties": true
        })
    }

    async fn invoke(&self, args: Value) -> Result<Value> {
        Ok(json!({ "echoed": args }))
    }
}

/// Returns the current time as unix seconds + RFC-3339-ish UTC string.
pub struct CurrentTimeTool;

#[async_trait]
impl Tool for CurrentTimeTool {
    fn name(&self) -> &str {
        "current_time"
    }

    fn description(&self) -> &str {
        "Get the current UTC time as a unix timestamp."
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    async fn invoke(&self, _args: Value) -> Result<Value> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Ok(json!({ "unix": now }))
    }
}

/// Fetch an `http(s)` URL and return its status + (truncated) body.
pub struct HttpFetchTool;

#[async_trait]
impl Tool for HttpFetchTool {
    fn name(&self) -> &str {
        "http_fetch"
    }

    fn description(&self) -> &str {
        "Fetch an http(s) URL and return its status code and text body."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "url": { "type": "string", "description": "The http(s) URL to fetch." } },
            "required": ["url"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<Value> {
        let url = args
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::InvalidRequest("missing 'url' argument".to_string()))?;
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(Error::InvalidRequest(
                "only http(s) URLs are allowed".to_string(),
            ));
        }
        let resp = reqwest::Client::new()
            .get(url)
            .send()
            .await
            .map_err(|e| Error::Upstream(e.to_string()))?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        let truncated: String = body.chars().take(MAX_FETCH_CHARS).collect();
        Ok(json!({ "status": status, "body": truncated }))
    }
}
