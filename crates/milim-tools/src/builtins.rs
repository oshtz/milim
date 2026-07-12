//! Built-in tools available out of the box.

use async_trait::async_trait;
use serde_json::{json, Value};

use milim_core::{Error, Result};

use crate::{Tool, ToolEffect};

/// Max characters returned by `http_fetch`.
const MAX_FETCH_CHARS: usize = 100_000;
const MAX_FETCH_BYTES: usize = 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

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

    fn effect(&self) -> ToolEffect {
        ToolEffect::ReadOnly
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

    fn effect(&self) -> ToolEffect {
        ToolEffect::ReadOnly
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

    fn effect(&self) -> ToolEffect {
        ToolEffect::ReadOnly
    }

    async fn invoke(&self, args: Value) -> Result<Value> {
        let url = args
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::InvalidRequest("missing 'url' argument".to_string()))?;
        let mut url = reqwest::Url::parse(url)
            .map_err(|error| Error::InvalidRequest(format!("invalid URL: {error}")))?;
        let mut resp = None;
        for redirect in 0..=MAX_REDIRECTS {
            let client = public_http_client(&url).await?;
            let response = client
                .get(url.clone())
                .send()
                .await
                .map_err(|e| Error::Upstream(e.to_string()))?;
            if response.status().is_redirection() {
                if redirect == MAX_REDIRECTS {
                    return Err(Error::Upstream("too many redirects".to_string()));
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| Error::Upstream("redirect is missing Location".to_string()))?;
                url = url
                    .join(location)
                    .map_err(|error| Error::Upstream(format!("invalid redirect: {error}")))?;
                continue;
            }
            resp = Some(response);
            break;
        }
        let mut resp = resp.ok_or_else(|| Error::Upstream("request failed".to_string()))?;
        let status = resp.status().as_u16();
        let mut bytes = Vec::new();
        let mut body_truncated = false;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|error| Error::Upstream(error.to_string()))?
        {
            let remaining = MAX_FETCH_BYTES.saturating_sub(bytes.len());
            if chunk.len() > remaining {
                bytes.extend_from_slice(&chunk[..remaining]);
                body_truncated = true;
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = String::from_utf8_lossy(&bytes);
        let truncated: String = body.chars().take(MAX_FETCH_CHARS).collect();
        body_truncated |= body.chars().count() > MAX_FETCH_CHARS;
        Ok(json!({ "status": status, "body": truncated, "truncated": body_truncated }))
    }
}

async fn public_http_client(url: &reqwest::Url) -> Result<reqwest::Client> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Error::InvalidRequest(
            "only http(s) URLs are allowed".to_string(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| Error::InvalidRequest("URL must include a host".to_string()))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| Error::InvalidRequest("URL must include a valid port".to_string()))?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| Error::Upstream(format!("DNS lookup failed: {error}")))?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(Error::InvalidRequest(
            "private, local, and link-local network addresses are not allowed".to_string(),
        ));
    }
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none());
    for address in addresses {
        builder = builder.resolve(host, address);
    }
    builder
        .build()
        .map_err(|error| Error::Other(format!("HTTP client: {error}")))
}

fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 240
                || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])))
        }
        std::net::IpAddr::V6(ip) => {
            let octets = ip.octets();
            if octets[..10] == [0; 10] && octets[10..12] == [0xff, 0xff] {
                return is_public_ip(std::net::IpAddr::V4(std::net::Ipv4Addr::new(
                    octets[12], octets[13], octets[14], octets[15],
                )));
            }
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (octets[0] & 0xfe) == 0xfc
                || (octets[0] == 0xfe && (octets[1] & 0xc0) == 0x80))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_address_policy_rejects_local_networks() {
        assert!(!is_public_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("10.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("169.254.169.254".parse().unwrap()));
        assert!(!is_public_ip("fc00::1".parse().unwrap()));
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
    }
}
