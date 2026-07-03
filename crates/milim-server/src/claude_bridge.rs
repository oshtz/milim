//! Thin bridge to the official `claude` CLI subscription runtime.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::process::Stdio;
use std::time::Duration;

use axum::response::sse::Event;
use futures::Stream;
use milim_core::api::openai::{ReasoningEffort, Usage};
use milim_core::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

use crate::privacy::Unredactor;

const CLAUDE_STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const CLAUDE_MODEL_ALIASES: &[&str] = &["sonnet", "opus", "haiku", "fable"];

#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeRunRequest {
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub tool_approval_policy: Option<String>,
    #[serde(default)]
    pub tool_approval_grant: bool,
    #[serde(default)]
    pub plan_mode: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClaudeStreamEvent {
    Token {
        text: String,
    },
    Reasoning {
        text: String,
    },
    Tool {
        id: String,
        name: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        icon: Option<String>,
    },
    RateLimit {
        limit: Value,
    },
    Done {
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
    },
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
    },
    Warning {
        message: String,
    },
}

#[derive(Debug, Clone)]
struct ClaudeToolState {
    name: String,
    detail: Option<String>,
}

pub(crate) async fn status() -> Result<Value> {
    let mut command = claude_command();
    command.arg("auth").arg("status");
    #[cfg(windows)]
    command.creation_flags(milim_core::proc::CREATE_NO_WINDOW);
    let output = match tokio::time::timeout(CLAUDE_STATUS_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            let error = claude_spawn_error_message(&e);
            let warning = is_cli_path_warning(&error);
            return Ok(json!({
                "available": false,
                "authenticated": false,
                "models": [],
                "error": error,
                "warning": warning
            }));
        }
        Err(_) => {
            return Ok(json!({
                "available": true,
                "authenticated": false,
                "models": [],
                "error": "`claude auth status` timed out"
            }));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let auth = serde_json::from_str::<Value>(&stdout).unwrap_or_else(|_| json!({ "raw": stdout }));
    let authenticated = output.status.success()
        && auth
            .get("loggedIn")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    Ok(json!({
        "available": true,
        "authenticated": authenticated,
        "auth": auth,
        "models": if authenticated { CLAUDE_MODEL_ALIASES } else { &[] as &[&str] },
        "error": if output.status.success() { Value::Null } else { Value::String(stderr) },
    }))
}

pub(crate) fn run_stream(
    req: ClaudeRunRequest,
    redactions: BTreeMap<String, String>,
) -> impl Stream<Item = std::result::Result<Event, Infallible>> {
    async_stream::stream! {
        let mut command = claude_command();
        for arg in claude_run_args(&req) {
            command.arg(arg);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = clean_optional(req.cwd.as_deref()) {
            command.current_dir(cwd);
        }
        #[cfg(windows)]
        command.creation_flags(milim_core::proc::CREATE_NO_WINDOW);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => {
                let message = claude_spawn_error_message(&e);
                if is_cli_path_warning(&message) {
                    yield sse_event(&ClaudeStreamEvent::Warning { message });
                } else {
                    yield sse_event(&ClaudeStreamEvent::Error {
                        message,
                        usage: None,
                        cost_usd: None,
                    });
                }
                yield Ok(Event::default().data("[DONE]"));
                return;
            }
        };
        let Some(stdout) = child.stdout.take() else {
            yield sse_event(&ClaudeStreamEvent::Error {
                message: "claude stdout was not available".to_string(),
                usage: None,
                cost_usd: None,
            });
            yield Ok(Event::default().data("[DONE]"));
            return;
        };
        let stderr = child.stderr.take();
        let stderr_task = tokio::spawn(async move {
            let mut text = String::new();
            if let Some(stderr) = stderr {
                let _ = BufReader::new(stderr).read_to_string(&mut text).await;
            }
            text
        });

        let mut lines = BufReader::new(stdout).lines();
        let mut content = Unredactor::new(redactions.clone());
        let mut reasoning = Unredactor::new(redactions);
        let mut tools = BTreeMap::new();
        let mut saw_terminal_event = false;

        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    for event in handle_line(&line, &mut content, &mut reasoning, &mut tools, &mut saw_terminal_event) {
                        yield sse_event(&event);
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    yield sse_event(&ClaudeStreamEvent::Error {
                        message: format!("claude stream failed: {e}"),
                        usage: None,
                        cost_usd: None,
                    });
                    yield Ok(Event::default().data("[DONE]"));
                    return;
                }
            }

        }

        let status = child.wait().await;
        let stderr = stderr_task.await.unwrap_or_default();
        let tail = content.flush();
        if !tail.is_empty() {
            yield sse_event(&ClaudeStreamEvent::Token { text: tail });
        }
        let rtail = reasoning.flush();
        if !rtail.is_empty() {
            yield sse_event(&ClaudeStreamEvent::Reasoning { text: rtail });
        }

        match status {
            Ok(status) if status.success() => {
                if !saw_terminal_event {
                    yield sse_event(&ClaudeStreamEvent::Done {
                        status: "completed".to_string(),
                        usage: None,
                        cost_usd: None,
                    });
                }
            }
            Ok(status) => yield sse_event(&ClaudeStreamEvent::Error {
                message: first_error(&stderr, &format!("claude exited with {status}")),
                usage: None,
                cost_usd: None,
            }),
            Err(e) => yield sse_event(&ClaudeStreamEvent::Error {
                message: format!("claude exit status failed: {e}"),
                usage: None,
                cost_usd: None,
            }),
        }
        yield Ok(Event::default().data("[DONE]"));
    }
}

