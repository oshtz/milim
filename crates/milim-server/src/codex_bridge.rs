//! Thin bridge to the official `codex app-server` JSON-RPC surface.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::process::Stdio;
use std::time::Duration;
#[cfg(windows)]
use std::{env, path::PathBuf};

use axum::response::sse::Event;
use futures::{Stream, StreamExt};
use milim_core::api::openai::{ReasoningEffort, Usage};
use milim_core::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::privacy::Unredactor;

const CODEX_MODEL_FALLBACK: &str = "gpt-5.4";
const CODEX_LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const CODEX_CLIENT_NAME: &str = "milim";
const CODEX_CLIENT_TITLE: &str = "Milim";

#[derive(Debug, Deserialize)]
pub(crate) struct CodexRunRequest {
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub persist_thread: bool,
    #[serde(default)]
    pub tool_approval_policy: Option<String>,
    #[serde(default)]
    pub tool_approval_grant: bool,
    #[serde(default)]
    pub plan_mode: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CodexApiKeyLoginRequest {
    pub api_key: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CodexStreamEvent {
    Thread {
        thread_id: String,
        model: String,
    },
    Start {
        thread_id: String,
        turn_id: String,
    },
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
    Done {
        thread_id: String,
        turn_id: Option<String>,
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
    Image {
        id: String,
        status: String,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        revised_prompt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        saved_path: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum AccountWorkerEvent {
    Session {
        runtime: String,
        external_thread_id: String,
        model: String,
    },
    Started {
        runtime: String,
        external_thread_id: Option<String>,
        external_turn_id: Option<String>,
    },
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
        label: Option<String>,
        detail: Option<String>,
        icon: Option<String>,
    },
    NativeWorker {
        lifecycle: AccountNativeWorkerLifecycle,
    },
    Done {
        status: String,
        usage: Option<Usage>,
        cost_usd: Option<f64>,
    },
    Error {
        message: String,
        usage: Option<Usage>,
        cost_usd: Option<f64>,
    },
    Warning {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct AccountNativeWorkerLifecycle {
    pub runtime: String,
    pub call_id: String,
    pub operation: String,
    pub status: String,
    pub parent_runtime_id: Option<String>,
    pub worker_runtime_ids: Vec<String>,
    pub workers: Vec<AccountNativeWorkerState>,
    pub prompt: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct AccountNativeWorkerState {
    pub runtime_id: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CodexLoginEvent {
    Browser {
        login_id: String,
        auth_url: String,
    },
    DeviceCode {
        login_id: String,
        user_code: String,
        verification_url: String,
    },
    Done {
        success: bool,
        error: Option<String>,
    },
    Error {
        message: String,
    },
    Warning {
        message: String,
    },
}

pub(crate) async fn account(refresh_token: bool) -> Result<Value> {
    let mut proc = CodexProcess::start().await?;
    proc.request(
        "account/read",
        Some(json!({ "refreshToken": refresh_token })),
    )
    .await
}

pub(crate) async fn logout() -> Result<Value> {
    let mut proc = CodexProcess::start().await?;
    proc.request("account/logout", None).await
}

pub(crate) async fn rate_limits() -> Result<Value> {
    let mut proc = CodexProcess::start().await?;
    proc.request("account/rateLimits/read", None).await
}

pub(crate) async fn models() -> Result<Value> {
    let mut proc = CodexProcess::start().await?;
    proc.request(
        "model/list",
        Some(json!({ "includeHidden": false, "limit": 100 })),
    )
    .await
}

pub(crate) async fn login_api_key(api_key: String) -> Result<Value> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(Error::InvalidRequest(
            "Codex API key is required".to_string(),
        ));
    }
    let mut proc = CodexProcess::start().await?;
    proc.request(
        "account/login/start",
        Some(json!({ "type": "apiKey", "apiKey": api_key })),
    )
    .await
}

pub(crate) fn login_device_stream() -> impl Stream<Item = std::result::Result<Event, Infallible>> {
    login_stream("chatgpt")
}

pub(crate) fn login_chatgpt_device_code_stream(
) -> impl Stream<Item = std::result::Result<Event, Infallible>> {
    login_stream("chatgptDeviceCode")
}

fn login_stream(
    login_type: &'static str,
) -> impl Stream<Item = std::result::Result<Event, Infallible>> {
    async_stream::stream! {
        let mut proc = match CodexProcess::start().await {
            Ok(proc) => proc,
            Err(e) => {
                let message = e.to_string();
                if is_cli_path_warning(&message) {
                    yield sse_event(&CodexLoginEvent::Warning { message });
                } else {
                    yield sse_event(&CodexLoginEvent::Error { message });
                }
                yield Ok(Event::default().data("[DONE]"));
                return;
            }
        };
        let started = match proc
            .request(
                "account/login/start",
                Some(json!({ "type": login_type })),
            )
            .await
        {
            Ok(value) => value,
            Err(e) => {
                yield sse_event(&CodexLoginEvent::Error { message: e.to_string() });
                yield Ok(Event::default().data("[DONE]"));
                return;
            }
        };

        let login_id = match extract_string(&started, &["loginId"]) {
            Some(id) => id,
            None => {
                yield sse_event(&CodexLoginEvent::Error {
                    message: "codex app-server did not return a login id".to_string(),
                });
                yield Ok(Event::default().data("[DONE]"));
                return;
            }
        };
        match started.get("type").and_then(Value::as_str) {
            Some("chatgpt") => match extract_string(&started, &["authUrl"]) {
                Some(auth_url) => yield sse_event(&CodexLoginEvent::Browser {
                    login_id: login_id.clone(),
                    auth_url,
                }),
                None => {
                    yield sse_event(&CodexLoginEvent::Error {
                        message: "codex app-server did not return an auth URL".to_string(),
                    });
                    yield Ok(Event::default().data("[DONE]"));
                    return;
                }
            },
            _ => {
                let user_code = match extract_string(&started, &["userCode"]) {
                    Some(code) => code,
                    None => {
                        yield sse_event(&CodexLoginEvent::Error {
                            message: "codex app-server did not return a device code".to_string(),
                        });
                        yield Ok(Event::default().data("[DONE]"));
                        return;
                    }
                };
                let verification_url = match extract_string(&started, &["verificationUrl"]) {
                    Some(url) => url,
                    None => {
                        yield sse_event(&CodexLoginEvent::Error {
                            message: "codex app-server did not return a verification URL".to_string(),
                        });
                        yield Ok(Event::default().data("[DONE]"));
                        return;
                    }
                };
                yield sse_event(&CodexLoginEvent::DeviceCode {
                    login_id: login_id.clone(),
                    user_code,
                    verification_url,
                });
            }
        }

        loop {
            let msg = match tokio::time::timeout(CODEX_LOGIN_TIMEOUT, proc.read_value()).await {
                Ok(Ok(msg)) => msg,
                Ok(Err(e)) => {
                    yield sse_event(&CodexLoginEvent::Error { message: e.to_string() });
                    yield Ok(Event::default().data("[DONE]"));
                    return;
                }
                Err(_) => {
                    let _ = proc
                        .request("account/login/cancel", Some(json!({ "loginId": login_id })))
                        .await;
                    yield sse_event(&CodexLoginEvent::Error {
                        message: "Codex login timed out before completion.".to_string(),
                    });
                    yield Ok(Event::default().data("[DONE]"));
                    return;
                }
            };
            if msg.get("method").and_then(Value::as_str) != Some("account/login/completed") {
                continue;
            }
            let params = msg.get("params").unwrap_or(&Value::Null);
            let notification_login_id = params.get("loginId").and_then(Value::as_str);
            if notification_login_id.is_some() && notification_login_id != Some(login_id.as_str()) {
                continue;
            }
            yield sse_event(&CodexLoginEvent::Done {
                success: params
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                error: params
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
            yield Ok(Event::default().data("[DONE]"));
            return;
        }
    }
}

pub(crate) fn run_stream(
    req: CodexRunRequest,
    redactions: BTreeMap<String, String>,
) -> impl Stream<Item = std::result::Result<Event, Infallible>> {
    async_stream::stream! {
        let (worker_tx, mut worker_rx) = tokio::sync::mpsc::unbounded_channel();
        let stream = run_stream_with_worker_events(req, redactions, Some(worker_tx));
        futures::pin_mut!(stream);
        while let Some(event) = stream.next().await {
            yield event;
            while let Ok(worker) = worker_rx.try_recv() {
                if matches!(worker, AccountWorkerEvent::NativeWorker { .. }) {
                    yield sse_event(&worker);
                }
            }
        }
    }
}

pub(crate) fn run_read_only_worker_events(
    prompt: String,
    model: Option<String>,
    cwd: Option<String>,
    redactions: BTreeMap<String, String>,
) -> impl Stream<Item = AccountWorkerEvent> {
    let req = read_only_worker_request(prompt, model, cwd);
    async_stream::stream! {
        let (worker_tx, mut worker_rx) = tokio::sync::mpsc::unbounded_channel();
        let stream = run_stream_with_worker_events(req, redactions, Some(worker_tx));
        futures::pin_mut!(stream);
        while stream.next().await.is_some() {
            while let Ok(event) = worker_rx.try_recv() {
                yield event;
            }
        }
        while let Ok(event) = worker_rx.try_recv() {
            yield event;
        }
    }
}

fn run_stream_with_worker_events(
    req: CodexRunRequest,
    redactions: BTreeMap<String, String>,
    worker_events: Option<tokio::sync::mpsc::UnboundedSender<AccountWorkerEvent>>,
) -> impl Stream<Item = std::result::Result<Event, Infallible>> {
    async_stream::stream! {
        let mut proc = match CodexProcess::start().await {
            Ok(proc) => proc,
            Err(e) => {
                let message = e.to_string();
                if is_cli_path_warning(&message) {
                    yield sse_event_with_worker(&CodexStreamEvent::Warning { message }, &worker_events);
                } else {
                    yield sse_event_with_worker(&CodexStreamEvent::Error {
                        message,
                        usage: None,
                        cost_usd: None,
                    }, &worker_events);
                }
                yield Ok(Event::default().data("[DONE]"));
                return;
            }
        };

        let model = clean_model(req.model.as_deref());
        let (thread_method, thread_params) = codex_thread_request(&req, model);

        let thread = match proc.request(thread_method, Some(thread_params)).await {
            Ok(value) => value,
            Err(e) => {
                yield sse_event_with_worker(&CodexStreamEvent::Error {
                    message: e.to_string(),
                    usage: None,
                    cost_usd: None,
                }, &worker_events);
                yield Ok(Event::default().data("[DONE]"));
                return;
            }
        };
        let thread_id = match extract_string(&thread, &["thread", "id"]) {
            Some(id) => id,
            None => {
                yield sse_event_with_worker(&CodexStreamEvent::Error {
                    message: "codex app-server did not return a thread id".to_string(),
                    usage: None,
                    cost_usd: None,
                }, &worker_events);
                yield Ok(Event::default().data("[DONE]"));
                return;
            }
        };
        yield sse_event_with_worker(&CodexStreamEvent::Thread {
            thread_id: thread_id.clone(),
            model: model.to_string(),
        }, &worker_events);

        let cwd = clean_optional(req.cwd.as_deref());
        let mut turn_params = json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": req.prompt }],
            "model": model,
            "approvalPolicy": codex_approval_policy(&req),
            "sandboxPolicy": codex_sandbox_policy(&req, cwd.as_deref()),
        });
        if let Some(effort) = req.reasoning_effort.filter(|effort| !effort.is_auto()) {
            turn_params["effort"] = Value::String(effort.as_str().to_string());
        }
        if let Some(cwd) = cwd {
            turn_params["cwd"] = Value::String(cwd);
        }

        let turn_request_id = match proc.send_request("turn/start", Some(turn_params)).await {
            Ok(id) => id,
            Err(e) => {
                yield sse_event_with_worker(&CodexStreamEvent::Error {
                    message: e.to_string(),
                    usage: None,
                    cost_usd: None,
                }, &worker_events);
                yield Ok(Event::default().data("[DONE]"));
                return;
            }
        };

        let mut turn_id: Option<String> = None;
        let mut content = Unredactor::new(redactions.clone());
        let mut reasoning = Unredactor::new(redactions);
        let mut last_agent_message_id: Option<String> = None;
        let mut emitted_agent_text = false;

        loop {
            let msg = match proc.read_value().await {
                Ok(msg) => msg,
                Err(e) => {
                    yield sse_event_with_worker(&CodexStreamEvent::Error {
                        message: e.to_string(),
                        usage: None,
                        cost_usd: None,
                    }, &worker_events);
                    yield Ok(Event::default().data("[DONE]"));
                    return;
                }
            };

            if response_id(&msg) == Some(turn_request_id) {
                if let Some(error) = msg.get("error") {
                    yield sse_event_with_worker(&CodexStreamEvent::Error {
                        message: rpc_error_message(error),
                        usage: usage_from_any(&msg),
                        cost_usd: cost_from_any(&msg),
                    }, &worker_events);
                    yield Ok(Event::default().data("[DONE]"));
                    return;
                }
                turn_id = extract_string(&msg, &["result", "turn", "id"]);
                if let Some(id) = &turn_id {
                    yield sse_event_with_worker(&CodexStreamEvent::Start {
                        thread_id: thread_id.clone(),
                        turn_id: id.clone(),
                    }, &worker_events);
                }
                continue;
            }

            let Some(method) = msg.get("method").and_then(Value::as_str) else {
                continue;
            };
            let params = msg.get("params").unwrap_or(&Value::Null);
            match method {
                "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                    if let Some(id) = response_id(&msg) {
                        let result = codex_approval_response(&req, method);
                        if let Err(e) = proc.respond(id, result).await {
                            yield sse_event_with_worker(&CodexStreamEvent::Error {
                                message: e.to_string(),
                                usage: None,
                                cost_usd: None,
                            }, &worker_events);
                            yield Ok(Event::default().data("[DONE]"));
                            return;
                        }
                    }
                }
                "item/started" => {
                    if let Some(event) = codex_native_worker_event(params.get("item").unwrap_or(&Value::Null)) {
                        publish_worker(&worker_events, AccountWorkerEvent::NativeWorker { lifecycle: event });
                    }
                    if let Some(event) = tool_event_from_item(params.get("item").unwrap_or(&Value::Null), true) {
                        yield sse_event_with_worker(&event, &worker_events);
                    }
                }
                "item/agentMessage/delta" => {
                    if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                        let item_id = extract_string(params, &["itemId"])
                            .or_else(|| extract_string(params, &["item", "id"]));
                        if item_id.is_some() && item_id != last_agent_message_id {
                            if emitted_agent_text {
                                yield sse_event_with_worker(&CodexStreamEvent::Token {
                                    text: "\n\n".to_string(),
                                }, &worker_events);
                            }
                            last_agent_message_id = item_id;
                        }
                        let text = content.push(delta);
                        if !text.is_empty() {
                            emitted_agent_text = true;
                            yield sse_event_with_worker(&CodexStreamEvent::Token { text }, &worker_events);
                        }
                    }
                }
                "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
                    if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                        let text = reasoning.push(delta);
                        if !text.is_empty() {
                            yield sse_event_with_worker(&CodexStreamEvent::Reasoning { text }, &worker_events);
                        }
                    }
                }
                "item/completed" | "rawResponseItem/completed" => {
                    let item = params.get("item").unwrap_or(&Value::Null);
                    if let Some(event) = codex_native_worker_event(item) {
                        publish_worker(&worker_events, AccountWorkerEvent::NativeWorker { lifecycle: event });
                    }
                    if let Some(event) = image_event_from_item(item) {
                        yield sse_event(&event);
                    }
                    if let Some(event) = tool_event_from_item(item, false) {
                        yield sse_event_with_worker(&event, &worker_events);
                    }
                }
                "turn/completed" => {
                    let tail = content.flush();
                    if !tail.is_empty() {
                        yield sse_event_with_worker(&CodexStreamEvent::Token { text: tail }, &worker_events);
                    }
                    let rtail = reasoning.flush();
                    if !rtail.is_empty() {
                        yield sse_event_with_worker(&CodexStreamEvent::Reasoning { text: rtail }, &worker_events);
                    }

                    let status = extract_string(params, &["turn", "status"])
                        .unwrap_or_else(|| "completed".to_string());
                    let completed_turn_id = extract_string(params, &["turn", "id"]).or_else(|| turn_id.clone());
                    let usage = usage_from_any(params);
                    let cost_usd = cost_from_any(params);
                    if status == "failed" {
                        let message = extract_string(params, &["turn", "error", "message"])
                            .unwrap_or_else(|| "codex turn failed".to_string());
                        yield sse_event_with_worker(&CodexStreamEvent::Error {
                            message,
                            usage,
                            cost_usd,
                        }, &worker_events);
                    } else {
                        yield sse_event_with_worker(&CodexStreamEvent::Done {
                            thread_id: thread_id.clone(),
                            turn_id: completed_turn_id,
                            status,
                            usage,
                            cost_usd,
                        }, &worker_events);
                    }
                    yield Ok(Event::default().data("[DONE]"));
                    return;
                }
                "error" => {
                    let message = params
                        .get("error")
                        .map(rpc_error_message)
                        .unwrap_or_else(|| "codex app-server reported an error".to_string());
                    yield sse_event_with_worker(&CodexStreamEvent::Error {
                        message,
                        usage: usage_from_any(params),
                        cost_usd: cost_from_any(params),
                    }, &worker_events);
                    yield Ok(Event::default().data("[DONE]"));
                    return;
                }
                _ => {}
            }
        }
    }
}

fn sse_event<T: Serialize>(value: &T) -> std::result::Result<Event, Infallible> {
    Ok(Event::default().data(serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())))
}

