//! `milim-agents` - the tool-use agent loop.
//!
//! [`run_agent`] drives the core agentic cycle milim exposes via
//! `POST /agents/{id}/run`: ask the model with the available tools; if it emits
//! tool calls, execute them through the [`ToolRegistry`] and feed the results
//! back as `tool`-role messages; repeat until the model answers in plain text.

mod store;
mod threads;

pub use store::{
    normalize_skill_mode, normalize_tool_mode, AgentDef, AgentStore, AGENT_MIGRATIONS,
};
pub use threads::{
    thread_status_terminal, AgentThread, ThreadEvent, ThreadStore, THREAD_MIGRATIONS,
    THREAD_STATUS_DONE, THREAD_STATUS_ERROR, THREAD_STATUS_QUEUED, THREAD_STATUS_RUNNING,
    THREAD_STATUS_STOPPED,
};

use std::sync::Arc;

use futures::{Stream, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};

use milim_core::api::openai::{
    ChatMessage, Content, ContentPart, ImageUrl, ReasoningEffort, Tool, ToolFunction, Usage,
};
use milim_core::Result;
use milim_inference::{
    CompletionRequest, ModelService, SamplingParams, SharedService, StreamEvent,
    ToolCallAccumulator,
};
use milim_tools::ToolRegistry;

const TOOL_REPLAY_MAX_LINES: usize = 2_000;
const TOOL_REPLAY_MAX_BYTES: usize = 50 * 1024;

/// One executed tool call within a run.
#[derive(Debug, Clone, Serialize)]
pub struct ToolStep {
    pub name: String,
    pub arguments: String,
    pub result: Value,
}

/// The result of an agent run.
#[derive(Debug, Clone, Serialize)]
pub struct AgentOutcome {
    /// The final assistant message.
    pub message: ChatMessage,
    /// Tool calls executed along the way, in order.
    pub steps: Vec<ToolStep>,
    /// Number of model turns taken.
    pub iterations: usize,
    /// Kept for API compatibility; agent runs no longer stop at an iteration limit.
    pub stopped_at_limit: bool,
}

/// Run the tool-use loop until the model answers.
pub async fn run_agent(
    service: &dyn ModelService,
    tools: &ToolRegistry,
    model: &str,
    mut messages: Vec<ChatMessage>,
    reasoning_effort: Option<ReasoningEffort>,
) -> Result<AgentOutcome> {
    let core_tools = tools_to_core(tools);
    let mut steps = Vec::new();

    let mut iteration = 0;
    loop {
        let req = CompletionRequest {
            model: model.to_string(),
            messages: messages.clone(),
            tools: core_tools.clone(),
            tool_choice: None,
            response_format: None,
            prompt: None,
            suffix: None,
            sampling: SamplingParams::default(),
            reasoning_effort,
        };
        let out = service.complete(req).await?;
        iteration += 1;

        let calls = out.message.tool_calls.clone().unwrap_or_default();
        if calls.is_empty() {
            return Ok(AgentOutcome {
                message: out.message,
                steps,
                iterations: iteration,
                stopped_at_limit: false,
            });
        }

        // Record the assistant's tool-call turn, then execute each call.
        messages.push(out.message);
        let mut pending_images: Vec<ChatMessage> = Vec::new();
        for call in calls {
            let args: Value = serde_json::from_str(&call.function.arguments).unwrap_or(Value::Null);
            let result = match tools.call(&call.function.name, args).await {
                Ok(v) => v,
                Err(e) => json!({ "error": e.to_string() }),
            };
            let (visible, image_uri) = split_tool_image(result);
            steps.push(ToolStep {
                name: call.function.name.clone(),
                arguments: call.function.arguments.clone(),
                result: visible.clone(),
            });
            messages.push(ChatMessage {
                role: "tool".to_string(),
                content: Some(Content::Text(tool_replay_content(&visible))),
                name: None,
                tool_calls: None,
                tool_call_id: call.id.clone(),
                reasoning_content: None,
            });
            if let Some(uri) = image_uri {
                pending_images.push(image_user_message(&call.function.name, uri));
            }
        }
        // Image results ride in follow-up user messages, pushed after every
        // tool reply (OpenAI requires each tool_call_id answered before any
        // other role appears).
        messages.extend(pending_images);
    }
}

