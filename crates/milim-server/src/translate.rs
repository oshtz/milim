//! Translation between wire DTOs and the backend-neutral request type.

use milim_core::api::anthropic::{
    self, ContentBlock, MessageContent, MessagesRequest, ResponseBlock,
};
use milim_core::api::ollama::{OllamaChatRequest, OllamaMessage};
use milim_core::api::openai::{
    ChatCompletionRequest, ChatMessage, Content, FunctionCall, ReasoningEffort, Tool, ToolCall,
    ToolFunction,
};
use milim_inference::{CompletionRequest, SamplingParams};
use serde_json::Value;

/// Build a neutral request from an OpenAI Chat Completions request.
pub fn openai_to_completion(req: ChatCompletionRequest) -> CompletionRequest {
    let sampling = SamplingParams {
        temperature: req.temperature,
        top_p: req.top_p,
        max_tokens: req.effective_max_tokens(),
        stop: req.stop.clone().map(|s| s.into_vec()).unwrap_or_default(),
        seed: req.seed,
        frequency_penalty: req.frequency_penalty,
        presence_penalty: req.presence_penalty,
    };
    CompletionRequest {
        model: req.model,
        messages: req.messages,
        tools: req.tools.unwrap_or_default(),
        tool_choice: req.tool_choice,
        response_format: req.response_format,
        prompt: None,
        suffix: None,
        sampling,
        reasoning_effort: req.reasoning_effort,
    }
}

/// Build a neutral request from an Ollama `/api/chat` request.
pub fn ollama_to_completion(req: OllamaChatRequest) -> CompletionRequest {
    let opts = req.options.unwrap_or(Value::Null);
    let sampling = SamplingParams {
        temperature: opt_f32(&opts, "temperature"),
        top_p: opt_f32(&opts, "top_p"),
        max_tokens: opt_u32(&opts, "num_predict"),
        stop: opt_stops(&opts),
        seed: opt_i64(&opts, "seed"),
        frequency_penalty: opt_f32(&opts, "frequency_penalty"),
        presence_penalty: opt_f32(&opts, "presence_penalty"),
    };
    CompletionRequest {
        model: req.model,
        messages: req.messages.into_iter().map(ollama_message).collect(),
        tools: req.tools.unwrap_or_default(),
        tool_choice: None,
        response_format: req.format.map(ollama_format_to_response_format),
        prompt: None,
        suffix: None,
        sampling,
        reasoning_effort: ollama_think_effort(req.think.as_ref()),
    }
}

fn ollama_message(m: OllamaMessage) -> ChatMessage {
    ChatMessage {
        role: m.role,
        content: Some(milim_core::api::openai::Content::Text(m.content)),
        name: None,
        tool_calls: m.tool_calls,
        tool_call_id: None,
        reasoning_content: m.thinking,
    }
}

pub(crate) fn ollama_think_effort(think: Option<&Value>) -> Option<ReasoningEffort> {
    match think? {
        Value::Bool(true) => Some(ReasoningEffort::Medium),
        Value::Bool(false) => Some(ReasoningEffort::None),
        Value::String(value) => serde_json::from_value(Value::String(value.clone())).ok(),
        _ => None,
    }
}

/// Build a neutral request from an Anthropic Messages request.
pub fn anthropic_to_completion(req: MessagesRequest) -> CompletionRequest {
    let mut messages: Vec<ChatMessage> = Vec::new();

    if let Some(system) = &req.system {
        messages.push(ChatMessage::text("system", system.plain_text()));
    }

    for m in req.messages {
        match m.content {
            MessageContent::Text(t) => messages.push(ChatMessage::text(m.role, t)),
            MessageContent::Blocks(blocks) => {
                let mut text = String::new();
                let mut tool_calls: Vec<ToolCall> = Vec::new();
                let mut tool_results: Vec<(String, String)> = Vec::new();

                for b in blocks {
                    match b {
                        ContentBlock::Text { text: t } => {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(&t);
                        }
                        ContentBlock::ToolUse { id, name, input } => tool_calls.push(ToolCall {
                            id: Some(id),
                            kind: "function".to_string(),
                            function: FunctionCall {
                                name,
                                arguments: input.to_string(),
                            },
                        }),
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        } => tool_results.push((tool_use_id, anthropic::value_to_text(&content))),
                        _ => {}
                    }
                }

                if !text.is_empty() || !tool_calls.is_empty() {
                    messages.push(ChatMessage {
                        role: m.role.clone(),
                        content: (!text.is_empty()).then_some(Content::Text(text)),
                        name: None,
                        tool_calls: (!tool_calls.is_empty()).then_some(tool_calls),
                        tool_call_id: None,
                        reasoning_content: None,
                    });
                }
                // Tool results map to OpenAI `tool` role messages.
                for (id, content) in tool_results {
                    messages.push(ChatMessage {
                        role: "tool".to_string(),
                        content: Some(Content::Text(content)),
                        name: None,
                        tool_calls: None,
                        tool_call_id: Some(id),
                        reasoning_content: None,
                    });
                }
            }
        }
    }

    let sampling = SamplingParams {
        temperature: req.temperature,
        top_p: req.top_p,
        max_tokens: Some(req.max_tokens),
        stop: req.stop_sequences.unwrap_or_default(),
        seed: None,
        frequency_penalty: None,
        presence_penalty: None,
    };

    let tools = req
        .tools
        .unwrap_or_default()
        .into_iter()
        .map(|t| Tool {
            kind: "function".to_string(),
            function: ToolFunction {
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
            },
        })
        .collect();

    CompletionRequest {
        model: req.model,
        messages,
        tools,
        tool_choice: req.tool_choice,
        response_format: None,
        prompt: None,
        suffix: None,
        sampling,
        reasoning_effort: None,
    }
}

