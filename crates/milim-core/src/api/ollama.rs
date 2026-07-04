//! Ollama-compatible DTOs (`/api/chat`, `/api/tags`, `/api/show`).
//!
//! Ollama streams newline-delimited JSON objects (not SSE) and uses
//! `created_at` RFC-3339 timestamps. Shapes mirror the Ollama REST API so
//! existing Ollama clients work unchanged.

use super::openai::{Tool, ToolCall};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `POST /api/chat` request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaChatRequest {
    pub model: String,
    #[serde(default)]
    pub messages: Vec<OllamaMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    /// Sampling options (`temperature`, `top_p`, `num_predict`, `stop`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Tool>>,
    /// `"json"` or a JSON schema for structured output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_alive: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub think: Option<Value>,
}

impl OllamaChatRequest {
    pub fn wants_stream(&self) -> bool {
        // Ollama defaults to streaming when `stream` is omitted.
        self.stream.unwrap_or(true)
    }
}

/// An Ollama chat message (content is always a plain string).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaMessage {
    pub role: String,
    #[serde(default)]
    pub content: String,
    /// Base64-encoded images for multimodal models.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

/// A streamed or final `/api/chat` response object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaChatResponse {
    pub model: String,
    pub created_at: String,
    pub message: OllamaMessage,
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_reason: Option<String>,

    // Timing/token stats included on the final (`done: true`) object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_duration: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_eval_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eval_count: Option<u32>,
}

/// `GET /api/tags` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaTagsResponse {
    pub models: Vec<OllamaModelTag>,
}

/// One installed model in the tags listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaModelTag {
    pub name: String,
    pub model: String,
    pub modified_at: String,
    pub size: u64,
    pub digest: String,
    pub details: OllamaModelDetails,
}

/// Model detail block in `/api/tags` and `/api/show`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OllamaModelDetails {
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub families: Option<Vec<String>>,
    #[serde(default)]
    pub parameter_size: String,
    #[serde(default)]
    pub quantization_level: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_defaults_to_streaming() {
        let req: OllamaChatRequest =
            serde_json::from_str(r#"{"model":"llama3","messages":[]}"#).unwrap();
        assert!(req.wants_stream());
    }

    #[test]
    fn final_chunk_serializes_stats() {
        let resp = OllamaChatResponse {
            model: "m".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            message: OllamaMessage {
                role: "assistant".into(),
                content: String::new(),
                images: None,
                tool_calls: None,
                thinking: None,
            },
            done: true,
            done_reason: Some("stop".into()),
            total_duration: Some(123),
            prompt_eval_count: Some(5),
            eval_count: Some(7),
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"done\":true"));
        assert!(json.contains("\"eval_count\":7"));
    }
}
