//! A deterministic backend with no native dependencies.
//!
//! Echoes the last user message word-by-word so streaming, non-streaming, and
//! tool-call paths can be exercised in deterministic tests without a model file
//! or network.

use async_trait::async_trait;
use std::sync::{Arc, Mutex};

use milim_core::api::openai::{DeltaFunction, DeltaToolCall, Model, ReasoningEffort, Usage};
use milim_core::Result;

use crate::service::{CompletionRequest, DeltaEvent, EventStream, ModelService, StreamEvent};

/// Deterministic echo backend for tests.
#[derive(Debug, Default, Clone)]
pub struct TestBackend {
    last_reasoning_effort: Arc<Mutex<Option<ReasoningEffort>>>,
}

impl TestBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn last_reasoning_effort(&self) -> Option<ReasoningEffort> {
        *self.last_reasoning_effort.lock().unwrap()
    }
}

#[async_trait]
impl ModelService for TestBackend {
    fn name(&self) -> &str {
        "test"
    }

    async fn list_models(&self) -> Result<Vec<Model>> {
        Ok(vec![Model::local("test-echo", 0)])
    }

    async fn stream(&self, req: CompletionRequest) -> Result<EventStream> {
        *self.last_reasoning_effort.lock().unwrap() = req.reasoning_effort;
        let last_user = req.last_user_text();
        let prompt_tokens: u32 = req
            .messages
            .iter()
            .map(|m| count_words(&m.text_content()))
            .sum::<u32>()
            .max(1);

        // Trigger a tool call when tools are offered and the user asks for one -
        // but not if a tool result is already present, so an agent loop
        // terminates (call once, then answer).
        let lower = last_user.to_lowercase();
        let has_tool_result = req.messages.iter().any(|m| m.role == "tool");
        let want_tool = !req.tools.is_empty()
            && !has_tool_result
            && (lower.starts_with("/tool") || lower.contains("call tool"));

        let stream = async_stream::stream! {
            if want_tool {
                // Name + id arrive first, arguments stream in fragments.
                yield Ok(StreamEvent::Delta(DeltaEvent {
                    tool_calls: vec![DeltaToolCall {
                        index: 0,
                        id: Some("call_0".to_string()),
                        kind: Some("function".to_string()),
                        function: DeltaFunction {
                            name: Some("echo".to_string()),
                            arguments: None,
                        },
                    }],
                    ..Default::default()
                }));
                for frag in ["{\"text\":", "\"", "test", "\"}"] {
                    yield Ok(StreamEvent::Delta(DeltaEvent {
                        tool_calls: vec![DeltaToolCall {
                            index: 0,
                            id: None,
                            kind: None,
                            function: DeltaFunction {
                                name: None,
                                arguments: Some(frag.to_string()),
                            },
                        }],
                        ..Default::default()
                    }));
                    tokio::task::yield_now().await;
                }
                yield Ok(StreamEvent::Done {
                    finish_reason: "tool_calls".to_string(),
                    usage: Usage::new(prompt_tokens, 4),
                });
                return;
            }

            let reply = if last_user.is_empty() {
                "Hello from the milim test backend.".to_string()
            } else {
                format!("Echo: {last_user}")
            };

            let words: Vec<&str> = reply.split_whitespace().collect();
            let completion_tokens = words.len() as u32;
            for (i, word) in words.iter().enumerate() {
                let chunk = if i == 0 {
                    word.to_string()
                } else {
                    format!(" {word}")
                };
                yield Ok(StreamEvent::Delta(DeltaEvent::text(chunk)));
                tokio::task::yield_now().await;
            }

            yield Ok(StreamEvent::Done {
                finish_reason: "stop".to_string(),
                usage: Usage::new(prompt_tokens, completion_tokens),
            });
        };

        Ok(Box::pin(stream))
    }

    async fn embed(&self, _model: &str, inputs: Vec<String>) -> Result<Vec<Vec<f32>>> {
        Ok(inputs.iter().map(|s| pseudo_embedding(s)).collect())
    }
}

fn count_words(s: &str) -> u32 {
    s.split_whitespace().count() as u32
}

/// A stable 16-dim pseudo-embedding (byte histogram, L2-normalized). Not
/// semantically meaningful - just deterministic and shaped like a real vector.
fn pseudo_embedding(s: &str) -> Vec<f32> {
    const DIM: usize = 16;
    let mut v = [0f32; DIM];
    for (i, b) in s.bytes().enumerate() {
        v[i % DIM] += (b as f32) / 255.0;
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    v.iter().map(|x| x / norm).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::SamplingParams;
    use futures::StreamExt;
    use milim_core::api::openai::{ChatMessage, Tool, ToolFunction};

    fn req(text: &str, tools: Vec<Tool>) -> CompletionRequest {
        CompletionRequest {
            model: "test-echo".into(),
            messages: vec![ChatMessage::text("user", text)],
            tools,
            tool_choice: None,
            response_format: None,
            prompt: None,
            suffix: None,
            sampling: SamplingParams::default(),
            reasoning_effort: None,
        }
    }

    #[tokio::test]
    async fn echoes_user_text_via_complete() {
        let out = TestBackend::new()
            .complete(req("ping", vec![]))
            .await
            .unwrap();
        assert_eq!(out.finish_reason, "stop");
        assert_eq!(out.message.text_content(), "Echo: ping");
        assert!(out.usage.completion_tokens >= 2);
    }

    #[tokio::test]
    async fn streams_multiple_deltas() {
        let mut s = TestBackend::new()
            .stream(req("a b c", vec![]))
            .await
            .unwrap();
        let mut deltas = 0;
        let mut done = false;
        while let Some(ev) = s.next().await {
            match ev.unwrap() {
                StreamEvent::Delta(_) => deltas += 1,
                StreamEvent::Done { .. } => done = true,
            }
        }
        assert!(deltas >= 2, "expected several deltas, got {deltas}");
        assert!(done);
    }

    #[tokio::test]
    async fn emits_tool_call_when_requested() {
        let tool = Tool {
            kind: "function".into(),
            function: ToolFunction {
                name: "echo".into(),
                description: None,
                parameters: None,
            },
        };
        let out = TestBackend::new()
            .complete(req("/tool please", vec![tool]))
            .await
            .unwrap();
        assert_eq!(out.finish_reason, "tool_calls");
        let calls = out.message.tool_calls.unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.name, "echo");
        assert_eq!(calls[0].function.arguments, "{\"text\":\"test\"}");
        assert!(out.message.content.is_none());
    }

    #[tokio::test]
    async fn embeddings_are_deterministic_and_normalized() {
        let b = TestBackend::new();
        let e1 = b.embed("x", vec!["hello".into()]).await.unwrap();
        let e2 = b.embed("x", vec!["hello".into()]).await.unwrap();
        assert_eq!(e1, e2);
        let norm = e1[0].iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3);
    }
}