fn sse_event_with_worker(
    value: &CodexStreamEvent,
    worker_events: &Option<tokio::sync::mpsc::UnboundedSender<AccountWorkerEvent>>,
) -> std::result::Result<Event, Infallible> {
    if let Some(event) = account_worker_event_from_codex(value) {
        publish_worker(worker_events, event);
    }
    sse_event(value)
}

fn publish_worker(
    worker_events: &Option<tokio::sync::mpsc::UnboundedSender<AccountWorkerEvent>>,
    event: AccountWorkerEvent,
) {
    if let Some(worker_events) = worker_events {
        let _ = worker_events.send(event);
    }
}

fn account_worker_event_from_codex(value: &CodexStreamEvent) -> Option<AccountWorkerEvent> {
    match value {
        CodexStreamEvent::Thread { thread_id, model } => Some(AccountWorkerEvent::Session {
            runtime: "codex".to_string(),
            external_thread_id: thread_id.clone(),
            model: model.clone(),
        }),
        CodexStreamEvent::Start { thread_id, turn_id } => Some(AccountWorkerEvent::Started {
            runtime: "codex".to_string(),
            external_thread_id: Some(thread_id.clone()),
            external_turn_id: Some(turn_id.clone()),
        }),
        CodexStreamEvent::Token { text } => Some(AccountWorkerEvent::Token { text: text.clone() }),
        CodexStreamEvent::Reasoning { text } => {
            Some(AccountWorkerEvent::Reasoning { text: text.clone() })
        }
        CodexStreamEvent::Tool {
            id,
            name,
            status,
            label,
            detail,
            icon,
        } => Some(AccountWorkerEvent::Tool {
            id: id.clone(),
            name: name.clone(),
            status: status.clone(),
            label: label.clone(),
            detail: detail.clone(),
            icon: icon.clone(),
        }),
        CodexStreamEvent::Done {
            status,
            usage,
            cost_usd,
            ..
        } => Some(AccountWorkerEvent::Done {
            status: status.clone(),
            usage: *usage,
            cost_usd: *cost_usd,
        }),
        CodexStreamEvent::Error {
            message,
            usage,
            cost_usd,
        } => Some(AccountWorkerEvent::Error {
            message: message.clone(),
            usage: *usage,
            cost_usd: *cost_usd,
        }),
        CodexStreamEvent::Warning { message } => Some(AccountWorkerEvent::Warning {
            message: message.clone(),
        }),
        CodexStreamEvent::Image { .. } => None,
    }
}

