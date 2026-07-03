use std::collections::HashMap;

use milim_core::api::openai::{ChatMessage, ReasoningEffort, Tool, ToolFunction};
use milim_inference::{
    anthropic::AnthropicBackend, CompletionRequest, ModelService, SamplingParams,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

#[derive(Debug)]
struct CapturedRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: serde_json::Value,
}

async fn spawn_once(
    response_body: &'static str,
    content_type: &'static str,
) -> (String, oneshot::Receiver<CapturedRequest>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = oneshot::channel();

    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut buf = [0u8; 1024];

        loop {
            let n = socket.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
            if request_complete(&bytes) {
                break;
            }
        }

        let captured = parse_request(&bytes);
        let _ = tx.send(captured);

        let resp = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n\r\n{}",
            response_body.len(),
            response_body
        );
        socket.write_all(resp.as_bytes()).await.unwrap();
    });

    (format!("http://{addr}/v1"), rx)
}

fn request_complete(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    let len = head
        .lines()
        .find_map(|l| {
            l.strip_prefix("Content-Length:")
                .or_else(|| l.strip_prefix("content-length:"))
        })
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    body.len() >= len
}

fn parse_request(bytes: &[u8]) -> CapturedRequest {
    let text = String::from_utf8_lossy(bytes);
    let (head, body) = text.split_once("\r\n\r\n").unwrap();
    let mut lines = head.lines();
    let first = lines.next().unwrap();
    let mut first_parts = first.split_whitespace();
    let method = first_parts.next().unwrap().to_string();
    let path = first_parts.next().unwrap().to_string();
    let headers = lines
        .filter_map(|line| {
            let (k, v) = line.split_once(':')?;
            Some((k.to_ascii_lowercase(), v.trim().to_string()))
        })
        .collect();
    let body = if body.trim().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(body).unwrap()
    };

    CapturedRequest {
        method,
        path,
        headers,
        body,
    }
}

fn basic_req(model: &str) -> CompletionRequest {
    CompletionRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage::text("system", "Be concise."),
            ChatMessage::text("user", "Hello"),
        ],
        tools: vec![],
        tool_choice: None,
        response_format: None,
        prompt: None,
        suffix: None,
        sampling: SamplingParams {
            max_tokens: Some(64),
            temperature: Some(0.2),
            stop: vec!["END".to_string()],
            ..Default::default()
        },
        reasoning_effort: None,
    }
}

#[tokio::test]
async fn lists_anthropic_models_with_required_headers() {
    let body = r#"{"data":[{"id":"claude-sonnet-4-20250514","display_name":"Claude Sonnet 4"}],"has_more":false}"#;
    let (base, captured) = spawn_once(body, "application/json").await;
    let backend = AnthropicBackend::new("anthropic", base, Some("sk-ant-test".to_string()));

    let models = backend.list_models().await.unwrap();
    let req = captured.await.unwrap();

    assert_eq!(req.method, "GET");
    assert_eq!(req.path, "/v1/models");
    assert_eq!(
        req.headers.get("x-api-key").map(String::as_str),
        Some("sk-ant-test")
    );
    assert_eq!(
        req.headers.get("anthropic-version").map(String::as_str),
        Some("2023-06-01")
    );
    assert_eq!(models[0].id, "claude-sonnet-4-20250514");
    assert_eq!(models[0].owned_by, "anthropic");
}

#[tokio::test]
async fn streams_text_and_builds_messages_body() {
    let sse = concat!(
        "event: message_start\n",
        r#"data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":1}}}"#,
        "\n\n",
        "event: content_block_start\n",
        r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        "\n\n",
        "event: content_block_delta\n",
        r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
        "\n\n",
        "event: message_delta\n",
        r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}"#,
        "\n\n",
        "event: message_stop\n",
        r#"data: {"type":"message_stop"}"#,
        "\n\n"
    );
    let (base, captured) = spawn_once(sse, "text/event-stream").await;
    let backend = AnthropicBackend::new("anthropic", base, Some("sk-ant-test".to_string()));

    let mut input = basic_req("claude-sonnet-4-20250514");
    input.reasoning_effort = Some(ReasoningEffort::High);
    let out = backend.complete(input).await.unwrap();
    let req = captured.await.unwrap();

    assert_eq!(req.method, "POST");
    assert_eq!(req.path, "/v1/messages");
    assert_eq!(req.body["model"], "claude-sonnet-4-20250514");
    assert_eq!(req.body["system"], "Be concise.");
    assert_eq!(req.body["messages"][0]["role"], "user");
    assert_eq!(req.body["messages"][0]["content"], "Hello");
    assert_eq!(req.body["max_tokens"], 64);
    let temp = req.body["temperature"].as_f64().unwrap();
    assert!((temp - 0.2).abs() < 0.000_001, "temperature was {temp}");
    assert_eq!(req.body["stop_sequences"][0], "END");
    assert_eq!(req.body["output_config"]["effort"], "high");

    assert_eq!(out.message.text_content(), "Hello");
    assert_eq!(out.finish_reason, "stop");
    assert_eq!(out.usage.prompt_tokens, 7);
    assert_eq!(out.usage.completion_tokens, 3);
    assert_eq!(out.usage.total_tokens, 10);
}

#[tokio::test]
async fn streams_tool_use_as_openai_tool_calls() {
    let sse = concat!(
        "event: message_start\n",
        r#"data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":1}}}"#,
        "\n\n",
        "event: content_block_start\n",
        r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}"#,
        "\n\n",
        "event: content_block_delta\n",
        r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"location\":\""}}"#,
        "\n\n",
        "event: content_block_delta\n",
        r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"Paris\"}"}}"#,
        "\n\n",
        "event: message_delta\n",
        r#"data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":9}}"#,
        "\n\n",
        "event: message_stop\n",
        r#"data: {"type":"message_stop"}"#,
        "\n\n"
    );
    let (base, captured) = spawn_once(sse, "text/event-stream").await;
    let backend = AnthropicBackend::new("anthropic", base, Some("sk-ant-test".to_string()));
    let mut req = basic_req("claude-sonnet-4-20250514");
    req.tools = vec![
        Tool {
            kind: "function".to_string(),
            function: ToolFunction {
                name: "get_weather".to_string(),
                description: Some("Get weather.".to_string()),
                parameters: Some(serde_json::json!({"type":"object"})),
            },
        },
        Tool {
            kind: "function".to_string(),
            function: ToolFunction {
                name: "no_description".to_string(),
                description: None,
                parameters: None,
            },
        },
    ];

    let out = backend.complete(req).await.unwrap();
    let sent = captured.await.unwrap();
    let calls = out.message.tool_calls.unwrap();

    assert_eq!(sent.body["tools"][0]["name"], "get_weather");
    assert_eq!(sent.body["tools"][0]["description"], "Get weather.");
    assert_eq!(sent.body["tools"][0]["input_schema"]["type"], "object");
    assert!(sent.body["tools"][1].get("description").is_none());
    assert_eq!(sent.body["tools"][1]["input_schema"]["type"], "object");
    assert_eq!(out.finish_reason, "tool_calls");
    assert_eq!(calls[0].id.as_deref(), Some("toolu_1"));
    assert_eq!(calls[0].function.name, "get_weather");
    assert_eq!(calls[0].function.arguments, r#"{"location":"Paris"}"#);
}