/// A streamed event from [`run_agent_stream`].
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// The run started; carries the model that will actually run (for a named
    /// agent this is the agent's own model, not the requested one).
    Start { model: String },
    /// A chunk of visible assistant text.
    Token { text: String },
    /// A chunk of non-answer reasoning/thinking text.
    Reasoning { text: String },
    /// Usage for one completed model request inside the agent loop.
    UsageDelta { usage: Usage },
    /// The agent decided to call a tool.
    ToolCall {
        call_id: Option<String>,
        name: String,
        arguments: String,
    },
    /// The result of executing a tool.
    ToolResult {
        call_id: Option<String>,
        name: String,
        result: Value,
    },
    /// A memory registration tool created a durable graph memory.
    MemoryRegistered {
        id: String,
        node_id: String,
        scope_kind: String,
        scope_label: String,
        summary: String,
        created_at: String,
    },
    /// A child thread was spawned by the parent run.
    ChildThreadStarted { thread: AgentThread },
    /// A child thread reached a terminal success state.
    ChildThreadDone { thread: AgentThread },
    /// A child thread reached a terminal error state.
    ChildThreadError {
        thread: AgentThread,
        message: String,
    },
    /// The final assistant answer.
    Final { content: String },
    /// Terminal event with the turn count. `stopped_at_limit` is retained for
    /// API compatibility and is always false.
    Done {
        iterations: usize,
        stopped_at_limit: bool,
        usage: Usage,
    },
    /// An error occurred mid-run.
    Error { message: String },
}

/// Stream the tool-use loop as [`AgentEvent`]s (errors are folded into
/// `AgentEvent::Error` so the stream itself never fails).
pub fn run_agent_stream(
    service: SharedService,
    tools: Arc<ToolRegistry>,
    model: String,
    messages: Vec<ChatMessage>,
    reasoning_effort: Option<ReasoningEffort>,
) -> impl Stream<Item = AgentEvent> + Send {
    async_stream::stream! {
        let core_tools = tools_to_core(&tools);
        let mut messages = messages;
        let mut total_usage = Usage::default();

        yield AgentEvent::Start { model: model.clone() };

        let mut iteration = 0;
        loop {
            let req = CompletionRequest {
                model: model.clone(),
                messages: messages.clone(),
                tools: core_tools.clone(),
                tool_choice: None,
                response_format: None,
                prompt: None,
                suffix: None,
                sampling: SamplingParams::default(),
                reasoning_effort,
            };
            let mut stream = match service.stream(req).await {
                Ok(s) => s,
                Err(e) => {
                    yield AgentEvent::Error { message: e.to_string() };
                    return;
                }
            };

            let mut content = String::new();
            let mut reasoning = String::new();
            let mut tool_acc = ToolCallAccumulator::default();
            while let Some(ev) = stream.next().await {
                match ev {
                    Ok(StreamEvent::Delta(d)) => {
                        if let Some(c) = d.content {
                            content.push_str(&c);
                            yield AgentEvent::Token { text: c };
                        }
                        if let Some(r) = d.reasoning {
                            reasoning.push_str(&r);
                            yield AgentEvent::Reasoning { text: r };
                        }
                        for tc in d.tool_calls {
                            tool_acc.push(tc);
                        }
                    }
                    Ok(StreamEvent::Done { usage, .. }) => {
                        add_usage(&mut total_usage, usage);
                        yield AgentEvent::UsageDelta { usage };
                    }
                    Err(e) => {
                        yield AgentEvent::Error { message: e.to_string() };
                        return;
                    }
                }
            }
            iteration += 1;

            let calls = tool_acc.finish();
            if calls.is_empty() {
                yield AgentEvent::Final { content };
                yield AgentEvent::Done { iterations: iteration, stopped_at_limit: false, usage: total_usage };
                return;
            }

            // Record the assistant's tool-call turn.
            messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: (!content.is_empty()).then_some(Content::Text(content)),
                name: None,
                tool_calls: Some(calls.clone()),
                tool_call_id: None,
                reasoning_content: (!reasoning.is_empty()).then_some(reasoning),
            });

            let mut pending_images: Vec<ChatMessage> = Vec::new();
            for call in calls {
                yield AgentEvent::ToolCall {
                    call_id: call.id.clone(),
                    name: call.function.name.clone(),
                    arguments: call.function.arguments.clone(),
                };
                let args: Value =
                    serde_json::from_str(&call.function.arguments).unwrap_or(Value::Null);
                let result = match tools.call(&call.function.name, args).await {
                    Ok(v) => v,
                    Err(e) => json!({ "error": e.to_string() }),
                };
                let (visible, image_uri) = split_tool_image(result);
                yield AgentEvent::ToolResult {
                    call_id: call.id.clone(),
                    name: call.function.name.clone(),
                    result: visible.clone(),
                };
                if let Some(ev) = memory_registered_event(&visible) {
                    yield ev;
                }
                if let Some(ev) = child_thread_event(&visible) {
                    yield ev;
                }
                messages.push(ChatMessage {
                    role: "tool".to_string(),
                    content: Some(Content::Text(tool_replay_content(&visible))),
                    name: None,
                    tool_calls: None,
                    tool_call_id: call.id.clone(),
                    reasoning_content: None,
                });
                if let Some(uri) = image_uri {
                    pending_images.push(image_user_message(&call.function.name, uri));
                }
            }
            // Image results follow the tool replies as user messages (keeps
            // each tool_call_id answered before any other role, per OpenAI).
            messages.extend(pending_images);
        }
    }
}