fn handle_line(
    line: &str,
    content: &mut Unredactor,
    reasoning: &mut Unredactor,
    tools: &mut BTreeMap<String, ClaudeToolState>,
    saw_terminal_event: &mut bool,
) -> Vec<ClaudeStreamEvent> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if value.get("type").and_then(Value::as_str) == Some("stream_event") {
        let event = value.get("event").unwrap_or(&Value::Null);
        match event.get("type").and_then(Value::as_str) {
            Some("content_block_start") => {
                let block = event.get("content_block").unwrap_or(&Value::Null);
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    if let Some(event) = claude_tool_start_event(block, tools) {
                        out.push(event);
                    }
                }
            }
            Some("content_block_delta") => {
                let delta = event.get("delta").unwrap_or(&Value::Null);
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            let text = content.push(text);
                            if !text.is_empty() {
                                out.push(ClaudeStreamEvent::Token { text });
                            }
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            let text = reasoning.push(text);
                            if !text.is_empty() {
                                out.push(ClaudeStreamEvent::Reasoning { text });
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    } else if value.get("type").and_then(Value::as_str) == Some("result") {
        *saw_terminal_event = true;
        let tail = content.flush();
        if !tail.is_empty() {
            out.push(ClaudeStreamEvent::Token { text: tail });
        }
        let rtail = reasoning.flush();
        if !rtail.is_empty() {
            out.push(ClaudeStreamEvent::Reasoning { text: rtail });
        }
        let status = value
            .get("stop_reason")
            .and_then(Value::as_str)
            .unwrap_or("completed")
            .to_string();
        let is_error = value
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        out.extend(close_claude_tools(tools, is_error));
        let usage = usage_from_claude_result(&value);
        let cost_usd = value.get("total_cost_usd").and_then(Value::as_f64);
        if is_error {
            let message = value
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("claude run failed")
                .to_string();
            out.push(ClaudeStreamEvent::Error {
                message,
                usage,
                cost_usd,
            });
        } else {
            out.push(ClaudeStreamEvent::Done {
                status,
                usage,
                cost_usd,
            });
        }
    } else if value.get("type").and_then(Value::as_str) == Some("rate_limit_event") {
        out.push(ClaudeStreamEvent::RateLimit {
            limit: claude_rate_limit(value.get("rate_limit_info").unwrap_or(&Value::Null)),
        });
    } else if value.get("type").and_then(Value::as_str) == Some("tool_progress") {
        if let Some(event) = claude_tool_progress_event(&value, tools) {
            out.push(event);
        }
    }
    out
}

fn claude_tool_start_event(
    block: &Value,
    tools: &mut BTreeMap<String, ClaudeToolState>,
) -> Option<ClaudeStreamEvent> {
    let id = string_field(block, "id")?;
    let name = string_field(block, "name").unwrap_or_else(|| "tool".to_string());
    if tools.contains_key(&id) {
        return None;
    }
    let detail = compact_json(block.get("input"));
    tools.insert(
        id.clone(),
        ClaudeToolState {
            name: name.clone(),
            detail: detail.clone(),
        },
    );
    Some(ClaudeStreamEvent::Tool {
        id,
        name: name.clone(),
        status: "running".to_string(),
        label: Some(format!("Using {name}")),
        detail,
        icon: Some(claude_tool_icon(&name).to_string()),
    })
}

fn claude_tool_progress_event(
    value: &Value,
    tools: &mut BTreeMap<String, ClaudeToolState>,
) -> Option<ClaudeStreamEvent> {
    let id = string_field(value, "tool_use_id")?;
    let name = string_field(value, "tool_name").unwrap_or_else(|| "tool".to_string());
    if tools.contains_key(&id) {
        return None;
    }
    tools.insert(
        id.clone(),
        ClaudeToolState {
            name: name.clone(),
            detail: None,
        },
    );
    Some(ClaudeStreamEvent::Tool {
        id,
        name: name.clone(),
        status: "running".to_string(),
        label: Some(format!("Using {name}")),
        detail: None,
        icon: Some(claude_tool_icon(&name).to_string()),
    })
}

fn close_claude_tools(
    tools: &mut BTreeMap<String, ClaudeToolState>,
    is_error: bool,
) -> Vec<ClaudeStreamEvent> {
    std::mem::take(tools)
        .into_iter()
        .map(|(id, tool)| ClaudeStreamEvent::Tool {
            id,
            name: tool.name.clone(),
            status: if is_error { "error" } else { "done" }.to_string(),
            label: Some(if is_error {
                format!("{} failed", tool.name)
            } else {
                format!("Used {}", tool.name)
            }),
            detail: tool.detail,
            icon: Some(claude_tool_icon(&tool.name).to_string()),
        })
        .collect()
}

fn claude_tool_icon(name: &str) -> &'static str {
    match name {
        "Read" | "Grep" | "Glob" | "Write" | "Edit" | "MultiEdit" => "file",
        "Bash" => "command",
        _ => "tool",
    }
}