struct CodexProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl CodexProcess {
    async fn start() -> Result<Self> {
        let mut command = codex_command();
        command
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // Don't flash a console window when spawning codex on Windows.
        #[cfg(windows)]
        command.creation_flags(milim_core::proc::CREATE_NO_WINDOW);

        let mut child = command
            .spawn()
            .map_err(|e| Error::Upstream(codex_spawn_error_message(&e)))?;
        let stdin = child.stdin.take().ok_or_else(|| {
            Error::Upstream("codex app-server stdin was not available".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            Error::Upstream("codex app-server stdout was not available".to_string())
        })?;
        let mut proc = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
            next_id: 1,
        };
        proc.initialize().await?;
        Ok(proc)
    }

    async fn initialize(&mut self) -> Result<()> {
        self.request(
            "initialize",
            Some(json!({
                "clientInfo": {
                    "name": CODEX_CLIENT_NAME,
                    "title": CODEX_CLIENT_TITLE,
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "experimentalApi": true,
                },
            })),
        )
        .await?;
        self.notify("initialized", json!({})).await
    }

    async fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value> {
        let id = self.send_request(method, params).await?;
        loop {
            let msg = self.read_value().await?;
            if response_id(&msg) != Some(id) {
                continue;
            }
            if let Some(error) = msg.get("error") {
                return Err(Error::Upstream(rpc_error_message(error)));
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn send_request(&mut self, method: &str, params: Option<Value>) -> Result<u64> {
        let id = self.next_id;
        self.next_id += 1;
        let mut msg = json!({ "method": method, "id": id });
        if let Some(params) = params {
            msg["params"] = params;
        }
        self.write_value(&msg).await?;
        Ok(id)
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.write_value(&json!({ "method": method, "params": params }))
            .await
    }

    async fn respond(&mut self, id: u64, result: Value) -> Result<()> {
        self.write_value(&json!({ "id": id, "result": result }))
            .await
    }

    async fn write_value(&mut self, value: &Value) -> Result<()> {
        let line = serde_json::to_string(value)?;
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn read_value(&mut self) -> Result<Value> {
        let line = self.stdout.next_line().await?.ok_or_else(|| {
            let status = self.child.try_wait().ok().flatten();
            match status {
                Some(status) => Error::Upstream(format!("codex app-server exited with {status}")),
                None => Error::Upstream("codex app-server closed stdout".to_string()),
            }
        })?;
        serde_json::from_str(&line).map_err(|e| {
            Error::Upstream(format!(
                "codex app-server emitted invalid JSON: {e}; line={line}"
            ))
        })
    }
}

#[cfg(windows)]
fn codex_command() -> Command {
    if let Some(path) = find_on_path("codex.cmd") {
        if let Some(command) = codex_npm_command(&path) {
            return command;
        }
        let mut fallback = Command::new("cmd");
        fallback.arg("/C").arg(path);
        return fallback;
    }
    if let Some(path) = find_on_path("codex.exe") {
        return Command::new(path);
    }
    Command::new("codex.exe")
}

#[cfg(not(windows))]
fn codex_command() -> Command {
    Command::new("codex")
}

#[cfg(windows)]
fn find_on_path(name: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(windows)]
fn codex_npm_command(cmd_path: &std::path::Path) -> Option<Command> {
    let basedir = cmd_path.parent()?;
    let script = basedir
        .join("node_modules")
        .join("@openai")
        .join("codex")
        .join("bin")
        .join("codex.js");
    if !script.is_file() {
        return None;
    }
    let node = find_on_path("node.exe").unwrap_or_else(|| PathBuf::from("node.exe"));
    let mut command = Command::new(node);
    command.arg(script);
    Some(command)
}

fn clean_model(value: Option<&str>) -> &str {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(CODEX_MODEL_FALLBACK)
}

fn clean_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn codex_thread_request(req: &CodexRunRequest, model: &str) -> (&'static str, Value) {
    let cwd = clean_optional(req.cwd.as_deref());
    let mut params = json!({
        "model": model,
        "approvalPolicy": codex_approval_policy(req),
        "sandbox": codex_sandbox_mode(req, cwd.as_deref()),
        "developerInstructions": codex_developer_instructions(),
    });
    if let Some(cwd) = cwd {
        params["cwd"] = Value::String(cwd);
    }
    if let Some(thread_id) = clean_optional(req.thread_id.as_deref()) {
        params["threadId"] = Value::String(thread_id);
        ("thread/resume", params)
    } else {
        if !req.persist_thread {
            params["ephemeral"] = Value::Bool(true);
        }
        ("thread/start", params)
    }
}

fn read_only_worker_request(
    prompt: String,
    model: Option<String>,
    cwd: Option<String>,
) -> CodexRunRequest {
    CodexRunRequest {
        prompt,
        model,
        cwd,
        reasoning_effort: None,
        thread_id: None,
        persist_thread: false,
        tool_approval_policy: Some("guarded".to_string()),
        tool_approval_grant: false,
        plan_mode: false,
    }
}

fn account_runtime_policy(value: Option<&str>) -> &str {
    match value.map(str::trim) {
        Some("review") => "review",
        Some("open") => "open",
        _ => "guarded",
    }
}

fn codex_tools_allowed(req: &CodexRunRequest) -> bool {
    !req.plan_mode
        && match account_runtime_policy(req.tool_approval_policy.as_deref()) {
            "review" => req.tool_approval_grant,
            _ => true,
        }
}

fn codex_approval_policy(req: &CodexRunRequest) -> &'static str {
    if !codex_tools_allowed(req)
        || account_runtime_policy(req.tool_approval_policy.as_deref()) == "guarded"
    {
        "onRequest"
    } else {
        // Matches Milim's Open mode: no per-tool prompt after the user selected Open or approved a Review run.
        "never"
    }
}

fn codex_sandbox_policy(req: &CodexRunRequest, cwd: Option<&str>) -> Value {
    if codex_sandbox_mode(req, cwd) == "workspace-write" {
        return json!({
            "type": "workspaceWrite",
            "writableRoots": [cwd.unwrap_or_default()],
            "networkAccess": true,
        });
    }
    json!({ "type": "readOnly", "access": { "type": "fullAccess" } })
}

fn codex_sandbox_mode(req: &CodexRunRequest, cwd: Option<&str>) -> &'static str {
    let policy = account_runtime_policy(req.tool_approval_policy.as_deref());
    let mutations_allowed = policy == "open" || (policy == "review" && req.tool_approval_grant);
    if !req.plan_mode && mutations_allowed && cwd.is_some() {
        "workspace-write"
    } else {
        "read-only"
    }
}

fn codex_approval_response(req: &CodexRunRequest, method: &str) -> Value {
    let policy = account_runtime_policy(req.tool_approval_policy.as_deref());
    let decision = if !codex_tools_allowed(req)
        || (policy == "guarded" && method == "item/commandExecution/requestApproval")
    {
        "decline"
    } else if policy == "guarded" {
        "accept"
    } else {
        "acceptForSession"
    };
    json!({ "decision": decision })
}

fn image_event_from_item(item: &Value) -> Option<CodexStreamEvent> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    if item_type != "imageGeneration" && item_type != "image_generation_call" {
        return None;
    }
    let result = item.get("result").and_then(Value::as_str)?;
    let url = image_result_url(result)?;
    Some(CodexStreamEvent::Image {
        id: extract_string(item, &["id"]).unwrap_or_else(|| "codex-image".to_string()),
        status: extract_string(item, &["status"]).unwrap_or_else(|| "completed".to_string()),
        url,
        revised_prompt: extract_string(item, &["revisedPrompt"])
            .or_else(|| extract_string(item, &["revised_prompt"])),
        saved_path: extract_string(item, &["savedPath"]),
    })
}

fn image_result_url(result: &str) -> Option<String> {
    let trimmed = result.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("data:image/")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
    {
        return Some(trimmed.to_string());
    }
    // ponytail: base64 over SSE is enough for Codex image previews; save-to-file if payload size hurts.
    Some(format!("data:image/png;base64,{trimmed}"))
}

fn tool_event_from_item(item: &Value, running: bool) -> Option<CodexStreamEvent> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    let id = extract_string(item, &["id"]).unwrap_or_else(|| item_type.to_string());
    let status = if running {
        "running".to_string()
    } else {
        match item
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("completed")
            .to_ascii_lowercase()
            .as_str()
        {
            "failed" | "declined" | "cancelled" | "canceled" | "error" => "error".to_string(),
            _ => "done".to_string(),
        }
    };

