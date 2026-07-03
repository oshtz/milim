//! An OpenAI-compatible upstream backend.
//!
//! Translates a backend-neutral [`CompletionRequest`] into an OpenAI Chat
//! Completions request, forwards it to any OpenAI-compatible base URL
//! (OpenAI, Ollama's `/v1`, vLLM, OpenRouter, …), and re-parses the SSE
//! stream back into [`StreamEvent`]s.

use async_trait::async_trait;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use milim_core::api::openai::{
    ChatCompletionChunk, ChatCompletionRequest, Content, ContentPart, DeltaFunction, DeltaToolCall,
    Model, ModelsResponse, ReasoningEffort, StreamOptions, StringOrArray, Tool, Usage,
};
use milim_core::{Error, Result};
use serde_json::{json, Map, Value};

use crate::service::{CompletionRequest, DeltaEvent, EventStream, ModelService, StreamEvent};

/// Forwards generation to an OpenAI-compatible HTTP endpoint.
#[derive(Debug, Clone)]
pub struct RemoteBackend {
    /// Base URL including the version segment, e.g. `https://api.openai.com/v1`.
    base_url: String,
    api_key: Option<String>,
    label: String,
    client: reqwest::Client,
}

#[cfg(not(test))]
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_millis(50);

#[cfg(not(test))]
const DEFAULT_READ_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(test)]
const DEFAULT_READ_TIMEOUT: Duration = Duration::from_millis(100);

impl RemoteBackend {
    /// Build a backend pointing at `base_url` (no trailing slash) with an
    /// optional bearer key. `label` is the [`ModelService::name`] value.
    pub fn new(
        label: impl Into<String>,
        base_url: impl Into<String>,
        api_key: Option<String>,
    ) -> Self {
        Self::with_client(label, base_url, api_key, default_client())
    }

    fn with_client(
        label: impl Into<String>,
        base_url: impl Into<String>,
        api_key: Option<String>,
        client: reqwest::Client,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key,
            label: label.into(),
            client,
        }
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}/{}", self.base_url, path.trim_start_matches('/'))
    }

    fn auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(k) => rb.bearer_auth(k),
            None => rb,
        }
    }

    /// Build the OpenAI wire body from a neutral request.
    fn build_body(&self, req: &CompletionRequest, stream: bool) -> ChatCompletionRequest {
        let s = &req.sampling;
        let mut extra = serde_json::Map::new();
        let reasoning_effort = self.reasoning_effort_for_body(req.reasoning_effort, &req.model);
        if let Some(effort) = reasoning_effort.openrouter {
            extra.insert(
                "reasoning".to_string(),
                json!({ "effort": effort.as_str() }),
            );
        }
        ChatCompletionRequest {
            model: req.model.clone(),
            messages: req.messages.clone(),
            temperature: s.temperature,
            top_p: s.top_p,
            max_tokens: s.max_tokens,
            max_completion_tokens: None,
            n: None,
            stream: Some(stream),
            stop: (!s.stop.is_empty()).then(|| StringOrArray::Array(s.stop.clone())),
            frequency_penalty: s.frequency_penalty,
            presence_penalty: s.presence_penalty,
            seed: s.seed,
            tools: (!req.tools.is_empty()).then(|| req.tools.clone()),
            tool_choice: req.tool_choice.clone(),
            response_format: req.response_format.clone(),
            reasoning_effort: reasoning_effort.openai,
            stream_options: stream.then_some(StreamOptions {
                include_usage: Some(true),
            }),
            extra,
        }
    }

    fn reasoning_effort_for_body(
        &self,
        effort: Option<ReasoningEffort>,
        model: &str,
    ) -> RemoteReasoningEffort {
        let Some(effort) = effort.filter(|e| !e.is_auto()) else {
            return RemoteReasoningEffort::default();
        };
        if self.is_openrouter() {
            return RemoteReasoningEffort {
                openrouter: Some(effort),
                openai: None,
            };
        }
        if self.is_lm_studio() || self.is_generic_local_endpoint() || !looks_reasoning_model(model)
        {
            return RemoteReasoningEffort::default();
        }
        RemoteReasoningEffort {
            openrouter: None,
            openai: Some(effort),
        }
    }

    fn is_openrouter(&self) -> bool {
        self.label.trim().eq_ignore_ascii_case("openrouter")
            || self
                .base_url
                .to_ascii_lowercase()
                .contains("openrouter.ai/")
    }

    fn is_ollama(&self) -> bool {
        let label = self.label.to_ascii_lowercase();
        let base = self.base_url.to_ascii_lowercase();
        label.contains("ollama") || base.contains(":11434/")
    }

    fn is_lm_studio(&self) -> bool {
        let label = self.label.to_ascii_lowercase();
        let base = self.base_url.to_ascii_lowercase();
        label.contains("lm studio") || label.contains("lmstudio") || base.contains(":1234/")
    }

    fn is_generic_local_endpoint(&self) -> bool {
        let base = self.base_url.to_ascii_lowercase();
        (base.contains("localhost:") || base.contains("127.0.0.1:"))
            && !self.is_ollama()
            && !self.is_lm_studio()
    }

    fn ollama_generate_endpoint(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        let root = base
            .strip_suffix("/v1")
            .or_else(|| base.strip_suffix("/api"))
            .unwrap_or(base)
            .trim_end_matches('/');
        format!("{root}/api/generate")
    }

    fn lm_studio_responses_effort(
        &self,
        req: &CompletionRequest,
    ) -> Result<Option<ReasoningEffort>> {
        if !self.is_lm_studio() {
            return Ok(None);
        }
        let Some(effort) = req.reasoning_effort.filter(|e| !e.is_auto()) else {
            return Ok(None);
        };
        if is_gpt_oss_model(&req.model)
            && matches!(
                effort,
                ReasoningEffort::Low | ReasoningEffort::Medium | ReasoningEffort::High
            )
        {
            Ok(Some(effort))
        } else {
            Err(Error::InvalidRequest(format!(
                "LM Studio reasoning effort is only supported for gpt-oss models with low, medium, or high effort (got {} for {}).",
                effort.as_str(),
                req.model
            )))
        }
    }
}