fn sse_event<T: Serialize>(value: &T) -> std::result::Result<Event, Infallible> {
    Ok(Event::default().data(serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())))
}

fn first_error(stderr: &str, fallback: &str) -> String {
    stderr
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| fallback.to_string())
}

fn clean_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn claude_run_args(req: &ClaudeRunRequest) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        req.prompt.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    if let Some(session_id) = clean_optional(req.session_id.as_deref()) {
        args.extend(["--session-id".to_string(), session_id]);
    } else {
        args.push("--no-session-persistence".to_string());
    }
    args.extend([
        "--permission-mode".to_string(),
        claude_permission_mode(req).to_string(),
    ]);
    for denied in claude_denied_tools(req) {
        args.extend(["--disallowedTools".to_string(), denied.to_string()]);
    }
    if let Some(model) = clean_optional(req.model.as_deref()) {
        args.extend(["--model".to_string(), model]);
    }
    if let Some(effort) = claude_effort(req.reasoning_effort) {
        args.extend(["--effort".to_string(), effort.to_string()]);
    }
    args
}

fn account_runtime_policy(value: Option<&str>) -> &str {
    match value.map(str::trim) {
        Some("review") => "review",
        Some("open") => "open",
        _ => "guarded",
    }
}

fn claude_tools_allowed(req: &ClaudeRunRequest) -> bool {
    !req.plan_mode
        && match account_runtime_policy(req.tool_approval_policy.as_deref()) {
            "review" => req.tool_approval_grant,
            _ => true,
        }
}