pub fn ollama_format_to_response_format(format: Value) -> Value {
    match format {
        Value::String(s) if s == "json" => serde_json::json!({ "type": "json_object" }),
        Value::Object(map) => serde_json::json!({
            "type": "json_schema",
            "json_schema": {
                "name": "ollama_schema",
                "schema": Value::Object(map),
            }
        }),
        other => other,
    }
}

/// Convert an assembled assistant message into Anthropic response blocks.
pub fn anthropic_response_blocks(msg: &ChatMessage) -> Vec<ResponseBlock> {
    let mut blocks = Vec::new();
    let text = msg.text_content();
    if !text.is_empty() {
        blocks.push(ResponseBlock::Text { text });
    }
    if let Some(calls) = &msg.tool_calls {
        for tc in calls {
            let input: Value = serde_json::from_str(&tc.function.arguments)
                .unwrap_or_else(|_| Value::Object(Default::default()));
            blocks.push(ResponseBlock::ToolUse {
                id: tc.id.clone().unwrap_or_default(),
                name: tc.function.name.clone(),
                input,
            });
        }
    }
    blocks
}

/// Map an OpenAI finish reason to an Anthropic stop reason.
pub fn anthropic_stop_reason(finish: &str) -> String {
    match finish {
        "tool_calls" => "tool_use",
        "length" => "max_tokens",
        "stop" => "end_turn",
        other => other,
    }
    .to_string()
}

fn opt_f32(v: &Value, key: &str) -> Option<f32> {
    v.get(key).and_then(|x| x.as_f64()).map(|x| x as f32)
}

fn opt_u32(v: &Value, key: &str) -> Option<u32> {
    v.get(key).and_then(|x| x.as_u64()).map(|x| x as u32)
}

fn opt_i64(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

/// Ollama's `stop` option may be a string or an array of strings.
fn opt_stops(v: &Value) -> Vec<String> {
    match v.get("stop") {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_openai_sampling() {
        let req: ChatCompletionRequest = serde_json::from_str(
            r#"{"model":"m","messages":[{"role":"user","content":"hi"}],"temperature":0.7,"max_completion_tokens":128,"stop":["END"]}"#,
        )
        .unwrap();
        let c = openai_to_completion(req);
        assert_eq!(c.sampling.temperature, Some(0.7));
        assert_eq!(c.sampling.max_tokens, Some(128));
        assert_eq!(c.sampling.stop, vec!["END".to_string()]);
        assert_eq!(c.messages.len(), 1);
    }

    #[test]
    fn maps_openai_reasoning_effort() {
        let req: ChatCompletionRequest =
            serde_json::from_str(r#"{"model":"m","messages":[],"reasoning_effort":"high"}"#)
                .unwrap();
        let c = openai_to_completion(req);
        assert_eq!(
            c.reasoning_effort,
            Some(milim_core::api::openai::ReasoningEffort::High)
        );
    }

    #[test]
    fn maps_ollama_options() {
        let req: OllamaChatRequest = serde_json::from_str(
            r#"{"model":"llama3","messages":[{"role":"user","content":"hi"}],"options":{"temperature":0.2,"num_predict":64,"stop":"<END>"}}"#,
        )
        .unwrap();
        let c = ollama_to_completion(req);
        assert_eq!(c.sampling.temperature, Some(0.2));
        assert_eq!(c.sampling.max_tokens, Some(64));
        assert_eq!(c.sampling.stop, vec!["<END>".to_string()]);
    }

    #[test]
    fn maps_structured_output_formats() {
        let req: ChatCompletionRequest = serde_json::from_str(
            r#"{"model":"m","messages":[],"response_format":{"type":"json_object"}}"#,
        )
        .unwrap();
        assert_eq!(
            openai_to_completion(req).response_format.unwrap()["type"],
            "json_object"
        );

        let req: OllamaChatRequest =
            serde_json::from_str(r#"{"model":"m","format":{"type":"object"}}"#).unwrap();
        let format = ollama_to_completion(req).response_format.unwrap();
        assert_eq!(format["type"], "json_schema");
        assert_eq!(format["json_schema"]["schema"]["type"], "object");
    }
}