#[derive(Default)]
struct RemoteReasoningEffort {
    openrouter: Option<ReasoningEffort>,
    openai: Option<ReasoningEffort>,
}

fn default_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
        .read_timeout(DEFAULT_READ_TIMEOUT)
        .build()
        .expect("valid reqwest client timeout configuration")
}

#[async_trait]
impl ModelService for RemoteBackend {
    fn name(&self) -> &str {
        &self.label
    }

    async fn list_models(&self) -> Result<Vec<Model>> {
        let resp = self
            .auth(self.client.get(self.endpoint("models")))
            .send()
            .await
            .map_err(upstream)?;
        if !resp.status().is_success() {
            return Err(Error::Upstream(format!(
                "{} GET /models -> {}",
                self.label,
                resp.status()
            )));
        }
        let parsed: ModelsResponse = resp.json().await.map_err(upstream)?;
        Ok(parsed.data)
    }

    async fn ollama_keep_alive(&self, model: &str, keep_alive: Option<Value>) -> Result<bool> {
        if !self.is_ollama() {
            return Ok(false);
        }
        let mut body = Map::new();
        body.insert("model".to_string(), Value::String(model.to_string()));
        body.insert("prompt".to_string(), Value::String(String::new()));
        body.insert("stream".to_string(), Value::Bool(false));
        if let Some(value) = keep_alive {
            body.insert("keep_alive".to_string(), value);
        }
        let resp = self
            .auth(self.client.post(self.ollama_generate_endpoint()))
            .json(&Value::Object(body))
            .send()
            .await
            .map_err(upstream)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(Error::Upstream(format!(
                "{} api/generate keep_alive -> {status}: {text}",
                self.label
            )));
        }
        Ok(true)
    }

    async fn stream(&self, req: CompletionRequest) -> Result<EventStream> {
        if req.prompt.is_some() {
            return self.stream_legacy_completion(req).await;
        }
        if let Some(effort) = self.lm_studio_responses_effort(&req)? {
            return self.stream_lm_studio_responses(req, effort).await;
        }
        let body = self.build_body(&req, true);
        let resp = self
            .auth(self.client.post(self.endpoint("chat/completions")))
            .json(&body)
            .send()
            .await
            .map_err(upstream)?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(Error::Upstream(format!(
                "{} chat/completions -> {status}: {text}",
                self.label
            )));
        }

        let stream = async_stream::stream! {
            let mut bytes = resp.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();
            let mut last_finish: Option<String> = None;
            let mut last_usage: Option<Usage> = None;
            let mut terminated = false;

            'outer: while let Some(chunk) = bytes.next().await {
                let chunk = match chunk {
                    Ok(b) => b,
                    Err(e) => {
                        yield Err(upstream(e));
                        return;
                    }
                };
                buf.extend_from_slice(&chunk);

                // Process whole lines (SSE field lines are newline-terminated).
                while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                    let line = String::from_utf8_lossy(&line_bytes);
                    match parse_sse_line(line.trim_end()) {
                        LineOutcome::Done => {
                            terminated = true;
                            break 'outer;
                        }
                        LineOutcome::Event(c) => {
                            let (delta, finish, usage) = chunk_to_delta(&c);
                            if let Some(f) = finish {
                                last_finish = Some(f);
                            }
                            if let Some(u) = usage {
                                last_usage = Some(u);
                            }
                            if !delta.is_empty() {
                                yield Ok(StreamEvent::Delta(delta));
                            }
                        }
                        LineOutcome::Ignore => {}
                    }
                }
            }

            let _ = terminated;
            yield Ok(StreamEvent::Done {
                finish_reason: last_finish.unwrap_or_else(|| "stop".to_string()),
                usage: last_usage.unwrap_or_default(),
            });
        };

        Ok(Box::pin(stream))
    }

    async fn embed(&self, model: &str, inputs: Vec<String>) -> Result<Vec<Vec<f32>>> {
        #[derive(serde::Serialize)]
        struct EmbedReq<'a> {
            model: &'a str,
            input: Vec<String>,
        }
        #[derive(Deserialize)]
        struct EmbedResp {
            data: Vec<EmbedItem>,
        }
        #[derive(Deserialize)]
        struct EmbedItem {
            embedding: Vec<f32>,
            #[serde(default)]
            index: usize,
        }

        let resp = self
            .auth(self.client.post(self.endpoint("embeddings")))
            .json(&EmbedReq {
                model,
                input: inputs,
            })
            .send()
            .await
            .map_err(upstream)?;
        if !resp.status().is_success() {
            return Err(Error::Upstream(format!(
                "{} embeddings -> {}",
                self.label,
                resp.status()
            )));
        }
        let mut parsed: EmbedResp = resp.json().await.map_err(upstream)?;
        parsed.data.sort_by_key(|i| i.index);
        Ok(parsed.data.into_iter().map(|i| i.embedding).collect())
    }
}