fn claude_permission_mode(req: &ClaudeRunRequest) -> &'static str {
    if req.plan_mode {
        "plan"
    } else if !claude_tools_allowed(req) {
        "dontAsk"
    } else if account_runtime_policy(req.tool_approval_policy.as_deref()) == "guarded" {
        "acceptEdits"
    } else {
        "bypassPermissions"
    }
}

fn claude_denied_tools(req: &ClaudeRunRequest) -> Vec<&'static str> {
    if req.plan_mode {
        Vec::new()
    } else if !claude_tools_allowed(req) {
        vec!["*"]
    } else if account_runtime_policy(req.tool_approval_policy.as_deref()) == "guarded" {
        vec!["Bash", "PowerShell"]
    } else {
        Vec::new()
    }
}

fn claude_effort(effort: Option<ReasoningEffort>) -> Option<&'static str> {
    match effort? {
        ReasoningEffort::Low => Some("low"),
        ReasoningEffort::Medium => Some("medium"),
        ReasoningEffort::High => Some("high"),
        ReasoningEffort::Xhigh => Some("xhigh"),
        ReasoningEffort::Max => Some("max"),
        ReasoningEffort::Auto | ReasoningEffort::None | ReasoningEffort::Minimal => None,
    }
}

fn usage_from_claude_result(value: &Value) -> Option<Usage> {
    let usage = value.get("usage")?;
    let prompt = opt_u32(usage, "input_tokens").unwrap_or(0)
        + opt_u32(usage, "cache_creation_input_tokens").unwrap_or(0)
        + opt_u32(usage, "cache_read_input_tokens").unwrap_or(0);
    let completion = opt_u32(usage, "output_tokens").unwrap_or(0);
    if prompt == 0 && completion == 0 {
        return None;
    }
    Some(Usage::new(prompt, completion))
}

fn claude_rate_limit(info: &Value) -> Value {
    json!({
        "provider": "Claude Code",
        "status": info.get("status").and_then(Value::as_str),
        "kind": info.get("rateLimitType").and_then(Value::as_str),
        "reset_at": info.get("resetsAt").and_then(Value::as_i64),
        "raw": info,
    })
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn compact_json(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    Some(compact(&value.to_string(), 110))
}

fn compact(value: &str, limit: usize) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > limit {
        let prefix = text
            .chars()
            .take(limit.saturating_sub(3))
            .collect::<String>();
        format!("{prefix}...")
    } else {
        text
    }
}

fn claude_spawn_error_message(error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return cli_path_warning("Claude Code", "claude");
    }
    format!("failed to start `claude`: {error}. Install Claude Code and sign in with `claude auth login`.")
}

fn cli_path_warning(label: &str, command: &str) -> String {
    format!("{label} CLI was not found on PATH. If this is macOS, apps launched from Finder or Dock may not inherit your shell PATH, so Milim may not see `{command}` even when Terminal can. Launch Milim from a terminal or add the CLI install folder to PATH for GUI apps.")
}

fn is_cli_path_warning(message: &str) -> bool {
    message.contains("CLI was not found on PATH")
}

fn opt_u32(value: &Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}