fn add_usage(total: &mut Usage, usage: Usage) {
    total.prompt_tokens += usage.prompt_tokens;
    total.completion_tokens += usage.completion_tokens;
    total.total_tokens += usage.total_tokens;
}

fn memory_registered_event(result: &Value) -> Option<AgentEvent> {
    let notice = result.get("memory_notice")?.as_object()?;
    Some(AgentEvent::MemoryRegistered {
        id: notice.get("id")?.as_str()?.to_string(),
        node_id: notice.get("node_id")?.as_str()?.to_string(),
        scope_kind: notice.get("scope_kind")?.as_str()?.to_string(),
        scope_label: notice.get("scope_label")?.as_str()?.to_string(),
        summary: notice.get("summary")?.as_str()?.to_string(),
        created_at: notice.get("created_at")?.as_str()?.to_string(),
    })
}

fn child_thread_event(result: &Value) -> Option<AgentEvent> {
    let notice = result.get("child_thread_notice")?.as_object()?;
    let thread: AgentThread = serde_json::from_value(notice.get("thread")?.clone()).ok()?;
    match notice.get("event")?.as_str()? {
        "started" => Some(AgentEvent::ChildThreadStarted { thread }),
        "done" => Some(AgentEvent::ChildThreadDone { thread }),
        "error" => {
            let message = notice
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| thread.error.clone())
                .unwrap_or_else(|| "child thread failed".to_string());
            Some(AgentEvent::ChildThreadError { thread, message })
        }
        _ => None,
    }
}

fn tool_replay_content(result: &Value) -> String {
    truncate_tool_replay_text(&result.to_string())
}

fn truncate_tool_replay_text(text: &str) -> String {
    let total_lines = text.split('\n').count();
    if total_lines <= TOOL_REPLAY_MAX_LINES && text.len() <= TOOL_REPLAY_MAX_BYTES {
        return text.to_string();
    }

    let mut preview = String::new();
    let mut kept_lines = 0;
    let mut hit_bytes = false;
    for (index, line) in text.split('\n').enumerate() {
        if kept_lines >= TOOL_REPLAY_MAX_LINES {
            break;
        }
        let prefix = if index == 0 { "" } else { "\n" };
        let needed = prefix.len() + line.len();
        if preview.len() + needed > TOOL_REPLAY_MAX_BYTES {
            hit_bytes = true;
            let remaining = TOOL_REPLAY_MAX_BYTES.saturating_sub(preview.len() + prefix.len());
            if remaining > 0 {
                preview.push_str(prefix);
                preview.push_str(prefix_by_bytes(line, remaining));
            }
            break;
        }
        preview.push_str(prefix);
        preview.push_str(line);
        kept_lines += 1;
    }

    let (removed, unit) = if hit_bytes {
        (text.len().saturating_sub(preview.len()), "bytes")
    } else {
        (total_lines.saturating_sub(kept_lines), "lines")
    };
    format!(
        "{preview}\n\n...tool result truncated for replay: omitted {removed} {unit}. Full result remains in Milim's tool timeline."
    )
}

fn prefix_by_bytes(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        let next = index + ch.len_utf8();
        if next > max_bytes {
            break;
        }
        end = next;
    }
    &text[..end]
}