impl RemoteBackend {
    async fn stream_legacy_completion(&self, req: CompletionRequest) -> Result<EventStream> {
        let body = build_legacy_completion_body(&req, true)?;
        let resp = self
            .auth(self.client.post(self.endpoint("completions")))
            .json(&body)
            .send()
            .await
            .map_err(upstream)?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(Error::Upstream(format!(
                "{} completions -> {status}: {text}",
                self.label
            )));
        }

        let stream = async_stream::stream! {
            let mut bytes = resp.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();
            let mut last_finish: Option<String> = None;
            let mut last_usage: Option<Usage> = None;

            'outer: while let Some(chunk) = bytes.next().await {
                let chunk = match chunk {
                    Ok(b) => b,
                    Err(e) => {
                        yield Err(upstream(e));
                        return;
                    }
                };
                buf.extend_from_slice(&chunk);

                while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                    let line = String::from_utf8_lossy(&line_bytes);
                    match parse_completion_sse_line(line.trim_end()) {
                        CompletionLineOutcome::Done => break 'outer,
                        CompletionLineOutcome::Event(value) => {
                            if let Some(text) = value.pointer("/choices/0/text").and_then(Value::as_str) {
                                if !text.is_empty() {
                                    yield Ok(StreamEvent::Delta(DeltaEvent::text(text)));
                                }
                            }
                            if let Some(finish) = value.pointer("/choices/0/finish_reason").and_then(Value::as_str) {
                                last_finish = Some(finish.to_string());
                            }
                            if let Some(usage) = completion_usage(&value) {
                                last_usage = Some(usage);
                            }
                        }
                        CompletionLineOutcome::Ignore => {}
                    }
                }
            }

            yield Ok(StreamEvent::Done {
                finish_reason: last_finish.unwrap_or_else(|| "stop".to_string()),
                usage: last_usage.unwrap_or_default(),
            });
        };

        Ok(Box::pin(stream))
    }

    async fn stream_lm_studio_responses(
        &self,
        req: CompletionRequest,
        effort: ReasoningEffort,
    ) -> Result<EventStream> {
        let body = build_lm_studio_responses_body(&req, effort, true)?;
        let resp = self
            .auth(self.client.post(self.endpoint("responses")))
            .json(&body)
            .send()
            .await
            .map_err(upstream)?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(Error::Upstream(format!(
                "{} responses -> {status}: {text}",
                self.label
            )));
        }

        let stream = async_stream::stream! {
            let mut bytes = resp.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();
            let mut usage = Usage::default();
            let mut saw_done = false;

            while let Some(chunk) = bytes.next().await {
                let chunk = match chunk {
                    Ok(b) => b,
                    Err(e) => {
                        yield Err(upstream(e));
                        return;
                    }
                };
                buf.extend_from_slice(&chunk);

                while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                    let line = String::from_utf8_lossy(&line_bytes);
                    match parse_responses_sse_line(line.trim_end()) {
                        ResponsesLineOutcome::Done => {
                            saw_done = true;
                            break;
                        }
                        ResponsesLineOutcome::Event(value) => match responses_event_to_stream_event(&value) {
                            Ok(Some(StreamEvent::Delta(delta))) => {
                                if !delta.is_empty() {
                                    yield Ok(StreamEvent::Delta(delta));
                                }
                            }
                            Ok(Some(StreamEvent::Done { usage: done_usage, .. })) => {
                                usage = done_usage;
                                saw_done = true;
                            }
                            Ok(None) => {}
                            Err(e) => {
                                yield Err(e);
                                return;
                            }
                        },
                        ResponsesLineOutcome::Ignore => {}
                    }
                }
                if saw_done {
                    break;
                }
            }

            yield Ok(StreamEvent::Done {
                finish_reason: "stop".to_string(),
                usage,
            });
        };

        Ok(Box::pin(stream))
    }
}