fn claude_command() -> Command {
    Command::new("claude")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_delta() {
        let mut content = Unredactor::new(BTreeMap::new());
        let mut reasoning = Unredactor::new(BTreeMap::new());
        let mut tools = BTreeMap::new();
        let mut done = false;
        let events = handle_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}"#,
            &mut content,
            &mut reasoning,
            &mut tools,
            &mut done,
        );
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn flushes_before_result_done() {
        let mut content = Unredactor::new(BTreeMap::new());
        let mut reasoning = Unredactor::new(BTreeMap::new());
        let mut tools = BTreeMap::new();
        let mut done = false;
        assert!(handle_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"["}}}"#,
            &mut content,
            &mut reasoning,
            &mut tools,
            &mut done,
        )
        .is_empty());
        let events = handle_line(
            r#"{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}"#,
            &mut content,
            &mut reasoning,
            &mut tools,
            &mut done,
        );
        assert!(matches!(events.first(), Some(ClaudeStreamEvent::Token { text }) if text == "["));
        assert!(
            matches!(events.last(), Some(ClaudeStreamEvent::Done { status, .. }) if status == "end_turn")
        );
    }

    #[test]
    fn parses_result_usage_and_limit_events() {
        let mut content = Unredactor::new(BTreeMap::new());
        let mut reasoning = Unredactor::new(BTreeMap::new());
        let mut tools = BTreeMap::new();
        let mut done = false;
        let events = handle_line(
            r#"{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","total_cost_usd":0.01,"usage":{"input_tokens":10,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":4}}"#,
            &mut content,
            &mut reasoning,
            &mut tools,
            &mut done,
        );
        assert!(matches!(
            events.last(),
            Some(ClaudeStreamEvent::Done {
                usage: Some(Usage { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 }),
                cost_usd: Some(cost),
                ..
            }) if (*cost - 0.01).abs() < f64::EPSILON
        ));

        let events = handle_line(
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1782660000,"rateLimitType":"five_hour"}}"#,
            &mut content,
            &mut reasoning,
            &mut tools,
            &mut done,
        );
        assert!(matches!(
            events.first(),
            Some(ClaudeStreamEvent::RateLimit { .. })
        ));
    }

    #[test]
    fn status_models_require_authentication() {
        assert!(CLAUDE_MODEL_ALIASES.contains(&"sonnet"));
        assert!(CLAUDE_MODEL_ALIASES.contains(&"haiku"));
    }

    #[test]
    fn maps_supported_effort_flags() {
        assert_eq!(claude_effort(Some(ReasoningEffort::Low)), Some("low"));
        assert_eq!(claude_effort(Some(ReasoningEffort::Xhigh)), Some("xhigh"));
        assert_eq!(claude_effort(Some(ReasoningEffort::Minimal)), None);
        assert_eq!(claude_effort(Some(ReasoningEffort::Auto)), None);
    }

    #[test]
    fn persistent_run_args_use_session_id_without_turn_cap() {
        let args = claude_run_args(&ClaudeRunRequest {
            prompt: "hello".into(),
            model: Some("sonnet".into()),
            cwd: None,
            reasoning_effort: Some(ReasoningEffort::High),
            session_id: Some("11111111-1111-4111-8111-111111111111".into()),
            tool_approval_policy: Some("open".into()),
            tool_approval_grant: true,
            plan_mode: false,
        });
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--session-id"
                && pair[1] == "11111111-1111-4111-8111-111111111111"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--effort" && pair[1] == "high"));
        assert!(!args.iter().any(|arg| arg == "--max-turns"));
        assert!(!args.iter().any(|arg| arg == "--no-session-persistence"));

        let args = claude_run_args(&ClaudeRunRequest {
            prompt: "hello".into(),
            model: None,
            cwd: None,
            reasoning_effort: None,
            session_id: None,
            tool_approval_policy: None,
            tool_approval_grant: false,
            plan_mode: false,
        });
        assert!(args.iter().any(|arg| arg == "--no-session-persistence"));
        assert!(!args.iter().any(|arg| arg == "--max-turns"));
    }

    #[test]
    fn maps_milim_tool_modes_to_claude_permissions() {
        let mut req = ClaudeRunRequest {
            prompt: "hello".into(),
            model: None,
            cwd: None,
            reasoning_effort: None,
            session_id: None,
            tool_approval_policy: Some("guarded".into()),
            tool_approval_grant: false,
            plan_mode: false,
        };
        assert_eq!(claude_permission_mode(&req), "acceptEdits");
        assert_eq!(claude_denied_tools(&req), vec!["Bash", "PowerShell"]);

        req.tool_approval_policy = Some("open".into());
        assert_eq!(claude_permission_mode(&req), "bypassPermissions");
        assert!(claude_denied_tools(&req).is_empty());

        req.plan_mode = true;
        assert_eq!(claude_permission_mode(&req), "plan");
    }

    #[test]
    fn spawn_not_found_is_path_warning() {
        let error = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        let message = claude_spawn_error_message(&error);
        assert!(is_cli_path_warning(&message));
        assert!(message.contains("claude"));
        assert!(message.contains("macOS"));
    }
}