    let (name, label, detail, icon) = match item_type {
        "commandExecution" => (
            "shell".to_string(),
            match status.as_str() {
                "running" => "Running command",
                "error" => "Command failed",
                _ => "Ran command",
            }
            .to_string(),
            command_detail(item),
            "command".to_string(),
        ),
        "fileChange" => (
            "patch_file".to_string(),
            match status.as_str() {
                "running" => "Editing files",
                "error" => "File edit failed",
                _ => "Edited files",
            }
            .to_string(),
            file_change_detail(item),
            "file".to_string(),
        ),
        "dynamicToolCall" | "mcpToolCall" | "collabToolCall" => {
            let tool = extract_string(item, &["tool"]).unwrap_or_else(|| item_type.to_string());
            (
                tool.clone(),
                match status.as_str() {
                    "running" => format!("Using {tool}"),
                    "error" => format!("{tool} failed"),
                    _ => format!("Used {tool}"),
                },
                compact_json(item.get("arguments").or_else(|| item.get("input"))),
                "tool".to_string(),
            )
        }
        "webSearch" => (
            "web_search".to_string(),
            match status.as_str() {
                "running" => "Searching web",
                "error" => "Web search failed",
                _ => "Searched web",
            }
            .to_string(),
            web_search_detail(item),
            "tool".to_string(),
        ),
        "imageView" => (
            "image_view".to_string(),
            match status.as_str() {
                "running" => "Viewing image",
                "error" => "Image view failed",
                _ => "Viewed image",
            }
            .to_string(),
            extract_string(item, &["path"]).map(|path| compact(&path, 110)),
            "screen".to_string(),
        ),
        "contextCompaction" => (
            "context_compaction".to_string(),
            match status.as_str() {
                "running" => "Compacting context",
                "error" => "Context compaction failed",
                _ => "Compacted context",
            }
            .to_string(),
            None,
            "tool".to_string(),
        ),
        _ => return None,
    };