fn upstream(e: impl std::fmt::Display) -> Error {
    Error::Upstream(e.to_string())
}

fn is_gpt_oss_model(model: &str) -> bool {
    model.trim().to_ascii_lowercase().contains("gpt-oss")
}

fn looks_reasoning_model(model: &str) -> bool {
    let id = model.trim().to_ascii_lowercase();
    id.starts_with("o1")
        || id.starts_with("o3")
        || id.starts_with("o4")
        || id.contains("/o1")
        || id.contains("/o3")
        || id.contains("/o4")
        || id.contains("gpt-5")
        || id.contains("gpt-oss")
        || id.contains("deepseek-r")
        || id.contains("deepseek-v3.1")
        || id.contains("qwen3")
        || id.contains("reason")
}

#[derive(Serialize)]
struct LegacyCompletionRequest {
    model: String,
    prompt: String,
    stream: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stop: Option<StringOrArray>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    frequency_penalty: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    presence_penalty: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seed: Option<i64>,
}

fn build_legacy_completion_body(
    req: &CompletionRequest,
    stream: bool,
) -> Result<LegacyCompletionRequest> {
    let s = &req.sampling;
    Ok(LegacyCompletionRequest {
        model: req.model.clone(),
        prompt: req.prompt.clone().ok_or_else(|| {
            Error::InvalidRequest("legacy completion prompt is required".to_string())
        })?,
        stream,
        suffix: req.suffix.clone(),
        temperature: s.temperature,
        top_p: s.top_p,
        max_tokens: s.max_tokens,
        stop: (!s.stop.is_empty()).then(|| StringOrArray::Array(s.stop.clone())),
        frequency_penalty: s.frequency_penalty,
        presence_penalty: s.presence_penalty,
        seed: s.seed,
    })
}

enum CompletionLineOutcome {
    Done,
    Event(Value),
    Ignore,
}

fn parse_completion_sse_line(line: &str) -> CompletionLineOutcome {
    let Some(data) = line.strip_prefix("data:") else {
        return CompletionLineOutcome::Ignore;
    };
    let data = data.trim();
    if data.is_empty() {
        return CompletionLineOutcome::Ignore;
    }
    if data == "[DONE]" {
        return CompletionLineOutcome::Done;
    }
    match serde_json::from_str::<Value>(data) {
        Ok(value) => CompletionLineOutcome::Event(value),
        Err(_) => CompletionLineOutcome::Ignore,
    }
}