/// Split a tool result into (visible_json, optional image data-URI).
///
/// A tool may return an `image` object `{ "mime": ..., "data": <base64> }`
/// (e.g. `screenshot`, or an MCP image tool). The image is removed from the
/// visible JSON - so multi-MB base64 blobs never reach the UI, logs, or the
/// `tool` message - and returned as a `data:` URI to attach as a follow-up
/// image message that vision models can actually see.
fn split_tool_image(mut result: Value) -> (Value, Option<String>) {
    let Some(obj) = result.as_object_mut() else {
        return (result, None);
    };
    let Some(img) = obj.remove("image") else {
        return (result, None);
    };
    let Some(data) = img.get("data").and_then(Value::as_str) else {
        return (result, None);
    };
    let mime = img
        .get("mime")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    let uri = format!("data:{mime};base64,{data}");
    (result, Some(uri))
}

/// A user message carrying an image a tool returned, so the model sees it next
/// turn. Encoded as an OpenAI `image_url` data-URI part (passed through to
/// OpenAI-compatible vision models verbatim; non-vision backends ignore it).
fn image_user_message(tool: &str, data_uri: String) -> ChatMessage {
    ChatMessage {
        role: "user".to_string(),
        content: Some(Content::Parts(vec![
            ContentPart::Text {
                text: format!("Image returned by the `{tool}` tool:"),
            },
            ContentPart::ImageUrl {
                image_url: ImageUrl {
                    url: data_uri,
                    detail: None,
                },
            },
        ])),
        name: None,
        tool_calls: None,
        tool_call_id: None,
        reasoning_content: None,
    }
}