    Some(CodexStreamEvent::Tool {
        id,
        name,
        status,
        label: Some(label),
        detail,
        icon: Some(icon),
    })
}

fn codex_native_worker_event(item: &Value) -> Option<AccountNativeWorkerLifecycle> {
    match item.get("type").and_then(Value::as_str)? {
        "collabAgentToolCall" | "collabToolCall" => {}
        _ => return None,
    }
    let call_id = extract_string(item, &["id"])?;
    let operation = extract_string(item, &["tool"])?;
    let parent_runtime_id = extract_string(item, &["senderThreadId"]);
    let worker_runtime_ids = item
        .get("receiverThreadIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if parent_runtime_id.is_none() && worker_runtime_ids.is_empty() {
        return None;
    }
    let workers = item
        .get("agentsStates")
        .and_then(Value::as_object)
        .map(|states| {
            states
                .iter()
                .filter_map(|(runtime_id, value)| {
                    Some(AccountNativeWorkerState {
                        runtime_id: runtime_id.clone(),
                        status: normalized_native_status(value.get("status")?.as_str()?),
                        message: value
                            .get("message")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(AccountNativeWorkerLifecycle {
        runtime: "codex".to_string(),
        call_id,
        operation,
        status: normalized_native_status(
            item.get("status")
                .and_then(Value::as_str)
                .unwrap_or("inProgress"),
        ),
        parent_runtime_id,
        worker_runtime_ids,
        workers,
        prompt: extract_string(item, &["prompt"]),
        model: extract_string(item, &["model"]),
    })
}

fn normalized_native_status(status: &str) -> String {
    match status {
        "pendingInit" | "inProgress" => "running",
        "completed" | "shutdown" => "completed",
        "failed" | "errored" | "notFound" => "error",
        "interrupted" => "stopped",
        other => other,
    }
    .to_string()
}

fn command_detail(item: &Value) -> Option<String> {
    if let Some(command) = item.get("command").and_then(Value::as_str) {
        return Some(compact(command, 110));
    }
    item.get("command")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|command| !command.trim().is_empty())
        .map(|command| compact(&command, 110))
}

fn file_change_detail(item: &Value) -> Option<String> {
    let changes = item.get("changes").and_then(Value::as_array)?;
    let paths = changes
        .iter()
        .filter_map(|change| {
            extract_string(change, &["path"])
                .or_else(|| extract_string(change, &["file"]))
                .or_else(|| extract_string(change, &["filePath"]))
        })
        .collect::<Vec<_>>();
    if paths.is_empty() {
        Some(format!("{} changes", changes.len()))
    } else {
        Some(compact(&paths.join(", "), 110))
    }
}

fn web_search_detail(item: &Value) -> Option<String> {
    extract_string(item, &["query"])
        .or_else(|| extract_string(item, &["action", "query"]))
        .or_else(|| {
            item.get("action")
                .and_then(|action| action.get("queries"))
                .and_then(Value::as_array)
                .map(|queries| {
                    queries
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
        })
        .or_else(|| extract_string(item, &["action", "url"]))
        .map(|detail| compact(&detail, 110))
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

fn codex_developer_instructions() -> &'static str {
    "You are running inside Milim as a Codex-powered chat runtime. Answer in chat. Respect the tool approval and sandbox settings Milim supplies for each turn."
}

fn response_id(value: &Value) -> Option<u64> {
    value.get("id").and_then(Value::as_u64)
}

fn extract_string(value: &Value, path: &[&str]) -> Option<String> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.get(*key)?;
    }
    cursor.as_str().map(str::to_string)
}

fn rpc_error_message(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| error.to_string())
}

fn codex_spawn_error_message(error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        return cli_path_warning("Codex", "codex");
    }
    format!(
        "failed to start `codex app-server`: {error}. Install or update the Codex CLI and make sure `codex` is on PATH."
    )
}

fn cli_path_warning(label: &str, command: &str) -> String {
    format!("{label} CLI was not found on PATH. If this is macOS, apps launched from Finder or Dock may not inherit your shell PATH, so Milim may not see `{command}` even when Terminal can. Launch Milim from a terminal or add the CLI install folder to PATH for GUI apps.")
}

fn is_cli_path_warning(message: &str) -> bool {
    message.contains("CLI was not found on PATH")
}

fn usage_from_any(value: &Value) -> Option<Usage> {
    if let Some(usage) = usage_from_object(value) {
        return Some(usage);
    }
    match value {
        Value::Object(map) => {
            for key in [
                "usage",
                "tokenUsage",
                "token_usage",
                "response",
                "turn",
                "message",
                "result",
            ] {
                if let Some(usage) = map.get(key).and_then(usage_from_any) {
                    return Some(usage);
                }
            }
            map.values().find_map(usage_from_any)
        }
        Value::Array(items) => items.iter().find_map(usage_from_any),
        _ => None,
    }
}

fn usage_from_object(value: &Value) -> Option<Usage> {
    let prompt = opt_u32_any(value, &["prompt_tokens", "input_tokens"]);
    let completion = opt_u32_any(value, &["completion_tokens", "output_tokens"]);
    let total = opt_u32_any(value, &["total_tokens"]);
    if prompt.is_none() && completion.is_none() && total.is_none() {
        return None;
    }
    let prompt_tokens =
        prompt.unwrap_or_else(|| total.unwrap_or(0).saturating_sub(completion.unwrap_or(0)));
    let completion_tokens =
        completion.unwrap_or_else(|| total.unwrap_or(0).saturating_sub(prompt_tokens));
    Some(Usage {
        prompt_tokens,
        completion_tokens,
        total_tokens: total.unwrap_or(prompt_tokens + completion_tokens),
    })
}

fn cost_from_any(value: &Value) -> Option<f64> {
    match value {
        Value::Object(map) => {
            for key in ["total_cost_usd", "totalCostUsd", "cost_usd", "costUsd"] {
                if let Some(cost) = map.get(key).and_then(Value::as_f64) {
                    return Some(cost);
                }
            }
            map.values().find_map(cost_from_any)
        }
        Value::Array(items) => items.iter().find_map(cost_from_any),
        _ => None,
    }
}

fn opt_u32_any(value: &Value, keys: &[&str]) -> Option<u32> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_nested_string() {
        let value = json!({ "thread": { "id": "thr_123" } });
        assert_eq!(
            extract_string(&value, &["thread", "id"]).as_deref(),
            Some("thr_123")
        );
    }

    #[test]
    fn rpc_error_prefers_message() {
        let value = json!({ "code": -1, "message": "not initialized" });
        assert_eq!(rpc_error_message(&value), "not initialized");
    }

    #[test]
    fn clean_model_uses_fallback_for_empty_values() {
        assert_eq!(clean_model(None), CODEX_MODEL_FALLBACK);
        assert_eq!(clean_model(Some("  ")), CODEX_MODEL_FALLBACK);
        assert_eq!(clean_model(Some(" gpt-5.4 ")), "gpt-5.4");
    }

    #[test]
    fn thread_request_resumes_or_starts_with_expected_persistence() {
        let req = CodexRunRequest {
            prompt: "hi".into(),
            model: None,
            cwd: Some("C:\\repo".into()),
            reasoning_effort: None,
            thread_id: Some("thread-1".into()),
            persist_thread: true,
            tool_approval_policy: Some("open".into()),
            tool_approval_grant: true,
            plan_mode: false,
        };
        let (method, params) = codex_thread_request(&req, "gpt-5.4");
        assert_eq!(method, "thread/resume");
        assert_eq!(params["threadId"], "thread-1");
        assert_eq!(params["sandbox"], "workspace-write");
        assert!(params.get("sandboxPolicy").is_none());
        assert!(params.get("ephemeral").is_none());

        let req = CodexRunRequest {
            thread_id: None,
            persist_thread: false,
            ..req
        };
        let (method, params) = codex_thread_request(&req, "gpt-5.4");
        assert_eq!(method, "thread/start");
        assert_eq!(params["ephemeral"], true);

        let req = CodexRunRequest {
            persist_thread: true,
            ..req
        };
        let (_, params) = codex_thread_request(&req, "gpt-5.4");
        assert!(params.get("ephemeral").is_none());
    }

    #[test]
    fn maps_milim_tool_modes_to_codex_permissions() {
        let mut req = CodexRunRequest {
            prompt: "hi".into(),
            model: None,
            cwd: Some("C:\\repo".into()),
            reasoning_effort: None,
            thread_id: None,
            persist_thread: true,
            tool_approval_policy: Some("guarded".into()),
            tool_approval_grant: false,
            plan_mode: false,
        };
        assert_eq!(codex_approval_policy(&req), "onRequest");
        assert_eq!(codex_sandbox_mode(&req, req.cwd.as_deref()), "read-only");
        assert_eq!(
            codex_sandbox_policy(&req, req.cwd.as_deref())["type"],
            "readOnly"
        );

        req.tool_approval_policy = Some("review".into());
        assert_eq!(codex_approval_policy(&req), "onRequest");
        assert_eq!(codex_sandbox_mode(&req, req.cwd.as_deref()), "read-only");
        assert_eq!(
            codex_sandbox_policy(&req, req.cwd.as_deref())["type"],
            "readOnly"
        );

        req.tool_approval_grant = true;
        assert_eq!(codex_approval_policy(&req), "never");
        assert_eq!(
            codex_sandbox_mode(&req, req.cwd.as_deref()),
            "workspace-write"
        );
        assert_eq!(
            codex_sandbox_policy(&req, req.cwd.as_deref())["type"],
            "workspaceWrite"
        );

        req.plan_mode = true;
        assert_eq!(codex_sandbox_mode(&req, req.cwd.as_deref()), "read-only");
        assert_eq!(
            codex_sandbox_policy(&req, req.cwd.as_deref())["type"],
            "readOnly"
        );
    }

    #[test]
    fn extracts_usage_from_nested_turn_payload() {
        let value = json!({
            "turn": {
                "status": "completed",
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 5,
                    "total_tokens": 17
                }
            },
            "total_cost_usd": 0.002
        });
        let usage = usage_from_any(&value).expect("usage");
        assert_eq!(usage.prompt_tokens, 12);
        assert_eq!(usage.completion_tokens, 5);
        assert_eq!(usage.total_tokens, 17);
        assert_eq!(cost_from_any(&value), Some(0.002));
    }

    #[test]
    fn parses_image_generation_items() {
        let event = image_event_from_item(&json!({
            "type": "imageGeneration",
            "id": "img_1",
            "status": "completed",
            "result": "abc123",
            "revisedPrompt": "a small diagram"
        }));
        assert!(matches!(
            event,
            Some(CodexStreamEvent::Image {
                id,
                status,
                url,
                revised_prompt: Some(prompt),
                ..
            }) if id == "img_1"
                && status == "completed"
                && url == "data:image/png;base64,abc123"
                && prompt == "a small diagram"
        ));
    }

    #[test]
    fn read_only_workers_are_ephemeral_and_cannot_write() {
        let req = read_only_worker_request(
            "inspect the repository".to_string(),
            Some("gpt-5.4-mini".to_string()),
            Some("C:\\repo".to_string()),
        );
        let (method, params) = codex_thread_request(&req, req.model.as_deref().unwrap());
        assert_eq!(method, "thread/start");
        assert_eq!(params["ephemeral"], true);
        assert_eq!(params["sandbox"], "read-only");
        assert_eq!(
            codex_sandbox_policy(&req, req.cwd.as_deref())["type"],
            "readOnly"
        );
        assert_eq!(codex_approval_policy(&req), "onRequest");
    }

    #[test]
    fn maps_codex_collab_lineage_to_native_worker_lifecycle() {
        let event = codex_native_worker_event(&json!({
            "type": "collabAgentToolCall",
            "id": "call-1",
            "tool": "spawnAgent",
            "status": "completed",
            "senderThreadId": "parent-thread",
            "receiverThreadIds": ["worker-thread"],
            "prompt": "review the parser",
            "model": "gpt-5.4-mini",
            "agentsStates": {
                "worker-thread": { "status": "completed", "message": "done" }
            }
        }))
        .expect("native worker event");
        assert_eq!(event.call_id, "call-1");
        assert_eq!(event.operation, "spawnAgent");
        assert_eq!(event.status, "completed");
        assert_eq!(event.parent_runtime_id.as_deref(), Some("parent-thread"));
        assert_eq!(event.worker_runtime_ids, vec!["worker-thread"]);
        assert_eq!(event.workers[0].runtime_id, "worker-thread");
        assert_eq!(event.workers[0].status, "completed");
    }

    #[test]
    fn ignores_codex_collab_items_without_lineage() {
        assert!(codex_native_worker_event(&json!({
            "type": "collabAgentToolCall",
            "id": "call-1",
            "tool": "spawnAgent",
            "status": "inProgress"
        }))
        .is_none());
    }

    #[test]
    fn spawn_not_found_is_path_warning() {
        let error = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        let message = codex_spawn_error_message(&error);
        assert!(is_cli_path_warning(&message));
        assert!(message.contains("codex"));
        assert!(message.contains("macOS"));
    }
}