fn completion_usage(value: &Value) -> Option<Usage> {
    let usage = value.get("usage")?;
    Some(Usage {
        prompt_tokens: usage
            .get("prompt_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32,
        completion_tokens: usage
            .get("completion_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32,
        total_tokens: usage
            .get("total_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32,
    })
}

#[derive(Serialize)]
struct ResponsesRequest {
    model: String,
    input: Vec<Value>,
    stream: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tools: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_choice: Option<Value>,
    reasoning: ResponsesReasoning,
}

#[derive(Serialize)]
struct ResponsesReasoning {
    effort: &'static str,
}

fn build_lm_studio_responses_body(
    req: &CompletionRequest,
    effort: ReasoningEffort,
    stream: bool,
) -> Result<ResponsesRequest> {
    Ok(ResponsesRequest {
        model: req.model.clone(),
        input: responses_input(&req.messages)?,
        stream,
        temperature: req.sampling.temperature,
        top_p: req.sampling.top_p,
        max_output_tokens: req.sampling.max_tokens,
        tools: responses_tools(&req.tools),
        tool_choice: req.tool_choice.clone(),
        reasoning: ResponsesReasoning {
            effort: effort.as_str(),
        },
    })
}

fn responses_input(messages: &[milim_core::api::openai::ChatMessage]) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for message in messages {
        if message.role == "tool" {
            let call_id = message.tool_call_id.clone().ok_or_else(|| {
                Error::InvalidRequest(
                    "LM Studio Responses requires tool messages to include tool_call_id"
                        .to_string(),
                )
            })?;
            out.push(json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": message.text_content(),
            }));
            continue;
        }

        if let Some(content) = responses_message_content(message)? {
            out.push(json!({
                "type": "message",
                "role": message.role.clone(),
                "content": content,
            }));
        }

        if let Some(tool_calls) = &message.tool_calls {
            for tool_call in tool_calls {
                out.push(json!({
                    "type": "function_call",
                    "call_id": tool_call.id.clone().unwrap_or_else(|| "call_0".to_string()),
                    "name": tool_call.function.name.clone(),
                    "arguments": tool_call.function.arguments.clone(),
                }));
            }
        }
    }
    Ok(out)
}

fn responses_message_content(
    message: &milim_core::api::openai::ChatMessage,
) -> Result<Option<Value>> {
    let Some(content) = &message.content else {
        return Ok(None);
    };
    match content {
        Content::Text(text) => Ok(Some(Value::String(text.clone()))),
        Content::Parts(parts) => {
            let mut out = Vec::new();
            for part in parts {
                match part {
                    ContentPart::Text { text } => out.push(json!({
                        "type": "input_text",
                        "text": text,
                    })),
                    ContentPart::ImageUrl { image_url } => {
                        let mut item = Map::new();
                        item.insert("type".to_string(), Value::String("input_image".to_string()));
                        item.insert(
                            "image_url".to_string(),
                            Value::String(image_url.url.clone()),
                        );
                        if let Some(detail) = &image_url.detail {
                            item.insert("detail".to_string(), Value::String(detail.clone()));
                        }
                        out.push(Value::Object(item));
                    }
                    ContentPart::InputAudio { .. } | ContentPart::Unknown => {
                        return Err(Error::InvalidRequest(
                            "LM Studio Responses reasoning path only supports text and image_url message parts".to_string(),
                        ));
                    }
                }
            }
            Ok(Some(Value::Array(out)))
        }
    }
}

fn responses_tools(tools: &[Tool]) -> Vec<Value> {
    tools
        .iter()
        .filter(|tool| tool.kind == "function")
        .map(|tool| {
            let mut out = Map::new();
            out.insert("type".to_string(), Value::String("function".to_string()));
            out.insert(
                "name".to_string(),
                Value::String(tool.function.name.clone()),
            );
            if let Some(description) = &tool.function.description {
                out.insert(
                    "description".to_string(),
                    Value::String(description.clone()),
                );
            }
            out.insert(
                "parameters".to_string(),
                tool.function
                    .parameters
                    .clone()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
            );
            out.insert("strict".to_string(), Value::Bool(false));
            Value::Object(out)
        })
        .collect()
}

enum ResponsesLineOutcome {
    Done,
    Event(Value),
    Ignore,
}

fn parse_responses_sse_line(line: &str) -> ResponsesLineOutcome {
    let Some(data) = line.strip_prefix("data:") else {
        return ResponsesLineOutcome::Ignore;
    };
    let data = data.trim();
    if data.is_empty() {
        return ResponsesLineOutcome::Ignore;
    }
    if data == "[DONE]" {
        return ResponsesLineOutcome::Done;
    }
    match serde_json::from_str::<Value>(data) {
        Ok(value) => ResponsesLineOutcome::Event(value),
        Err(_) => ResponsesLineOutcome::Ignore,
    }
}