/// Map the registry's tools into OpenAI `Tool` definitions for the request.
fn tools_to_core(tools: &ToolRegistry) -> Vec<Tool> {
    tools
        .list()
        .into_iter()
        .map(|s| Tool {
            kind: "function".to_string(),
            function: ToolFunction {
                name: s.name,
                description: Some(s.description),
                parameters: Some(s.input_schema),
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use milim_inference::test_backend::TestBackend;

    #[tokio::test]
    async fn runs_a_two_step_tool_loop() {
        let service = TestBackend::new();
        let tools = ToolRegistry::with_builtins();
        let messages = vec![ChatMessage::text("user", "/tool please")];

        let outcome = run_agent(&service, &tools, "test-echo", messages, None)
            .await
            .unwrap();

        // The test backend calls `echo` once, the loop runs it, then answers.
        assert_eq!(outcome.iterations, 2);
        assert!(!outcome.stopped_at_limit);
        assert_eq!(outcome.steps.len(), 1);
        assert_eq!(outcome.steps[0].name, "echo");
        assert_eq!(outcome.steps[0].result["echoed"]["text"], "test");
        assert!(outcome.message.text_content().contains("Echo:"));
    }

    #[tokio::test]
    async fn streams_tool_loop_events() {
        let service: SharedService = Arc::new(TestBackend::new());
        let tools = Arc::new(ToolRegistry::with_builtins());
        let messages = vec![ChatMessage::text("user", "/tool please")];
        let mut stream = Box::pin(run_agent_stream(
            service,
            tools,
            "test-echo".into(),
            messages,
            None,
        ));

        let mut kinds = Vec::new();
        while let Some(ev) = stream.next().await {
            kinds.push(match ev {
                AgentEvent::Start { .. } => "start",
                AgentEvent::Token { .. } => "token",
                AgentEvent::Reasoning { .. } => "reasoning",
                AgentEvent::UsageDelta { .. } => "usage_delta",
                AgentEvent::ToolCall { .. } => "tool_call",
                AgentEvent::ToolResult { .. } => "tool_result",
                AgentEvent::MemoryRegistered { .. } => "memory_registered",
                AgentEvent::ChildThreadStarted { .. } => "child_thread_started",
                AgentEvent::ChildThreadDone { .. } => "child_thread_done",
                AgentEvent::ChildThreadError { .. } => "child_thread_error",
                AgentEvent::Final { .. } => "final",
                AgentEvent::Done { .. } => "done",
                AgentEvent::Error { .. } => "error",
            });
        }
        assert_eq!(kinds.first(), Some(&"start"));
        assert!(kinds.contains(&"tool_call"));
        assert!(kinds.contains(&"tool_result"));
        assert!(kinds.contains(&"final"));
        assert_eq!(kinds.last(), Some(&"done"));
    }

    #[tokio::test]
    async fn streams_usage_summed_across_model_turns() {
        let service: SharedService = Arc::new(TestBackend::new());
        let tools = Arc::new(ToolRegistry::with_builtins());
        let messages = vec![ChatMessage::text("user", "/tool please")];
        let mut stream = Box::pin(run_agent_stream(
            service,
            tools,
            "test-echo".into(),
            messages,
            None,
        ));

        let mut usage = None;
        let mut deltas = Vec::new();
        while let Some(ev) = stream.next().await {
            match ev {
                AgentEvent::UsageDelta { usage: u } => deltas.push(u),
                AgentEvent::Done { usage: u, .. } => usage = Some(u),
                _ => {}
            }
        }

        let usage = usage.expect("agent stream should finish with usage");
        assert_eq!(usage.prompt_tokens, 5);
        assert_eq!(usage.completion_tokens, 7);
        assert_eq!(usage.total_tokens, 12);
        assert_eq!(deltas.len(), 2);
        let summed = deltas
            .into_iter()
            .fold(Usage::default(), |mut total, usage| {
                add_usage(&mut total, usage);
                total
            });
        assert_eq!(summed.prompt_tokens, usage.prompt_tokens);
        assert_eq!(summed.completion_tokens, usage.completion_tokens);
        assert_eq!(summed.total_tokens, usage.total_tokens);
    }

    #[test]
    fn split_tool_image_extracts_and_strips() {
        let result = json!({"path":"x.png","width":100,"image":{"mime":"image/png","data":"AAAA"}});
        let (visible, uri) = split_tool_image(result);
        assert_eq!(uri.as_deref(), Some("data:image/png;base64,AAAA"));
        assert!(
            visible.get("image").is_none(),
            "image must be stripped from visible result"
        );
        assert_eq!(visible["path"], "x.png");
    }

    #[test]
    fn split_tool_image_passthrough_without_image() {
        let (visible, uri) = split_tool_image(json!({"ok": true}));
        assert!(uri.is_none());
        assert_eq!(visible["ok"], true);
    }

    #[test]
    fn tool_replay_keeps_small_results() {
        let text = r#"{"ok":true}"#;
        assert_eq!(truncate_tool_replay_text(text), text);
    }

    #[test]
    fn tool_replay_truncates_large_results_by_bytes() {
        let text = "a".repeat(TOOL_REPLAY_MAX_BYTES + 10);
        let replay = truncate_tool_replay_text(&text);
        assert!(replay.starts_with(&"a".repeat(TOOL_REPLAY_MAX_BYTES)));
        assert!(replay.contains("tool result truncated for replay"));
        assert!(replay.contains("omitted 10 bytes"));
    }

    #[test]
    fn tool_replay_truncates_large_results_by_lines() {
        let text = (0..=TOOL_REPLAY_MAX_LINES)
            .map(|index| index.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let replay = truncate_tool_replay_text(&text);
        assert!(replay.contains("tool result truncated for replay"));
        assert!(replay.contains("omitted 1 lines"));
        assert!(!replay.ends_with(&TOOL_REPLAY_MAX_LINES.to_string()));
    }

    #[test]
    fn tool_replay_truncates_on_utf8_boundary() {
        let text = "é".repeat((TOOL_REPLAY_MAX_BYTES / "é".len()) + 10);
        let replay = truncate_tool_replay_text(&text);
        assert!(replay.contains("tool result truncated for replay"));
        assert!(replay.is_char_boundary(TOOL_REPLAY_MAX_BYTES));
    }

    #[test]
    fn image_user_message_is_multimodal() {
        let m = image_user_message("screenshot", "data:image/png;base64,AAAA".into());
        assert_eq!(m.role, "user");
        match m.content.unwrap() {
            Content::Parts(p) => {
                assert_eq!(p.len(), 2);
                assert!(matches!(p[1], ContentPart::ImageUrl { .. }));
            }
            _ => panic!("expected multimodal parts"),
        }
    }

    #[tokio::test]
    async fn answers_directly_without_tools() {
        let service = TestBackend::new();
        let tools = ToolRegistry::new();
        let messages = vec![ChatMessage::text("user", "hello")];
        let outcome = run_agent(&service, &tools, "test-echo", messages, None)
            .await
            .unwrap();
        assert_eq!(outcome.iterations, 1);
        assert!(outcome.steps.is_empty());
        assert_eq!(outcome.message.text_content(), "Echo: hello");
    }

    #[tokio::test]
    async fn forwards_reasoning_effort_to_model_turns() {
        let service = TestBackend::new();
        let tools = ToolRegistry::new();
        let messages = vec![ChatMessage::text("user", "hello")];
        let _ = run_agent(
            &service,
            &tools,
            "test-echo",
            messages,
            Some(ReasoningEffort::High),
        )
        .await
        .unwrap();
        assert_eq!(service.last_reasoning_effort(), Some(ReasoningEffort::High));
    }
}