fn responses_event_to_stream_event(value: &Value) -> Result<Option<StreamEvent>> {
    match value.get("type").and_then(Value::as_str) {
        Some("response.output_text.delta") => Ok(value
            .get("delta")
            .and_then(Value::as_str)
            .map(|text| StreamEvent::Delta(DeltaEvent::text(text)))),
        Some("response.reasoning_text.delta") | Some("response.reasoning_summary_text.delta") => {
            Ok(value.get("delta").and_then(Value::as_str).map(|text| {
                StreamEvent::Delta(DeltaEvent {
                    reasoning: Some(text.to_string()),
                    ..Default::default()
                })
            }))
        }
        Some("response.function_call_arguments.done") => {
            Ok(response_tool_call_delta(value).map(|delta| {
                StreamEvent::Delta(DeltaEvent {
                    tool_calls: vec![delta],
                    ..Default::default()
                })
            }))
        }
        Some("response.output_item.done") => Ok(value
            .get("item")
            .and_then(response_tool_call_delta)
            .map(|delta| {
                StreamEvent::Delta(DeltaEvent {
                    tool_calls: vec![delta],
                    ..Default::default()
                })
            })),
        Some("response.completed") => Ok(Some(StreamEvent::Done {
            finish_reason: "stop".to_string(),
            usage: response_usage(value),
        })),
        Some("response.failed") => Err(Error::Upstream(format!(
            "LM Studio response failed: {}",
            response_error_message(value)
        ))),
        Some("response.incomplete") => Err(Error::Upstream(format!(
            "LM Studio response incomplete: {}",
            value
                .pointer("/response/incomplete_details/reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ))),
        _ => Ok(None),
    }
}

fn response_tool_call_delta(value: &Value) -> Option<DeltaToolCall> {
    let item_type = value.get("type").and_then(Value::as_str);
    if item_type != Some("function_call")
        && item_type != Some("response.function_call_arguments.done")
    {
        return None;
    }
    let name = value.get("name").and_then(Value::as_str)?;
    let arguments = value
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Some(DeltaToolCall {
        index: value
            .get("output_index")
            .and_then(Value::as_u64)
            .unwrap_or_default() as u32,
        id: value
            .get("call_id")
            .or_else(|| value.get("item_id"))
            .or_else(|| value.get("id"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        kind: Some("function".to_string()),
        function: DeltaFunction {
            name: Some(name.to_string()),
            arguments: Some(arguments.to_string()),
        },
    })
}

fn response_usage(value: &Value) -> Usage {
    let usage = value.pointer("/response/usage").unwrap_or(&Value::Null);
    let prompt = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default() as u32;
    let completion = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default() as u32;
    let total = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| u64::from(prompt + completion)) as u32;
    Usage {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
    }
}

fn response_error_message(value: &Value) -> String {
    value
        .pointer("/response/error/message")
        .or_else(|| value.pointer("/error/message"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

/// Outcome of interpreting one SSE line.
enum LineOutcome {
    /// The terminal `data: [DONE]` sentinel.
    Done,
    /// A parsed `chat.completion.chunk`.
    Event(ChatCompletionChunk),
    /// Comment, blank line, keepalive, or unparseable fragment.
    Ignore,
}

/// Interpret one trimmed SSE line.
fn parse_sse_line(line: &str) -> LineOutcome {
    let Some(data) = line.strip_prefix("data:") else {
        return LineOutcome::Ignore;
    };
    let data = data.trim();
    if data.is_empty() {
        return LineOutcome::Ignore;
    }
    if data == "[DONE]" {
        return LineOutcome::Done;
    }
    match serde_json::from_str::<ChatCompletionChunk>(data) {
        Ok(c) => LineOutcome::Event(c),
        Err(_) => LineOutcome::Ignore,
    }
}

/// Project an OpenAI chunk into a neutral delta + optional finish/usage.
fn chunk_to_delta(chunk: &ChatCompletionChunk) -> (DeltaEvent, Option<String>, Option<Usage>) {
    let mut delta = DeltaEvent::default();
    let mut finish = None;
    if let Some(choice) = chunk.choices.first() {
        delta.content = choice.delta.content.clone();
        delta.reasoning = choice
            .delta
            .reasoning_content
            .clone()
            .or_else(|| choice.delta.reasoning.clone());
        if let Some(tcs) = &choice.delta.tool_calls {
            delta.tool_calls = tcs.clone();
        }
        finish = choice.finish_reason.clone();
    }
    (delta, finish, chunk.usage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn classifies_sse_lines() {
        assert!(matches!(parse_sse_line(": ping"), LineOutcome::Ignore));
        assert!(matches!(parse_sse_line(""), LineOutcome::Ignore));
        assert!(matches!(parse_sse_line("data: [DONE]"), LineOutcome::Done));
        assert!(matches!(parse_sse_line("event: foo"), LineOutcome::Ignore));
        let line = r#"data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}"#;
        assert!(matches!(parse_sse_line(line), LineOutcome::Event(_)));
    }

    #[test]
    fn extracts_content_and_finish_from_chunk() {
        let line = r#"data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}"#;
        let LineOutcome::Event(chunk) = parse_sse_line(line) else {
            panic!("expected event");
        };
        let (delta, finish, usage) = chunk_to_delta(&chunk);
        assert_eq!(delta.content.as_deref(), Some("hi"));
        assert_eq!(finish.as_deref(), Some("stop"));
        assert_eq!(usage.unwrap().total_tokens, 4);
    }

    #[test]
    fn extracts_reasoning_from_openrouter_chunk() {
        let line = r#"data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"reasoning":"checking options"}}]}"#;
        let LineOutcome::Event(chunk) = parse_sse_line(line) else {
            panic!("expected event");
        };
        let (delta, _, _) = chunk_to_delta(&chunk);
        assert_eq!(delta.reasoning.as_deref(), Some("checking options"));
    }

    #[test]
    fn builds_openai_body_with_stream_options() {
        let backend = RemoteBackend::new("openai", "https://api.openai.com/v1/", None);
        let req = CompletionRequest {
            model: "gpt-4o".into(),
            messages: vec![],
            tools: vec![],
            tool_choice: None,
            response_format: None,
            prompt: None,
            suffix: None,
            sampling: crate::service::SamplingParams {
                temperature: Some(0.5),
                stop: vec!["X".into()],
                ..Default::default()
            },
            reasoning_effort: None,
        };
        let body = backend.build_body(&req, true);
        assert_eq!(body.stream, Some(true));
        assert!(body.stream_options.is_some());
        assert!(matches!(body.stop, Some(StringOrArray::Array(_))));
        assert_eq!(
            backend.endpoint("chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn builds_ollama_native_generate_endpoint() {
        let backend = RemoteBackend::new("Ollama", "http://localhost:11434/v1", None);
        assert_eq!(
            backend.ollama_generate_endpoint(),
            "http://localhost:11434/api/generate"
        );
    }

    #[test]
    fn builds_reasoning_effort_for_reasoning_openai_models() {
        let backend = RemoteBackend::new("openai", "https://api.openai.com/v1/", None);
        let mut req = empty_req();
        req.model = "gpt-5".into();
        req.reasoning_effort = Some(ReasoningEffort::High);
        let body = backend.build_body(&req, true);
        assert_eq!(body.reasoning_effort, Some(ReasoningEffort::High));
        assert!(body.extra.get("reasoning").is_none());
    }

    #[test]
    fn builds_reasoning_object_for_openrouter() {
        let backend = RemoteBackend::new("OpenRouter", "https://openrouter.ai/api/v1", None);
        let mut req = empty_req();
        req.model = "anthropic/claude-sonnet-4".into();
        req.reasoning_effort = Some(ReasoningEffort::Max);
        let body = backend.build_body(&req, true);
        assert!(body.reasoning_effort.is_none());
        assert_eq!(body.extra["reasoning"]["effort"], "max");
    }

    #[test]
    fn sends_reasoning_effort_for_ollama_openai_compatible() {
        let backend = RemoteBackend::new("Ollama", "http://localhost:11434/v1", None);
        let mut req = empty_req();
        req.model = "deepseek-r1".into();
        req.reasoning_effort = Some(ReasoningEffort::High);
        let body = backend.build_body(&req, true);
        assert_eq!(body.reasoning_effort, Some(ReasoningEffort::High));
        assert!(body.extra.is_empty());
    }

    #[test]
    fn skips_reasoning_effort_for_generic_local_openai_compatible() {
        let backend = RemoteBackend::new("custom", "http://localhost:9999/v1", None);
        let mut req = empty_req();
        req.model = "deepseek-r1".into();
        req.reasoning_effort = Some(ReasoningEffort::High);
        let body = backend.build_body(&req, true);
        assert!(body.reasoning_effort.is_none());
        assert!(body.extra.is_empty());
    }

    #[test]
    fn lm_studio_chat_completions_omits_reasoning_effort() {
        let backend = RemoteBackend::new("LM Studio", "http://localhost:1234/v1", None);
        let mut req = empty_req();
        req.model = "openai/gpt-oss-20b".into();
        req.reasoning_effort = Some(ReasoningEffort::High);
        let body = backend.build_body(&req, true);
        assert!(body.reasoning_effort.is_none());
        assert!(body.extra.is_empty());
        assert_eq!(
            backend.lm_studio_responses_effort(&req).unwrap(),
            Some(ReasoningEffort::High)
        );
    }

    #[test]
    fn lm_studio_rejects_unsupported_reasoning_effort() {
        let backend = RemoteBackend::new("LM Studio", "http://localhost:1234/v1", None);
        let mut req = empty_req();
        req.model = "openai/gpt-oss-20b".into();
        req.reasoning_effort = Some(ReasoningEffort::Max);
        let err = backend.lm_studio_responses_effort(&req).unwrap_err();
        assert!(err.to_string().contains("low, medium, or high"));
    }

    #[test]
    fn builds_lm_studio_responses_body() {
        let mut req = empty_req();
        req.model = "openai/gpt-oss-20b".into();
        req.messages = vec![
            milim_core::api::openai::ChatMessage::text("system", "brief"),
            milim_core::api::openai::ChatMessage {
                role: "user".into(),
                content: Some(Content::Parts(vec![
                    ContentPart::Text {
                        text: "look".into(),
                    },
                    ContentPart::ImageUrl {
                        image_url: milim_core::api::openai::ImageUrl {
                            url: "data:image/png;base64,abc".into(),
                            detail: Some("low".into()),
                        },
                    },
                ])),
                name: None,
                tool_calls: None,
                tool_call_id: None,
                reasoning_content: None,
            },
        ];
        req.tools = vec![Tool {
            kind: "function".into(),
            function: milim_core::api::openai::ToolFunction {
                name: "lookup".into(),
                description: Some("find a value".into()),
                parameters: Some(json!({"type":"object","properties":{"id":{"type":"string"}}})),
            },
        }];
        req.sampling.max_tokens = Some(64);

        let body = build_lm_studio_responses_body(&req, ReasoningEffort::Low, true).unwrap();
        let value = serde_json::to_value(body).unwrap();
        assert_eq!(value["model"], "openai/gpt-oss-20b");
        assert_eq!(value["stream"], true);
        assert_eq!(value["max_output_tokens"], 64);
        assert_eq!(value["reasoning"]["effort"], "low");
        assert_eq!(value["input"][0]["role"], "system");
        assert_eq!(value["input"][1]["content"][0]["type"], "input_text");
        assert_eq!(value["input"][1]["content"][1]["type"], "input_image");
        assert_eq!(value["tools"][0]["type"], "function");
        assert_eq!(value["tools"][0]["strict"], false);
    }

    #[test]
    fn parses_lm_studio_responses_events() {
        let text = json!({"type":"response.output_text.delta","delta":"hi"});
        let reasoning = json!({"type":"response.reasoning_text.delta","delta":"thinking"});
        let tool = json!({
            "type":"response.function_call_arguments.done",
            "output_index":2,
            "call_id":"call_abc",
            "name":"lookup",
            "arguments":"{\"id\":\"1\"}"
        });
        let done = json!({
            "type":"response.completed",
            "response":{"usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}
        });

        let Some(StreamEvent::Delta(delta)) = responses_event_to_stream_event(&text).unwrap()
        else {
            panic!("expected text delta");
        };
        assert_eq!(delta.content.as_deref(), Some("hi"));

        let Some(StreamEvent::Delta(delta)) = responses_event_to_stream_event(&reasoning).unwrap()
        else {
            panic!("expected reasoning delta");
        };
        assert_eq!(delta.reasoning.as_deref(), Some("thinking"));

        let Some(StreamEvent::Delta(delta)) = responses_event_to_stream_event(&tool).unwrap()
        else {
            panic!("expected tool delta");
        };
        assert_eq!(delta.tool_calls[0].id.as_deref(), Some("call_abc"));
        assert_eq!(delta.tool_calls[0].function.name.as_deref(), Some("lookup"));
        assert_eq!(
            delta.tool_calls[0].function.arguments.as_deref(),
            Some("{\"id\":\"1\"}")
        );

        let Some(StreamEvent::Done { usage, .. }) = responses_event_to_stream_event(&done).unwrap()
        else {
            panic!("expected done");
        };
        assert_eq!(usage.total_tokens, 7);
    }

    #[tokio::test]
    async fn stream_times_out_when_upstream_never_responds() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let _server = tokio::spawn(async move {
            if let Ok((_socket, _peer)) = listener.accept().await {
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });

        let backend = RemoteBackend::new("silent-upstream", format!("http://{addr}/v1"), None);

        let start = std::time::Instant::now();
        let err = match tokio::time::timeout(Duration::from_secs(1), backend.stream(empty_req()))
            .await
            .expect("backend stream should return before the outer timeout")
        {
            Ok(_) => panic!("silent upstream should produce a timeout error"),
            Err(e) => e,
        };

        assert!(start.elapsed() < Duration::from_secs(1));
        let msg = err.to_string();
        assert!(
            msg.contains("error sending request"),
            "expected upstream request error, got: {msg}"
        );
    }

    fn empty_req() -> CompletionRequest {
        CompletionRequest {
            model: "m".into(),
            messages: vec![],
            tools: vec![],
            tool_choice: None,
            response_format: None,
            prompt: None,
            suffix: None,
            sampling: Default::default(),
            reasoning_effort: None,
        }
    }
}
