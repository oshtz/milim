//! HTTP handlers for the OpenAI- and Ollama-compatible endpoints.

use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Component, Path as FsPath, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use bytes::Bytes;
use flate2::read::GzDecoder;
use futures::{future::join_all, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use milim_core::api::anthropic::{self, MessagesRequest, MessagesResponse};
use milim_core::api::ollama::{
    OllamaChatRequest, OllamaChatResponse, OllamaMessage, OllamaModelDetails, OllamaModelTag,
    OllamaTagsResponse,
};
use milim_core::api::openai::{
    ChatCompletionRequest, ChatCompletionResponse, ChatMessage, Choice, Content, ContentPart,
    FunctionCall, ImageUrl, Model, ModelsResponse, ReasoningEffort, StringOrArray,
    Tool as OpenAiTool, ToolCall, ToolFunction, Usage,
};
use milim_core::Error;
use milim_inference::remote::RemoteBackend;
use milim_inference::{
    CompletionRequest, EventStream, ModelService, SamplingParams, StreamEvent, ToolCallAccumulator,
};
use milim_tools::{Tool, ToolRegistry};
use milim_voice::{
    validate_voice_command, validate_voice_model_file, CommandSpeechSynthesizer,
    EnergyVoiceActivityDetector, OpenAiAudioSpeechSynthesizer, OpenAiAudioTranscriptionTranscriber,
    ParakeetCommandTranscriber, PiperSpeechSynthesizer, RemoteRawTranscriber, SpeechInput,
    Synthesizer, Transcriber, TranscriptionInput, VoiceActivityDetector, VoiceActivityInput,
    DEFAULT_ENERGY_VAD_THRESHOLD, DEFAULT_PARAKEET_MODEL,
};
#[cfg(feature = "native-tts")]
use milim_voice::{NativeKokoroSpeechSynthesizer, NativePiperSpeechSynthesizer};

use crate::auth::authorize;
use crate::companion::{
    MobileCompanionBridge, MobilePairRequest, MobileRelayRequest, MobileThreadUpdateRequest,
};
use crate::error::ApiError;
use crate::preview_runtime::{
    PreviewAppPreflightRequest, PreviewAppStageRequest, PreviewAppStartRequest,
};
use crate::privacy::{kinds_summary, PrivacyMode};
use crate::sse::{agent_sse, anthropic_sse, ollama_ndjson, openai_sse, ChunkCtx};
use crate::state::AppState;
use crate::threads::{missing_threads_error, ChildRunSpec, SupervisorEvent, ThreadSupervisor};
use crate::translate::{
    anthropic_response_blocks, anthropic_stop_reason, anthropic_to_completion,
    ollama_format_to_response_format, ollama_think_effort, ollama_to_completion,
    openai_to_completion,
};
use crate::{gen_id, now_unix, rfc3339_now};

// axum 0.8 routes `Option<T>` through `OptionalFromRequestParts`, which
// `ConnectInfo` does not implement -- so extract it directly. `serve_listener`
// always attaches connect-info, so this is present for every request.
type Peer = ConnectInfo<SocketAddr>;

fn peer_addr(peer: Peer) -> Option<SocketAddr> {
    Some(peer.0)
}

fn agent_run_config_from_request(req: &ChatCompletionRequest) -> milim_agents::AgentRunConfig {
    let mut config = milim_agents::AgentRunConfig::default();
    if let Some(max_iterations) = req
        .extra
        .get("agent_max_iterations")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
    {
        config.max_iterations = max_iterations.max(1);
    }
    config
}

/// `GET /health`
pub(crate) async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "service": "milim" }))
}

fn mobile_bridge(st: &AppState) -> Result<Arc<MobileCompanionBridge>, ApiError> {
    st.mobile_companion.as_ref().cloned().ok_or_else(|| {
        ApiError(Error::InvalidRequest(
            "mobile companion bridge is not available".to_string(),
        ))
    })
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
}

fn companion_device_key(headers: &HeaderMap) -> Result<&str, ApiError> {
    bearer_token(headers).ok_or_else(|| {
        ApiError(Error::Unauthorized(
            "missing mobile companion device key".to_string(),
        ))
    })
}

#[derive(Deserialize)]
pub(crate) struct MobileCompanionEnabledRequest {
    enabled: bool,
}

/// `GET /mobile`
pub(crate) async fn mobile_companion_page() -> Html<&'static str> {
    Html(MOBILE_COMPANION_HTML)
}

/// `GET /mobile/manifest.webmanifest`
pub(crate) async fn mobile_companion_manifest() -> Response {
    (
        [(CONTENT_TYPE, "application/manifest+json")],
        MOBILE_COMPANION_MANIFEST,
    )
        .into_response()
}

/// `GET /mobile/sw.js`
pub(crate) async fn mobile_companion_service_worker() -> Response {
    (
        [(CONTENT_TYPE, "application/javascript")],
        MOBILE_COMPANION_SERVICE_WORKER,
    )
        .into_response()
}

/// `GET /mobile/icon.svg`
pub(crate) async fn mobile_companion_icon() -> Response {
    ([(CONTENT_TYPE, "image/svg+xml")], MOBILE_COMPANION_ICON).into_response()
}

/// `GET /mobile/icon.png`
pub(crate) async fn mobile_companion_icon_png() -> Response {
    ([(CONTENT_TYPE, "image/png")], MOBILE_COMPANION_ICON_PNG).into_response()
}

/// `GET /mobile/wordmark.svg`
pub(crate) async fn mobile_companion_wordmark() -> Response {
    ([(CONTENT_TYPE, "image/svg+xml")], MOBILE_COMPANION_WORDMARK).into_response()
}

/// `GET /mobile/status`
pub(crate) async fn mobile_companion_status(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let bridge = mobile_bridge(&st)?;
    Ok(Json(bridge.status(now_unix())).into_response())
}

/// `POST /mobile/enabled`
pub(crate) async fn mobile_companion_enabled(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<MobileCompanionEnabledRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let bridge = mobile_bridge(&st)?;
    Ok(Json(bridge.set_enabled(req.enabled, now_unix())).into_response())
}

/// `POST /mobile/pairing`
pub(crate) async fn mobile_companion_pairing(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let bridge = mobile_bridge(&st)?;
    let pairing = bridge.start_pairing(now_unix()).map_err(|message| {
        ApiError(Error::InvalidRequest(format!(
            "could not start mobile pairing: {message}"
        )))
    })?;
    Ok(Json(pairing).into_response())
}

/// `POST /mobile/pair`
pub(crate) async fn mobile_companion_pair(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<MobilePairRequest>,
) -> Result<Response, ApiError> {
    let bridge = mobile_bridge(&st)?;
    let user_agent = headers
        .get(USER_AGENT)
        .and_then(|value| value.to_str().ok());
    let pair = bridge
        .pair_device(req, now_unix(), user_agent)
        .map_err(|message| ApiError(Error::Unauthorized(message)))?;
    Ok(Json(pair).into_response())
}

/// `GET /mobile/device/status`
pub(crate) async fn mobile_companion_device_status(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let bridge = mobile_bridge(&st)?;
    let key = companion_device_key(&headers)?;
    let device = bridge.authenticate_device(key, now_unix()).ok_or_else(|| {
        ApiError(Error::Unauthorized(
            "invalid mobile companion device key".to_string(),
        ))
    })?;
    Ok(Json(json!({ "connected": true, "device": device })).into_response())
}

/// `POST /mobile/relay`
pub(crate) async fn mobile_companion_relay(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<MobileRelayRequest>,
) -> Result<Response, ApiError> {
    let bridge = mobile_bridge(&st)?;
    let key = companion_device_key(&headers)?;
    let event = bridge
        .submit_relay(key, req, now_unix())
        .map_err(|message| ApiError(Error::Unauthorized(message)))?;
    Ok(Json(json!({ "ok": true, "event": event })).into_response())
}

/// `GET /mobile/thread`
pub(crate) async fn mobile_companion_thread(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let bridge = mobile_bridge(&st)?;
    let key = companion_device_key(&headers)?;
    let thread = bridge
        .thread_for_device(key, now_unix())
        .map_err(|message| ApiError(Error::Unauthorized(message)))?;
    Ok(Json(json!({ "thread": thread })).into_response())
}

/// `GET /mobile/thread/events`
pub(crate) async fn mobile_companion_thread_events(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let bridge = mobile_bridge(&st)?;
    let key = bearer_token(&headers)
        .map(str::to_string)
        .or_else(|| query.get("key").cloned())
        .ok_or_else(|| {
            ApiError(Error::Unauthorized(
                "missing mobile companion device key".to_string(),
            ))
        })?;
    bridge
        .authenticate_device(&key, now_unix())
        .ok_or_else(|| {
            ApiError(Error::Unauthorized(
                "invalid mobile companion device key".to_string(),
            ))
        })?;
    let mut updates = bridge.subscribe_thread();
    let stream = async_stream::stream! {
        match bridge.thread_for_device(&key, now_unix()) {
            Ok(thread) => yield Ok::<Event, Infallible>(Event::default().data(json!({ "thread": thread }).to_string())),
            Err(_) => return,
        }
        loop {
            if updates.changed().await.is_err() {
                break;
            }
            match bridge.thread_for_device(&key, now_unix()) {
                Ok(thread) => yield Ok::<Event, Infallible>(Event::default().data(json!({ "thread": thread }).to_string())),
                Err(_) => break,
            }
        }
    };
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

/// `POST /mobile/thread`
pub(crate) async fn mobile_companion_thread_update(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<MobileThreadUpdateRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let bridge = mobile_bridge(&st)?;
    let thread = bridge.update_thread(req, now_unix());
    Ok(Json(json!({ "thread": thread })).into_response())
}

/// `GET /mobile/events`
pub(crate) async fn mobile_companion_events(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let bridge = mobile_bridge(&st)?;
    Ok(Json(json!({ "events": bridge.take_events() })).into_response())
}

/// `DELETE /mobile/devices/{id}`
pub(crate) async fn mobile_companion_device_revoke(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let bridge = mobile_bridge(&st)?;
    Ok(Json(bridge.revoke_device(&id, now_unix())).into_response())
}

const MOBILE_COMPANION_HTML: &str = r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
  <title>Milim Mobile Companion</title>
  <link rel="manifest" href="/mobile/manifest.webmanifest" />
  <link rel="icon" href="/mobile/icon.png" type="image/png" />
  <link rel="apple-touch-icon" href="/mobile/icon.png" />
  <meta name="theme-color" content="#0d0d0f" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="Milim" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d0d0f; color: #ededf0; overflow-x: hidden; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100svh;
      overflow-x: hidden;
      background:
        linear-gradient(180deg, rgba(255,255,255,.035), transparent 180px),
        repeating-linear-gradient(90deg, rgba(255,255,255,.018) 0 1px, transparent 1px 88px),
        #0d0d0f;
    }
    main { width: min(100%, 560px); min-height: 100svh; margin: 0 auto; display: grid; grid-template-rows: auto 1fr auto; gap: 14px; padding: max(14px, env(safe-area-inset-top)) 12px max(14px, env(safe-area-inset-bottom)); }
    header { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid #262629; }
    .brand { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .wordmark { font-size: 16px; font-weight: 760; letter-spacing: -.03em; }
    h1 { margin: 0; color: #a0a0a8; font-size: 12px; font-weight: 520; letter-spacing: 0; }
    .status { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #323237; background: #161618; border-radius: 8px; padding: 5px 8px; font-size: 11px; color: #a0a0a8; white-space: nowrap; }
    .status::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: #fbbf24; box-shadow: 0 0 0 3px rgba(251,191,36,.12); }
    .status.ok::before { background: #34d399; box-shadow: 0 0 0 3px rgba(52,211,153,.12); }
    .status.stale::before { background: #fb7185; box-shadow: 0 0 0 3px rgba(251,113,133,.12); }
    .panel { display: grid; gap: 16px; align-content: start; align-self: start; border: 1px solid #262629; border-radius: 8px; background: rgba(22,22,24,.96); padding: 14px; box-shadow: inset 0 1px 0 rgba(255,255,255,.05), 0 18px 50px rgba(0,0,0,.28); animation: panel-in .18s ease-out; }
    .panel-head { display: grid; gap: 5px; }
    h2 { margin: 0; font-size: clamp(28px, 9vw, 44px); line-height: .95; letter-spacing: -.055em; }
    .panel-head p { margin: 0; color: #a0a0a8; font-size: 13px; line-height: 1.45; }
    label { display: grid; gap: 7px; font-size: 12px; color: #a0a0a8; }
    input, textarea { width: 100%; border: 1px solid #323237; border-radius: 8px; background: #0d0d0f; color: #ededf0; padding: 12px; font: inherit; outline: none; transition: border-color .15s, box-shadow .15s, transform .15s; }
    input:focus, textarea:focus { border-color: #55555e; box-shadow: 0 0 0 2px rgba(237,237,240,.12); }
    input::placeholder, textarea::placeholder { color: #71717a; }
    textarea { min-height: 96px; resize: vertical; line-height: 1.5; }
    .top-actions { display: flex; gap: 8px; align-items: center; }
    .mini-btn { min-height: 30px; padding: 0 9px; background: transparent; color: #ededf0; border-color: #323237; font-size: 12px; }
    .mini-btn.danger { color: var(--error); }
    .thread-panel { min-height: calc(100svh - 142px); grid-template-rows: auto auto auto auto minmax(0, 1fr) auto auto auto; }
    .thread-head { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: start; gap: 8px; border-bottom: 1px solid #262629; padding-bottom: 12px; }
    .thread-head h2 { font-size: 22px; line-height: 1.05; letter-spacing: -.04em; }
    .thread-head p { margin: 4px 0 0; color: #71717a; font-size: 12px; }
    .thread-state { flex: none; border: 1px solid #323237; border-radius: 7px; padding: 4px 7px; color: #a0a0a8; font-size: 11px; }
    .thread-switch { min-height: 28px; padding: 0 9px; background: transparent; color: #ededf0; border-color: #323237; font-size: 12px; }
    .thread-list { max-height: 34svh; overflow: auto; display: grid; gap: 6px; border-bottom: 1px solid #262629; padding-bottom: 12px; scrollbar-width: thin; }
    .thread-item { min-height: 0; display: grid; gap: 3px; text-align: left; border-color: #262629; background: #0d0d0f; color: #ededf0; padding: 9px 10px; }
    .thread-item.active { background: #ededf0; color: #0d0d0f; border-color: transparent; }
    .thread-item small { color: #71717a; font-size: 11px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .thread-item.active small { color: #3f3f46; }
    .thread-messages { min-height: 0; overflow: auto; display: grid; align-content: start; gap: 10px; padding: 2px 1px 4px; scrollbar-width: thin; }
    select { width: 100%; border: 1px solid #323237; border-radius: 8px; background: #0d0d0f; color: #ededf0; padding: 10px; font: inherit; }
    .thread-search { margin-bottom: -6px; }
    .msg-wrap { display: grid; gap: 4px; max-width: 88%; }
    .msg-wrap.user { justify-self: end; }
    .msg-wrap.assistant { justify-self: start; }
    .msg { width: fit-content; max-width: 100%; border: 1px solid #262629; border-radius: 8px; padding: 9px 10px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.45; }
    .msg.user { justify-self: end; background: #ededf0; color: #0d0d0f; border-color: transparent; }
    .msg.assistant { justify-self: start; background: #0d0d0f; color: #ededf0; }
    .msg-actions { display: flex; gap: 5px; opacity: .82; }
    .msg-actions button { min-height: 26px; padding: 0 7px; background: transparent; color: #a0a0a8; border-color: #323237; font-size: 11px; }
    .empty-thread { align-self: center; justify-self: center; color: #71717a; text-align: center; font-size: 13px; line-height: 1.45; }
    .compose { display: grid; gap: 8px; }
    .actions { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .pair-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .pair-link-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    .pair-link-block { display: grid; gap: 7px; }
    .pair-scanner { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border: 1px solid #323237; border-radius: 8px; background: #050507; }
    .attachment-tray { display: flex; flex-wrap: wrap; gap: 6px; }
    .attachment-pill { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; border: 1px solid #323237; border-radius: 7px; padding: 5px 7px; background: #0d0d0f; color: #a0a0a8; font-size: 11px; }
    .attachment-pill span { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .settings-panel { display: grid; gap: 8px; border-top: 1px solid #262629; padding-top: 10px; color: #a0a0a8; font-size: 12px; }
    button { min-height: 44px; border: 1px solid transparent; border-radius: 7px; padding: 0 12px; font: inherit; font-weight: 650; color: #0d0d0f; background: #ededf0; cursor: pointer; transition: transform .15s, border-color .15s, background .15s, color .15s; }
    button:hover { transform: translateY(-1px); }
    button:active { transform: translateY(0) scale(.99); }
    button.secondary { background: transparent; color: #ededf0; border-color: #323237; }
    button.secondary:hover { background: #1f1f23; border-color: #55555e; }
    button:disabled { opacity: .45; }
    .notice { min-height: 20px; margin: 0; color: #71717a; font-size: 12px; line-height: 1.45; }
    .error { color: #f87171; }
    .hidden { display: none; }
    footer { display: grid; gap: 8px; color: #71717a; font-size: 12px; line-height: 1.45; }
    .limits { display: flex; flex-wrap: wrap; gap: 6px; }
    .limits span { border: 1px solid #262629; border-radius: 7px; padding: 5px 7px; background: rgba(22,22,24,.72); }
    .install { justify-self: start; min-height: 34px; background: transparent; color: #ededf0; border-color: #323237; font-size: 12px; }
    @keyframes panel-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes drawer-fade {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .panel, .thread-drawer-backdrop { animation: none; }
      input, textarea, button, .thread-drawer { transition: none; }
    }
    /* Milim mobile shell: mirror desktop primitives without pulling in React. */
    :root {
      --bg-primary: #0d0d0f;
      --bg-secondary: #161618;
      --bg-tertiary: #1f1f23;
      --panel-bg: #161618;
      --sidebar-bg: #0a0a0c;
      --input-bg: #161618;
      --input-border: #323237;
      --border-primary: #262629;
      --border-secondary: #323237;
      --focus-border: #55555e;
      --glass-edge: rgba(255,255,255,0.08);
      --primary-text: #ededf0;
      --secondary-text: #a0a0a8;
      --tertiary-text: #71717a;
      --placeholder-text: #71717a;
      --accent: #ededf0;
      --accent-light: #c8c8d0;
      --accent-contrast: #10131a;
      --accent-soft: rgba(237, 237, 240, .14);
      --accent-15: rgba(237, 237, 240, .16);
      --accent-glow: rgba(237, 237, 240, .38);
      --chip-bg: #1f1f23;
      --chip-hover: #323237;
      --error: #f87171;
      --warning: #fbbf24;
      --success: #34d399;
      --blur: 0px;
      --bg-image: none;
      --bg-image-opacity: 1;
      --bg-image-blur: 0px;
      --overlay-color: #000000;
      --overlay-opacity: 0;
      --topbar-bg: var(--bg-primary);
      --app-height: 100svh;
      --viewport-top: 0px;
      --composer-height: 0px;
      --message-actions-inset: 36px;
      --shadow-soft: none;
      --shadow-strong: 0 18px 40px rgba(0,0,0,.52), 0 0 0 1px rgba(255,255,255,.04);
      --panel-row-hover: color-mix(in srgb, var(--chip-bg) 68%, transparent);
      --panel-row-active: color-mix(in srgb, var(--chip-bg) 88%, transparent);
      --panel-muted-bg: color-mix(in srgb, var(--bg-tertiary) 38%, transparent);
      --popover-bg: var(--panel-bg);
      --popover-border: var(--border-primary);
      --popover-blur: var(--blur);
      --card-radius: 12px;
      --input-radius: 10px;
      --chip-radius: 8px;
      --font: "Segoe UI Variable", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      --mono: "Cascadia Mono", "SFMono-Regular", Consolas, ui-monospace, monospace;
      font-family: var(--font);
      background: var(--bg-primary);
      color: var(--primary-text);
    }
    html {
      width: 100%;
      height: 100%;
      overflow: hidden;
      overscroll-behavior: none;
    }
    body {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      max-height: 100%;
      overflow: hidden;
      overscroll-behavior: none;
      background: var(--bg-primary);
      color: var(--primary-text);
      touch-action: manipulation;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      background-color: var(--bg-primary);
      background-image: var(--bg-image);
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      opacity: var(--bg-image-opacity, 1);
      filter: blur(var(--bg-image-blur, 0px));
      transform: scale(1.06);
    }
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      background: var(--overlay-color);
      opacity: var(--overlay-opacity);
    }
    body.bg-fit-cover::before {
      background-size: cover;
      background-repeat: no-repeat;
      background-position: center;
    }
    body.bg-fit-contain::before {
      background-size: contain;
      background-repeat: no-repeat;
      background-position: center;
      transform: none;
    }
    body.bg-fit-center::before {
      background-size: auto;
      background-repeat: no-repeat;
      background-position: center;
      transform: none;
    }
    body.bg-fit-tile::before {
      background-size: auto;
      background-repeat: repeat;
      background-position: top left;
      transform: none;
    }
    body.bg-treatment-blur::before {
      filter: blur(calc(var(--bg-image-blur, 0px) + 8px));
      transform: scale(1.09);
    }
    body.bg-treatment-mono::before {
      filter: grayscale(1) blur(var(--bg-image-blur, 0px));
    }
    body.bg-fit-tile.bg-treatment-blur::before {
      transform: none;
    }
    body.bg-treatment-dim::after {
      opacity: calc(var(--overlay-opacity) + 0.18);
    }
    main {
      position: relative;
      z-index: 1;
      width: min(100%, 760px);
      height: var(--app-height);
      min-height: var(--app-height);
      gap: 0;
      padding: env(safe-area-inset-top) 0 0;
      grid-template-rows: 44px minmax(0, 1fr);
      background: color-mix(in srgb, var(--bg-primary) 88%, transparent);
      border-inline: 1px solid var(--border-primary);
      box-shadow: 0 24px 80px rgba(0,0,0,.28);
      transform: translateY(var(--viewport-top));
      overflow: hidden;
      overscroll-behavior: none;
    }
    header {
      height: 44px;
      min-height: 44px;
      padding: 0 8px;
      border-bottom: 1px solid var(--border-primary);
      background: var(--topbar-bg);
      backdrop-filter: blur(var(--blur));
    }
    .top-actions { min-width: 0; }
    .brand { align-items: center; }
    .wordmark {
      width: 22px;
      height: 18px;
      background: currentColor;
      color: var(--primary-text);
      -webkit-mask: url("/mobile/wordmark.svg") center / contain no-repeat;
      mask: url("/mobile/wordmark.svg") center / contain no-repeat;
    }
    h1 { color: var(--tertiary-text); font-size: 11px; font-weight: 650; }
    .status {
      display: none;
      height: 28px;
      max-width: 72px;
      overflow: hidden;
      text-overflow: ellipsis;
      border-color: var(--border-primary);
      background: transparent;
      border-radius: 8px;
      color: var(--secondary-text);
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
    }
    .status::before { background: var(--warning); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning) 18%, transparent); }
    .status.ok::before { background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 18%, transparent); }
    .status.stale::before { background: var(--error); box-shadow: 0 0 0 3px color-mix(in srgb, var(--error) 18%, transparent); }
    .panel {
      align-self: stretch;
      min-height: 0;
      border: 0;
      border-radius: 0;
      padding: 0;
      background: transparent;
      box-shadow: none;
      animation: none;
    }
    #pairPanel {
      align-content: center;
      justify-items: center;
      overflow: auto;
      padding: 18px 14px calc(18px + env(safe-area-inset-bottom));
      background: transparent;
    }
    .pair-card {
      width: min(100%, 300px);
      display: grid;
      gap: 12px;
      padding: 13px;
      border: 1px solid var(--border-primary);
      border-radius: var(--card-radius);
      background: var(--panel-bg);
      box-shadow: inset 0 1px 0 var(--glass-edge);
    }
    #pairPanel .panel-head { gap: 5px; }
    #pairPanel h2 { max-width: none; font-size: 22px; line-height: 1.05; letter-spacing: -.04em; text-wrap: balance; }
    #pairPanel .panel-head p { max-width: 36ch; color: var(--secondary-text); font-size: 12.5px; }
    .pair-actions,
    .pair-link-row { grid-template-columns: 1fr; }
    .pair-actions,
    .pair-link-row { width: 100%; }
    .pair-link-row button { justify-self: stretch; }
    .thread-panel {
      position: relative;
      height: calc(var(--app-height) - 44px - env(safe-area-inset-top));
      min-height: 0;
      grid-template-rows: auto auto minmax(0, 1fr) auto auto;
      gap: 0;
      overflow: hidden;
    }
    .thread-head {
      min-height: 50px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border-primary);
      background: var(--sidebar-bg);
      backdrop-filter: blur(var(--blur));
    }
    .thread-head h2 {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 17px;
      font-weight: 720;
      letter-spacing: -.02em;
    }
    .thread-head p {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--tertiary-text);
      font-family: var(--mono);
      font-size: 11px;
    }
    .thread-state,
    .thread-switch,
    .mini-btn {
      min-height: 30px;
      border-radius: 8px;
      border-color: transparent;
      background: transparent;
      color: var(--secondary-text);
      font-size: 12px;
    }
    .thread-state {
      border-color: var(--border-primary);
      background: transparent;
      color: var(--tertiary-text);
      font-family: var(--mono);
      font-size: 10.5px;
    }
    .thread-switch:hover,
    .mini-btn:hover {
      background: var(--chip-hover);
      color: var(--primary-text);
    }
    .mini-btn.danger { color: #fca5a5; }
    select,
    input,
    textarea {
      border-color: var(--border-primary);
      background: var(--input-bg);
      color: var(--primary-text);
      border-radius: 8px;
      font-size: 16px;
    }
    input:focus,
    textarea:focus,
    select:focus {
      border-color: var(--border-secondary);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    .thread-search {
      padding: 7px 10px;
      margin: 0;
      border-bottom: 1px solid var(--border-primary);
      background: var(--bg-secondary);
    }
    .thread-drawer-backdrop {
      position: fixed;
      inset: 0;
      z-index: 20;
      background: color-mix(in srgb, var(--bg-primary) 58%, transparent);
      backdrop-filter: blur(2px);
      animation: drawer-fade .16s ease-out;
    }
    .thread-drawer {
      position: fixed;
      z-index: 21;
      top: calc(env(safe-area-inset-top) + 44px);
      bottom: 0;
      left: max(0px, calc((100vw - 760px) / 2));
      width: min(86vw, 340px);
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr);
      border-right: 1px solid var(--border-primary);
      background:
        linear-gradient(180deg, var(--sidebar-bg), color-mix(in srgb, var(--sidebar-bg) 92%, var(--bg-secondary))),
        var(--sidebar-bg);
      box-shadow: 18px 0 48px rgba(0,0,0,.34), inset -1px 0 0 var(--glass-edge);
      transform: translateX(-105%);
      transition: transform .2s ease;
      pointer-events: none;
    }
    .thread-drawer.open {
      transform: translateX(0);
      pointer-events: auto;
    }
    .thread-drawer-head {
      min-height: 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 8px 8px 12px;
      border-bottom: 1px solid var(--border-primary);
      background: var(--panel-bg);
    }
    .thread-drawer-head strong {
      display: block;
      color: var(--primary-text);
      font-size: 13px;
      font-weight: 760;
    }
    .thread-drawer-head span {
      display: block;
      color: var(--tertiary-text);
      font-size: 11px;
      margin-top: 2px;
    }
    .thread-drawer-head button {
      min-height: 30px;
      width: auto;
      padding: 0 9px;
    }
    .thread-drawer-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      padding: 7px 8px;
      border-bottom: 1px solid var(--border-primary);
      background: var(--sidebar-bg);
    }
    .thread-list {
      min-height: 0;
      max-height: none;
      overflow: auto;
      display: grid;
      align-content: start;
      gap: 10px;
      padding: 10px 8px 14px;
      border: 0;
      background: transparent;
      scrollbar-width: thin;
    }
    .thread-group { display: grid; gap: 5px; }
    .thread-group-head {
      display: grid;
      gap: 2px;
      padding: 7px 8px 3px;
      color: var(--tertiary-text);
      font-size: 10px;
      font-weight: 760;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    .thread-group-head span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--tertiary-text);
      font-family: var(--mono);
      font-size: 10px;
      font-weight: 520;
      letter-spacing: 0;
      text-transform: none;
    }
    .thread-item {
      min-height: 34px;
      padding: 5px 7px 5px 10px;
      border-color: transparent;
      border-radius: 8px;
      background: transparent;
      color: var(--secondary-text);
    }
    .thread-item.active {
      border-color: var(--border-primary);
      background: var(--panel-row-active);
      color: var(--primary-text);
    }
    .thread-item:hover { background: var(--chip-hover); }
    .thread-item.child { margin-left: 14px; }
    .thread-item small { color: var(--tertiary-text); font-family: var(--mono); }
    .thread-item.active small { color: var(--tertiary-text); }
    .thread-messages {
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      padding: 14px 12px calc(16px + var(--composer-height) + var(--message-actions-inset));
      scroll-padding-bottom: calc(16px + var(--composer-height) + var(--message-actions-inset));
      gap: 12px;
      background:
        linear-gradient(180deg, rgba(255,255,255,.018), transparent 160px),
        color-mix(in srgb, var(--bg-primary) 88%, transparent);
      backdrop-filter: blur(var(--blur));
    }
    .msg-wrap { max-width: 100%; gap: 4px; }
    .msg-wrap.user { max-width: 82%; }
    .msg {
      min-width: 0;
      border-color: var(--border-primary);
      border-radius: 8px;
      background: color-mix(in srgb, var(--panel-bg) 72%, var(--bg-primary));
      color: var(--primary-text);
      font-size: 13px;
      line-height: 1.58;
      overflow-wrap: anywhere;
      backdrop-filter: blur(var(--blur));
    }
    .msg.user {
      border-color: var(--accent-soft);
      background: var(--accent-15);
      color: var(--primary-text);
    }
    .msg.assistant {
      width: 100%;
      border-color: transparent;
      background: transparent;
      padding-inline: 2px;
      backdrop-filter: none;
    }
    .msg > :first-child { margin-top: 0; }
    .msg > :last-child { margin-bottom: 0; }
    .msg p { margin: 0 0 8px; }
    .msg h1,
    .msg h2,
    .msg h3,
    .msg h4,
    .msg h5,
    .msg h6 {
      margin: 10px 0 6px;
      font-size: 14px;
      line-height: 1.3;
      letter-spacing: 0;
    }
    .msg ul,
    .msg ol { margin: 6px 0; padding-left: 18px; }
    .msg li { margin: 3px 0; }
    .msg blockquote {
      margin: 8px 0;
      padding-left: 10px;
      border-left: 2px solid var(--border-secondary);
      color: var(--secondary-text);
    }
    .msg pre {
      max-width: 100%;
      overflow: auto;
      margin: 8px 0;
      padding: 9px 10px;
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      background: var(--bg-secondary);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre;
    }
    .msg code {
      border-radius: 5px;
      background: var(--chip-bg);
      padding: 1px 4px;
      font-family: var(--mono);
      font-size: .92em;
    }
    .msg pre code { background: transparent; padding: 0; }
    .msg table {
      display: block;
      max-width: 100%;
      overflow: auto;
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 12px;
    }
    .msg th,
    .msg td {
      border: 1px solid var(--border-primary);
      padding: 5px 7px;
      text-align: left;
      vertical-align: top;
    }
    .msg th { background: var(--bg-secondary); }
    .msg a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
    .msg-actions button {
      min-height: 26px;
      border-radius: 6px;
      background: transparent;
      color: var(--tertiary-text);
      border-color: transparent;
      font-size: 11px;
    }
    .msg-actions button:hover { background: var(--chip-hover); color: var(--secondary-text); }
    .compose {
      align-self: end;
      margin: 6px 8px max(4px, env(safe-area-inset-bottom));
      padding: 6px 7px;
      gap: 4px;
      border: 1px solid var(--border-primary);
      border-radius: var(--input-radius);
      background: var(--panel-bg);
      box-shadow: inset 0 1px 0 var(--glass-edge);
      backdrop-filter: blur(var(--blur));
    }
    .composer-model-select {
      min-height: 30px;
      height: 30px;
      padding: 0 28px 0 8px;
      border-radius: 7px;
      background: var(--chip-bg);
      color: var(--secondary-text);
      font-size: 12px;
      font-weight: 650;
    }
    textarea {
      height: 44px;
      min-height: 36px;
      max-height: 26svh;
      resize: vertical;
      padding: 4px 2px;
      border: 0;
      background: transparent;
      line-height: 1.4;
    }
    .compose .actions {
      display: grid;
      grid-template-columns: 32px minmax(0, 1fr) 32px;
      align-items: center;
      gap: 6px;
      margin-top: 0;
    }
    .compose .actions button {
      width: 32px;
      min-height: 32px;
      padding: 0;
    }
    .compose .actions button span { display: none; }
    .send-stack {
      display: grid;
      width: 32px;
      height: 32px;
    }
    .send-stack button {
      grid-area: 1 / 1;
    }
    .attachment-tray:empty { display: none; }
    .compose .notice {
      min-width: 0;
      min-height: 0;
      padding: 0 4px;
      overflow: hidden;
      color: var(--tertiary-text);
      font-size: 11px;
      text-align: center;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .compose .notice:empty { display: block; }
    .compose .notice.error { color: var(--error); }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 32px;
      border-radius: 8px;
      color: var(--accent-contrast);
      background: var(--accent);
      transition: transform .14s ease, background .14s ease, border-color .14s ease;
    }
    button.secondary {
      color: var(--secondary-text);
      background: transparent;
      border-color: var(--border-primary);
    }
    button.secondary:hover {
      background: var(--chip-hover);
      border-color: var(--border-secondary);
      color: var(--primary-text);
    }
    button:focus-visible {
      outline: 2px solid rgba(220,230,248,.62);
      outline-offset: 2px;
    }
    .button-icon {
      width: 14px;
      height: 14px;
      flex: none;
    }
    .attachment-pill,
    .limits span {
      border-color: var(--border-primary);
      background: var(--chip-bg);
      color: var(--secondary-text);
    }
    .settings-panel {
      margin: 0 10px 10px;
      padding: 10px;
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      background: var(--panel-bg);
      box-shadow: inset 0 1px 0 var(--glass-edge);
      backdrop-filter: blur(var(--blur));
    }
    .notice,
    .empty-thread,
    footer {
      color: var(--tertiary-text);
    }
    .notice { padding: 0 10px; }
    .notice:empty { display: none; }
    footer { display: none; }
    @media (max-width: 430px) {
      .thread-head { grid-template-columns: minmax(0, 1fr) auto; }
      .thread-state { display: none; }
    }
    @media (min-width: 520px) {
      .status { display: inline-flex; }
    }
  </style>
</head>
<body class="theme-dark bg-fit-cover bg-treatment-clear">
  <main>
    <header>
      <div class="brand" aria-label="Milim Relay">
        <span class="wordmark" role="img" aria-label="milim"></span>
        <h1>Relay</h1>
      </div>
      <div class="top-actions">
        <button id="settingsToggle" class="mini-btn" type="button">Device</button>
        <span id="status" class="status">Disconnected</span>
      </div>
    </header>

    <section id="pairPanel" class="panel hidden">
      <div class="pair-card">
        <div class="panel-head">
          <h2>Pair this phone</h2>
          <p>Give this device a name. Milim will show it on incoming relay events.</p>
        </div>
        <label>
          Device name
          <input id="deviceName" autocomplete="name" placeholder="My phone" />
        </label>
        <div class="pair-actions">
          <button id="pairButton" type="button">Pair this device</button>
          <button id="scanPairButton" class="secondary" type="button">Scan desktop QR</button>
        </div>
        <video id="pairScanner" class="pair-scanner hidden" playsinline muted></video>
        <button id="stopScanButton" class="secondary hidden" type="button">Stop camera</button>
        <div class="pair-link-block">
          <label for="pairLinkInput">Pairing link</label>
          <div class="pair-link-row">
            <input id="pairLinkInput" inputmode="url" autocomplete="off" placeholder="Paste pairing link" />
            <button id="pairLinkButton" class="secondary" type="button">Use link</button>
          </div>
        </div>
        <p id="pairNotice" class="notice"></p>
      </div>
    </section>

    <section id="relayPanel" class="panel thread-panel hidden">
      <div class="thread-head">
        <div>
          <h2 id="threadTitle">Milim</h2>
          <p id="threadMeta">Waiting for desktop thread...</p>
        </div>
        <button id="threadsToggle" class="thread-switch" type="button">Threads</button>
        <span id="threadState" class="thread-state">Idle</span>
      </div>
      <div id="threadDrawerBackdrop" class="thread-drawer-backdrop hidden"></div>
      <aside id="threadDrawer" class="thread-drawer" aria-hidden="true" aria-label="Thread sidebar">
        <div class="thread-drawer-head">
          <div>
            <strong>Threads</strong>
            <span>Desktop sidebar</span>
          </div>
          <button id="threadDrawerClose" class="mini-btn" type="button">Close</button>
        </div>
        <div class="thread-drawer-actions">
          <button id="newThreadButton" class="mini-btn" type="button">New</button>
          <button id="renameButton" class="mini-btn" type="button">Rename</button>
        </div>
        <label class="thread-search" id="threadSearchWrap">
          Search threads
          <input id="threadSearch" placeholder="Search by title, model, or project" />
        </label>
        <div id="threadList" class="thread-list"></div>
      </aside>
      <div id="threadMessages" class="thread-messages"></div>
      <form id="relayForm" class="compose">
        <select id="modelSelect" class="composer-model-select" aria-label="Model"></select>
        <textarea id="relayText" autofocus aria-label="Message" placeholder="Ask from your phone..."></textarea>
        <div id="attachmentTray" class="attachment-tray"></div>
        <input id="fileInput" class="hidden" type="file" multiple accept="image/*,.txt,.md,.json,.csv,.log" />
        <div class="actions">
          <button id="attachButton" class="secondary" type="button">Attach</button>
          <p id="relayNotice" class="notice"></p>
          <span class="send-stack">
            <button id="sendButton" type="submit">Send</button>
            <button id="stopButton" class="danger hidden" type="button">Stop</button>
          </span>
        </div>
      </form>
      <div id="settingsPanel" class="settings-panel hidden">
        <div id="deviceStatus">No device details yet.</div>
        <button id="forgetButton" class="secondary danger" type="button">Forget this phone</button>
        <button id="archiveButton" class="secondary" type="button">Archive thread</button>
        <button id="deleteThreadButton" class="secondary danger" type="button">Delete thread</button>
      </div>
    </section>

    <footer>
      <div class="limits">
        <span>Live desktop mirror</span>
        <span>Thread controls</span>
        <span>Phone uploads</span>
      </div>
      <button id="installButton" class="install hidden" type="button">Add to Home Screen</button>
      <span>Actions run through the paired desktop app.</span>
    </footer>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const MAX_TEXT_ATTACHMENT_BYTES = 128 * 1024;
    const MAX_IMAGE_PREVIEW_BYTES = 2 * 1024 * 1024;
    const MAX_ATTACHMENTS = 6;
    const state = { thread: null, device: null, attachments: [], query: "", source: null, streamLive: false, lastUpdate: 0 };
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    const themeCssVarPattern = /^--[a-z0-9-]+$/;
    const backgroundFits = new Set(["cover", "contain", "tile", "center"]);
    const backgroundTreatments = new Set(["clear", "dim", "blur", "mono"]);
    const buttonIcons = {
      archive: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v5H4Z"/><path d="M6 9v9a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/></svg>`,
      arrowUp: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`,
      camera: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4Z"/><circle cx="12" cy="13" r="3"/></svg>`,
      copy: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>`,
      gear: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>`,
      link: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"/></svg>`,
      paperclip: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5 12.5 20a4.5 4.5 0 0 1-6.4-6.4l8.5-8.5a3 3 0 0 1 4.3 4.3l-8.6 8.5a1.5 1.5 0 0 1-2.1-2.1l7.8-7.8"/></svg>`,
      pencil: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
      plus: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`,
      refresh: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/></svg>`,
      sidebar: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>`,
      smartphone: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>`,
      square: `<svg class="button-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`,
      trash: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>`,
      x: `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
    };
    const store = {
      get key() { return localStorage.getItem("milim.mobile.deviceKey") || ""; },
      set key(value) { value ? localStorage.setItem("milim.mobile.deviceKey", value) : localStorage.removeItem("milim.mobile.deviceKey"); },
      get id() { return localStorage.getItem("milim.mobile.deviceId") || ""; },
      set id(value) { value ? localStorage.setItem("milim.mobile.deviceId", value) : localStorage.removeItem("milim.mobile.deviceId"); },
      get name() { return localStorage.getItem("milim.mobile.deviceName") || ""; },
      set name(value) { value ? localStorage.setItem("milim.mobile.deviceName", value) : localStorage.removeItem("milim.mobile.deviceName"); },
    };
    const statusEl = document.getElementById("status");
    const pairPanel = document.getElementById("pairPanel");
    const relayPanel = document.getElementById("relayPanel");
    const pairNotice = document.getElementById("pairNotice");
    const relayNotice = document.getElementById("relayNotice");
    const relayText = document.getElementById("relayText");
    const relayForm = document.getElementById("relayForm");
    const threadTitle = document.getElementById("threadTitle");
    const threadMeta = document.getElementById("threadMeta");
    const threadState = document.getElementById("threadState");
    const threadsToggle = document.getElementById("threadsToggle");
    const threadDrawer = document.getElementById("threadDrawer");
    const threadDrawerBackdrop = document.getElementById("threadDrawerBackdrop");
    const threadDrawerClose = document.getElementById("threadDrawerClose");
    const threadSearch = document.getElementById("threadSearch");
    const threadList = document.getElementById("threadList");
    const threadMessages = document.getElementById("threadMessages");
    const modelSelect = document.getElementById("modelSelect");
    const sendButton = document.getElementById("sendButton");
    const stopButton = document.getElementById("stopButton");
    const attachmentTray = document.getElementById("attachmentTray");
    const fileInput = document.getElementById("fileInput");
    const installButton = document.getElementById("installButton");
    const deviceName = document.getElementById("deviceName");
    const pairLinkInput = document.getElementById("pairLinkInput");
    const scanPairButton = document.getElementById("scanPairButton");
    const stopScanButton = document.getElementById("stopScanButton");
    const pairScanner = document.getElementById("pairScanner");
    const settingsPanel = document.getElementById("settingsPanel");
    const deviceStatus = document.getElementById("deviceStatus");
    let installPrompt = null;
    let activePairId = params.get("pair_id") || "";
    let activePairSecret = params.get("secret") || "";
    let scannerStream = null;
    let scannerFrame = 0;
    deviceName.value = store.name || "";
    [
      ["settingsToggle", "gear", "Device"],
      ["pairButton", "smartphone", "Pair this device"],
      ["scanPairButton", "camera", "Scan desktop QR"],
      ["stopScanButton", "x", "Stop camera"],
      ["pairLinkButton", "link", "Use link"],
      ["threadsToggle", "sidebar", "Threads"],
      ["threadDrawerClose", "x", "Close"],
      ["newThreadButton", "plus", "New"],
      ["stopButton", "square", "Stop"],
      ["renameButton", "pencil", "Rename"],
      ["sendButton", "arrowUp", "Send"],
      ["attachButton", "paperclip", "Attach"],
      ["forgetButton", "smartphone", "Forget this phone"],
      ["archiveButton", "archive", "Archive thread"],
      ["deleteThreadButton", "trash", "Delete thread"],
      ["installButton", "smartphone", "Add to Home Screen"],
    ].forEach(([id, icon, label]) => setButtonIcon(document.getElementById(id), icon, label));

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/mobile/sw.js", { scope: "/mobile" }).catch(() => {});
    }
    function syncVisualViewport() {
      const viewport = window.visualViewport;
      const height = Math.max(320, Math.floor(viewport?.height || window.innerHeight || document.documentElement.clientHeight));
      const top = Math.max(0, Math.floor(viewport?.offsetTop || 0));
      document.documentElement.style.setProperty("--app-height", `${height}px`);
      document.documentElement.style.setProperty("--viewport-top", `${top}px`);
      syncComposerInset();
      if (document.activeElement === relayText) {
        requestAnimationFrame(() => relayText.scrollIntoView({ block: "nearest" }));
      }
    }
    function syncComposerInset() {
      document.documentElement.style.setProperty("--composer-height", `${Math.ceil(relayForm.getBoundingClientRect().height || 0)}px`);
    }
    syncVisualViewport();
    if ("ResizeObserver" in window) new ResizeObserver(syncComposerInset).observe(relayForm);
    window.visualViewport?.addEventListener("resize", syncVisualViewport);
    window.visualViewport?.addEventListener("scroll", syncVisualViewport);
    window.addEventListener("resize", syncVisualViewport);
    relayText.addEventListener("focus", syncVisualViewport);
    relayText.addEventListener("blur", () => window.setTimeout(syncVisualViewport, 120));
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      installPrompt = event;
      installButton.classList.remove("hidden");
    });
    let lastTouchEnd = 0;
    document.addEventListener("gesturestart", (event) => event.preventDefault());
    document.addEventListener("gesturechange", (event) => event.preventDefault());
    document.addEventListener("touchmove", (event) => {
      if (event.touches.length > 1) event.preventDefault();
    }, { passive: false });
    document.addEventListener("touchend", (event) => {
      const now = Date.now();
      if (now - lastTouchEnd < 320) event.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    installButton.addEventListener("click", async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => {});
      installPrompt = null;
      installButton.classList.add("hidden");
    });

    function show(panel) {
      pairPanel.classList.toggle("hidden", panel !== "pair");
      relayPanel.classList.toggle("hidden", panel !== "relay");
    }
    function setButtonIcon(button, icon, label) {
      if (!button) return;
      button.innerHTML = `${buttonIcons[icon] || ""}<span>${label}</span>`;
      button.setAttribute("aria-label", label);
      button.title = label;
    }
    function setStatus(text, ok, stale = false) {
      statusEl.textContent = text;
      statusEl.classList.toggle("ok", ok && !stale);
      statusEl.classList.toggle("stale", stale);
      statusEl.style.color = ok ? "var(--success)" : stale ? "var(--error)" : "var(--warning)";
    }
    function setChoiceClass(prefix, value, allowed, fallback) {
      const next = allowed.has(value) ? value : fallback;
      for (const option of allowed) document.body.classList.toggle(`${prefix}-${option}`, option === next);
    }
    function applyThemeSnapshot(theme) {
      if (!theme || typeof theme !== "object") return;
      const vars = theme.css_vars && typeof theme.css_vars === "object" ? theme.css_vars : {};
      for (const [key, value] of Object.entries(vars)) {
        if (!themeCssVarPattern.test(key) || typeof value !== "string") continue;
        document.documentElement.style.setProperty(key, value);
      }
      const isDark = theme.is_dark !== false;
      document.documentElement.dataset.dark = String(isDark);
      document.documentElement.style.colorScheme = isDark ? "dark" : "light";
      document.body.classList.toggle("theme-dark", isDark);
      document.body.classList.toggle("theme-light", !isDark);
      setChoiceClass("bg-fit", theme.background_fit, backgroundFits, "cover");
      setChoiceClass("bg-treatment", theme.background_treatment, backgroundTreatments, "clear");
      if (typeof vars["--bg-primary"] === "string" && vars["--bg-primary"]) {
        themeColorMeta?.setAttribute("content", vars["--bg-primary"]);
      }
    }
    async function api(path, options = {}) {
      const headers = new Headers(options.headers || {});
      if (store.key) headers.set("Authorization", `Bearer ${store.key}`);
      if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      const response = await fetch(path, { ...options, headers });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const data = await response.json();
          message = data.error?.message || data.message || message;
        } catch {}
        throw new Error(message);
      }
      return await response.json();
    }
    async function relayAction(action, text = "", attachments = []) {
      return await api("/mobile/relay", {
        method: "POST",
        body: JSON.stringify({ action, text, attachments }),
      });
    }
    function showRelayError(error) {
      relayNotice.textContent = String(error.message || error);
      relayNotice.className = "notice error";
    }
    function renderDevice() {
      const device = state.device;
      deviceStatus.textContent = device
        ? `Paired as ${device.name}. Last seen ${new Date((device.last_seen_at || 0) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
        : "No device details yet.";
    }
    function renderModelSelect(thread) {
      modelSelect.replaceChildren();
      const models = Array.isArray(thread?.models) ? thread.models : [];
      const current = thread?.model || "";
      const seen = new Set();
      for (const model of current ? [{ id: current, provider: "Current" }, ...models] : models) {
        if (!model.id || seen.has(model.id)) continue;
        seen.add(model.id);
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.provider ? `${model.id} (${model.provider})` : model.id;
        modelSelect.append(option);
      }
      modelSelect.disabled = modelSelect.options.length === 0;
      if (current) modelSelect.value = current;
    }
    function threadSearchText(group, item) {
      return [
        group?.label,
        group?.subtitle,
        item?.title,
        item?.model,
        item?.project_label,
        item?.project_path,
      ].filter(Boolean).join(" ").toLowerCase();
    }
    function groupedThreads(thread) {
      const groups = Array.isArray(thread?.groups) && thread.groups.length
        ? thread.groups
        : [{ id: "threads", label: "Threads", threads: Array.isArray(thread?.threads) ? thread.threads : [] }];
      const query = state.query.trim().toLowerCase();
      return groups.map((group) => {
        const threads = Array.isArray(group.threads) ? group.threads : [];
        const visible = query
          ? threads.filter((item) => threadSearchText(group, item).includes(query))
          : threads;
        return { ...group, threads: visible };
      }).filter((group) => group.threads.length);
    }
    function renderThreadList(thread) {
      threadList.replaceChildren();
      const groups = groupedThreads(thread);
      if (!groups.length) {
        const empty = document.createElement("div");
        empty.className = "empty-thread";
        empty.textContent = state.query.trim() ? "No matching threads." : "No desktop threads yet.";
        threadList.append(empty);
        return;
      }
      for (const group of groups) {
        const section = document.createElement("section");
        section.className = "thread-group";
        const head = document.createElement("div");
        head.className = "thread-group-head";
        const label = document.createElement("strong");
        label.textContent = group.label || "Threads";
        head.append(label);
        if (group.subtitle) {
          const subtitle = document.createElement("span");
          subtitle.textContent = group.subtitle;
          head.append(subtitle);
        }
        section.append(head);
        for (const item of group.threads) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `thread-item ${item.id === thread?.session_id ? "active" : ""} ${item.parent_id ? "child" : ""}`;
          const title = document.createElement("span");
          title.textContent = item.title || "New chat";
          const meta = document.createElement("small");
          const project = group.id === "pinned" && item.project_label ? item.project_label : "";
          meta.textContent = [project, item.model, item.busy ? "Running" : ""].filter(Boolean).join(" / ");
          button.append(title, meta);
          button.addEventListener("click", () => switchThread(item.id));
          section.append(button);
        }
        threadList.append(section);
      }
    }
    function safeHref(raw) {
      try {
        const url = new URL(raw, location.href);
        return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : "";
      } catch {
        return "";
      }
    }
    function appendInline(parent, text) {
      let i = 0;
      const addText = (value) => { if (value) parent.append(document.createTextNode(value)); };
      while (i < text.length) {
        if (text.startsWith("`", i)) {
          const end = text.indexOf("`", i + 1);
          if (end > i + 1) {
            const code = document.createElement("code");
            code.textContent = text.slice(i + 1, end);
            parent.append(code);
            i = end + 1;
            continue;
          }
        }
        if (text.startsWith("**", i)) {
          const end = text.indexOf("**", i + 2);
          if (end > i + 2) {
            const strong = document.createElement("strong");
            appendInline(strong, text.slice(i + 2, end));
            parent.append(strong);
            i = end + 2;
            continue;
          }
        }
        if (text.startsWith("*", i)) {
          const end = text.indexOf("*", i + 1);
          if (end > i + 1) {
            const em = document.createElement("em");
            appendInline(em, text.slice(i + 1, end));
            parent.append(em);
            i = end + 1;
            continue;
          }
        }
        if (text.startsWith("[", i)) {
          const close = text.indexOf("](", i + 1);
          const end = close > i ? text.indexOf(")", close + 2) : -1;
          const href = end > close ? safeHref(text.slice(close + 2, end)) : "";
          if (href) {
            const link = document.createElement("a");
            link.href = href;
            link.target = "_blank";
            link.rel = "noreferrer";
            appendInline(link, text.slice(i + 1, close));
            parent.append(link);
            i = end + 1;
            continue;
          }
        }
        const next = ["`", "**", "*", "["]
          .map((marker) => text.indexOf(marker, i + 1))
          .filter((index) => index > i)
          .sort((a, b) => a - b)[0] ?? text.length;
        addText(text.slice(i, next));
        i = next;
      }
    }
    function tableCells(line) {
      return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    }
    function isTableSeparator(line) {
      return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
    }
    function isListLine(line, ordered) {
      return ordered ? /^\s*\d+[.)]\s+/.test(line) : /^\s*[-*+]\s+/.test(line);
    }
    function isBlockStart(lines, index) {
      const line = lines[index] || "";
      return /^```/.test(line)
        || /^#{1,6}\s+/.test(line)
        || /^>\s?/.test(line)
        || isListLine(line, true)
        || isListLine(line, false)
        || (line.includes("|") && isTableSeparator(lines[index + 1] || ""));
    }
    function renderMarkdown(target, source) {
      const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
      target.replaceChildren();
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i += 1; continue; }
        if (line.startsWith("```")) {
          const codeLines = [];
          i += 1;
          while (i < lines.length && !lines[i].startsWith("```")) codeLines.push(lines[i++]);
          if (i < lines.length) i += 1;
          const pre = document.createElement("pre");
          const code = document.createElement("code");
          code.textContent = codeLines.join("\n");
          pre.append(code);
          target.append(pre);
          continue;
        }
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        if (heading) {
          const el = document.createElement(`h${heading[1].length}`);
          appendInline(el, heading[2]);
          target.append(el);
          i += 1;
          continue;
        }
        if (line.includes("|") && isTableSeparator(lines[i + 1] || "")) {
          const headers = tableCells(line);
          i += 2;
          const table = document.createElement("table");
          const thead = table.createTHead();
          const headerRow = thead.insertRow();
          headers.forEach((header) => {
            const th = document.createElement("th");
            appendInline(th, header);
            headerRow.append(th);
          });
          const body = table.createTBody();
          while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
            const row = body.insertRow();
            tableCells(lines[i++]).forEach((cell) => {
              const td = row.insertCell();
              appendInline(td, cell);
            });
          }
          target.append(table);
          continue;
        }
        if (/^>\s?/.test(line)) {
          const quote = document.createElement("blockquote");
          const parts = [];
          while (i < lines.length && /^>\s?/.test(lines[i])) parts.push(lines[i++].replace(/^>\s?/, ""));
          appendInline(quote, parts.join(" "));
          target.append(quote);
          continue;
        }
        if (isListLine(line, true) || isListLine(line, false)) {
          const ordered = isListLine(line, true);
          const list = document.createElement(ordered ? "ol" : "ul");
          while (i < lines.length && isListLine(lines[i], ordered)) {
            const li = document.createElement("li");
            appendInline(li, lines[i++].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, ""));
            list.append(li);
          }
          target.append(list);
          continue;
        }
        const paragraph = [];
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) paragraph.push(lines[i++]);
        const p = document.createElement("p");
        appendInline(p, paragraph.join(" "));
        target.append(p);
      }
      if (!target.childNodes.length && source) target.textContent = source;
    }
    function renderThread(thread) {
      state.thread = thread;
      applyThemeSnapshot(thread?.theme);
      threadMessages.replaceChildren();
      renderModelSelect(thread);
      if (!thread) {
        threadTitle.textContent = "No active thread";
        threadMeta.textContent = "Open Milim on desktop to publish the current chat.";
        threadState.textContent = "Offline";
        stopButton.disabled = true;
        stopButton.classList.add("hidden");
        sendButton.classList.remove("hidden");
        renderThreadList(null);
        const empty = document.createElement("div");
        empty.className = "empty-thread";
        empty.textContent = "Waiting for the active desktop thread.";
        threadMessages.append(empty);
        return;
      }
      threadTitle.textContent = thread.title || "Current thread";
      threadMeta.textContent = [thread.model, new Date(thread.updated_at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })].filter(Boolean).join(" / ");
      threadState.textContent = thread.busy ? "Running" : "Idle";
      stopButton.disabled = !thread.busy;
      stopButton.classList.toggle("hidden", !thread.busy);
      sendButton.classList.toggle("hidden", thread.busy);
      renderThreadList(thread);
      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      if (!messages.length) {
        const empty = document.createElement("div");
        empty.className = "empty-thread";
        empty.textContent = "This thread is empty. Send a message from your phone.";
        threadMessages.append(empty);
        return;
      }
      const latestAssistantIndex = messages.reduce((latest, message, index) => message.role === "assistant" ? index : latest, -1);
      messages.forEach((message, index) => {
        const role = message.role === "user" ? "user" : "assistant";
        const wrap = document.createElement("div");
        wrap.className = `msg-wrap ${role}`;
        const item = document.createElement("article");
        item.className = `msg ${role}`;
        renderMarkdown(item, message.content || "");
        const actions = document.createElement("div");
        actions.className = "msg-actions";
        const copy = document.createElement("button");
        copy.type = "button";
        setButtonIcon(copy, "copy", "Copy");
        copy.addEventListener("click", () => navigator.clipboard?.writeText(message.content || "").catch(() => {}));
        const del = document.createElement("button");
        del.type = "button";
        setButtonIcon(del, "trash", "Delete");
        del.addEventListener("click", () => relayAction("delete_message", String(index)).catch(showRelayError));
        actions.append(copy, del);
        if (index === latestAssistantIndex) {
          const regen = document.createElement("button");
          regen.type = "button";
          setButtonIcon(regen, "refresh", "Regenerate");
          regen.addEventListener("click", () => relayAction("regenerate").catch(showRelayError));
          actions.append(regen);
        }
        wrap.append(item, actions);
        threadMessages.append(wrap);
      });
      threadMessages.scrollTop = threadMessages.scrollHeight;
    }
    async function refreshThread() {
      if (!store.key || relayPanel.classList.contains("hidden")) return;
      try {
        const data = await api("/mobile/thread");
        state.lastUpdate = Date.now();
        renderThread(data.thread);
      } catch (error) {
        renderThread(null);
        showRelayError(error);
      }
    }
    function connectThreadStream() {
      if (state.source) state.source.close();
      state.streamLive = false;
      if (!store.key || !("EventSource" in window)) return;
      const source = new EventSource(`/mobile/thread/events?key=${encodeURIComponent(store.key)}`);
      state.source = source;
      source.onopen = () => {
        state.streamLive = true;
        setStatus("Live", true);
      };
      source.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          state.lastUpdate = Date.now();
          renderThread(data.thread);
          setStatus("Live", true);
        } catch {}
      };
      source.onerror = () => {
        state.streamLive = false;
        setStatus("Reconnecting", false, true);
      };
    }
    function checkHealth() {
      if (relayPanel.classList.contains("hidden") || !state.lastUpdate) return;
      if (Date.now() - state.lastUpdate > 10000) setStatus("Stale", false, true);
    }
    function openThreadDrawer() {
      threadDrawer.classList.add("open");
      threadDrawer.setAttribute("aria-hidden", "false");
      threadDrawerBackdrop.classList.remove("hidden");
    }
    function closeThreadDrawer() {
      threadDrawer.classList.remove("open");
      threadDrawer.setAttribute("aria-hidden", "true");
      threadDrawerBackdrop.classList.add("hidden");
    }
    async function switchThread(sessionId) {
      if (!sessionId) return;
      relayNotice.textContent = "Switching thread...";
      relayNotice.className = "notice";
      try {
        await relayAction("switch_thread", sessionId);
        closeThreadDrawer();
        window.setTimeout(refreshThread, 800);
      } catch (error) {
        showRelayError(error);
      }
    }
    async function checkDevice() {
      if (!store.key) return false;
      try {
        const data = await api("/mobile/device/status");
        state.device = data.device;
        renderDevice();
        setStatus("Connected", true);
        show("relay");
        connectThreadStream();
        await refreshThread();
        return true;
      } catch (error) {
        setStatus("Pairing needed", false);
        return false;
      }
    }
    function applyPairingLink(raw) {
      const value = String(raw || "").trim().replaceAll("&amp;", "&");
      if (!value) throw new Error("Paste a Milim pairing link first.");
      let url;
      try {
        url = new URL(value, location.href);
      } catch {
        throw new Error("That does not look like a Milim pairing link.");
      }
      const pairId = url.searchParams.get("pair_id") || "";
      const secret = url.searchParams.get("secret") || "";
      if (!pairId || !secret) throw new Error("That QR code did not include a Milim pairing token.");
      if (url.origin !== location.origin) {
        pairNotice.textContent = "Opening that pairing link...";
        pairNotice.className = "notice";
        location.href = url.href;
        return false;
      }
      activePairId = pairId;
      activePairSecret = secret;
      pairLinkInput.value = url.href;
      return true;
    }
    async function usePairingLink(raw) {
      try {
        if (!applyPairingLink(raw)) return;
        await pair();
      } catch (error) {
        pairNotice.textContent = String(error.message || error);
        pairNotice.className = "notice error";
      }
    }
    function stopPairScanner() {
      if (scannerFrame) cancelAnimationFrame(scannerFrame);
      scannerFrame = 0;
      if (scannerStream) {
        scannerStream.getTracks().forEach((track) => track.stop());
        scannerStream = null;
      }
      pairScanner.pause();
      pairScanner.srcObject = null;
      pairScanner.classList.add("hidden");
      stopScanButton.classList.add("hidden");
      scanPairButton.disabled = false;
    }
    async function startPairScanner() {
      pairNotice.textContent = "Opening camera...";
      pairNotice.className = "notice";
      if (!window.isSecureContext) {
        pairNotice.textContent = "Camera scanning needs HTTPS or localhost. Use the HTTPS Tailscale URL, or paste the pairing link here.";
        pairNotice.className = "notice error";
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        pairNotice.textContent = "This browser cannot open the camera from the relay app. Paste the pairing link instead.";
        pairNotice.className = "notice error";
        return;
      }
      if (!("BarcodeDetector" in window)) {
        pairNotice.textContent = "This browser cannot scan QR codes here. Paste the pairing link instead.";
        pairNotice.className = "notice error";
        return;
      }
      const BarcodeDetectorCtor = window.BarcodeDetector;
      let detector;
      try {
        detector = new BarcodeDetectorCtor({ formats: ["qr_code"] });
      } catch {
        detector = new BarcodeDetectorCtor();
      }
      stopPairScanner();
      scanPairButton.disabled = true;
      try {
        scannerStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        pairScanner.srcObject = scannerStream;
        pairScanner.classList.remove("hidden");
        stopScanButton.classList.remove("hidden");
        await pairScanner.play();
        pairNotice.textContent = "Point your camera at the Milim desktop QR.";
        const scan = async () => {
          if (!scannerStream) return;
          try {
            const codes = await detector.detect(pairScanner);
            const value = codes[0]?.rawValue || "";
            if (value) {
              stopPairScanner();
              await usePairingLink(value);
              return;
            }
          } catch {}
          scannerFrame = requestAnimationFrame(scan);
        };
        scannerFrame = requestAnimationFrame(scan);
      } catch {
        stopPairScanner();
        pairNotice.textContent = "Could not open the camera. Paste the pairing link instead.";
        pairNotice.className = "notice error";
      }
    }
    async function pair() {
      pairNotice.textContent = "Pairing...";
      pairNotice.className = "notice";
      if (!activePairId || !activePairSecret) {
        pairNotice.textContent = "Scan the desktop QR or paste a pairing link first.";
        pairNotice.className = "notice error";
        return;
      }
      try {
        const data = await api("/mobile/pair", {
          method: "POST",
          body: JSON.stringify({
            pair_id: activePairId,
            secret: activePairSecret,
            device_name: deviceName.value.trim() || "Phone",
          }),
        });
        store.key = data.device_key;
        store.id = data.device_id;
        store.name = data.device_name;
        pairNotice.textContent = "Paired.";
        if (location.search) history.replaceState(null, "", "/mobile");
        await checkDevice();
      } catch (error) {
        const message = String(error.message || error);
        pairNotice.textContent = message.includes("invalid pairing token") || message.includes("expired")
          ? "This pairing link expired. Start a fresh pairing from Milim desktop Settings, then scan the new QR or paste its link here."
          : message;
        pairNotice.className = "notice error";
      }
    }
    function attachmentId() {
      return crypto.randomUUID ? crypto.randomUUID() : `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    function fileDataUrl(file) {
      return new Promise((resolve) => {
        if (!file.type.startsWith("image/") || file.size > MAX_IMAGE_PREVIEW_BYTES) return resolve(undefined);
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
        reader.onerror = () => resolve(undefined);
        reader.readAsDataURL(file);
      });
    }
    async function fileAttachment(file) {
      const mime = file.type || "application/octet-stream";
      const textLike = mime.startsWith("text/") || ["application/json", "application/xml", "application/javascript"].includes(mime);
      const [content, dataUrl] = await Promise.all([
        textLike ? file.slice(0, MAX_TEXT_ATTACHMENT_BYTES).text() : undefined,
        fileDataUrl(file),
      ]);
      return {
        id: attachmentId(),
        name: file.name || "attachment",
        mime,
        size: file.size,
        content,
        dataUrl,
        truncated: textLike ? file.size > MAX_TEXT_ATTACHMENT_BYTES : file.type.startsWith("image/") ? file.size > MAX_IMAGE_PREVIEW_BYTES : false,
      };
    }
    function renderAttachments() {
      attachmentTray.replaceChildren();
      for (const attachment of state.attachments) {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "attachment-pill";
        pill.title = "Remove attachment";
        const label = document.createElement("span");
        label.textContent = attachment.name;
        pill.append(label, document.createTextNode("x"));
        pill.addEventListener("click", () => {
          state.attachments = state.attachments.filter((item) => item.id !== attachment.id);
          renderAttachments();
        });
        attachmentTray.append(pill);
      }
    }
    async function addFiles(files) {
      const incoming = Array.from(files || []).slice(0, MAX_ATTACHMENTS - state.attachments.length);
      if (!incoming.length) return;
      state.attachments = [...state.attachments, ...(await Promise.all(incoming.map(fileAttachment)))].slice(0, MAX_ATTACHMENTS);
      renderAttachments();
    }
    async function relay(action) {
      const text = relayText.value.trim();
      const attachments = state.attachments;
      if (!text && !attachments.length && action !== "new_thread") return;
      relayNotice.textContent = action === "new_thread" ? "Creating thread..." : "Sending...";
      relayNotice.className = "notice";
      try {
        await relayAction(action, text, attachments);
        relayText.value = "";
        state.attachments = [];
        renderAttachments();
        relayNotice.textContent = action === "new_thread" ? "New thread requested." : "Sent to desktop.";
        window.setTimeout(refreshThread, 800);
      } catch (error) {
        showRelayError(error);
      }
    }
    document.getElementById("pairButton").addEventListener("click", pair);
    scanPairButton.addEventListener("click", startPairScanner);
    stopScanButton.addEventListener("click", stopPairScanner);
    document.getElementById("pairLinkButton").addEventListener("click", () => usePairingLink(pairLinkInput.value));
    pairLinkInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        usePairingLink(pairLinkInput.value);
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopPairScanner();
    });
    document.getElementById("settingsToggle").addEventListener("click", () => settingsPanel.classList.toggle("hidden"));
    document.getElementById("newThreadButton").addEventListener("click", () => {
      closeThreadDrawer();
      relay("new_thread");
    });
    document.getElementById("stopButton").addEventListener("click", () => relayAction("stop").catch(showRelayError));
    document.getElementById("renameButton").addEventListener("click", () => {
      const next = prompt("Rename thread", state.thread?.title || "");
      if (next) {
        closeThreadDrawer();
        relayAction("rename_thread", next).catch(showRelayError);
      }
    });
    document.getElementById("archiveButton").addEventListener("click", () => {
      if (state.thread && confirm("Archive this thread?")) relayAction("archive_thread", state.thread.session_id).catch(showRelayError);
    });
    document.getElementById("deleteThreadButton").addEventListener("click", () => {
      if (state.thread && confirm("Delete this thread?")) relayAction("delete_thread", state.thread.session_id).catch(showRelayError);
    });
    document.getElementById("forgetButton").addEventListener("click", () => {
      if (state.source) state.source.close();
      store.key = "";
      store.id = "";
      store.name = "";
      state.device = null;
      setStatus("Pairing needed", false);
      show("pair");
    });
    modelSelect.addEventListener("change", () => {
      if (modelSelect.value) relayAction("set_model", modelSelect.value).catch(showRelayError);
    });
    fileInput.addEventListener("change", () => addFiles(fileInput.files).finally(() => { fileInput.value = ""; }));
    document.getElementById("attachButton").addEventListener("click", () => fileInput.click());
    relayForm.addEventListener("submit", (event) => {
      event.preventDefault();
      relay("send");
    });
    threadsToggle.addEventListener("click", () => openThreadDrawer());
    threadDrawerClose.addEventListener("click", () => closeThreadDrawer());
    threadDrawerBackdrop.addEventListener("click", () => closeThreadDrawer());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeThreadDrawer();
    });
    threadSearch.addEventListener("input", () => {
      state.query = threadSearch.value;
      renderThreadList(state.thread);
    });
    window.setInterval(() => {
      checkHealth();
      if (!state.streamLive) refreshThread();
    }, 5000);
    (async () => {
      if (await checkDevice()) return;
      if (activePairId && activePairSecret) {
        setStatus("Pairing", false);
        show("pair");
        await pair();
      } else {
        setStatus("Pair this phone", false);
        show("pair");
        pairNotice.textContent = "Start pairing from Milim desktop Settings, then scan the QR here. If camera scanning is unavailable, paste the pairing link instead.";
      }
    })();
  </script>
</body>
</html>"##;

const MOBILE_COMPANION_MANIFEST: &str = r##"{
  "id": "/mobile",
  "name": "Milim Relay",
  "short_name": "Milim",
  "description": "Mobile companion for the active Milim desktop thread.",
  "start_url": "/mobile",
  "scope": "/mobile",
  "display": "standalone",
  "background_color": "#0d0d0f",
  "theme_color": "#0d0d0f",
  "icons": [
    {
      "src": "/mobile/icon.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any maskable"
    },
    {
      "src": "/mobile/icon.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}"##;

const MOBILE_COMPANION_SERVICE_WORKER: &str = r##"self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
"##;

const MOBILE_COMPANION_ICON: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="104" fill="#0d0d0f"/>
  <rect x="40" y="40" width="432" height="432" rx="72" fill="#161618" stroke="#323237" stroke-width="8"/>
  <path fill="#ededf0" d="M120 326V178h44l4 18c12-15 28-23 48-23 24 0 41 10 52 29 13-19 32-29 56-29 42 0 68 28 68 76v77h-48v-73c0-24-11-37-31-37-21 0-34 15-34 40v70h-48v-74c0-23-11-36-31-36-21 0-34 15-34 40v70h-46Z"/>
</svg>"##;

const MOBILE_COMPANION_WORDMARK: &str =
    include_str!("../../../apps/desktop/public/milim-wordmark.svg");
const MOBILE_COMPANION_ICON_PNG: &[u8] =
    include_bytes!("../../../apps/desktop/src-tauri/icons/icon.png");

/// `GET /v1/models` and `/models`
pub(crate) async fn openai_models(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let data = st.service.list_models().await.map_err(ApiError)?;
    Ok(Json(ModelsResponse {
        object: "list".to_string(),
        data,
    })
    .into_response())
}

/// `GET /api/tags` (Ollama)
pub(crate) async fn ollama_tags(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let tags = st
        .service
        .list_models()
        .await
        .map_err(ApiError)?
        .into_iter()
        .map(|m: Model| OllamaModelTag {
            name: m.id.clone(),
            model: m.id,
            modified_at: rfc3339_now(),
            size: 0,
            digest: String::new(),
            details: OllamaModelDetails {
                format: "gguf".to_string(),
                ..Default::default()
            },
        })
        .collect();
    Ok(Json(OllamaTagsResponse { models: tags }).into_response())
}

/// `POST /v1/chat/completions` and `/chat/completions`
pub(crate) async fn openai_chat(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<ChatCompletionRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;

    let model = req.model.clone();
    let want_stream = req.wants_stream();
    let include_usage = req
        .stream_options
        .as_ref()
        .and_then(|o| o.include_usage)
        .unwrap_or(false);

    let creq = openai_to_completion(req);
    let ctx = ChunkCtx {
        id: gen_id("chatcmpl"),
        created: now_unix(),
        model: model.clone(),
    };

    if want_stream {
        let inner = st.service.stream(creq).await.map_err(ApiError)?;
        let stream = openai_sse(inner, ctx, include_usage);
        Ok(Sse::new(stream)
            .keep_alive(KeepAlive::default())
            .into_response())
    } else {
        let out = st.service.complete(creq).await.map_err(ApiError)?;
        let resp = ChatCompletionResponse {
            id: ctx.id,
            object: "chat.completion".to_string(),
            created: ctx.created,
            model,
            choices: vec![Choice {
                index: 0,
                message: out.message,
                finish_reason: Some(out.finish_reason),
            }],
            usage: out.usage,
            system_fingerprint: None,
        };
        Ok(Json(resp).into_response())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum PromptInput {
    Text(String),
    Many(Vec<String>),
}

impl PromptInput {
    fn text(self) -> String {
        match self {
            Self::Text(text) => text,
            Self::Many(items) => items.join("\n"),
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct LegacyCompletionRequest {
    model: String,
    prompt: PromptInput,
    #[serde(default)]
    suffix: Option<String>,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    top_p: Option<f32>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    stream: Option<bool>,
    #[serde(default)]
    stop: Option<StringOrArray>,
    #[serde(default)]
    frequency_penalty: Option<f32>,
    #[serde(default)]
    presence_penalty: Option<f32>,
    #[serde(default)]
    seed: Option<i64>,
    #[serde(default)]
    echo: Option<bool>,
}

impl LegacyCompletionRequest {
    fn wants_stream(&self) -> bool {
        self.stream.unwrap_or(false)
    }
}

/// `POST /v1/completions` and `/completions`
pub(crate) async fn openai_completions(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<LegacyCompletionRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;

    let model = req.model.clone();
    let want_stream = req.wants_stream();
    let prompt = req.prompt.clone().text();
    let echo = req.echo.unwrap_or(false);
    let creq = legacy_completion_to_completion(req);
    let id = gen_id("cmpl");
    let created = now_unix();

    if want_stream {
        let inner = st.service.stream(creq).await.map_err(ApiError)?;
        return Ok(Sse::new(completion_sse(inner, id, created, model))
            .keep_alive(KeepAlive::default())
            .into_response());
    }

    let out = st.service.complete(creq).await.map_err(ApiError)?;
    let text = if echo {
        format!("{prompt}{}", out.message.text_content())
    } else {
        out.message.text_content()
    };
    Ok(Json(json!({
        "id": id,
        "object": "text_completion",
        "created": created,
        "model": model,
        "choices": [{
            "text": text,
            "index": 0,
            "logprobs": null,
            "finish_reason": out.finish_reason,
        }],
        "usage": out.usage,
    }))
    .into_response())
}

fn legacy_completion_to_completion(req: LegacyCompletionRequest) -> CompletionRequest {
    let prompt = req.prompt.text();
    CompletionRequest {
        model: req.model,
        messages: vec![ChatMessage::text("user", prompt.clone())],
        tools: Vec::new(),
        tool_choice: None,
        response_format: None,
        prompt: Some(prompt),
        suffix: req.suffix,
        sampling: SamplingParams {
            temperature: req.temperature,
            top_p: req.top_p,
            max_tokens: req.max_tokens,
            stop: req.stop.map(|s| s.into_vec()).unwrap_or_default(),
            seed: req.seed,
            frequency_penalty: req.frequency_penalty,
            presence_penalty: req.presence_penalty,
        },
        reasoning_effort: None,
    }
}

fn completion_sse(
    mut inner: EventStream,
    id: String,
    created: u64,
    model: String,
) -> impl futures::Stream<Item = Result<Event, Infallible>> {
    async_stream::stream! {
        while let Some(ev) = inner.next().await {
            match ev {
                Ok(StreamEvent::Delta(delta)) => {
                    if let Some(text) = delta.content {
                        yield Ok(Event::default().data(json!({
                            "id": id,
                            "object": "text_completion",
                            "created": created,
                            "model": model,
                            "choices": [{
                                "text": text,
                                "index": 0,
                                "logprobs": null,
                                "finish_reason": null,
                            }],
                        }).to_string()));
                    }
                }
                Ok(StreamEvent::Done { finish_reason, usage }) => {
                    yield Ok(Event::default().data(json!({
                        "id": id,
                        "object": "text_completion",
                        "created": created,
                        "model": model,
                        "choices": [{
                            "text": "",
                            "index": 0,
                            "logprobs": null,
                            "finish_reason": finish_reason,
                        }],
                        "usage": usage,
                    }).to_string()));
                    yield Ok(Event::default().data("[DONE]"));
                    return;
                }
                Err(e) => {
                    yield Ok(Event::default().event("error").data(json!({
                        "error": { "message": e.to_string(), "type": e.code() }
                    }).to_string()));
                    yield Ok(Event::default().data("[DONE]"));
                    return;
                }
            }
        }
        yield Ok(Event::default().data("[DONE]"));
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum ResponsesInput {
    Text(String),
    Items(Vec<Value>),
}

#[derive(Debug, Deserialize)]
pub(crate) struct ResponsesRequest {
    model: String,
    input: ResponsesInput,
    #[serde(default)]
    instructions: Option<String>,
    #[serde(default)]
    stream: Option<bool>,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    top_p: Option<f32>,
    #[serde(default)]
    max_output_tokens: Option<u32>,
    #[serde(default)]
    tools: Vec<Value>,
    #[serde(default)]
    tool_choice: Option<Value>,
    #[serde(default)]
    reasoning: Option<Value>,
    #[serde(default)]
    text: Option<Value>,
    #[serde(default)]
    previous_response_id: Option<String>,
}

impl ResponsesRequest {
    fn wants_stream(&self) -> bool {
        self.stream.unwrap_or(false)
    }
}

/// `POST /v1/responses`
pub(crate) async fn openai_responses(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<ResponsesRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;

    let model = req.model.clone();
    let want_stream = req.wants_stream();
    let response_id = gen_id("resp");
    let created = now_unix();
    let text = response_text_value(req.text.clone());
    let tools = req.tools.clone();
    let tool_choice = req.tool_choice.clone().unwrap_or_else(|| json!("auto"));
    let reasoning = req
        .reasoning
        .clone()
        .unwrap_or_else(|| json!({ "effort": null, "summary": null }));
    let previous_response_id = req.previous_response_id.clone();
    let response_shape = ResponseShape {
        id: response_id,
        created,
        model,
        text,
        tools,
        tool_choice,
        reasoning,
        previous_response_id,
    };
    let creq = responses_to_completion(req).map_err(ApiError)?;

    if want_stream {
        let inner = st.service.stream(creq).await.map_err(ApiError)?;
        return Ok(Sse::new(responses_sse(inner, response_shape))
            .keep_alive(KeepAlive::default())
            .into_response());
    }

    let out = st.service.complete(creq).await.map_err(ApiError)?;
    Ok(Json(response_json(
        &response_shape,
        response_output_items(&out.message),
        Some(out.usage),
    ))
    .into_response())
}

fn responses_to_completion(req: ResponsesRequest) -> Result<CompletionRequest, Error> {
    let text = response_text_value(req.text);
    let mut messages = response_input_messages(req.input)?;
    if let Some(instructions) = req.instructions.filter(|s| !s.is_empty()) {
        messages.insert(0, ChatMessage::text("system", instructions));
    }
    Ok(CompletionRequest {
        model: req.model,
        messages,
        tools: response_tools(req.tools)?,
        tool_choice: req.tool_choice,
        response_format: response_format_from_responses_text(&text),
        prompt: None,
        suffix: None,
        sampling: SamplingParams {
            temperature: req.temperature,
            top_p: req.top_p,
            max_tokens: req.max_output_tokens,
            ..Default::default()
        },
        reasoning_effort: response_reasoning_effort(req.reasoning.as_ref()),
    })
}

fn response_input_messages(input: ResponsesInput) -> Result<Vec<ChatMessage>, Error> {
    match input {
        ResponsesInput::Text(text) => Ok(vec![ChatMessage::text("user", text)]),
        ResponsesInput::Items(items) => items.into_iter().map(response_input_item).collect(),
    }
}

fn response_input_item(item: Value) -> Result<ChatMessage, Error> {
    if let Some(text) = item.as_str() {
        return Ok(ChatMessage::text("user", text));
    }
    let kind = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("message");
    match kind {
        "function_call_output" => Ok(ChatMessage {
            role: "tool".to_string(),
            content: Some(Content::Text(
                item.get("output")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            )),
            name: None,
            tool_calls: None,
            tool_call_id: item
                .get("call_id")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            reasoning_content: None,
        }),
        "function_call" => Ok(ChatMessage {
            role: "assistant".to_string(),
            content: None,
            name: None,
            tool_calls: Some(vec![ToolCall {
                id: item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                kind: "function".to_string(),
                function: FunctionCall {
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    arguments: item
                        .get("arguments")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                },
            }]),
            tool_call_id: None,
            reasoning_content: None,
        }),
        _ => {
            let role = item
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user")
                .to_string();
            let content = item
                .get("content")
                .map(response_content)
                .transpose()?
                .unwrap_or_else(|| Content::Text(String::new()));
            Ok(ChatMessage {
                role,
                content: Some(content),
                name: None,
                tool_calls: None,
                tool_call_id: None,
                reasoning_content: None,
            })
        }
    }
}

fn response_content(value: &Value) -> Result<Content, Error> {
    if let Some(text) = value.as_str() {
        return Ok(Content::Text(text.to_string()));
    }
    let parts = value.as_array().ok_or_else(|| {
        Error::InvalidRequest("Responses message content must be a string or array".to_string())
    })?;
    let mut out = Vec::new();
    for part in parts {
        match part.get("type").and_then(Value::as_str) {
            Some("input_text") | Some("text") | Some("output_text") => {
                out.push(ContentPart::Text {
                    text: part
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                });
            }
            Some("input_image") | Some("image_url") => {
                if let Some(url) = part
                    .get("image_url")
                    .and_then(Value::as_str)
                    .or_else(|| part.pointer("/image_url/url").and_then(Value::as_str))
                {
                    out.push(ContentPart::ImageUrl {
                        image_url: ImageUrl {
                            url: url.to_string(),
                            detail: part
                                .get("detail")
                                .and_then(Value::as_str)
                                .map(ToString::to_string),
                        },
                    });
                }
            }
            _ => {}
        }
    }
    Ok(Content::Parts(out))
}

fn response_tools(tools: Vec<Value>) -> Result<Vec<OpenAiTool>, Error> {
    let mut out = Vec::new();
    for tool in tools {
        if tool.get("type").and_then(Value::as_str) != Some("function") {
            continue;
        }
        if tool.get("function").is_some() {
            out.push(serde_json::from_value(tool).map_err(|e| {
                Error::InvalidRequest(format!("invalid Responses function tool: {e}"))
            })?);
            continue;
        }
        let name = tool.get("name").and_then(Value::as_str).ok_or_else(|| {
            Error::InvalidRequest("Responses function tool is missing name".to_string())
        })?;
        out.push(OpenAiTool {
            kind: "function".to_string(),
            function: ToolFunction {
                name: name.to_string(),
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                parameters: tool.get("parameters").cloned(),
            },
        });
    }
    Ok(out)
}

fn response_reasoning_effort(reasoning: Option<&Value>) -> Option<ReasoningEffort> {
    let effort = reasoning?.get("effort")?.as_str()?;
    serde_json::from_value(Value::String(effort.to_string())).ok()
}

fn response_text_value(text: Option<Value>) -> Value {
    text.unwrap_or_else(|| json!({ "format": { "type": "text" } }))
}

fn response_format_from_responses_text(text: &Value) -> Option<Value> {
    let format = text.get("format")?;
    match format.get("type").and_then(Value::as_str) {
        Some("text") | None => None,
        Some("json_schema") if format.get("json_schema").is_none() => Some(json!({
            "type": "json_schema",
            "json_schema": {
                "name": format
                    .get("name")
                    .cloned()
                    .unwrap_or_else(|| Value::String("response".to_string())),
                "strict": format.get("strict").cloned().unwrap_or(Value::Bool(false)),
                "schema": format.get("schema").cloned().unwrap_or_else(|| json!({})),
            }
        })),
        _ => Some(format.clone()),
    }
}

fn response_output_items(message: &ChatMessage) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(calls) = &message.tool_calls {
        for call in calls {
            out.push(json!({
                "type": "function_call",
                "id": call.id.clone().unwrap_or_else(|| gen_id("fc")),
                "call_id": call.id.clone().unwrap_or_else(|| gen_id("call")),
                "name": call.function.name.clone(),
                "arguments": call.function.arguments.clone(),
                "status": "completed",
            }));
        }
    }
    let text = message.text_content();
    if !text.is_empty() || out.is_empty() {
        out.push(response_message_item(&text));
    }
    out
}

fn response_message_item(text: &str) -> Value {
    json!({
        "type": "message",
        "id": gen_id("msg"),
        "status": "completed",
        "role": "assistant",
        "content": [{
            "type": "output_text",
            "text": text,
            "annotations": [],
        }],
    })
}

#[derive(Debug, Clone)]
struct ResponseShape {
    id: String,
    created: u64,
    model: String,
    text: Value,
    tools: Vec<Value>,
    tool_choice: Value,
    reasoning: Value,
    previous_response_id: Option<String>,
}

fn response_json(shape: &ResponseShape, output: Vec<Value>, usage: Option<Usage>) -> Value {
    let usage = usage.map(|u| {
        json!({
            "input_tokens": u.prompt_tokens,
            "output_tokens": u.completion_tokens,
            "total_tokens": u.total_tokens,
        })
    });
    json!({
        "id": shape.id.clone(),
        "object": "response",
        "created_at": shape.created,
        "status": "completed",
        "completed_at": now_unix(),
        "error": null,
        "incomplete_details": null,
        "instructions": null,
        "max_output_tokens": null,
        "model": shape.model.clone(),
        "output": output,
        "parallel_tool_calls": true,
        "previous_response_id": shape.previous_response_id.clone(),
        "reasoning": shape.reasoning.clone(),
        "store": false,
        "temperature": null,
        "text": shape.text.clone(),
        "tool_choice": shape.tool_choice.clone(),
        "tools": shape.tools.clone(),
        "top_p": null,
        "truncation": "disabled",
        "usage": usage,
        "user": null,
        "metadata": {},
    })
}

fn responses_sse(
    mut inner: EventStream,
    shape: ResponseShape,
) -> impl futures::Stream<Item = Result<Event, Infallible>> {
    async_stream::stream! {
        yield named_response_event("response.created", json!({
            "type": "response.created",
            "response": response_json(
                &shape,
                Vec::new(),
                None,
            )
        }));

        let mut content = String::new();
        let mut reasoning_text = String::new();
        let mut text_started = false;
        let mut tool_calls = ToolCallAccumulator::default();

        while let Some(ev) = inner.next().await {
            match ev {
                Ok(StreamEvent::Delta(delta)) => {
                    for call in delta.tool_calls {
                        tool_calls.push(call);
                    }
                    if let Some(reasoning_delta) = delta.reasoning {
                        reasoning_text.push_str(&reasoning_delta);
                        yield named_response_event("response.reasoning_text.delta", json!({
                            "type": "response.reasoning_text.delta",
                            "delta": reasoning_delta,
                        }));
                    }
                    if let Some(chunk) = delta.content {
                        if !text_started {
                            text_started = true;
                            yield named_response_event("response.output_item.added", json!({
                                "type": "response.output_item.added",
                                "output_index": 0,
                                "item": { "type": "message", "id": gen_id("msg"), "status": "in_progress", "role": "assistant", "content": [] }
                            }));
                            yield named_response_event("response.content_part.added", json!({
                                "type": "response.content_part.added",
                                "output_index": 0,
                                "content_index": 0,
                                "part": { "type": "output_text", "text": "", "annotations": [] }
                            }));
                        }
                        content.push_str(&chunk);
                        yield named_response_event("response.output_text.delta", json!({
                            "type": "response.output_text.delta",
                            "output_index": 0,
                            "content_index": 0,
                            "delta": chunk,
                        }));
                    }
                }
                Ok(StreamEvent::Done { usage, .. }) => {
                    let mut message = ChatMessage::text("assistant", content.clone());
                    let calls = tool_calls.finish();
                    if !calls.is_empty() {
                        message.tool_calls = Some(calls);
                    }
                    if !reasoning_text.is_empty() {
                        message.reasoning_content = Some(reasoning_text);
                    }
                    yield named_response_event("response.output_text.done", json!({
                        "type": "response.output_text.done",
                        "output_index": 0,
                        "content_index": 0,
                        "text": content,
                    }));
                    let output = response_output_items(&message);
                    yield named_response_event("response.completed", json!({
                        "type": "response.completed",
                        "response": response_json(
                            &shape,
                            output,
                            Some(usage),
                        )
                    }));
                    return;
                }
                Err(e) => {
                    yield named_response_event("response.failed", json!({
                        "type": "response.failed",
                        "response": {
                            "id": shape.id.clone(),
                            "object": "response",
                            "created_at": shape.created,
                            "status": "failed",
                            "error": { "message": e.to_string(), "type": e.code() },
                            "model": shape.model.clone(),
                        }
                    }));
                    return;
                }
            }
        }
    }
}

fn named_response_event(name: &str, value: Value) -> Result<Event, Infallible> {
    Ok(Event::default().event(name).data(value.to_string()))
}

/// `POST /api/chat` (Ollama)
pub(crate) async fn ollama_chat(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<OllamaChatRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;

    let model = req.model.clone();
    let want_stream = req.wants_stream();
    let creq = ollama_to_completion(req);

    if want_stream {
        let inner = st.service.stream(creq).await.map_err(ApiError)?;
        let body = Body::from_stream(ollama_ndjson(inner, model));
        Ok(Response::builder()
            .header(CONTENT_TYPE, "application/x-ndjson")
            .body(body)
            .expect("valid ndjson response"))
    } else {
        let out = st.service.complete(creq).await.map_err(ApiError)?;
        let resp = OllamaChatResponse {
            model,
            created_at: rfc3339_now(),
            message: OllamaMessage {
                role: "assistant".to_string(),
                content: out.message.text_content(),
                images: None,
                tool_calls: out.message.tool_calls,
                thinking: out.message.reasoning_content,
            },
            done: true,
            done_reason: Some(out.finish_reason),
            total_duration: Some(0),
            prompt_eval_count: Some(out.usage.prompt_tokens),
            eval_count: Some(out.usage.completion_tokens),
        };
        Ok(Json(resp).into_response())
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct OllamaGenerateRequest {
    model: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    suffix: Option<String>,
    #[serde(default)]
    system: Option<String>,
    #[serde(default)]
    stream: Option<bool>,
    #[serde(default)]
    raw: Option<bool>,
    #[serde(default)]
    format: Option<Value>,
    #[serde(default)]
    keep_alive: Option<Value>,
    #[serde(default)]
    options: Option<Value>,
    #[serde(default)]
    think: Option<Value>,
}

impl OllamaGenerateRequest {
    fn wants_stream(&self) -> bool {
        self.stream.unwrap_or(true)
    }
}

/// `POST /api/generate` (Ollama)
pub(crate) async fn ollama_generate(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<OllamaGenerateRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;

    let model = req.model.clone();
    let want_stream = req.wants_stream();
    if req.prompt.is_empty() && req.keep_alive.is_some() {
        let keep_alive = req.keep_alive.clone();
        st.service
            .ollama_keep_alive(&model, keep_alive.as_ref().cloned())
            .await
            .map_err(ApiError)?;
        let done_reason = ollama_keep_alive_done_reason(keep_alive.as_ref());
        let value = ollama_keep_alive_response(&model, done_reason);
        if want_stream {
            let body = Body::from(ollama_generate_line(value));
            return Ok(Response::builder()
                .header(CONTENT_TYPE, "application/x-ndjson")
                .body(body)
                .expect("valid ndjson response"));
        }
        return Ok(Json(value).into_response());
    }
    let creq = ollama_generate_to_completion(req);

    if want_stream {
        let inner = st.service.stream(creq).await.map_err(ApiError)?;
        let body = Body::from_stream(ollama_generate_ndjson(inner, model));
        return Ok(Response::builder()
            .header(CONTENT_TYPE, "application/x-ndjson")
            .body(body)
            .expect("valid ndjson response"));
    }

    let out = st.service.complete(creq).await.map_err(ApiError)?;
    Ok(Json(json!({
        "model": model,
        "created_at": rfc3339_now(),
        "response": out.message.text_content(),
        "thinking": out.message.reasoning_content,
        "done": true,
        "done_reason": out.finish_reason,
        "total_duration": 0,
        "load_duration": 0,
        "prompt_eval_count": out.usage.prompt_tokens,
        "prompt_eval_duration": 0,
        "eval_count": out.usage.completion_tokens,
        "eval_duration": 0,
    }))
    .into_response())
}

fn ollama_generate_to_completion(req: OllamaGenerateRequest) -> CompletionRequest {
    let opts = req.options.unwrap_or(Value::Null);
    let mut messages = Vec::new();
    if !req.raw.unwrap_or(false) {
        if let Some(system) = req.system.filter(|s| !s.is_empty()) {
            messages.push(ChatMessage::text("system", system));
        }
    }
    messages.push(ChatMessage::text("user", req.prompt.clone()));
    CompletionRequest {
        model: req.model,
        messages,
        tools: Vec::new(),
        tool_choice: None,
        response_format: req.format.map(ollama_format_to_response_format),
        prompt: Some(req.prompt),
        suffix: req.suffix,
        sampling: SamplingParams {
            temperature: opt_f32(&opts, "temperature"),
            top_p: opt_f32(&opts, "top_p"),
            max_tokens: opt_u32(&opts, "num_predict"),
            stop: opt_stops(&opts),
            seed: opt_i64(&opts, "seed"),
            frequency_penalty: opt_f32(&opts, "frequency_penalty"),
            presence_penalty: opt_f32(&opts, "presence_penalty"),
        },
        reasoning_effort: ollama_think_effort(req.think.as_ref()),
    }
}

fn ollama_keep_alive_done_reason(keep_alive: Option<&Value>) -> &'static str {
    match keep_alive {
        Some(Value::Number(n)) if n.as_i64() == Some(0) || n.as_u64() == Some(0) => "unload",
        Some(Value::String(s)) if s.trim() == "0" => "unload",
        _ => "load",
    }
}

fn ollama_keep_alive_response(model: &str, done_reason: &str) -> Value {
    json!({
        "model": model,
        "created_at": rfc3339_now(),
        "response": "",
        "done": true,
        "done_reason": done_reason,
        "total_duration": 0,
        "load_duration": 0,
        "prompt_eval_count": 0,
        "prompt_eval_duration": 0,
        "eval_count": 0,
        "eval_duration": 0,
    })
}

fn ollama_generate_ndjson(
    mut inner: EventStream,
    model: String,
) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> {
    async_stream::stream! {
        while let Some(ev) = inner.next().await {
            match ev {
                Ok(StreamEvent::Delta(delta)) => {
                    if let Some(content) = delta.content {
                        yield Ok(ollama_generate_line(json!({
                            "model": model,
                            "created_at": rfc3339_now(),
                            "response": content,
                            "done": false,
                        })));
                    }
                    if let Some(thinking) = delta.reasoning {
                        yield Ok(ollama_generate_line(json!({
                            "model": model,
                            "created_at": rfc3339_now(),
                            "response": "",
                            "thinking": thinking,
                            "done": false,
                        })));
                    }
                }
                Ok(StreamEvent::Done { finish_reason, usage }) => {
                    yield Ok(ollama_generate_line(json!({
                        "model": model,
                        "created_at": rfc3339_now(),
                        "response": "",
                        "done": true,
                        "done_reason": finish_reason,
                        "total_duration": 0,
                        "load_duration": 0,
                        "prompt_eval_count": usage.prompt_tokens,
                        "prompt_eval_duration": 0,
                        "eval_count": usage.completion_tokens,
                        "eval_duration": 0,
                    })));
                    return;
                }
                Err(e) => {
                    yield Ok(ollama_generate_line(json!({
                        "model": model,
                        "created_at": rfc3339_now(),
                        "response": "",
                        "done": true,
                        "done_reason": format!("error: {e}"),
                    })));
                    return;
                }
            }
        }
    }
}

fn ollama_generate_line(value: Value) -> Bytes {
    let mut line = value.to_string();
    line.push('\n');
    Bytes::from(line)
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

/// `POST /anthropic/v1/messages`
pub(crate) async fn anthropic_messages(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<MessagesRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;

    let model = req.model.clone();
    let want_stream = req.wants_stream();
    let creq = anthropic_to_completion(req);
    let id = gen_id("msg");

    if want_stream {
        let inner = st.service.stream(creq).await.map_err(ApiError)?;
        let stream = anthropic_sse(inner, id, model);
        Ok(Sse::new(stream)
            .keep_alive(KeepAlive::default())
            .into_response())
    } else {
        let out = st.service.complete(creq).await.map_err(ApiError)?;
        let resp = MessagesResponse {
            id,
            kind: "message".to_string(),
            role: "assistant".to_string(),
            content: anthropic_response_blocks(&out.message),
            model,
            stop_reason: Some(anthropic_stop_reason(&out.finish_reason)),
            stop_sequence: None,
            usage: anthropic::Usage {
                input_tokens: out.usage.prompt_tokens,
                output_tokens: out.usage.completion_tokens,
            },
        };
        Ok(Json(resp).into_response())
    }
}

// ----- Codex app-server bridge -----

#[derive(Deserialize)]
pub(crate) struct CodexAccountQuery {
    #[serde(default)]
    refresh: bool,
}

/// `GET /codex/account` - current Codex-managed auth state.
pub(crate) async fn codex_account(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Query(query): Query<CodexAccountQuery>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let account = crate::codex_bridge::account(query.refresh)
        .await
        .map_err(ApiError)?;
    Ok(Json(account).into_response())
}

/// `POST /codex/login/device` - start ChatGPT login and stream completion.
pub(crate) async fn codex_login_device(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    Ok(Sse::new(crate::codex_bridge::login_device_stream())
        .keep_alive(KeepAlive::default())
        .into_response())
}

/// `POST /codex/login/chatgpt-device` - start ChatGPT device-code login.
pub(crate) async fn codex_login_chatgpt_device(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    Ok(
        Sse::new(crate::codex_bridge::login_chatgpt_device_code_stream())
            .keep_alive(KeepAlive::default())
            .into_response(),
    )
}

/// `POST /codex/login/api-key` - sign Codex in with an OpenAI API key.
pub(crate) async fn codex_login_api_key(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<crate::codex_bridge::CodexApiKeyLoginRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let result = crate::codex_bridge::login_api_key(req.api_key)
        .await
        .map_err(ApiError)?;
    Ok(Json(result).into_response())
}

/// `POST /codex/logout` - clear Codex-managed auth.
pub(crate) async fn codex_logout(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let result = crate::codex_bridge::logout().await.map_err(ApiError)?;
    Ok(Json(result).into_response())
}

/// `GET /codex/rate-limits` - read Codex account usage buckets.
pub(crate) async fn codex_rate_limits(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let result = crate::codex_bridge::rate_limits().await.map_err(ApiError)?;
    Ok(Json(result).into_response())
}

/// `GET /codex/models` - list models exposed by the installed Codex app-server.
pub(crate) async fn codex_models(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let result = crate::codex_bridge::models().await.map_err(ApiError)?;
    Ok(Json(result).into_response())
}

/// `POST /codex/run` - run a Codex turn as a separate account runtime.
pub(crate) async fn codex_run(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(mut req): Json<crate::codex_bridge::CodexRunRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    if req.prompt.trim().is_empty() {
        return Err(ApiError(Error::InvalidRequest(
            "Codex prompt is required".to_string(),
        )));
    }
    let (prompt, redactions) =
        account_runtime_prompt_for_remote(&st, &req.prompt, "Codex").map_err(ApiError)?;
    req.prompt = prompt;
    Ok(Sse::new(crate::codex_bridge::run_stream(req, redactions))
        .keep_alive(KeepAlive::default())
        .into_response())
}

/// `GET /claude/status` - current installed Claude CLI auth/runtime state.
pub(crate) async fn claude_status(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let status = crate::claude_bridge::status().await.map_err(ApiError)?;
    Ok(Json(status).into_response())
}

/// `POST /claude/run` - run an installed Claude CLI turn as a separate account runtime.
pub(crate) async fn claude_run(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(mut req): Json<crate::claude_bridge::ClaudeRunRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    if req.prompt.trim().is_empty() {
        return Err(ApiError(Error::InvalidRequest(
            "Claude prompt is required".to_string(),
        )));
    }
    let (prompt, redactions) =
        account_runtime_prompt_for_remote(&st, &req.prompt, "Claude").map_err(ApiError)?;
    req.prompt = prompt;
    Ok(Sse::new(crate::claude_bridge::run_stream(req, redactions))
        .keep_alive(KeepAlive::default())
        .into_response())
}

fn account_runtime_prompt_for_remote(
    st: &AppState,
    prompt: &str,
    runtime: &str,
) -> milim_core::Result<(String, BTreeMap<String, String>)> {
    match st.privacy.mode() {
        PrivacyMode::Off => Ok((prompt.to_string(), BTreeMap::new())),
        PrivacyMode::Block => {
            let detections = st.privacy.scan_text(prompt);
            if detections.is_empty() {
                Ok((prompt.to_string(), BTreeMap::new()))
            } else {
                Err(Error::InvalidRequest(format!(
                    "blocked by the privacy gate: {runtime} prompt contains {} ({} item(s)). Switch the gate to Redact or Off to send this to {runtime}.",
                    kinds_summary(&detections),
                    detections.len()
                )))
            }
        }
        PrivacyMode::Redact => {
            let redaction = st.privacy.redact_text(prompt);
            Ok((redaction.text, redaction.map))
        }
    }
}

// ----- MCP (tools) -----

fn mcp_registry(st: &AppState) -> ToolRegistry {
    let mut reg = st.tools.as_deref().cloned().unwrap_or_default();
    if let Some(hub) = &st.mcp {
        for tool in hub.tools() {
            reg.register(tool);
        }
    }
    reg.without(HASHLINE_TOOL_NAMES)
}

/// `GET /mcp/tools` — list available tools.
pub(crate) async fn mcp_tools(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let tools = mcp_registry(&st).list();
    Ok(Json(json!({ "tools": tools })).into_response())
}

#[derive(Deserialize)]
pub(crate) struct McpCallRequest {
    name: String,
    #[serde(default)]
    arguments: Value,
}

/// `POST /mcp/call` — invoke a tool by name.
pub(crate) async fn mcp_call(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<McpCallRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let registry = mcp_registry(&st);
    if registry.is_empty() {
        return Err(ApiError(Error::InvalidRequest(
            "no tools registered".to_string(),
        )));
    }
    let result = registry
        .call(&req.name, req.arguments)
        .await
        .map_err(ApiError)?;
    Ok(Json(json!({ "result": result })).into_response())
}

#[derive(Debug, Deserialize)]
pub(crate) struct PiperPresetDownloadRequest {
    id: String,
    model_url: String,
    config_url: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct VadPresetDownloadRequest {
    id: String,
    model_url: String,
}

/// POST /audio/vad/presets/download - install a Silero VAD ONNX preset.
pub(crate) async fn audio_vad_preset_download(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<VadPresetDownloadRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let id = safe_asset_id(&req.id, "VAD preset id")?;
    let model_url = validate_download_url(&req.model_url, "VAD model URL")?;
    let install_dir = st.models_dir.join("voices").join("vad").join(&id);
    tokio::fs::create_dir_all(&install_dir).await.map_err(|e| {
        ApiError(Error::Other(format!(
            "failed to create VAD preset dir: {e}"
        )))
    })?;

    let model_name = url_file_name(&model_url, "silero_vad.onnx")?;
    let model_path = install_dir.join(model_name);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, u64, Option<u64>)>();
    let handle = tokio::spawn(async move {
        let client = reqwest::Client::new();
        download_file_with_progress(&client, &model_url, &model_path, "VAD model", "model", &tx)
            .await?;
        Ok::<_, ApiError>((id, model_path))
    });

    let stream = async_stream::stream! {
        while let Some((phase, downloaded, total)) = rx.recv().await {
            let data = json!({
                "phase": phase,
                "downloaded": downloaded,
                "total": total,
            })
            .to_string();
            yield Ok::<_, std::convert::Infallible>(Event::default().data(data));
        }

        let done = match handle.await {
            Ok(Ok((id, model_path))) => json!({
                "done": true,
                "id": id,
                "model_path": model_path.to_string_lossy(),
                "message": "VAD preset installed"
            }),
            Ok(Err(e)) => json!({ "error": e.0.to_string() }),
            Err(e) => json!({ "error": format!("VAD install task failed: {e}") }),
        };
        yield Ok(Event::default().data(done.to_string()));
    };

    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

/// POST /audio/piper/presets/download - install a Piper preset model/config.
pub(crate) async fn audio_piper_preset_download(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<PiperPresetDownloadRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let id = safe_preset_id(&req.id)?;
    let model_url = validate_download_url(&req.model_url, "Piper model URL")?;
    let config_url = validate_download_url(&req.config_url, "Piper config URL")?;
    let install_dir = st.models_dir.join("voices").join("piper").join(&id);
    tokio::fs::create_dir_all(&install_dir).await.map_err(|e| {
        ApiError(Error::Other(format!(
            "failed to create Piper preset dir: {e}"
        )))
    })?;

    let model_name = url_file_name(&model_url, "voice.onnx")?;
    let config_name = url_file_name(&config_url, "voice.onnx.json")?;
    let model_path = install_dir.join(model_name);
    let config_path = install_dir.join(config_name);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, u64, Option<u64>)>();
    let handle = tokio::spawn(async move {
        let client = reqwest::Client::new();
        download_file_with_progress(
            &client,
            &model_url,
            &model_path,
            "Piper model",
            "model",
            &tx,
        )
        .await?;
        download_file_with_progress(
            &client,
            &config_url,
            &config_path,
            "Piper config",
            "config",
            &tx,
        )
        .await?;
        Ok::<_, ApiError>((id, model_path, config_path))
    });

    let stream = async_stream::stream! {
        while let Some((phase, downloaded, total)) = rx.recv().await {
            let data = json!({
                "phase": phase,
                "downloaded": downloaded,
                "total": total,
            })
            .to_string();
            yield Ok::<_, std::convert::Infallible>(Event::default().data(data));
        }

        let done = match handle.await {
            Ok(Ok((id, model_path, config_path))) => json!({
                "done": true,
                "id": id,
                "model_path": model_path.to_string_lossy(),
                "config_path": config_path.to_string_lossy(),
                "message": "Piper preset installed"
            }),
            Ok(Err(e)) => json!({ "error": e.0.to_string() }),
            Err(e) => json!({ "error": format!("Piper install task failed: {e}") }),
        };
        yield Ok(Event::default().data(done.to_string()));
    };

    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

#[derive(Debug, Deserialize)]
pub(crate) struct KokoroPresetDownloadRequest {
    id: String,
    model_url: String,
    config_url: String,
    voice_url: String,
    voice: String,
}

/// POST /audio/kokoro/presets/download - install a Kokoro model/config/voice package.
pub(crate) async fn audio_kokoro_preset_download(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<KokoroPresetDownloadRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let id = safe_asset_id(&req.id, "Kokoro preset id")?;
    let voice = safe_kokoro_voice_id(&req.voice)?;
    let model_url = validate_download_url(&req.model_url, "Kokoro model URL")?;
    let config_url = validate_download_url(&req.config_url, "Kokoro config URL")?;
    let voice_url = validate_download_url(&req.voice_url, "Kokoro voice URL")?;
    let install_dir = st.models_dir.join("voices").join("kokoro").join(&id);
    let onnx_dir = install_dir.join("onnx");
    let voices_dir = install_dir.join("voices");
    tokio::fs::create_dir_all(&onnx_dir).await.map_err(|e| {
        ApiError(Error::Other(format!(
            "failed to create Kokoro model dir: {e}"
        )))
    })?;
    tokio::fs::create_dir_all(&voices_dir).await.map_err(|e| {
        ApiError(Error::Other(format!(
            "failed to create Kokoro voices dir: {e}"
        )))
    })?;

    let model_name = url_file_name(&model_url, "model.onnx")?;
    let model_path = onnx_dir.join(model_name);
    let config_path = install_dir.join("config.json");
    let voice_path = voices_dir.join(format!("{voice}.bin"));

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, u64, Option<u64>)>();
    let handle = tokio::spawn(async move {
        let client = reqwest::Client::new();
        download_file_with_progress(
            &client,
            &model_url,
            &model_path,
            "Kokoro model",
            "model",
            &tx,
        )
        .await?;
        download_file_with_progress(
            &client,
            &config_url,
            &config_path,
            "Kokoro config",
            "config",
            &tx,
        )
        .await?;
        download_file_with_progress(
            &client,
            &voice_url,
            &voice_path,
            "Kokoro voice",
            "voice",
            &tx,
        )
        .await?;
        Ok::<_, ApiError>((id, voice, model_path, config_path, voice_path))
    });

    let stream = async_stream::stream! {
        while let Some((phase, downloaded, total)) = rx.recv().await {
            let data = json!({
                "phase": phase,
                "downloaded": downloaded,
                "total": total,
            })
            .to_string();
            yield Ok::<_, std::convert::Infallible>(Event::default().data(data));
        }

        let done = match handle.await {
            Ok(Ok((id, voice, model_path, config_path, voice_path))) => json!({
                "done": true,
                "id": id,
                "voice": voice,
                "model_path": model_path.to_string_lossy(),
                "config_path": config_path.to_string_lossy(),
                "voice_path": voice_path.to_string_lossy(),
                "message": "Kokoro preset installed"
            }),
            Ok(Err(e)) => json!({ "error": e.0.to_string() }),
            Err(e) => json!({ "error": format!("Kokoro install task failed: {e}") }),
        };
        yield Ok(Event::default().data(done.to_string()));
    };

    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

#[derive(Debug, Deserialize)]
pub(crate) struct PiperExecutableInstallRequest {
    #[serde(default)]
    archive_url: Option<String>,
    #[serde(default)]
    executable_name: Option<String>,
}

/// POST /audio/piper/executable/install - install the platform Piper CLI archive.
pub(crate) async fn audio_piper_executable_install(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<PiperExecutableInstallRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let (archive_url, default_executable_name) = match req.archive_url {
        Some(url) => (
            validate_download_url(&url, "Piper executable archive URL")?,
            default_piper_executable_name().to_string(),
        ),
        None => default_piper_archive()?,
    };
    let executable_name = req
        .executable_name
        .map(|name| safe_executable_name(&name))
        .transpose()?
        .unwrap_or(default_executable_name);

    let archive_name = url_file_name(&archive_url, "piper.zip")?;
    let install_name = safe_archive_install_name(&archive_name)?;
    let install_dir = st.models_dir.join("tools").join("piper").join(install_name);
    tokio::fs::create_dir_all(&install_dir).await.map_err(|e| {
        ApiError(Error::Other(format!(
            "failed to create Piper executable dir: {e}"
        )))
    })?;
    let archive_path = install_dir.join(&archive_name);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, u64, Option<u64>)>();
    let handle = tokio::spawn(async move {
        let client = reqwest::Client::new();
        download_file_with_progress(
            &client,
            &archive_url,
            &archive_path,
            "Piper executable archive",
            "archive",
            &tx,
        )
        .await?;
        send_download_progress(&tx, "extract", 0, Some(1));
        let executable_path = tokio::task::spawn_blocking(move || {
            extract_piper_archive(&archive_path, &install_dir, &executable_name)
        })
        .await
        .map_err(|e| ApiError(Error::Other(format!("Piper extraction task failed: {e}"))))?
        .map_err(ApiError)?;
        send_download_progress(&tx, "extract", 1, Some(1));
        Ok::<_, ApiError>(executable_path)
    });

    let stream = async_stream::stream! {
        while let Some((phase, downloaded, total)) = rx.recv().await {
            let data = json!({
                "phase": phase,
                "downloaded": downloaded,
                "total": total,
            })
            .to_string();
            yield Ok::<_, std::convert::Infallible>(Event::default().data(data));
        }

        let done = match handle.await {
            Ok(Ok(executable_path)) => json!({
                "done": true,
                "executable_path": executable_path.to_string_lossy(),
                "message": "Piper executable installed"
            }),
            Ok(Err(e)) => json!({ "error": e.0.to_string() }),
            Err(e) => json!({ "error": format!("Piper executable install task failed: {e}") }),
        };
        yield Ok(Event::default().data(done.to_string()));
    };

    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

fn safe_preset_id(id: &str) -> Result<String, ApiError> {
    safe_asset_id(id, "Piper preset id")
}

fn safe_kokoro_voice_id(id: &str) -> Result<String, ApiError> {
    let id = id.trim().strip_suffix(".bin").unwrap_or(id.trim());
    safe_asset_id(id, "Kokoro voice id")
}

fn safe_asset_id(id: &str, label: &str) -> Result<String, ApiError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(ApiError(Error::InvalidRequest(format!(
            "{label} is required"
        ))));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(ApiError(Error::InvalidRequest(format!(
            "invalid {label}: {id}"
        ))));
    }
    Ok(id.to_string())
}

fn default_piper_archive() -> Result<(String, String), ApiError> {
    let asset = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "piper_windows_amd64.zip",
        ("linux", "x86_64") => "piper_linux_x86_64.tar.gz",
        ("linux", "aarch64") => "piper_linux_aarch64.tar.gz",
        ("linux", "arm") => "piper_linux_armv7l.tar.gz",
        ("macos", "x86_64") => "piper_macos_x64.tar.gz",
        ("macos", "aarch64") => "piper_macos_aarch64.tar.gz",
        (os, arch) => {
            return Err(ApiError(Error::InvalidRequest(format!(
                "no default Piper executable archive for {os}/{arch}"
            ))))
        }
    };
    Ok((
        format!("https://github.com/rhasspy/piper/releases/download/2023.11.14-2/{asset}"),
        default_piper_executable_name().to_string(),
    ))
}

fn default_piper_executable_name() -> &'static str {
    if cfg!(windows) {
        "piper.exe"
    } else {
        "piper"
    }
}

fn safe_executable_name(name: &str) -> Result<String, ApiError> {
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Err(ApiError(Error::InvalidRequest(
            "Piper executable name must be a single file name".to_string(),
        )));
    }
    Ok(name.to_string())
}

fn safe_archive_install_name(file_name: &str) -> Result<String, ApiError> {
    let name = file_name
        .strip_suffix(".tar.gz")
        .or_else(|| file_name.strip_suffix(".tgz"))
        .or_else(|| file_name.strip_suffix(".zip"))
        .unwrap_or_else(|| {
            FsPath::new(file_name)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or(file_name)
        });
    safe_preset_id(name).map_err(|_| {
        ApiError(Error::InvalidRequest(format!(
            "invalid Piper executable archive name: {file_name}"
        )))
    })
}

fn validate_download_url(url: &str, label: &str) -> Result<String, ApiError> {
    let url = url.trim();
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| ApiError(Error::InvalidRequest(format!("{label} is invalid: {e}"))))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ApiError(Error::InvalidRequest(format!(
            "{label} must start with http:// or https://"
        ))));
    }
    Ok(parsed.to_string())
}

fn url_file_name(url: &str, fallback: &str) -> Result<String, ApiError> {
    let parsed = reqwest::Url::parse(url).map_err(|e| {
        ApiError(Error::InvalidRequest(format!(
            "download URL is invalid: {e}"
        )))
    })?;
    let name = parsed
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|segment| !segment.is_empty())
        .unwrap_or(fallback);
    let Some(file_name) = FsPath::new(name).file_name() else {
        return Err(ApiError(Error::InvalidRequest(format!(
            "invalid download file name: {name}"
        ))));
    };
    Ok(file_name.to_string_lossy().to_string())
}

fn extract_piper_archive(
    archive_path: &FsPath,
    install_dir: &FsPath,
    executable_name: &str,
) -> Result<PathBuf, Error> {
    let archive_name = archive_path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    if archive_name.ends_with(".zip") {
        extract_zip_archive(archive_path, install_dir)?;
    } else if archive_name.ends_with(".tar.gz") || archive_name.ends_with(".tgz") {
        extract_tar_gz_archive(archive_path, install_dir)?;
    } else {
        return Err(Error::InvalidRequest(format!(
            "unsupported Piper executable archive format: {archive_name}"
        )));
    }

    let executable_path = find_file_named(install_dir, executable_name)?.ok_or_else(|| {
        Error::InvalidRequest(format!(
            "Piper executable {executable_name} was not found in the archive"
        ))
    })?;
    mark_executable(&executable_path)?;
    Ok(executable_path)
}

fn extract_zip_archive(archive_path: &FsPath, install_dir: &FsPath) -> Result<(), Error> {
    let file = std::fs::File::open(archive_path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| Error::InvalidRequest(e.to_string()))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| Error::InvalidRequest(e.to_string()))?;
        let Some(path) = entry.enclosed_name().map(|path| path.to_path_buf()) else {
            return Err(Error::InvalidRequest(format!(
                "unsafe archive path: {}",
                entry.name()
            )));
        };
        let dest = safe_archive_path(install_dir, &path)?;
        if entry.is_dir() {
            std::fs::create_dir_all(&dest)?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out = std::fs::File::create(&dest)?;
            std::io::copy(&mut entry, &mut out)?;
        }
    }
    Ok(())
}

fn extract_tar_gz_archive(archive_path: &FsPath, install_dir: &FsPath) -> Result<(), Error> {
    let file = std::fs::File::open(archive_path)?;
    let gz = GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.to_path_buf();
        let dest = safe_archive_path(install_dir, &path)?;
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&dest)?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            entry.unpack(&dest)?;
        }
    }
    Ok(())
}

fn safe_archive_path(base: &FsPath, path: &FsPath) -> Result<PathBuf, Error> {
    let mut out = base.to_path_buf();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => out.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(Error::InvalidRequest(format!(
                    "unsafe archive path: {}",
                    path.display()
                )))
            }
        }
    }
    Ok(out)
}

fn find_file_named(dir: &FsPath, file_name: &str) -> Result<Option<PathBuf>, Error> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_named(&path, file_name)? {
                return Ok(Some(found));
            }
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == file_name)
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

#[cfg(unix)]
fn mark_executable(path: &FsPath) -> Result<(), Error> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(permissions.mode() | 0o755);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn mark_executable(_path: &FsPath) -> Result<(), Error> {
    Ok(())
}

async fn download_file_with_progress(
    client: &reqwest::Client,
    url: &str,
    dest: &std::path::Path,
    label: &str,
    phase: &str,
    tx: &tokio::sync::mpsc::UnboundedSender<(String, u64, Option<u64>)>,
) -> Result<(), ApiError> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| ApiError(Error::Upstream(format!("{label} download failed: {e}"))))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(ApiError(Error::Upstream(format!(
            "{label} download returned HTTP {status}"
        ))));
    }
    let total = resp.content_length();
    let tmp = dest.with_extension("part");
    let mut out = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| ApiError(Error::Other(format!("failed to write {label}: {e}"))))?;
    let mut stream = resp.bytes_stream();
    let mut written = 0_u64;
    let mut last_reported = 0_u64;
    send_download_progress(tx, phase, 0, total);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|e| ApiError(Error::Upstream(format!("{label} download failed: {e}"))))?;
        out.write_all(&chunk)
            .await
            .map_err(|e| ApiError(Error::Other(format!("failed to write {label}: {e}"))))?;
        written += chunk.len() as u64;
        let is_last = total.map(|total| written >= total).unwrap_or(false);
        if is_last || written.saturating_sub(last_reported) >= 1_000_000 {
            send_download_progress(tx, phase, written, total);
            last_reported = written;
        }
    }

    if written == 0 {
        return Err(ApiError(Error::Upstream(format!(
            "{label} download returned no bytes"
        ))));
    }
    if last_reported != written {
        send_download_progress(tx, phase, written, total);
    }
    out.flush()
        .await
        .map_err(|e| ApiError(Error::Other(format!("failed to write {label}: {e}"))))?;
    drop(out);
    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(|e| ApiError(Error::Other(format!("failed to install {label}: {e}"))))
}

fn send_download_progress(
    tx: &tokio::sync::mpsc::UnboundedSender<(String, u64, Option<u64>)>,
    phase: &str,
    downloaded: u64,
    total: Option<u64>,
) {
    let _ = tx.send((phase.to_string(), downloaded, total));
}

// ----- Voice (speech-to-text) -----

#[derive(Debug, Deserialize)]
pub(crate) struct AudioSetupCheckRequest {
    kind: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    model_path: Option<String>,
    #[serde(default)]
    config_path: Option<String>,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

/// POST /audio/setup/check - validate local voice executable/model settings.
pub(crate) async fn audio_setup_check(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(request): Json<AudioSetupCheckRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let kind = request.kind.trim();
    match kind {
        "parakeet" => {
            let command = request.command.as_deref().unwrap_or_default();
            let resolved = validate_voice_command(command).map_err(ApiError)?;
            Ok(Json(json!({
                "ok": true,
                "message": format!("Parakeet command found: {resolved}")
            }))
            .into_response())
        }
        "tts-command" => {
            let command = request.command.as_deref().unwrap_or_default();
            let resolved = validate_voice_command(command).map_err(ApiError)?;
            Ok(Json(json!({
                "ok": true,
                "message": format!("TTS command found: {resolved}")
            }))
            .into_response())
        }
        "openai-tts" => {
            let endpoint = request.endpoint.as_deref().unwrap_or_default();
            let model = request.model.as_deref().unwrap_or_default().trim();
            let resolved = validate_download_url(endpoint, "OpenAI-compatible TTS endpoint")?;
            if model.is_empty() {
                return Err(ApiError(Error::InvalidRequest(
                    "OpenAI-compatible TTS model is required".to_string(),
                )));
            }
            Ok(Json(json!({
                "ok": true,
                "message": format!("OpenAI-compatible TTS endpoint configured: {resolved}; model: {model}")
            }))
            .into_response())
        }
        "native-tts" => {
            let model_path = request.model_path.as_deref().unwrap_or_default();
            let resolved_model =
                validate_voice_model_file(model_path, "Native TTS model path").map_err(ApiError)?;
            let message = if let Some(config_path) = request
                .config_path
                .as_deref()
                .filter(|v| !v.trim().is_empty())
            {
                let resolved_config =
                    validate_voice_model_file(config_path, "Native TTS config path")
                        .map_err(ApiError)?;
                format!("Native TTS model found: {resolved_model}; config found: {resolved_config}")
            } else {
                format!("Native TTS model found: {resolved_model}")
            };
            Ok(Json(json!({
                "ok": true,
                "message": message
            }))
            .into_response())
        }
        "native-vad" => {
            let model_path = request.model_path.as_deref().unwrap_or_default();
            let resolved =
                validate_voice_model_file(model_path, "Native VAD model path").map_err(ApiError)?;
            Ok(Json(json!({
                "ok": true,
                "message": format!("Native VAD model found: {resolved}")
            }))
            .into_response())
        }
        "whisper" => {
            let model_path = request.model_path.as_deref().unwrap_or_default();
            let resolved =
                validate_voice_model_file(model_path, "Whisper model path").map_err(ApiError)?;
            Ok(Json(json!({
                "ok": true,
                "message": format!("Whisper model found: {resolved}")
            }))
            .into_response())
        }
        "piper" => {
            let command = request.command.as_deref().unwrap_or_default();
            let model_path = request.model_path.as_deref().unwrap_or_default();
            let resolved_command = validate_voice_command(command).map_err(ApiError)?;
            let resolved_model =
                validate_voice_model_file(model_path, "Piper model path").map_err(ApiError)?;
            Ok(Json(json!({
                "ok": true,
                "message": format!("Piper command found: {resolved_command}; model found: {resolved_model}")
            }))
            .into_response())
        }
        _ => Err(ApiError(Error::InvalidRequest(format!(
            "unknown voice setup check: {kind}"
        )))),
    }
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct AudioTranscriptionQuery {
    provider: Option<String>,
    model_path: Option<String>,
    endpoint: Option<String>,
    model: Option<String>,
    command: Option<String>,
}

/// POST /audio/transcriptions - OpenAI-style STT (accepts a WAV body).
/// Concrete transcription is delegated to an optional backend.
pub(crate) async fn audio_transcriptions(
    State(st): State<AppState>,
    Query(query): Query<AudioTranscriptionQuery>,
    headers: HeaderMap,
    peer: Peer,
    body: axum::body::Bytes,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let Some(transcriber) = transcriber_for_audio_request(&st, &query, &headers)? else {
        return Ok((
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({
                "error": "voice transcription is not enabled in this build - configure a transcriber backend"
            })),
        )
            .into_response());
    };
    let out = transcriber
        .transcribe(TranscriptionInput {
            audio: body.to_vec(),
            mime_type: headers
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string),
        })
        .await
        .map_err(ApiError)?;
    Ok(Json(json!({ "text": out.text })).into_response())
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct AudioVadQuery {
    provider: Option<String>,
    model_path: Option<String>,
    threshold: Option<f32>,
}

/// POST /audio/vad - classify whether a WAV payload contains speech.
pub(crate) async fn audio_vad(
    State(st): State<AppState>,
    Query(query): Query<AudioVadQuery>,
    headers: HeaderMap,
    peer: Peer,
    body: axum::body::Bytes,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let Some(detector) = vad_for_audio_request(&st, &query)? else {
        return Ok((
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({
                "error": "voice activity detection is not enabled - configure a VAD backend"
            })),
        )
            .into_response());
    };
    let out = detector
        .detect(VoiceActivityInput {
            audio: body.to_vec(),
            mime_type: headers
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string),
        })
        .await
        .map_err(ApiError)?;
    Ok(Json(json!({
        "is_speech": out.is_speech,
        "speech_probability": out.speech_probability
    }))
    .into_response())
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct AudioSpeechQuery {
    provider: Option<String>,
    command: Option<String>,
    endpoint: Option<String>,
    model: Option<String>,
    engine: Option<String>,
    model_path: Option<String>,
    config_path: Option<String>,
    voice: Option<String>,
    speed: Option<f32>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct AudioSpeechRequest {
    input: String,
    #[serde(default)]
    voice: Option<String>,
    #[serde(default)]
    speed: Option<f32>,
}

/// POST /audio/speech - OpenAI-style TTS surface backed by a local command.
pub(crate) async fn audio_speech(
    State(st): State<AppState>,
    Query(query): Query<AudioSpeechQuery>,
    headers: HeaderMap,
    peer: Peer,
    Json(request): Json<AudioSpeechRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let provider = query
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("");
    if provider == "native" {
        let engine = query
            .engine
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("piper");
        if engine == "kokoro" {
            #[cfg(not(feature = "native-tts"))]
            return Ok((
                StatusCode::NOT_IMPLEMENTED,
                Json(json!({
                    "error": "Kokoro native TTS is not enabled yet"
                })),
            )
                .into_response());
        }
        if engine != "piper" && engine != "kokoro" {
            return Err(ApiError(Error::InvalidRequest(format!(
                "unknown native TTS engine: {engine}"
            ))));
        }
        let Some(model_path) = query.model_path.as_deref().filter(|v| !v.is_empty()) else {
            return Err(ApiError(Error::InvalidRequest(
                "Native TTS model path is required".to_string(),
            )));
        };
        let _config_path = query.config_path.as_deref().filter(|v| !v.is_empty());

        #[cfg(feature = "native-tts")]
        {
            let voice = request
                .voice
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .or_else(|| {
                    query
                        .voice
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                })
                .unwrap_or("0")
                .to_string();
            let speed = request.speed.or(query.speed).unwrap_or(1.0);
            let input = SpeechInput {
                text: request.input,
                voice: Some(voice.clone()),
                speed: Some(speed),
            };
            let out = if engine == "kokoro" {
                NativeKokoroSpeechSynthesizer::new(model_path, _config_path, &voice, speed)
                    .map_err(ApiError)?
                    .synthesize(input)
                    .await
                    .map_err(ApiError)?
            } else {
                NativePiperSpeechSynthesizer::new(model_path, _config_path, &voice, speed)
                    .map_err(ApiError)?
                    .synthesize(input)
                    .await
                    .map_err(ApiError)?
            };
            return Response::builder()
                .header(CONTENT_TYPE, out.mime_type)
                .body(Body::from(out.audio))
                .map_err(|e| ApiError(Error::Other(format!("failed to build TTS response: {e}"))));
        }

        #[cfg(not(feature = "native-tts"))]
        return Ok((
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({
                "error": format!("native TTS is not enabled in this build (engine: {engine}, model: {model_path})")
            })),
        )
            .into_response());
    }
    if provider != "command" && provider != "piper" && provider != "openai" {
        return Ok((
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({
                "error": "text-to-speech is not enabled - configure a supported TTS backend"
            })),
        )
            .into_response());
    }
    let voice = request
        .voice
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .or_else(|| {
            query
                .voice
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
        })
        .unwrap_or("alloy")
        .to_string();
    let speed = request.speed.or(query.speed).unwrap_or(1.0);
    let input = SpeechInput {
        text: request.input,
        voice: Some(voice.clone()),
        speed: Some(speed),
    };
    let out = if provider == "piper" {
        let Some(command) = query.command.as_deref().filter(|v| !v.is_empty()) else {
            return Err(ApiError(Error::InvalidRequest(
                "Piper command is required".to_string(),
            )));
        };
        let Some(model_path) = query.model_path.as_deref().filter(|v| !v.is_empty()) else {
            return Err(ApiError(Error::InvalidRequest(
                "Piper model path is required".to_string(),
            )));
        };
        PiperSpeechSynthesizer::new(command, model_path, &voice, speed)
            .synthesize(input)
            .await
            .map_err(ApiError)?
    } else if provider == "openai" {
        let Some(endpoint) = query.endpoint.as_deref().filter(|v| !v.is_empty()) else {
            return Err(ApiError(Error::InvalidRequest(
                "OpenAI-compatible TTS endpoint is required".to_string(),
            )));
        };
        let Some(model) = query.model.as_deref().filter(|v| !v.is_empty()) else {
            return Err(ApiError(Error::InvalidRequest(
                "OpenAI-compatible TTS model is required".to_string(),
            )));
        };
        let api_key = headers
            .get("X-Milim-TTS-Api-Key")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        OpenAiAudioSpeechSynthesizer::new(endpoint, model, api_key, &voice, speed)
            .map_err(ApiError)?
            .synthesize(input)
            .await
            .map_err(ApiError)?
    } else {
        let Some(command) = query.command.as_deref().filter(|v| !v.is_empty()) else {
            return Err(ApiError(Error::InvalidRequest(
                "TTS command is required".to_string(),
            )));
        };
        CommandSpeechSynthesizer::new(command, &voice, speed)
            .synthesize(input)
            .await
            .map_err(ApiError)?
    };
    Response::builder()
        .header(CONTENT_TYPE, out.mime_type)
        .body(Body::from(out.audio))
        .map_err(|e| ApiError(Error::Other(format!("failed to build TTS response: {e}"))))
}

fn transcriber_for_audio_request(
    st: &AppState,
    query: &AudioTranscriptionQuery,
    headers: &HeaderMap,
) -> Result<Option<Arc<dyn Transcriber>>, ApiError> {
    let Some(provider) = query.provider.as_deref().filter(|v| !v.is_empty()) else {
        if let Some(transcriber) = st.transcriber.as_ref() {
            return Ok(Some(Arc::clone(transcriber)));
        }
        return Ok(None);
    };
    if provider == "remote" {
        let Some(endpoint) = query.endpoint.as_deref().filter(|v| !v.is_empty()) else {
            return Err(ApiError(Error::InvalidRequest(
                "remote voice input requires an endpoint".to_string(),
            )));
        };
        return Ok(Some(Arc::new(
            RemoteRawTranscriber::new(endpoint).map_err(ApiError)?,
        )));
    }

    if provider == "openai" {
        let Some(endpoint) = query.endpoint.as_deref().filter(|v| !v.is_empty()) else {
            return Err(ApiError(Error::InvalidRequest(
                "OpenAI-compatible voice input requires an endpoint".to_string(),
            )));
        };
        let Some(model) = query.model.as_deref().filter(|v| !v.is_empty()) else {
            return Err(ApiError(Error::InvalidRequest(
                "OpenAI-compatible voice input requires a model".to_string(),
            )));
        };
        let api_key = headers
            .get("x-milim-stt-api-key")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        return Ok(Some(Arc::new(
            OpenAiAudioTranscriptionTranscriber::new(endpoint, model, api_key).map_err(ApiError)?,
        )));
    }

    if provider == "parakeet" {
        let Some(command) = query.command.as_deref().filter(|v| !v.is_empty()) else {
            return Err(ApiError(Error::InvalidRequest(
                "Parakeet voice input requires a command".to_string(),
            )));
        };
        let model = query
            .model
            .as_deref()
            .filter(|v| !v.is_empty())
            .unwrap_or(DEFAULT_PARAKEET_MODEL);
        return Ok(Some(Arc::new(ParakeetCommandTranscriber::new(
            command, model,
        ))));
    }

    if provider == "whisper" {
        let Some(model_path) = query.model_path.as_deref().filter(|v| !v.is_empty()) else {
            return Err(ApiError(Error::InvalidRequest(
                "local Whisper voice input requires a model path".to_string(),
            )));
        };
        let Some(factory) = st.transcriber_factory.as_ref() else {
            return Err(ApiError(Error::InvalidRequest(
                "local Whisper voice input is not available in this build".to_string(),
            )));
        };

        if let Some(transcriber) = st
            .transcriber_cache
            .read()
            .map_err(|_| ApiError(Error::Other("transcriber cache poisoned".to_string())))?
            .get(model_path)
            .cloned()
        {
            return Ok(Some(transcriber));
        }

        let transcriber = factory(model_path.to_string()).map_err(ApiError)?;
        st.transcriber_cache
            .write()
            .map_err(|_| ApiError(Error::Other("transcriber cache poisoned".to_string())))?
            .insert(model_path.to_string(), Arc::clone(&transcriber));
        return Ok(Some(transcriber));
    }

    Err(ApiError(Error::InvalidRequest(format!(
        "voice provider {provider} is not available"
    ))))
}

fn vad_for_audio_request(
    st: &AppState,
    query: &AudioVadQuery,
) -> Result<Option<Arc<dyn VoiceActivityDetector>>, ApiError> {
    let Some(provider) = query.provider.as_deref().filter(|v| !v.is_empty()) else {
        if let Some(vad) = st.vad.as_ref() {
            return Ok(Some(Arc::clone(vad)));
        }
        return Ok(None);
    };

    if provider == "energy" {
        let threshold = query.threshold.unwrap_or(DEFAULT_ENERGY_VAD_THRESHOLD);
        return Ok(Some(Arc::new(
            EnergyVoiceActivityDetector::new(threshold).map_err(ApiError)?,
        )));
    }

    if provider == "native" || provider == "silero" {
        let Some(model_path) = query.model_path.as_deref().filter(|v| !v.is_empty()) else {
            return Err(ApiError(Error::InvalidRequest(
                "native VAD requires a model path".to_string(),
            )));
        };
        let Some(factory) = st.vad_factory.as_ref() else {
            return Err(ApiError(Error::InvalidRequest(
                "native VAD is not available in this build".to_string(),
            )));
        };

        if let Some(vad) = st
            .vad_cache
            .read()
            .map_err(|_| ApiError(Error::Other("VAD cache poisoned".to_string())))?
            .get(model_path)
            .cloned()
        {
            return Ok(Some(vad));
        }

        let vad = factory(model_path.to_string()).map_err(ApiError)?;
        st.vad_cache
            .write()
            .map_err(|_| ApiError(Error::Other("VAD cache poisoned".to_string())))?
            .insert(model_path.to_string(), Arc::clone(&vad));
        return Ok(Some(vad));
    }

    Err(ApiError(Error::InvalidRequest(format!(
        "VAD provider {provider} is not available"
    ))))
}

// ----- Workspace (host working folder for filesystem/shell tools) -----

#[derive(Deserialize)]
pub(crate) struct WorkspaceSet {
    #[serde(default)]
    folder: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceGitStatus {
    state: String,
    folder: Option<String>,
    is_repo: bool,
    root: Option<String>,
    branch: Option<String>,
    head: Option<String>,
    upstream: Option<String>,
    remote: Option<String>,
    ahead: u32,
    behind: u32,
    staged: u32,
    unstaged: u32,
    untracked: u32,
    conflicts: u32,
    insertions: u32,
    deletions: u32,
    has_changes: bool,
    changed_file_count: u32,
    changed_files: Vec<WorkspaceGitFileChange>,
    branches: Vec<WorkspaceGitBranch>,
    recent_commits: Vec<WorkspaceGitCommit>,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceGitFileChange {
    status: String,
    path: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceGitBranch {
    name: String,
    current: bool,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceGitCommit {
    hash: String,
    subject: String,
}

#[derive(Deserialize)]
pub(crate) struct WorkspaceGitActionRequest {
    action: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    checkpoint: Option<String>,
    #[serde(default)]
    stage_all: bool,
    #[serde(default)]
    staged_only: bool,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    worktree: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceGitActionResponse {
    ok: bool,
    action: String,
    command: String,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    message: String,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    checkpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worktree: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    undo_checkpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conflicts: Option<Vec<String>>,
}

#[derive(Debug, Default)]
struct GitChangeCounts {
    staged: u32,
    unstaged: u32,
    untracked: u32,
    conflicts: u32,
}

/// `GET /workspace` — the current host working folder (or null).
pub(crate) async fn workspace_get(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let cur = st
        .workspace
        .read()
        .ok()
        .and_then(|g| g.clone())
        .map(|p| p.to_string_lossy().to_string());
    Ok(Json(json!({ "folder": cur })).into_response())
}

/// `POST /workspace` — set (or clear, with empty/null) the host working folder
/// that the filesystem/shell tools operate within.
pub(crate) async fn workspace_set(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<WorkspaceSet>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let folder = req
        .folder
        .filter(|s| !s.trim().is_empty())
        .map(std::path::PathBuf::from);
    if let Ok(mut g) = st.workspace.write() {
        *g = folder.clone();
    }
    Ok(Json(json!({ "folder": folder.map(|p| p.to_string_lossy().to_string()) })).into_response())
}

/// `GET /preview-apps/{thread_id}` - status for a managed preview app.
pub(crate) async fn preview_app_get(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Path(thread_id): Path<String>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    Ok(Json(st.preview_runtime.status(&thread_id)?).into_response())
}

/// `POST /preview-apps/{thread_id}/stage` - stage no-folder named artifact files.
pub(crate) async fn preview_app_stage(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Path(thread_id): Path<String>,
    Json(req): Json<PreviewAppStageRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    Ok(Json(st.preview_runtime.stage(&thread_id, &req.files)?).into_response())
}

/// `POST /preview-apps/{thread_id}/preflight` - inspect commands without staging or executing.
pub(crate) async fn preview_app_preflight(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Path(thread_id): Path<String>,
    Json(req): Json<PreviewAppPreflightRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    Ok(Json(st.preview_runtime.preflight(&thread_id, &req)?).into_response())
}

/// `POST /preview-apps/{thread_id}/start` - install and start the preview app.
pub(crate) async fn preview_app_start(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Path(thread_id): Path<String>,
    req: Option<Json<PreviewAppStartRequest>>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let request = req.map(|Json(req)| req).unwrap_or_default();
    Ok(Json(st.preview_runtime.start(&thread_id, &request)?).into_response())
}

/// `POST /preview-apps/{thread_id}/stop` - stop the preview app process tree.
pub(crate) async fn preview_app_stop(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Path(thread_id): Path<String>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    Ok(Json(st.preview_runtime.stop(&thread_id).await?).into_response())
}

/// `POST /preview-apps/{thread_id}/restart` - stop, then start the preview app.
pub(crate) async fn preview_app_restart(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Path(thread_id): Path<String>,
    req: Option<Json<PreviewAppStartRequest>>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let request = req.map(|Json(req)| req).unwrap_or_default();
    Ok(Json(st.preview_runtime.restart(&thread_id, &request).await?).into_response())
}

/// `GET /preview-apps/{thread_id}/logs` - recent preview app logs.
pub(crate) async fn preview_app_logs(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Path(thread_id): Path<String>,
    Query(query): Query<PreviewAppLogsQuery>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    Ok(Json(st.preview_runtime.logs_after(&thread_id, query.after_seq)?).into_response())
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct PreviewAppLogsQuery {
    after_seq: Option<u64>,
}

/// `GET /workspace/git` - Git status for the current host working folder.
pub(crate) async fn workspace_git_status(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let folder = st.workspace.read().ok().and_then(|g| g.clone());
    let status = tokio::task::spawn_blocking(move || workspace_git_status_blocking(folder))
        .await
        .map_err(|e| ApiError(Error::Other(format!("git status task failed: {e}"))))?;
    Ok(Json(status).into_response())
}

/// `POST /workspace/git/action` - run a narrow, guarded Git sidebar action.
pub(crate) async fn workspace_git_action(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(mut req): Json<WorkspaceGitActionRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let action = req.action.trim().to_string();
    if !matches!(
        action.as_str(),
        "diff"
            | "fetch"
            | "pull"
            | "push"
            | "publish"
            | "commit"
            | "commit_push"
            | "checkout_branch"
            | "create_branch"
            | "checkpoint"
            | "restore_checkpoint"
            | "create_retry_worktree"
            | "apply_retry_worktree"
            | "remove_retry_worktree"
    ) {
        return Err(ApiError(Error::InvalidRequest(format!(
            "unsupported git action: {action}"
        ))));
    }

    let folder = st.workspace.read().ok().and_then(|g| g.clone());
    let hot_swap_root = milim_core::paths::Paths::resolve()
        .root()
        .join("runtime")
        .join("hot-swap");
    req.action = action;
    let result = tokio::task::spawn_blocking(move || {
        workspace_git_action_blocking(folder, req, hot_swap_root)
    })
    .await
    .map_err(|e| ApiError(Error::Other(format!("git action task failed: {e}"))))?;
    Ok(Json(result).into_response())
}

fn workspace_git_status_blocking(folder: Option<PathBuf>) -> WorkspaceGitStatus {
    let Some(folder) = folder else {
        return workspace_git_status_message(
            "no_folder",
            None,
            false,
            "No working folder selected",
        );
    };
    let folder_text = folder.to_string_lossy().to_string();

    match std::fs::metadata(&folder) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return workspace_git_status_message(
                "error",
                Some(folder_text),
                false,
                "Selected working folder is not a directory",
            )
        }
        Err(e) => {
            return workspace_git_status_message(
                "error",
                Some(folder_text),
                false,
                &format!("Failed to read working folder metadata: {e}"),
            )
        }
    }

    let inside = match git_output(&folder, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(output) if output.status.success() => output_text(&output),
        Ok(_) => {
            return workspace_git_status_message(
                "not_git",
                Some(folder_text),
                false,
                "No Git repository found in the selected folder",
            )
        }
        Err(e) => return workspace_git_status_message("error", Some(folder_text), false, &e),
    };

    if inside.trim() != "true" {
        return workspace_git_status_message(
            "not_git",
            Some(folder_text),
            false,
            "No Git worktree found in the selected folder",
        );
    }

    let root_text = git_text(&folder, &["rev-parse", "--show-toplevel"])
        .unwrap_or_else(|| folder.to_string_lossy().to_string());
    let root = PathBuf::from(&root_text);
    let branch = git_text(&root, &["branch", "--show-current"]);
    let head = git_text(&root, &["rev-parse", "--short", "HEAD"]);
    let upstream = git_text(
        &root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    );
    let remote = git_text(&root, &["remote", "get-url", "origin"]);
    let branches = workspace_git_branches(&root, branch.as_deref());
    let recent_commits = workspace_git_recent_commits(&root);
    let (ahead, behind) = if upstream.is_some() {
        git_text(
            &root,
            &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
        )
        .map(|text| parse_ahead_behind(&text))
        .unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    let porcelain = match git_output(
        &root,
        &[
            "status",
            "--porcelain=v1",
            "--branch",
            "--untracked-files=normal",
        ],
    ) {
        Ok(output) if output.status.success() => output_text(&output),
        Ok(output) => {
            return workspace_git_status_message(
                "error",
                Some(folder_text),
                true,
                &format!("Failed to read git status: {}", output_error_text(&output)),
            )
        }
        Err(e) => return workspace_git_status_message("error", Some(folder_text), true, &e),
    };

    let counts = parse_git_porcelain_counts(&porcelain);
    let (changed_file_count, changed_files) = parse_git_porcelain_files(&porcelain, 20);
    let (insertions, deletions) = git_text(&root, &["diff", "--shortstat", "HEAD"])
        .map(|text| parse_git_shortstat(&text))
        .unwrap_or((0, 0));
    let has_changes = counts.staged + counts.unstaged + counts.untracked + counts.conflicts > 0;

    WorkspaceGitStatus {
        state: "ready".to_string(),
        folder: Some(folder_text),
        is_repo: true,
        root: Some(root_text),
        branch,
        head,
        upstream,
        remote,
        ahead,
        behind,
        staged: counts.staged,
        unstaged: counts.unstaged,
        untracked: counts.untracked,
        conflicts: counts.conflicts,
        insertions,
        deletions,
        has_changes,
        changed_file_count,
        changed_files,
        branches,
        recent_commits,
        message: None,
    }
}

fn workspace_git_status_message(
    state: &str,
    folder: Option<String>,
    is_repo: bool,
    message: &str,
) -> WorkspaceGitStatus {
    WorkspaceGitStatus {
        state: state.to_string(),
        folder,
        is_repo,
        root: None,
        branch: None,
        head: None,
        upstream: None,
        remote: None,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicts: 0,
        insertions: 0,
        deletions: 0,
        has_changes: false,
        changed_file_count: 0,
        changed_files: Vec::new(),
        branches: Vec::new(),
        recent_commits: Vec::new(),
        message: Some(message.to_string()),
    }
}

fn workspace_git_recent_commits(root: &FsPath) -> Vec<WorkspaceGitCommit> {
    let Ok(output) = git_output(root, &["log", "-n", "5", "--format=%h%x00%s"]) else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (hash, subject) = line.split_once('\0')?;
            let hash = hash.trim();
            let subject = subject.trim();
            if hash.is_empty() || subject.is_empty() {
                return None;
            }
            Some(WorkspaceGitCommit {
                hash: hash.to_string(),
                subject: subject.to_string(),
            })
        })
        .collect()
}

fn workspace_git_branches(root: &FsPath, current: Option<&str>) -> Vec<WorkspaceGitBranch> {
    let Ok(output) = git_output(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(upstream:short)",
            "refs/heads",
        ],
    ) else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let mut branches: Vec<WorkspaceGitBranch> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            let upstream = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let (ahead, behind) = upstream
                .as_deref()
                .and_then(|upstream| {
                    let range = format!("{name}...{upstream}");
                    git_text(
                        root,
                        &["rev-list", "--left-right", "--count", range.as_str()],
                    )
                })
                .map(|text| parse_ahead_behind(&text))
                .unwrap_or((0, 0));
            Some(WorkspaceGitBranch {
                name: name.to_string(),
                current: current == Some(name),
                upstream,
                ahead,
                behind,
            })
        })
        .collect();

    branches.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| a.name.cmp(&b.name)));
    branches
}

fn git_output(cwd: &FsPath, args: &[&str]) -> std::result::Result<Output, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    milim_core::proc::hide_console(&mut cmd)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))
}

fn git_output_with_env(
    cwd: &FsPath,
    args: &[&str],
    envs: &[(&str, String)],
) -> std::result::Result<Output, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    for (key, value) in envs {
        cmd.env(key, value);
    }
    milim_core::proc::hide_console(&mut cmd)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))
}

fn git_text(cwd: &FsPath, args: &[&str]) -> Option<String> {
    let output = git_output(cwd, args).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = output_text(&output);
    (!text.trim().is_empty()).then(|| text.trim().to_string())
}

fn output_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn output_error_text(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("git exited with {}", output.status)
    } else {
        stderr
    }
}

fn parse_ahead_behind(text: &str) -> (u32, u32) {
    let mut parts = text.split_whitespace();
    let ahead = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn parse_git_porcelain_counts(text: &str) -> GitChangeCounts {
    let mut counts = GitChangeCounts::default();
    for line in text.lines() {
        if line.starts_with("##") || line.len() < 2 {
            continue;
        }
        let bytes = line.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        if x == '?' && y == '?' {
            counts.untracked += 1;
            continue;
        }
        if x == '!' && y == '!' {
            continue;
        }
        if is_git_conflict_status(x, y) {
            counts.conflicts += 1;
            continue;
        }
        if x != ' ' {
            counts.staged += 1;
        }
        if y != ' ' {
            counts.unstaged += 1;
        }
    }
    counts
}

fn is_git_conflict_status(x: char, y: char) -> bool {
    matches!(
        (x, y),
        ('D', 'D') | ('A', 'U') | ('U', 'D') | ('U', 'A') | ('D', 'U') | ('A', 'A') | ('U', 'U')
    )
}

fn parse_git_porcelain_files(text: &str, limit: usize) -> (u32, Vec<WorkspaceGitFileChange>) {
    let mut count = 0;
    let mut files = Vec::new();
    for line in text.lines() {
        if line.starts_with("##") || line.len() < 3 {
            continue;
        }
        let status = line[..2].trim().to_string();
        let path = line[3..].trim().to_string();
        if !status.is_empty() && !path.is_empty() {
            count += 1;
            if files.len() < limit {
                files.push(WorkspaceGitFileChange { status, path });
            }
        }
    }
    (count, files)
}

fn parse_git_shortstat(text: &str) -> (u32, u32) {
    let mut insertions = 0;
    let mut deletions = 0;
    for part in text.split(',').map(str::trim) {
        let mut words = part.split_whitespace();
        let Some(value) = words.next().and_then(|word| word.parse::<u32>().ok()) else {
            continue;
        };
        let Some(kind) = words.next() else {
            continue;
        };
        if kind.starts_with("insertion") {
            insertions = value;
        } else if kind.starts_with("deletion") {
            deletions = value;
        }
    }
    (insertions, deletions)
}

fn workspace_git_action_blocking(
    folder: Option<PathBuf>,
    request: WorkspaceGitActionRequest,
    hot_swap_root: PathBuf,
) -> WorkspaceGitActionResponse {
    const OUTPUT_LIMIT: usize = 24_000;
    let WorkspaceGitActionRequest {
        action,
        message,
        checkpoint,
        stage_all,
        staged_only,
        branch,
        worktree,
    } = request;

    let status = workspace_git_status_blocking(folder);
    let Some(root) = status.root.as_ref().map(PathBuf::from) else {
        return workspace_git_action_message(
            &action,
            "",
            false,
            &git_state_label_for_action(&status),
        );
    };

    if action == "diff" {
        return workspace_git_diff_action(&root, &action, status.head.is_some(), staged_only);
    }
    if action == "checkpoint" {
        return workspace_git_checkpoint_action(&root, &status, message);
    }
    if action == "restore_checkpoint" {
        return workspace_git_restore_checkpoint_action(&root, checkpoint);
    }
    if action == "create_retry_worktree" {
        return workspace_git_create_retry_worktree_action(&root, checkpoint, &hot_swap_root);
    }
    if action == "apply_retry_worktree" {
        return workspace_git_apply_retry_worktree_action(
            &root,
            checkpoint,
            worktree,
            &hot_swap_root,
        );
    }
    if action == "remove_retry_worktree" {
        return workspace_git_remove_retry_worktree_action(&root, worktree, &hot_swap_root);
    }
    if matches!(action.as_str(), "commit" | "commit_push") {
        return workspace_git_commit_action(&root, &action, &status, message, stage_all);
    }

    let requested_branch = branch.unwrap_or_default().trim().to_string();
    let args: Vec<String> = match action.as_str() {
        "fetch" => vec!["fetch".into(), "--prune".into()],
        "checkout_branch" => {
            if requested_branch.is_empty() {
                return workspace_git_action_message(
                    &action,
                    "git checkout <branch>",
                    false,
                    "Branch name required.",
                );
            }
            vec!["checkout".into(), requested_branch.clone()]
        }
        "create_branch" => {
            if requested_branch.is_empty() {
                return workspace_git_action_message(
                    &action,
                    "git checkout -b <branch>",
                    false,
                    "Branch name required.",
                );
            }
            vec!["checkout".into(), "-b".into(), requested_branch.clone()]
        }
        "pull" => {
            if status.has_changes {
                return workspace_git_action_message(
                    &action,
                    "git pull --ff-only",
                    false,
                    "Pull requires a clean worktree.",
                );
            }
            if status.upstream.is_none() || status.behind == 0 {
                return workspace_git_action_message(
                    &action,
                    "git pull --ff-only",
                    false,
                    "Nothing to pull from an upstream branch.",
                );
            }
            vec!["pull".into(), "--ff-only".into()]
        }
        "push" => {
            if status.upstream.is_none() || status.ahead == 0 {
                return workspace_git_action_message(
                    &action,
                    "git push",
                    false,
                    "Nothing to push to an upstream branch.",
                );
            }
            vec!["push".into()]
        }
        "publish" => {
            let Some(branch) = status.branch.as_deref().filter(|s| !s.trim().is_empty()) else {
                return workspace_git_action_message(
                    &action,
                    "git push -u origin <branch>",
                    false,
                    "Publish requires a named branch.",
                );
            };
            if status.remote.is_none() || status.upstream.is_some() {
                return workspace_git_action_message(
                    &action,
                    &format!("git push -u origin {branch}"),
                    false,
                    "Publish requires a remote and no upstream.",
                );
            }
            vec![
                "push".into(),
                "-u".into(),
                "origin".into(),
                branch.to_string(),
            ]
        }
        _ => return workspace_git_action_message(&action, "", false, "Unsupported Git action."),
    };

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let command = format!("git {}", args.join(" "));
    match git_output(&root, &arg_refs) {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let (stdout, stdout_truncated) = truncate_git_action_output(stdout, OUTPUT_LIMIT);
            let (stderr, stderr_truncated) = truncate_git_action_output(stderr, OUTPUT_LIMIT);
            let ok = output.status.success();
            let message = if ok {
                match action.as_str() {
                    "diff" if stdout.trim().is_empty() => "No diff to show.".to_string(),
                    "diff" => "Diff ready.".to_string(),
                    "fetch" => "Fetch complete.".to_string(),
                    "checkout_branch" => "Branch checked out.".to_string(),
                    "create_branch" => "Branch created.".to_string(),
                    "pull" => "Pull complete.".to_string(),
                    "push" => "Push complete.".to_string(),
                    "publish" => "Branch published.".to_string(),
                    _ => "Git action complete.".to_string(),
                }
            } else {
                output_error_text(&output)
            };
            WorkspaceGitActionResponse {
                ok,
                action,
                command,
                stdout,
                stderr,
                exit_code: output.status.code(),
                message,
                truncated: stdout_truncated || stderr_truncated,
                checkpoint: None,
                root: None,
                head: None,
                worktree: None,
                undo_checkpoint: None,
                conflicts: None,
            }
        }
        Err(e) => workspace_git_action_message(&action, &command, false, &e),
    }
}

fn workspace_git_commit_action(
    root: &FsPath,
    action: &str,
    status: &WorkspaceGitStatus,
    message: Option<String>,
    stage_all: bool,
) -> WorkspaceGitActionResponse {
    let message = message.unwrap_or_default().trim().to_string();
    if message.is_empty() {
        return workspace_git_action_message(
            action,
            "git commit -m <message>",
            false,
            "Commit message required.",
        );
    }
    if !status.has_changes {
        return workspace_git_action_message(
            action,
            "git commit -m <message>",
            false,
            "Nothing to commit.",
        );
    }
    if status.conflicts > 0 {
        return workspace_git_action_message(
            action,
            "git commit -m <message>",
            false,
            "Resolve conflicts before committing.",
        );
    }
    if !stage_all && status.staged == 0 {
        return workspace_git_action_message(
            action,
            "git commit -m <message>",
            false,
            "No staged changes to commit.",
        );
    }

    let push_args: Option<Vec<String>> = if action == "commit_push" {
        if status.behind > 0 {
            return workspace_git_action_message(action, "git push", false, "Pull before pushing.");
        }
        if status.remote.is_none() {
            return workspace_git_action_message(
                action,
                "git push",
                false,
                "No remote configured.",
            );
        }
        if status.upstream.is_some() {
            Some(vec!["push".into()])
        } else {
            let Some(branch) = status.branch.as_deref().filter(|s| !s.trim().is_empty()) else {
                return workspace_git_action_message(
                    action,
                    "git push -u origin <branch>",
                    false,
                    "Publish requires a named branch.",
                );
            };
            Some(vec![
                "push".into(),
                "-u".into(),
                "origin".into(),
                branch.to_string(),
            ])
        }
    } else {
        None
    };

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut commands = Vec::new();

    if stage_all {
        let args = ["add", "-A"];
        commands.push(git_command_text(&args));
        match git_output(root, &args) {
            Ok(output) if output.status.success() => {
                append_git_output(&mut stdout, &mut stderr, &output)
            }
            Ok(output) => {
                append_git_output(&mut stdout, &mut stderr, &output);
                return workspace_git_combined_response(
                    action,
                    &commands.join(" && "),
                    false,
                    stdout,
                    stderr,
                    output.status.code(),
                    output_error_text(&output),
                );
            }
            Err(e) => {
                return workspace_git_action_message(action, &commands.join(" && "), false, &e)
            }
        }
    }

    let commit_args = ["commit", "-m", message.as_str()];
    commands.push(git_command_text(&commit_args));
    match git_output(root, &commit_args) {
        Ok(output) if output.status.success() => {
            append_git_output(&mut stdout, &mut stderr, &output)
        }
        Ok(output) => {
            append_git_output(&mut stdout, &mut stderr, &output);
            return workspace_git_combined_response(
                action,
                &commands.join(" && "),
                false,
                stdout,
                stderr,
                output.status.code(),
                output_error_text(&output),
            );
        }
        Err(e) => return workspace_git_action_message(action, &commands.join(" && "), false, &e),
    }

    if let Some(args) = push_args {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        commands.push(git_command_text(&refs));
        match git_output(root, &refs) {
            Ok(output) if output.status.success() => {
                append_git_output(&mut stdout, &mut stderr, &output)
            }
            Ok(output) => {
                append_git_output(&mut stdout, &mut stderr, &output);
                return workspace_git_combined_response(
                    action,
                    &commands.join(" && "),
                    false,
                    stdout,
                    stderr,
                    output.status.code(),
                    output_error_text(&output),
                );
            }
            Err(e) => {
                return workspace_git_action_message(action, &commands.join(" && "), false, &e)
            }
        }
    }

    workspace_git_combined_response(
        action,
        &commands.join(" && "),
        true,
        stdout,
        stderr,
        Some(0),
        if action == "commit_push" {
            "Commit and push complete.".to_string()
        } else {
            "Commit complete.".to_string()
        },
    )
}

fn workspace_git_checkpoint_action(
    root: &FsPath,
    status: &WorkspaceGitStatus,
    message: Option<String>,
) -> WorkspaceGitActionResponse {
    let Some(index_path) = git_text(root, &["rev-parse", "--git-path", "index"]) else {
        return workspace_git_action_message(
            "checkpoint",
            "git rev-parse --git-path index",
            false,
            "Failed to locate the Git index.",
        );
    };
    let index_path = {
        let path = PathBuf::from(index_path);
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    };
    let temp_index = index_path.with_file_name(format!("milim-{}.index", gen_id("checkpoint")));
    let index_env = [("GIT_INDEX_FILE", temp_index.to_string_lossy().to_string())];
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut commands = Vec::new();

    let add_args = ["add", "-A", "--"];
    commands.push(format!(
        "GIT_INDEX_FILE={} {}",
        temp_index.display(),
        git_command_text(&add_args)
    ));
    match git_output_with_env(root, &add_args, &index_env) {
        Ok(output) if output.status.success() => {
            append_git_output(&mut stdout, &mut stderr, &output)
        }
        Ok(output) => {
            append_git_output(&mut stdout, &mut stderr, &output);
            let _ = std::fs::remove_file(&temp_index);
            return workspace_git_combined_response(
                "checkpoint",
                &commands.join(" && "),
                false,
                stdout,
                stderr,
                output.status.code(),
                output_error_text(&output),
            );
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp_index);
            return workspace_git_action_message("checkpoint", &commands.join(" && "), false, &e);
        }
    }

    let write_tree_args = ["write-tree"];
    commands.push(format!(
        "GIT_INDEX_FILE={} {}",
        temp_index.display(),
        git_command_text(&write_tree_args)
    ));
    let tree = match git_output_with_env(root, &write_tree_args, &index_env) {
        Ok(output) if output.status.success() => {
            append_git_output(&mut stdout, &mut stderr, &output);
            output_text(&output)
        }
        Ok(output) => {
            append_git_output(&mut stdout, &mut stderr, &output);
            let _ = std::fs::remove_file(&temp_index);
            return workspace_git_combined_response(
                "checkpoint",
                &commands.join(" && "),
                false,
                stdout,
                stderr,
                output.status.code(),
                output_error_text(&output),
            );
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp_index);
            return workspace_git_action_message("checkpoint", &commands.join(" && "), false, &e);
        }
    };
    let _ = std::fs::remove_file(&temp_index);

    let checkpoint_ref = format!("refs/milim/checkpoints/{}", gen_id("turn"));
    let checkpoint_label = message
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("turn");
    let commit_message = format!("milim workspace checkpoint: {checkpoint_label}");
    let head = git_text(root, &["rev-parse", "HEAD"]);
    let mut commit_args = vec!["commit-tree", tree.as_str()];
    if let Some(head) = head.as_deref() {
        commit_args.push("-p");
        commit_args.push(head);
    }
    commit_args.push("-m");
    commit_args.push(commit_message.as_str());
    commands.push(git_command_text(&commit_args));
    let commit_env = [
        ("GIT_AUTHOR_NAME", "milim".to_string()),
        ("GIT_AUTHOR_EMAIL", "milim@example.invalid".to_string()),
        ("GIT_COMMITTER_NAME", "milim".to_string()),
        ("GIT_COMMITTER_EMAIL", "milim@example.invalid".to_string()),
    ];
    let commit = match git_output_with_env(root, &commit_args, &commit_env) {
        Ok(output) if output.status.success() => {
            append_git_output(&mut stdout, &mut stderr, &output);
            output_text(&output)
        }
        Ok(output) => {
            append_git_output(&mut stdout, &mut stderr, &output);
            return workspace_git_combined_response(
                "checkpoint",
                &commands.join(" && "),
                false,
                stdout,
                stderr,
                output.status.code(),
                output_error_text(&output),
            );
        }
        Err(e) => {
            return workspace_git_action_message("checkpoint", &commands.join(" && "), false, &e)
        }
    };

    let update_ref_args = ["update-ref", checkpoint_ref.as_str(), commit.as_str()];
    commands.push(git_command_text(&update_ref_args));
    match git_output(root, &update_ref_args) {
        Ok(output) if output.status.success() => {
            append_git_output(&mut stdout, &mut stderr, &output)
        }
        Ok(output) => {
            append_git_output(&mut stdout, &mut stderr, &output);
            return workspace_git_combined_response(
                "checkpoint",
                &commands.join(" && "),
                false,
                stdout,
                stderr,
                output.status.code(),
                output_error_text(&output),
            );
        }
        Err(e) => {
            return workspace_git_action_message("checkpoint", &commands.join(" && "), false, &e)
        }
    }

    let mut response = workspace_git_combined_response(
        "checkpoint",
        &commands.join(" && "),
        true,
        stdout,
        stderr,
        Some(0),
        "Workspace checkpoint created.".to_string(),
    );
    response.checkpoint = Some(checkpoint_ref);
    response.root = Some(root.to_string_lossy().to_string());
    response.head = status.head.clone();
    response
}

fn workspace_git_restore_checkpoint_action(
    root: &FsPath,
    checkpoint: Option<String>,
) -> WorkspaceGitActionResponse {
    let checkpoint = checkpoint.unwrap_or_default().trim().to_string();
    if checkpoint.is_empty() {
        return workspace_git_action_message(
            "restore_checkpoint",
            "git read-tree --reset -u <checkpoint>",
            false,
            "Checkpoint ref required.",
        );
    }

    let treeish = format!("{checkpoint}^{{tree}}");
    let tree = match git_output(root, &["rev-parse", "--verify", treeish.as_str()]) {
        Ok(output) if output.status.success() => output_text(&output),
        Ok(output) => {
            return workspace_git_action_message(
                "restore_checkpoint",
                &format!("git rev-parse --verify {treeish}"),
                false,
                &output_error_text(&output),
            )
        }
        Err(e) => {
            return workspace_git_action_message(
                "restore_checkpoint",
                &format!("git rev-parse --verify {treeish}"),
                false,
                &e,
            )
        }
    };

    let mut stdout = String::new();
    let mut stderr = String::new();
    let read_tree_args = ["read-tree", "--reset", "-u", tree.as_str()];
    let clean_args = ["clean", "-fd"];
    let commands = [
        git_command_text(&read_tree_args),
        git_command_text(&clean_args),
    ];

    match git_output(root, &read_tree_args) {
        Ok(output) if output.status.success() => {
            append_git_output(&mut stdout, &mut stderr, &output)
        }
        Ok(output) => {
            append_git_output(&mut stdout, &mut stderr, &output);
            return workspace_git_combined_response(
                "restore_checkpoint",
                &commands.join(" && "),
                false,
                stdout,
                stderr,
                output.status.code(),
                output_error_text(&output),
            );
        }
        Err(e) => {
            return workspace_git_action_message(
                "restore_checkpoint",
                &commands.join(" && "),
                false,
                &e,
            )
        }
    }
    match git_output(root, &clean_args) {
        Ok(output) if output.status.success() => {
            append_git_output(&mut stdout, &mut stderr, &output)
        }
        Ok(output) => {
            append_git_output(&mut stdout, &mut stderr, &output);
            return workspace_git_combined_response(
                "restore_checkpoint",
                &commands.join(" && "),
                false,
                stdout,
                stderr,
                output.status.code(),
                output_error_text(&output),
            );
        }
        Err(e) => {
            return workspace_git_action_message(
                "restore_checkpoint",
                &commands.join(" && "),
                false,
                &e,
            )
        }
    }

    let mut response = workspace_git_combined_response(
        "restore_checkpoint",
        &commands.join(" && "),
        true,
        stdout,
        stderr,
        Some(0),
        "Workspace restored to checkpoint.".to_string(),
    );
    response.checkpoint = Some(checkpoint);
    response.root = Some(root.to_string_lossy().to_string());
    response.head = git_text(root, &["rev-parse", "--short", "HEAD"]);
    response
}

fn valid_milim_checkpoint(checkpoint: Option<String>) -> Option<String> {
    let checkpoint = checkpoint.unwrap_or_default().trim().to_string();
    if checkpoint.starts_with("refs/milim/checkpoints/") {
        Some(checkpoint)
    } else {
        None
    }
}

fn retry_worktree_path(
    worktree: Option<String>,
    hot_swap_root: &FsPath,
) -> Result<PathBuf, String> {
    let requested = PathBuf::from(worktree.unwrap_or_default());
    let root = std::fs::canonicalize(hot_swap_root)
        .map_err(|e| format!("Hot Swap runtime is unavailable: {e}"))?;
    let path = std::fs::canonicalize(&requested)
        .map_err(|e| format!("Retry worktree is unavailable: {e}"))?;
    if path.starts_with(&root) {
        Ok(path)
    } else {
        Err("Retry worktree must be inside Milim's runtime directory.".to_string())
    }
}

fn git_common_dir(root: &FsPath) -> Option<PathBuf> {
    let raw = PathBuf::from(git_text(root, &["rev-parse", "--git-common-dir"])?);
    std::fs::canonicalize(if raw.is_absolute() {
        raw
    } else {
        root.join(raw)
    })
    .ok()
}

fn workspace_git_create_retry_worktree_action(
    root: &FsPath,
    checkpoint: Option<String>,
    hot_swap_root: &FsPath,
) -> WorkspaceGitActionResponse {
    let Some(checkpoint) = valid_milim_checkpoint(checkpoint) else {
        return workspace_git_action_message(
            "create_retry_worktree",
            "git rev-parse --verify <checkpoint>",
            false,
            "A Milim workspace checkpoint is required.",
        );
    };
    if let Err(e) = std::fs::create_dir_all(hot_swap_root) {
        return workspace_git_action_message(
            "create_retry_worktree",
            "",
            false,
            &format!("Failed to create Hot Swap runtime directory: {e}"),
        );
    }
    let worktree = hot_swap_root.join(gen_id("retry"));
    let worktree_text = worktree.to_string_lossy().to_string();
    let args = [
        "worktree",
        "add",
        "--detach",
        worktree_text.as_str(),
        checkpoint.as_str(),
    ];
    let output = match git_output(root, &args) {
        Ok(output) => output,
        Err(e) => {
            return workspace_git_action_message(
                "create_retry_worktree",
                &git_command_text(&args),
                false,
                &e,
            )
        }
    };
    let ok = output.status.success();
    let mut response = workspace_git_combined_response(
        "create_retry_worktree",
        &git_command_text(&args),
        ok,
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code(),
        if ok {
            "Retry worktree created.".to_string()
        } else {
            output_error_text(&output)
        },
    );
    if ok {
        response.checkpoint = Some(checkpoint);
        response.root = Some(root.to_string_lossy().to_string());
        response.worktree = Some(worktree_text);
    }
    response
}

fn workspace_git_apply_retry_worktree_action(
    root: &FsPath,
    checkpoint: Option<String>,
    worktree: Option<String>,
    hot_swap_root: &FsPath,
) -> WorkspaceGitActionResponse {
    let Some(checkpoint) = valid_milim_checkpoint(checkpoint) else {
        return workspace_git_action_message(
            "apply_retry_worktree",
            "git rev-parse --verify <checkpoint>",
            false,
            "A Milim workspace checkpoint is required.",
        );
    };
    if let Err(e) = std::fs::create_dir_all(hot_swap_root) {
        return workspace_git_action_message("apply_retry_worktree", "", false, &e.to_string());
    }
    let worktree = match retry_worktree_path(worktree, hot_swap_root) {
        Ok(value) => value,
        Err(message) => {
            return workspace_git_action_message("apply_retry_worktree", "", false, &message)
        }
    };
    if git_common_dir(root) != git_common_dir(&worktree) {
        return workspace_git_action_message(
            "apply_retry_worktree",
            "",
            false,
            "Retry worktree does not belong to the selected repository.",
        );
    }

    let retry_status = workspace_git_status_blocking(Some(worktree.clone()));
    let retry_checkpoint = workspace_git_checkpoint_action(
        &worktree,
        &retry_status,
        Some("hot-swap-retry-result".to_string()),
    );
    let Some(retry_ref) = retry_checkpoint.checkpoint else {
        return workspace_git_action_message(
            "apply_retry_worktree",
            "",
            false,
            &retry_checkpoint.message,
        );
    };

    let diff_args = [
        "diff",
        "--binary",
        checkpoint.as_str(),
        retry_ref.as_str(),
        "--",
    ];
    let diff = match git_output(&worktree, &diff_args) {
        Ok(output) if output.status.success() => output.stdout,
        Ok(output) => {
            return workspace_git_action_message(
                "apply_retry_worktree",
                &git_command_text(&diff_args),
                false,
                &output_error_text(&output),
            )
        }
        Err(e) => {
            return workspace_git_action_message(
                "apply_retry_worktree",
                &git_command_text(&diff_args),
                false,
                &e,
            )
        }
    };
    if diff.is_empty() {
        return workspace_git_action_message(
            "apply_retry_worktree",
            &git_command_text(&diff_args),
            true,
            "Retry workspace has no changes to apply.",
        );
    }
    let names = git_text(
        &worktree,
        &[
            "diff",
            "--name-only",
            checkpoint.as_str(),
            retry_ref.as_str(),
            "--",
        ],
    )
    .unwrap_or_default()
    .lines()
    .map(str::trim)
    .filter(|line| !line.is_empty())
    .map(str::to_string)
    .collect::<Vec<_>>();
    let patch_path = hot_swap_root.join(format!("{}.patch", gen_id("apply")));
    if let Err(e) = std::fs::write(&patch_path, &diff) {
        return workspace_git_action_message(
            "apply_retry_worktree",
            "",
            false,
            &format!("Failed to prepare retry patch: {e}"),
        );
    }
    let patch_text = patch_path.to_string_lossy().to_string();
    let check_args = ["apply", "--check", "--binary", patch_text.as_str()];
    let check = git_output(root, &check_args);
    if !matches!(&check, Ok(output) if output.status.success()) {
        let _ = std::fs::remove_file(&patch_path);
        let detail = match check {
            Ok(output) => output_error_text(&output),
            Err(e) => e,
        };
        let mut response = workspace_git_action_message(
            "apply_retry_worktree",
            &git_command_text(&check_args),
            false,
            &format!("Retry changes conflict with the original workspace: {detail}"),
        );
        response.conflicts = Some(names);
        return response;
    }

    let original_status = workspace_git_status_blocking(Some(root.to_path_buf()));
    let undo = workspace_git_checkpoint_action(
        root,
        &original_status,
        Some("before-hot-swap-apply".to_string()),
    );
    let Some(undo_ref) = undo.checkpoint else {
        let _ = std::fs::remove_file(&patch_path);
        return workspace_git_action_message("apply_retry_worktree", "", false, &undo.message);
    };
    let apply_args = ["apply", "--binary", patch_text.as_str()];
    let output = match git_output(root, &apply_args) {
        Ok(output) => output,
        Err(e) => {
            let _ = std::fs::remove_file(&patch_path);
            return workspace_git_action_message(
                "apply_retry_worktree",
                &git_command_text(&apply_args),
                false,
                &e,
            );
        }
    };
    let _ = std::fs::remove_file(&patch_path);
    if !output.status.success() {
        let restored = workspace_git_restore_checkpoint_action(root, Some(undo_ref));
        return workspace_git_action_message(
            "apply_retry_worktree",
            &git_command_text(&apply_args),
            false,
            &format!(
                "Retry apply failed and the original workspace was {}: {}",
                if restored.ok {
                    "restored"
                } else {
                    "not restored"
                },
                output_error_text(&output)
            ),
        );
    }
    let mut response = workspace_git_combined_response(
        "apply_retry_worktree",
        &git_command_text(&apply_args),
        true,
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code(),
        "Retry changes applied to the original workspace.".to_string(),
    );
    response.root = Some(root.to_string_lossy().to_string());
    response.worktree = Some(worktree.to_string_lossy().to_string());
    response.undo_checkpoint = Some(undo_ref);
    response
}

fn workspace_git_remove_retry_worktree_action(
    root: &FsPath,
    worktree: Option<String>,
    hot_swap_root: &FsPath,
) -> WorkspaceGitActionResponse {
    if let Err(e) = std::fs::create_dir_all(hot_swap_root) {
        return workspace_git_action_message("remove_retry_worktree", "", false, &e.to_string());
    }
    let worktree = match retry_worktree_path(worktree, hot_swap_root) {
        Ok(value) => value,
        Err(message) => {
            return workspace_git_action_message("remove_retry_worktree", "", false, &message)
        }
    };
    if git_common_dir(root) != git_common_dir(&worktree) {
        return workspace_git_action_message(
            "remove_retry_worktree",
            "",
            false,
            "Retry worktree does not belong to the selected repository.",
        );
    }
    let worktree_text = worktree.to_string_lossy().to_string();
    let args = ["worktree", "remove", "--force", worktree_text.as_str()];
    let output = match git_output(root, &args) {
        Ok(output) => output,
        Err(e) => {
            return workspace_git_action_message(
                "remove_retry_worktree",
                &git_command_text(&args),
                false,
                &e,
            )
        }
    };
    let ok = output.status.success();
    workspace_git_combined_response(
        "remove_retry_worktree",
        &git_command_text(&args),
        ok,
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code(),
        if ok {
            "Retry worktree removed.".to_string()
        } else {
            output_error_text(&output)
        },
    )
}

fn append_git_output(stdout: &mut String, stderr: &mut String, output: &Output) {
    stdout.push_str(&String::from_utf8_lossy(&output.stdout));
    stderr.push_str(&String::from_utf8_lossy(&output.stderr));
}

fn git_command_text(args: &[&str]) -> String {
    let rendered = args
        .iter()
        .map(|arg| {
            if arg.chars().any(char::is_whitespace) {
                format!("{arg:?}")
            } else {
                (*arg).to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!("git {rendered}")
}

fn workspace_git_combined_response(
    action: &str,
    command: &str,
    ok: bool,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    message: String,
) -> WorkspaceGitActionResponse {
    const OUTPUT_LIMIT: usize = 24_000;
    let (stdout, stdout_truncated) = truncate_git_action_output(stdout, OUTPUT_LIMIT);
    let (stderr, stderr_truncated) = truncate_git_action_output(stderr, OUTPUT_LIMIT);
    WorkspaceGitActionResponse {
        ok,
        action: action.to_string(),
        command: command.to_string(),
        stdout,
        stderr,
        exit_code,
        message,
        truncated: stdout_truncated || stderr_truncated,
        checkpoint: None,
        root: None,
        head: None,
        worktree: None,
        undo_checkpoint: None,
        conflicts: None,
    }
}

fn workspace_git_diff_action(
    root: &FsPath,
    action: &str,
    has_head: bool,
    staged_only: bool,
) -> WorkspaceGitActionResponse {
    const OUTPUT_LIMIT: usize = 24_000;

    let args: &[&str] = if staged_only {
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--stat",
            "--patch",
            "--",
        ]
    } else if has_head {
        &["diff", "--no-ext-diff", "--stat", "--patch", "HEAD", "--"]
    } else {
        &["diff", "--no-ext-diff", "--stat", "--patch"]
    };
    let command = format!("git {}", args.join(" "));
    let output = match git_output(root, args) {
        Ok(output) => output,
        Err(e) => return workspace_git_action_message(action, &command, false, &e),
    };

    let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() && !staged_only {
        stdout.push_str(&untracked_git_diff(root));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let (stdout, stdout_truncated) = truncate_git_action_output(stdout, OUTPUT_LIMIT);
    let (stderr, stderr_truncated) = truncate_git_action_output(stderr, OUTPUT_LIMIT);
    let ok = output.status.success();
    let message = if ok {
        if stdout.trim().is_empty() {
            "No diff to show.".to_string()
        } else {
            "Diff ready.".to_string()
        }
    } else {
        output_error_text(&output)
    };

    WorkspaceGitActionResponse {
        ok,
        action: action.to_string(),
        command,
        stdout,
        stderr,
        exit_code: output.status.code(),
        message,
        truncated: stdout_truncated || stderr_truncated,
        checkpoint: None,
        root: None,
        head: None,
        worktree: None,
        undo_checkpoint: None,
        conflicts: None,
    }
}

fn untracked_git_diff(root: &FsPath) -> String {
    let Ok(output) = git_output(root, &["ls-files", "--others", "--exclude-standard", "-z"]) else {
        return String::new();
    };
    if !output.status.success() {
        return String::new();
    }

    let mut patch = String::new();
    for raw in output
        .stdout
        .split(|b| *b == 0)
        .filter(|item| !item.is_empty())
    {
        let path = String::from_utf8_lossy(raw).replace('\\', "/");
        let Some(file_patch) = untracked_file_patch(root, &path) else {
            continue;
        };
        if !patch.ends_with('\n') && !patch.is_empty() {
            patch.push('\n');
        }
        patch.push_str(&file_patch);
    }
    patch
}

fn untracked_file_patch(root: &FsPath, path: &str) -> Option<String> {
    let full_path = root.join(path);
    if !full_path.is_file() {
        return None;
    }
    let bytes = std::fs::read(full_path).ok()?;
    let mut patch = format!(
        "\ndiff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n"
    );
    match String::from_utf8(bytes) {
        Ok(text) => {
            let line_count = text.lines().count().max(1);
            patch.push_str(&format!("@@ -0,0 +1,{line_count} @@\n"));
            if text.is_empty() {
                return Some(patch);
            }
            for line in text.split_inclusive('\n') {
                patch.push('+');
                patch.push_str(line);
                if !line.ends_with('\n') {
                    patch.push('\n');
                }
            }
        }
        Err(_) => {
            patch.push_str(&format!("Binary files /dev/null and b/{path} differ\n"));
        }
    }
    Some(patch)
}

fn workspace_git_action_message(
    action: &str,
    command: &str,
    ok: bool,
    message: &str,
) -> WorkspaceGitActionResponse {
    WorkspaceGitActionResponse {
        ok,
        action: action.to_string(),
        command: command.to_string(),
        stdout: String::new(),
        stderr: String::new(),
        exit_code: None,
        message: message.to_string(),
        truncated: false,
        checkpoint: None,
        root: None,
        head: None,
        worktree: None,
        undo_checkpoint: None,
        conflicts: None,
    }
}

fn truncate_git_action_output(text: String, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}...\n[truncated]", &text[..end]), true)
}

fn git_state_label_for_action(status: &WorkspaceGitStatus) -> String {
    status
        .message
        .clone()
        .unwrap_or_else(|| "No Git repository is available.".to_string())
}

// ----- Computer use (screen capture + mouse/keyboard gate) -----

#[derive(Deserialize)]
pub(crate) struct ComputerSet {
    enabled: bool,
}

/// `GET /computer` — whether the computer-use layer is currently enabled.
pub(crate) async fn computer_get(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let enabled = st.computer_use.load(std::sync::atomic::Ordering::Relaxed);
    Ok(Json(json!({ "enabled": enabled })).into_response())
}

/// `POST /computer` — enable/disable the computer-use layer (mouse/keyboard).
pub(crate) async fn computer_set(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<ComputerSet>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    st.computer_use
        .store(req.enabled, std::sync::atomic::Ordering::Relaxed);
    Ok(Json(json!({ "enabled": req.enabled })).into_response())
}

// ----- Providers -----

fn default_enabled() -> bool {
    true
}

#[derive(Deserialize)]
pub(crate) struct ProviderUpsert {
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(default)]
    kind: crate::providers::ProviderKind,
    base_url: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default = "default_enabled")]
    enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ProviderDiscovery {
    name: &'static str,
    kind: crate::providers::ProviderKind,
    base_url: &'static str,
    configured: bool,
    provider_id: Option<String>,
    reachable: bool,
    models: Vec<String>,
    error: Option<String>,
}

const LOCAL_PROVIDER_CANDIDATES: &[(&str, &str)] = &[
    ("Ollama (local)", "http://localhost:11434/v1"),
    ("LM Studio (local)", "http://localhost:1234/v1"),
];
const LOCAL_PROVIDER_PROBE_TIMEOUT: Duration = Duration::from_millis(900);

/// `GET /providers` — list configured providers (keys redacted to `has_key`).
pub(crate) async fn providers_list(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let list = match &st.providers {
        Some(r) => r.list().await,
        None => Vec::new(),
    };
    let safe: Vec<Value> = list
        .into_iter()
        .map(|p| {
            json!({
                "id": p.id, "name": p.name, "kind": p.kind, "base_url": p.base_url,
                "enabled": p.enabled, "has_key": p.api_key.is_some(), "models": p.models,
                "pricing": p.pricing,
                "error": p.last_error,
            })
        })
        .collect();
    Ok(Json(json!({ "providers": safe })).into_response())
}

/// `GET /providers/discover` — probe well-known local OpenAI-compatible
/// endpoints and report whether they are reachable/configured.
pub(crate) async fn providers_discover(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;

    let configured = match &st.providers {
        Some(reg) => reg.list().await,
        None => Vec::new(),
    };
    let out = join_all(LOCAL_PROVIDER_CANDIDATES.iter().map(|(name, base_url)| {
        let existing = configured.iter().find(|p| {
            p.kind == crate::providers::ProviderKind::OpenAiCompatible
                && p.base_url.trim_end_matches('/') == base_url.trim_end_matches('/')
        });
        let configured = existing.is_some();
        let provider_id = existing.map(|p| p.id.clone());
        async move {
            let backend = RemoteBackend::new(*name, *base_url, None);
            let (models, error) =
                match tokio::time::timeout(LOCAL_PROVIDER_PROBE_TIMEOUT, backend.list_models())
                    .await
                {
                    Ok(Ok(models)) => (models.into_iter().map(|m| m.id).collect(), None),
                    Ok(Err(err)) => (Vec::new(), Some(err.to_string())),
                    Err(_) => (
                        Vec::new(),
                        Some("local provider probe timed out".to_string()),
                    ),
                };
            ProviderDiscovery {
                name,
                kind: crate::providers::ProviderKind::OpenAiCompatible,
                base_url,
                configured,
                provider_id,
                reachable: error.is_none(),
                models,
                error,
            }
        }
    }))
    .await;

    Ok(Json(json!({ "providers": out })).into_response())
}

/// `POST /providers` — create (no id) or update (with id) a provider.
pub(crate) async fn provider_upsert(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<ProviderUpsert>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let reg = st.providers.as_ref().ok_or_else(|| {
        ApiError(Error::InvalidRequest(
            "providers are not enabled".to_string(),
        ))
    })?;
    let cfg = crate::providers::Provider {
        id: req.id.unwrap_or_else(|| gen_id("prov")),
        name: req.name,
        kind: req.kind,
        base_url: req.base_url,
        api_key: req.api_key,
        enabled: req.enabled,
        models: Vec::new(),
        pricing: BTreeMap::new(),
        model_context: BTreeMap::new(),
        model_reasoning: BTreeMap::new(),
        model_capabilities: BTreeMap::new(),
        last_error: None,
    };
    let saved = reg.upsert(cfg).await.map_err(ApiError)?;
    Ok(Json(json!({
        "id": saved.id, "name": saved.name, "kind": saved.kind, "base_url": saved.base_url,
        "enabled": saved.enabled, "has_key": saved.api_key.is_some(), "models": saved.models,
        "pricing": saved.pricing,
        "error": saved.last_error,
    }))
    .into_response())
}

/// `DELETE /providers/{id}` — remove a provider.
pub(crate) async fn provider_delete(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let reg = st.providers.as_ref().ok_or_else(|| {
        ApiError(Error::InvalidRequest(
            "providers are not enabled".to_string(),
        ))
    })?;
    Ok(Json(json!({ "deleted": reg.delete(&id).await.map_err(ApiError)? })).into_response())
}

// ----- Media generation -----

fn default_media_kind() -> String {
    "image".to_string()
}

#[derive(Deserialize)]
pub(crate) struct MediaGenerateRequest {
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    provider_kind: Option<crate::providers::ProviderKind>,
    model: String,
    #[serde(default = "default_media_kind")]
    kind: String,
    prompt: String,
    #[serde(default)]
    input: serde_json::Map<String, Value>,
}

#[derive(Deserialize)]
pub(crate) struct MediaModelsQuery {
    provider_id: String,
    #[serde(default = "default_media_kind")]
    kind: String,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    refresh: bool,
}

#[derive(Deserialize)]
pub(crate) struct MediaModelSchemaQuery {
    provider_id: String,
    model: String,
    #[serde(default)]
    refresh: bool,
}

#[derive(Deserialize)]
pub(crate) struct MediaStatusQuery {
    provider_id: String,
    id: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    response_url: Option<String>,
    #[serde(default)]
    status_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct MediaItem {
    url: String,
    kind: String,
    mime: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct MediaPrivacyInfo {
    mode: &'static str,
    redacted: bool,
    detections: usize,
    kinds: String,
}

#[derive(Debug, Serialize)]
struct MediaModelInfo {
    id: String,
    name: String,
    description: String,
    output_modalities: Vec<String>,
    supported_parameters: Vec<String>,
    default_parameters: Value,
    pricing: Value,
}

#[derive(Debug, Serialize)]
struct MediaControlOption {
    label: String,
    value: Value,
}

#[derive(Debug, Serialize)]
struct MediaSchemaControl {
    key: String,
    label: String,
    kind: String,
    path: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<Vec<MediaControlOption>>,
    #[serde(rename = "default", skip_serializing_if = "Option::is_none")]
    default_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    item_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    placeholder: Option<String>,
}

struct MediaCacheEntry {
    created_at: Instant,
    value: Value,
}

const MEDIA_METADATA_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
static MEDIA_METADATA_CACHE: OnceLock<Mutex<HashMap<String, MediaCacheEntry>>> = OnceLock::new();

fn media_metadata_cache() -> &'static Mutex<HashMap<String, MediaCacheEntry>> {
    MEDIA_METADATA_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_media_cache(key: &str) -> Option<Value> {
    let cache = media_metadata_cache().lock().ok()?;
    let entry = cache.get(key)?;
    if entry.created_at.elapsed() <= MEDIA_METADATA_CACHE_TTL {
        Some(entry.value.clone())
    } else {
        None
    }
}

fn write_media_cache(key: String, value: &Value) {
    if let Ok(mut cache) = media_metadata_cache().lock() {
        cache.insert(
            key,
            MediaCacheEntry {
                created_at: Instant::now(),
                value: value.clone(),
            },
        );
    }
}

fn media_cache_response(mut value: Value, cached: bool) -> Value {
    if let Value::Object(map) = &mut value {
        map.insert("cached".to_string(), Value::Bool(cached));
        map.insert(
            "cache_ttl_seconds".to_string(),
            json!(MEDIA_METADATA_CACHE_TTL.as_secs()),
        );
    }
    value
}

fn media_models_cache_key(
    provider: &crate::providers::Provider,
    kind: &str,
    query: &str,
) -> String {
    format!(
        "models:{}:{:?}:{}:{}",
        provider.id,
        provider.kind,
        provider.base_url.trim_end_matches('/'),
        kind
    ) + ":"
        + query
}

fn media_schema_cache_key(provider: &crate::providers::Provider, model: &str) -> String {
    format!(
        "schema:{}:{}:{}",
        provider.id,
        provider.base_url.trim_end_matches('/'),
        model
    )
}

/// `GET /media/models` - list provider models that can produce the requested
/// media kind.
pub(crate) async fn media_models(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Query(query): Query<MediaModelsQuery>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let provider = select_media_provider(&st, Some(&query.provider_id), None)
        .await
        .map_err(ApiError)?;
    let key = media_provider_key(&provider)?;
    let kind = query.kind.trim();
    if kind != "image" {
        return Err(ApiError(Error::InvalidRequest(
            "only image model metadata is supported".to_string(),
        )));
    }
    let model_query = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(kind);
    let cache_key = media_models_cache_key(&provider, kind, model_query);
    if !query.refresh {
        if let Some(cached) = read_media_cache(&cache_key) {
            return Ok(Json(media_cache_response(cached, true)).into_response());
        }
    }
    let models = match provider.kind {
        crate::providers::ProviderKind::Replicate => {
            let upstream =
                call_replicate_media_models(&provider.base_url, &key, model_query).await?;
            media_models_from_replicate(&upstream, kind)
        }
        crate::providers::ProviderKind::Fal => {
            let upstream =
                call_fal_media_models(&provider.base_url, &key, kind, model_query).await?;
            media_models_from_fal(&upstream, kind)
        }
        crate::providers::ProviderKind::OpenAiCompatible if is_openrouter_provider(&provider) => {
            let upstream = call_openrouter_media_models(&provider.base_url, &key, kind).await?;
            filter_media_models(media_models_from_openrouter(&upstream, kind), model_query)
        }
        _ => {
            return Err(ApiError(Error::InvalidRequest(
                "selected provider does not expose media model metadata".to_string(),
            )))
        }
    };
    let response = json!({ "models": models });
    write_media_cache(cache_key, &response);
    Ok(Json(media_cache_response(response, false)).into_response())
}

/// `GET /media/model-schema` - return normalized UI controls for a selected
/// media model.
pub(crate) async fn media_model_schema(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Query(query): Query<MediaModelSchemaQuery>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let model = query.model.trim();
    if model.is_empty() {
        return Err(ApiError(Error::InvalidRequest(
            "media model is required".to_string(),
        )));
    }
    let provider = select_media_provider(&st, Some(&query.provider_id), None)
        .await
        .map_err(ApiError)?;
    let key = media_provider_key(&provider)?;
    let cache_key = media_schema_cache_key(&provider, model);
    if !query.refresh {
        if let Some(cached) = read_media_cache(&cache_key) {
            return Ok(Json(media_cache_response(cached, true)).into_response());
        }
    }
    let (supported, controls, upstream) = match provider.kind {
        crate::providers::ProviderKind::Replicate => {
            let upstream = call_replicate_model_schema(&provider.base_url, &key, model).await?;
            let (supported, controls) = replicate_schema_controls(&upstream)?;
            (supported, controls, upstream)
        }
        crate::providers::ProviderKind::Fal => {
            let upstream = call_fal_model_schema(&provider.base_url, &key, model).await?;
            let (supported, controls) = fal_schema_controls(&upstream)?;
            (supported, controls, upstream)
        }
        crate::providers::ProviderKind::OpenAiCompatible if is_openrouter_provider(&provider) => {
            let upstream = call_openrouter_model_endpoints(&provider.base_url, &key, model).await?;
            let supported = openrouter_schema_supported_parameters(&upstream);
            let controls = media_schema_controls(&supported);
            (supported, controls, upstream)
        }
        _ => {
            return Err(ApiError(Error::InvalidRequest(
                "selected provider does not expose media model metadata".to_string(),
            )))
        }
    };

    let response = json!({
        "model": model,
        "provider_id": provider.id,
        "provider": provider.name,
        "supported_parameters": supported,
        "controls": controls,
        "raw": upstream,
    });
    write_media_cache(cache_key, &response);
    Ok(Json(media_cache_response(response, false)).into_response())
}

/// `GET /media/status` - fetch the latest status for an asynchronous media run.
pub(crate) async fn media_status(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Query(query): Query<MediaStatusQuery>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let id = query.id.trim();
    if id.is_empty() {
        return Err(ApiError(Error::InvalidRequest(
            "media generation id is required".to_string(),
        )));
    }
    let provider = select_media_provider(&st, Some(&query.provider_id), None)
        .await
        .map_err(ApiError)?;
    let key = media_provider_key(&provider)?;
    let upstream = match provider.kind {
        crate::providers::ProviderKind::Replicate => {
            call_replicate_media_status(&provider.base_url, &key, id).await?
        }
        crate::providers::ProviderKind::Fal => {
            call_fal_media_status(
                &provider.base_url,
                &key,
                id,
                query.model.as_deref(),
                query.response_url.as_deref(),
                query.status_url.as_deref(),
            )
            .await?
        }
        _ => {
            return Err(ApiError(Error::InvalidRequest(
                "selected provider does not expose media run status".to_string(),
            )))
        }
    };
    let media = media_items_from_result(&upstream);
    let urls = media_urls_from_result(&provider.kind, &upstream);
    let status = upstream
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("submitted")
        .to_string();
    Ok(Json(json!({
        "id": id,
        "object": "media.status",
        "kind": "image",
        "provider_id": provider.id,
        "provider": provider.name,
        "provider_kind": provider.kind,
        "model": query.model.unwrap_or_default(),
        "status": status,
        "output": upstream.get("output").cloned().unwrap_or(Value::Null),
        "media": media,
        "urls": urls,
        "raw": upstream,
    }))
    .into_response())
}

/// `POST /media/generate` - submit a prompt to an enabled remote media
/// provider. The endpoint is intentionally provider-neutral at the UI boundary:
/// callers pass a model id, a prompt, and optional model-specific input fields.
pub(crate) async fn media_generate(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<MediaGenerateRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let model = req.model.trim();
    if model.is_empty() {
        return Err(ApiError(Error::InvalidRequest(
            "media model is required".to_string(),
        )));
    }
    let prompt = req.prompt.trim();
    if prompt.is_empty() {
        return Err(ApiError(Error::InvalidRequest(
            "media prompt is required".to_string(),
        )));
    }

    let provider = select_media_provider(&st, req.provider_id.as_deref(), req.provider_kind)
        .await
        .map_err(ApiError)?;
    let key = provider
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .ok_or_else(|| {
            ApiError(Error::InvalidRequest(format!(
                "{} requires an API key",
                provider.name
            )))
        })?
        .to_string();
    let (prompt, privacy) = media_prompt_for_remote(&st, prompt).map_err(ApiError)?;

    let mut input = req.input;
    input.insert("prompt".to_string(), Value::String(prompt));

    let upstream = match provider.kind {
        crate::providers::ProviderKind::Replicate => {
            call_replicate_media(&provider.base_url, &key, model, input).await?
        }
        crate::providers::ProviderKind::Fal => {
            call_fal_media(&provider.base_url, &key, model, input).await?
        }
        crate::providers::ProviderKind::OpenAiCompatible if is_openrouter_provider(&provider) => {
            call_openrouter_image_media(&provider.base_url, &key, model, input).await?
        }
        _ => {
            return Err(ApiError(Error::InvalidRequest(
                "selected provider is not a media provider".to_string(),
            )))
        }
    };
    let media = media_items_from_result(&upstream);
    let urls = media_urls_from_result(&provider.kind, &upstream);
    let id = upstream
        .get("id")
        .or_else(|| upstream.get("request_id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let status = upstream
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(if is_openrouter_provider(&provider) {
            "completed"
        } else {
            "submitted"
        })
        .to_string();

    Ok(Json(json!({
        "id": id,
        "object": "media.generation",
        "provider_id": provider.id,
        "provider": provider.name,
        "provider_kind": provider.kind,
        "kind": req.kind,
        "model": model,
        "status": status,
        "output": upstream.get("output").cloned().unwrap_or(Value::Null),
        "media": media,
        "urls": urls,
        "privacy": privacy,
        "raw": upstream,
    }))
    .into_response())
}

async fn select_media_provider(
    st: &AppState,
    provider_id: Option<&str>,
    provider_kind: Option<crate::providers::ProviderKind>,
) -> milim_core::Result<crate::providers::Provider> {
    let reg = st
        .providers
        .as_ref()
        .ok_or_else(|| Error::InvalidRequest("providers are not enabled".to_string()))?;
    let providers = reg.list().await;
    let selected = providers.into_iter().find(|provider| {
        if !provider.enabled {
            return false;
        }
        if provider.kind.is_chat() && !is_openrouter_provider(provider) {
            return false;
        }
        if let Some(id) = provider_id {
            return provider.id == id;
        }
        if let Some(kind) = provider_kind {
            return provider.kind == kind;
        }
        true
    });
    selected.ok_or_else(|| {
        Error::InvalidRequest(
            "no enabled Replicate, fal, or OpenRouter media provider matched the request"
                .to_string(),
        )
    })
}

fn is_openrouter_provider(provider: &crate::providers::Provider) -> bool {
    if provider.kind != crate::providers::ProviderKind::OpenAiCompatible {
        return false;
    }
    provider.name.eq_ignore_ascii_case("openrouter")
        || provider
            .base_url
            .to_ascii_lowercase()
            .contains("openrouter.ai/")
}

fn media_provider_key(provider: &crate::providers::Provider) -> Result<String, ApiError> {
    provider
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            ApiError(Error::InvalidRequest(format!(
                "{} requires an API key",
                provider.name
            )))
        })
}

fn media_prompt_for_remote(
    st: &AppState,
    prompt: &str,
) -> milim_core::Result<(String, MediaPrivacyInfo)> {
    match st.privacy.mode() {
        PrivacyMode::Off => Ok((
            prompt.to_string(),
            MediaPrivacyInfo {
                mode: "off",
                redacted: false,
                detections: 0,
                kinds: String::new(),
            },
        )),
        PrivacyMode::Block => {
            let detections = st.privacy.scan_text(prompt);
            if detections.is_empty() {
                Ok((
                    prompt.to_string(),
                    MediaPrivacyInfo {
                        mode: "block",
                        redacted: false,
                        detections: 0,
                        kinds: String::new(),
                    },
                ))
            } else {
                Err(Error::InvalidRequest(format!(
                    "blocked by the privacy gate: media prompt contains {} ({} item(s)). Switch the gate to Redact or Off to send this to a remote media provider.",
                    kinds_summary(&detections),
                    detections.len()
                )))
            }
        }
        PrivacyMode::Redact => {
            let detections = st.privacy.scan_text(prompt);
            let redaction = st.privacy.redact_text(prompt);
            Ok((
                redaction.text,
                MediaPrivacyInfo {
                    mode: "redact",
                    redacted: !redaction.map.is_empty(),
                    detections: detections.len(),
                    kinds: kinds_summary(&detections),
                },
            ))
        }
    }
}

async fn call_replicate_media(
    base_url: &str,
    api_key: &str,
    model: &str,
    input: serde_json::Map<String, Value>,
) -> Result<Value, ApiError> {
    let url = format!("{}/predictions", base_url.trim_end_matches('/'));
    let mut body = serde_json::Map::new();
    if is_replicate_version_id(model) {
        body.insert("version".to_string(), Value::String(model.to_string()));
    } else {
        body.insert("model".to_string(), Value::String(model.to_string()));
    }
    body.insert("input".to_string(), Value::Object(input));
    post_media_json(
        reqwest::Client::new()
            .post(url)
            .bearer_auth(api_key)
            .header("Prefer", "wait")
            .json(&Value::Object(body)),
    )
    .await
}

async fn call_replicate_media_status(
    base_url: &str,
    api_key: &str,
    id: &str,
) -> Result<Value, ApiError> {
    let url = format!(
        "{}/predictions/{}",
        base_url.trim_end_matches('/'),
        id.trim_start_matches('/')
    );
    get_media_json(reqwest::Client::new().get(url).bearer_auth(api_key)).await
}

async fn call_fal_media(
    base_url: &str,
    api_key: &str,
    model: &str,
    input: serde_json::Map<String, Value>,
) -> Result<Value, ApiError> {
    let url = format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        model.trim_start_matches('/')
    );
    post_media_json(
        reqwest::Client::new()
            .post(url)
            .header("Authorization", format!("Key {api_key}"))
            .json(&Value::Object(input)),
    )
    .await
}

async fn call_fal_media_status(
    base_url: &str,
    api_key: &str,
    id: &str,
    model: Option<&str>,
    response_url: Option<&str>,
    status_url: Option<&str>,
) -> Result<Value, ApiError> {
    let url = response_url
        .or(status_url)
        .map(|url| validate_media_status_url(base_url, url))
        .transpose()?
        .unwrap_or_else(|| {
            let model = model.unwrap_or_default().trim_matches('/');
            format!(
                "{}/{}/requests/{}",
                base_url.trim_end_matches('/'),
                model,
                id.trim_start_matches('/')
            )
        });
    get_media_json(
        reqwest::Client::new()
            .get(url)
            .header("Authorization", format!("Key {api_key}")),
    )
    .await
}

async fn call_openrouter_image_media(
    base_url: &str,
    api_key: &str,
    model: &str,
    mut input: serde_json::Map<String, Value>,
) -> Result<Value, ApiError> {
    let prompt = input
        .remove("prompt")
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    // The media endpoint returns image artifacts; accepting a saved/custom
    // text co-output here breaks image-only OpenRouter endpoints such as Flux.
    let _ = input.remove("modalities");
    let modalities = json!(["image"]);
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let mut body = input;
    body.insert("model".to_string(), Value::String(model.to_string()));
    body.insert(
        "messages".to_string(),
        json!([{ "role": "user", "content": prompt }]),
    );
    body.insert("modalities".to_string(), modalities);
    body.insert("stream".to_string(), Value::Bool(false));

    post_media_json(
        reqwest::Client::new()
            .post(url)
            .bearer_auth(api_key)
            .json(&Value::Object(body)),
    )
    .await
}

async fn call_openrouter_media_models(
    base_url: &str,
    api_key: &str,
    kind: &str,
) -> Result<Value, ApiError> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    get_media_json(
        reqwest::Client::new()
            .get(url)
            .bearer_auth(api_key)
            .query(&[("output_modalities", kind)]),
    )
    .await
}

async fn call_openrouter_model_endpoints(
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<Value, ApiError> {
    let (author, slug) = model.split_once('/').ok_or_else(|| {
        ApiError(Error::InvalidRequest(
            "OpenRouter media model id must be in author/slug form".to_string(),
        ))
    })?;
    if author.is_empty() || slug.is_empty() || slug.contains('/') {
        return Err(ApiError(Error::InvalidRequest(
            "OpenRouter media model id must be in author/slug form".to_string(),
        )));
    }
    let url = format!(
        "{}/models/{author}/{slug}/endpoints",
        base_url.trim_end_matches('/')
    );
    get_media_json(reqwest::Client::new().get(url).bearer_auth(api_key)).await
}

async fn call_replicate_media_models(
    base_url: &str,
    api_key: &str,
    kind: &str,
) -> Result<Value, ApiError> {
    let url = format!("{}/search", base_url.trim_end_matches('/'));
    get_media_json(
        reqwest::Client::new()
            .get(url)
            .bearer_auth(api_key)
            .query(&[("query", kind), ("limit", "50")]),
    )
    .await
}

async fn call_replicate_model_schema(
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<Value, ApiError> {
    let (owner, name) = model.split_once('/').ok_or_else(|| {
        ApiError(Error::InvalidRequest(
            "Replicate media model id must be in owner/name form".to_string(),
        ))
    })?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return Err(ApiError(Error::InvalidRequest(
            "Replicate media model id must be in owner/name form".to_string(),
        )));
    }
    let url = format!("{}/models/{owner}/{name}", base_url.trim_end_matches('/'));
    get_media_json(reqwest::Client::new().get(url).bearer_auth(api_key)).await
}

async fn call_fal_media_models(
    base_url: &str,
    api_key: &str,
    kind: &str,
    query: &str,
) -> Result<Value, ApiError> {
    let category = match kind {
        "image" => "text-to-image",
        _ => kind,
    };
    let url = format!("{}/models", fal_platform_base_url(base_url));
    let mut params = vec![
        ("limit", "50"),
        ("category", category),
        ("status", "active"),
    ];
    if query != kind && !query.trim().is_empty() {
        params.push(("q", query));
    }
    get_media_json(
        reqwest::Client::new()
            .get(url)
            .header("Authorization", format!("Key {api_key}"))
            .query(&params),
    )
    .await
}

async fn call_fal_model_schema(
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<Value, ApiError> {
    let url = format!("{}/models", fal_platform_base_url(base_url));
    get_media_json(
        reqwest::Client::new()
            .get(url)
            .header("Authorization", format!("Key {api_key}"))
            .query(&[("endpoint_id", model), ("expand", "openapi-3.0")]),
    )
    .await
}

fn fal_platform_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("127.0.0.1")
        || lower.contains("localhost")
        || lower.contains("[::1]")
        || lower.contains("api.fal.ai/")
    {
        trimmed.to_string()
    } else {
        "https://api.fal.ai/v1".to_string()
    }
}

fn validate_media_status_url(base_url: &str, url: &str) -> Result<String, ApiError> {
    let parsed = reqwest::Url::parse(url).map_err(|_| {
        ApiError(Error::InvalidRequest(
            "media status URL is not a valid URL".to_string(),
        ))
    })?;
    let allowed = reqwest::Url::parse(base_url)
        .ok()
        .map(|base| parsed.scheme() == base.scheme() && parsed.host_str() == base.host_str())
        .unwrap_or(false)
        || matches!(
            parsed.host_str(),
            Some("queue.fal.run") | Some("fal.run") | Some("api.replicate.com")
        );
    if !allowed {
        return Err(ApiError(Error::InvalidRequest(
            "media status URL must match the selected provider".to_string(),
        )));
    }
    Ok(url.to_string())
}

async fn get_media_json(builder: reqwest::RequestBuilder) -> Result<Value, ApiError> {
    let response = builder.send().await.map_err(|e| {
        ApiError(Error::Upstream(format!(
            "media provider request failed: {e}"
        )))
    })?;
    let status = response.status();
    let body = response.text().await.map_err(|e| {
        ApiError(Error::Upstream(format!(
            "media provider response failed: {e}"
        )))
    })?;
    if !status.is_success() {
        return Err(ApiError(Error::Upstream(format!(
            "media provider returned HTTP {status}: {body}"
        ))));
    }
    serde_json::from_str(&body).map_err(|e| {
        ApiError(Error::Upstream(format!(
            "media provider returned invalid JSON: {e}"
        )))
    })
}

fn media_models_from_openrouter(value: &Value, kind: &str) -> Vec<MediaModelInfo> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let output_modalities = openrouter_output_modalities(model);
            if !output_modalities.iter().any(|item| item == kind) {
                return None;
            }
            let id = model.get("id").and_then(Value::as_str)?.to_string();
            Some(MediaModelInfo {
                name: model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                description: model
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                output_modalities,
                supported_parameters: string_array(model.get("supported_parameters")),
                default_parameters: model
                    .get("default_parameters")
                    .cloned()
                    .unwrap_or(Value::Null),
                pricing: model.get("pricing").cloned().unwrap_or(Value::Null),
                id,
            })
        })
        .collect()
}

fn media_models_from_replicate(value: &Value, kind: &str) -> Vec<MediaModelInfo> {
    value
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let model = item.get("model").unwrap_or(item);
            let openapi = replicate_model_openapi_schema(model);
            let output_modalities = openapi
                .map(openapi_output_modalities)
                .filter(|modalities| modalities.iter().any(|item| item == kind))?;
            let id = replicate_model_id(model)?;
            let controls = openapi
                .and_then(|openapi| {
                    openapi_input_schema(openapi)
                        .map(|schema| json_schema_controls(schema, openapi))
                })
                .unwrap_or_default();
            let description = item
                .get("metadata")
                .and_then(|metadata| metadata.get("generated_description"))
                .and_then(Value::as_str)
                .or_else(|| model.get("description").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string();
            Some(MediaModelInfo {
                name: model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                description,
                output_modalities,
                supported_parameters: supported_parameters_from_controls(&controls),
                default_parameters: defaults_from_controls(&controls),
                pricing: Value::Null,
                id,
            })
        })
        .collect()
}

fn media_models_from_fal(value: &Value, kind: &str) -> Vec<MediaModelInfo> {
    value
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let metadata = model.get("metadata").unwrap_or(&Value::Null);
            let output_modalities = fal_output_modalities(metadata);
            if !output_modalities.iter().any(|item| item == kind) {
                return None;
            }
            let id = model
                .get("endpoint_id")
                .and_then(Value::as_str)?
                .to_string();
            let controls = model
                .get("openapi")
                .and_then(|openapi| {
                    openapi_input_schema(openapi)
                        .map(|schema| json_schema_controls(schema, openapi))
                })
                .unwrap_or_default();
            Some(MediaModelInfo {
                name: metadata
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                description: metadata
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                output_modalities,
                supported_parameters: supported_parameters_from_controls(&controls),
                default_parameters: defaults_from_controls(&controls),
                pricing: Value::Null,
                id,
            })
        })
        .collect()
}

fn filter_media_models(models: Vec<MediaModelInfo>, query: &str) -> Vec<MediaModelInfo> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() || needle == "image" {
        return models;
    }
    models
        .into_iter()
        .filter(|model| {
            model.id.to_ascii_lowercase().contains(&needle)
                || model.name.to_ascii_lowercase().contains(&needle)
                || model.description.to_ascii_lowercase().contains(&needle)
        })
        .collect()
}

fn replicate_schema_controls(
    value: &Value,
) -> Result<(Vec<String>, Vec<MediaSchemaControl>), ApiError> {
    let openapi = replicate_model_openapi_schema(value).ok_or_else(|| {
        ApiError(Error::Upstream(
            "Replicate model response did not include an OpenAPI schema".to_string(),
        ))
    })?;
    let input_schema = openapi_input_schema(openapi).ok_or_else(|| {
        ApiError(Error::Upstream(
            "Replicate model schema did not include an Input schema".to_string(),
        ))
    })?;
    let controls = json_schema_controls(input_schema, openapi);
    Ok((supported_parameters_from_controls(&controls), controls))
}

fn fal_schema_controls(value: &Value) -> Result<(Vec<String>, Vec<MediaSchemaControl>), ApiError> {
    let openapi = value
        .get("models")
        .and_then(Value::as_array)
        .and_then(|models| models.first())
        .and_then(|model| model.get("openapi"))
        .or_else(|| value.get("openapi"))
        .ok_or_else(|| {
            ApiError(Error::Upstream(
                "fal model response did not include an OpenAPI schema".to_string(),
            ))
        })?;
    let input_schema = openapi_input_schema(openapi).ok_or_else(|| {
        ApiError(Error::Upstream(
            "fal model schema did not include an input schema".to_string(),
        ))
    })?;
    let controls = json_schema_controls(input_schema, openapi);
    Ok((supported_parameters_from_controls(&controls), controls))
}

fn replicate_model_id(model: &Value) -> Option<String> {
    let owner = model.get("owner").and_then(Value::as_str)?;
    let name = model.get("name").and_then(Value::as_str)?;
    Some(format!("{owner}/{name}"))
}

fn replicate_model_openapi_schema(model: &Value) -> Option<&Value> {
    model
        .get("latest_version")
        .and_then(|version| version.get("openapi_schema"))
}

fn fal_output_modalities(metadata: &Value) -> Vec<String> {
    let category = metadata
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if category == "text-to-image" || category.ends_with("to-image") || category == "image" {
        vec!["image".to_string()]
    } else {
        Vec::new()
    }
}

fn openapi_output_modalities(openapi: &Value) -> Vec<String> {
    openapi_schema_by_name(openapi, "Output")
        .filter(|schema| schema_outputs_image(schema, openapi, 0))
        .map(|_| vec!["image".to_string()])
        .unwrap_or_default()
}

fn openapi_input_schema(openapi: &Value) -> Option<&Value> {
    if let Some(schema) = openapi_schema_by_name(openapi, "Input") {
        return Some(schema);
    }
    if let Some(paths) = openapi.get("paths").and_then(Value::as_object) {
        for operation in paths.values().filter_map(|path| path.get("post")) {
            if let Some(schema) = operation
                .get("requestBody")
                .and_then(|body| body.get("content"))
                .and_then(|content| content.get("application/json"))
                .and_then(|content| content.get("schema"))
                .and_then(|schema| resolve_schema_ref(openapi, schema))
            {
                return Some(schema);
            }
        }
    }
    openapi
        .get("components")
        .and_then(|components| components.get("schemas"))
        .and_then(Value::as_object)
        .and_then(|schemas| {
            schemas
                .iter()
                .find(|(name, schema)| {
                    name.to_ascii_lowercase().ends_with("input")
                        && schema
                            .get("properties")
                            .and_then(Value::as_object)
                            .is_some()
                })
                .map(|(_, schema)| schema)
        })
}

fn openapi_schema_by_name<'a>(openapi: &'a Value, suffix: &str) -> Option<&'a Value> {
    let suffix = suffix.to_ascii_lowercase();
    openapi
        .get("components")
        .and_then(|components| components.get("schemas"))
        .and_then(Value::as_object)
        .and_then(|schemas| {
            schemas
                .iter()
                .find(|(name, _)| name.to_ascii_lowercase() == suffix)
                .or_else(|| {
                    schemas
                        .iter()
                        .find(|(name, _)| name.to_ascii_lowercase().ends_with(&suffix))
                })
                .map(|(_, schema)| schema)
        })
}

fn resolve_schema_ref<'a>(root: &'a Value, schema: &'a Value) -> Option<&'a Value> {
    let reference = schema.get("$ref").and_then(Value::as_str)?;
    let path = reference.strip_prefix("#/")?;
    let mut cursor = root;
    for segment in path.split('/') {
        let segment = segment.replace("~1", "/").replace("~0", "~");
        cursor = cursor.get(&segment)?;
    }
    Some(cursor)
}

fn json_schema_controls(input_schema: &Value, root: &Value) -> Vec<MediaSchemaControl> {
    let Some(properties) = input_schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut keys = input_schema
        .get("x-fal-order-properties")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| properties.keys().cloned().collect());
    for key in properties.keys() {
        if !keys.iter().any(|existing| existing == key) {
            keys.push(key.clone());
        }
    }
    keys.into_iter()
        .filter(|key| key != "prompt")
        .filter_map(|key| {
            properties
                .get(&key)
                .and_then(|schema| control_from_json_schema_property(&key, schema, root))
        })
        .collect()
}

fn control_from_json_schema_property(
    key: &str,
    schema: &Value,
    root: &Value,
) -> Option<MediaSchemaControl> {
    let label = schema
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| label_from_key(key));
    let description = schema_description(schema, root, 0);
    let default_value = schema.get("default").cloned();
    if let Some(options) = schema_enum_options(schema, root, 0) {
        return Some(select_control_values(
            key,
            &label,
            vec![key.to_string()],
            options,
            default_value,
            description,
        ));
    }
    let schema_type = schema_type(schema, root, 0)?;
    match schema_type.as_str() {
        "boolean" => Some(MediaSchemaControl {
            key: key.to_string(),
            label,
            kind: "checkbox".to_string(),
            path: vec![key.to_string()],
            description,
            options: None,
            default_value,
            min: None,
            max: None,
            step: None,
            item_kind: None,
            placeholder: None,
        }),
        "integer" | "number" => Some(MediaSchemaControl {
            key: key.to_string(),
            label,
            kind: "number".to_string(),
            path: vec![key.to_string()],
            description,
            options: None,
            default_value,
            min: schema_number(schema, root, "minimum", 0),
            max: schema_number(schema, root, "maximum", 0),
            step: if schema_type == "integer" {
                Some(1.0)
            } else {
                None
            },
            item_kind: None,
            placeholder: None,
        }),
        "array" => Some(MediaSchemaControl {
            key: key.to_string(),
            label,
            kind: "array".to_string(),
            path: vec![key.to_string()],
            description,
            options: None,
            default_value,
            min: schema_number(schema, root, "minItems", 0),
            max: schema_number(schema, root, "maxItems", 0),
            step: None,
            item_kind: schema_array_item_kind(schema, root, 0).map(str::to_string),
            placeholder: Some("one value per line".to_string()),
        }),
        "object" => Some(MediaSchemaControl {
            key: key.to_string(),
            label,
            kind: "json".to_string(),
            path: vec![key.to_string()],
            description,
            options: None,
            default_value,
            min: None,
            max: None,
            step: None,
            item_kind: None,
            placeholder: Some("{ }".to_string()),
        }),
        "string" => Some(MediaSchemaControl {
            key: key.to_string(),
            label,
            kind: if schema_is_url(schema, root, key, 0) {
                "url".to_string()
            } else {
                "text".to_string()
            },
            path: vec![key.to_string()],
            description,
            options: None,
            default_value,
            min: None,
            max: None,
            step: None,
            item_kind: None,
            placeholder: None,
        }),
        _ => None,
    }
}

fn schema_enum_options(
    schema: &Value,
    root: &Value,
    depth: usize,
) -> Option<Vec<MediaControlOption>> {
    if depth > 8 {
        return None;
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        let options = values
            .iter()
            .filter(|value| !value.is_null())
            .map(|value| MediaControlOption {
                label: media_option_label(value),
                value: value.clone(),
            })
            .collect::<Vec<_>>();
        if !options.is_empty() {
            return Some(options);
        }
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(items) = schema.get(key).and_then(Value::as_array) {
            for item in items {
                if let Some(options) = schema_enum_options(item, root, depth + 1) {
                    return Some(options);
                }
                if let Some(resolved) = resolve_schema_ref(root, item) {
                    if let Some(options) = schema_enum_options(resolved, root, depth + 1) {
                        return Some(options);
                    }
                }
            }
        }
    }
    resolve_schema_ref(root, schema)
        .and_then(|resolved| schema_enum_options(resolved, root, depth + 1))
}

fn schema_type(schema: &Value, root: &Value, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    match schema.get("type") {
        Some(Value::String(kind)) if kind != "null" => return Some(kind.to_string()),
        Some(Value::Array(kinds)) => {
            if let Some(kind) = kinds
                .iter()
                .filter_map(Value::as_str)
                .find(|kind| *kind != "null")
            {
                return Some(kind.to_string());
            }
        }
        _ => {}
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(items) = schema.get(key).and_then(Value::as_array) {
            for item in items {
                if let Some(kind) = schema_type(item, root, depth + 1) {
                    return Some(kind);
                }
                if let Some(resolved) = resolve_schema_ref(root, item) {
                    if let Some(kind) = schema_type(resolved, root, depth + 1) {
                        return Some(kind);
                    }
                }
            }
        }
    }
    resolve_schema_ref(root, schema).and_then(|resolved| schema_type(resolved, root, depth + 1))
}

fn schema_number(schema: &Value, root: &Value, key: &str, depth: usize) -> Option<f64> {
    if depth > 8 {
        return None;
    }
    if let Some(value) = schema.get(key).and_then(Value::as_f64) {
        return Some(value);
    }
    for group in ["anyOf", "oneOf", "allOf"] {
        if let Some(items) = schema.get(group).and_then(Value::as_array) {
            for item in items {
                if let Some(value) = schema_number(item, root, key, depth + 1) {
                    return Some(value);
                }
                if let Some(resolved) = resolve_schema_ref(root, item) {
                    if let Some(value) = schema_number(resolved, root, key, depth + 1) {
                        return Some(value);
                    }
                }
            }
        }
    }
    resolve_schema_ref(root, schema)
        .and_then(|resolved| schema_number(resolved, root, key, depth + 1))
}

fn schema_description(schema: &Value, root: &Value, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    if let Some(description) = schema.get("description").and_then(Value::as_str) {
        return Some(description.trim().to_string());
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(items) = schema.get(key).and_then(Value::as_array) {
            for item in items {
                if let Some(description) = schema_description(item, root, depth + 1) {
                    return Some(description);
                }
                if let Some(resolved) = resolve_schema_ref(root, item) {
                    if let Some(description) = schema_description(resolved, root, depth + 1) {
                        return Some(description);
                    }
                }
            }
        }
    }
    resolve_schema_ref(root, schema)
        .and_then(|resolved| schema_description(resolved, root, depth + 1))
}

fn schema_is_url(schema: &Value, root: &Value, key: &str, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    if schema.get("format").and_then(Value::as_str) == Some("uri") {
        return true;
    }
    let lower = key.to_ascii_lowercase();
    if lower.ends_with("_url") || lower.ends_with(" url") || lower.contains("image_url") {
        return true;
    }
    for group in ["anyOf", "oneOf", "allOf"] {
        if let Some(items) = schema.get(group).and_then(Value::as_array) {
            if items
                .iter()
                .any(|item| schema_is_url(item, root, key, depth + 1))
            {
                return true;
            }
        }
    }
    resolve_schema_ref(root, schema)
        .map(|resolved| schema_is_url(resolved, root, key, depth + 1))
        .unwrap_or(false)
}

fn schema_array_item_kind(schema: &Value, root: &Value, depth: usize) -> Option<&'static str> {
    if depth > 8 {
        return None;
    }
    let items = schema.get("items")?;
    let resolved = resolve_schema_ref(root, items).unwrap_or(items);
    if schema_is_url(resolved, root, "", depth + 1) {
        return Some("url");
    }
    match schema_type(resolved, root, depth + 1).as_deref() {
        Some("integer") | Some("number") => Some("number"),
        Some("boolean") => Some("checkbox"),
        Some("object") | Some("array") => Some("json"),
        Some("string") => Some("text"),
        _ => None,
    }
}

fn schema_outputs_image(schema: &Value, root: &Value, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    if schema
        .get("title")
        .and_then(Value::as_str)
        .map(|title| title.to_ascii_lowercase().contains("image"))
        .unwrap_or(false)
    {
        return true;
    }
    if schema.get("format").and_then(Value::as_str) == Some("uri") {
        return true;
    }
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        for (key, value) in properties {
            if key.to_ascii_lowercase().contains("image")
                || schema_outputs_image(value, root, depth + 1)
            {
                return true;
            }
        }
    }
    if let Some(items) = schema.get("items") {
        if schema_outputs_image(items, root, depth + 1) {
            return true;
        }
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(items) = schema.get(key).and_then(Value::as_array) {
            if items
                .iter()
                .any(|item| schema_outputs_image(item, root, depth + 1))
            {
                return true;
            }
        }
    }
    resolve_schema_ref(root, schema)
        .map(|resolved| schema_outputs_image(resolved, root, depth + 1))
        .unwrap_or(false)
}

fn supported_parameters_from_controls(controls: &[MediaSchemaControl]) -> Vec<String> {
    controls.iter().map(|control| control.key.clone()).collect()
}

fn defaults_from_controls(controls: &[MediaSchemaControl]) -> Value {
    let mut out = serde_json::Map::new();
    for control in controls {
        if let Some(value) = &control.default_value {
            out.insert(control.key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

fn media_option_label(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn label_from_key(key: &str) -> String {
    key.split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn openrouter_output_modalities(model: &Value) -> Vec<String> {
    string_array(
        model
            .get("architecture")
            .and_then(|architecture| architecture.get("output_modalities")),
    )
}

fn openrouter_schema_supported_parameters(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(endpoints) = value.get("endpoints").and_then(Value::as_array) {
        for endpoint in endpoints {
            push_unique_strings(&mut out, endpoint.get("supported_parameters"));
        }
    }
    push_unique_strings(&mut out, value.get("supported_parameters"));
    out
}

fn push_unique_strings(out: &mut Vec<String>, value: Option<&Value>) {
    for item in string_array(value) {
        if !out.iter().any(|existing| existing == &item) {
            out.push(item);
        }
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn media_schema_controls(supported: &[String]) -> Vec<MediaSchemaControl> {
    let has = |key: &str| supported.iter().any(|item| item == key);
    let mut controls = vec![select_control(
        "aspect_ratio",
        "Aspect ratio",
        ["image_config", "aspect_ratio"],
        ["1:1", "16:9", "9:16", "4:3", "3:4"],
        Some("1:1"),
    )];

    controls.push(select_control(
        "quality",
        "Quality",
        ["image_config", "quality"],
        ["auto", "low", "medium", "high"],
        Some("auto"),
    ));

    if has("seed") {
        controls.push(number_control(
            "seed",
            "Seed",
            ["seed"],
            None,
            Some(0.0),
            None,
            Some(1.0),
        ));
    }
    if has("temperature") {
        controls.push(number_control(
            "temperature",
            "Temperature",
            ["temperature"],
            Some(json!(0.7)),
            Some(0.0),
            Some(2.0),
            Some(0.1),
        ));
    }
    if has("top_p") {
        controls.push(number_control(
            "top_p",
            "Top P",
            ["top_p"],
            Some(json!(0.9)),
            Some(0.0),
            Some(1.0),
            Some(0.05),
        ));
    }
    controls
}

fn select_control<const N: usize, const M: usize>(
    key: &str,
    label: &str,
    path: [&str; N],
    options: [&str; M],
    default_value: Option<&str>,
) -> MediaSchemaControl {
    MediaSchemaControl {
        key: key.to_string(),
        label: label.to_string(),
        kind: "select".to_string(),
        path: path.into_iter().map(str::to_string).collect(),
        description: None,
        options: Some(
            options
                .into_iter()
                .map(|value| MediaControlOption {
                    label: value.to_string(),
                    value: Value::String(value.to_string()),
                })
                .collect(),
        ),
        default_value: default_value.map(|value| Value::String(value.to_string())),
        min: None,
        max: None,
        step: None,
        item_kind: None,
        placeholder: None,
    }
}

fn select_control_values(
    key: &str,
    label: &str,
    path: Vec<String>,
    options: Vec<MediaControlOption>,
    default_value: Option<Value>,
    description: Option<String>,
) -> MediaSchemaControl {
    MediaSchemaControl {
        key: key.to_string(),
        label: label.to_string(),
        kind: "select".to_string(),
        path,
        description,
        options: Some(options),
        default_value,
        min: None,
        max: None,
        step: None,
        item_kind: None,
        placeholder: None,
    }
}

fn number_control<const N: usize>(
    key: &str,
    label: &str,
    path: [&str; N],
    default_value: Option<Value>,
    min: Option<f64>,
    max: Option<f64>,
    step: Option<f64>,
) -> MediaSchemaControl {
    MediaSchemaControl {
        key: key.to_string(),
        label: label.to_string(),
        kind: "number".to_string(),
        path: path.into_iter().map(str::to_string).collect(),
        description: None,
        options: None,
        default_value,
        min,
        max,
        step,
        item_kind: None,
        placeholder: None,
    }
}

async fn post_media_json(builder: reqwest::RequestBuilder) -> Result<Value, ApiError> {
    let response = builder.send().await.map_err(|e| {
        ApiError(Error::Upstream(format!(
            "media provider request failed: {e}"
        )))
    })?;
    let status = response.status();
    let body = response.text().await.map_err(|e| {
        ApiError(Error::Upstream(format!(
            "media provider response failed: {e}"
        )))
    })?;
    if !status.is_success() {
        return Err(ApiError(Error::Upstream(format!(
            "media provider returned HTTP {status}: {body}"
        ))));
    }
    serde_json::from_str(&body).map_err(|e| {
        ApiError(Error::Upstream(format!(
            "media provider returned invalid JSON: {e}"
        )))
    })
}

fn is_replicate_version_id(model: &str) -> bool {
    model.len() == 64 && model.bytes().all(|b| b.is_ascii_hexdigit())
}

fn media_urls_from_result(kind: &crate::providers::ProviderKind, value: &Value) -> Value {
    let mut urls = serde_json::Map::new();
    if let Some(source) = value.get("urls").and_then(Value::as_object) {
        for (key, value) in source {
            urls.insert(key.clone(), value.clone());
        }
    }
    if matches!(kind, crate::providers::ProviderKind::Fal) {
        for (source, target) in [
            ("response_url", "response"),
            ("status_url", "status"),
            ("cancel_url", "cancel"),
        ] {
            if let Some(url) = value.get(source).and_then(Value::as_str) {
                urls.insert(target.to_string(), Value::String(url.to_string()));
            }
        }
    }
    Value::Object(urls)
}

fn media_items_from_result(value: &Value) -> Vec<MediaItem> {
    let mut urls = Vec::new();
    if let Some(output) = value.get("output") {
        collect_media_urls(output, &mut urls);
    }
    if let Some(images) = value.get("images") {
        collect_media_urls(images, &mut urls);
    }
    if let Some(video) = value.get("video") {
        collect_media_urls(video, &mut urls);
    }
    if let Some(choices) = value.get("choices") {
        collect_media_urls(choices, &mut urls);
    }
    urls.sort();
    urls.dedup();
    urls.into_iter()
        .map(|url| MediaItem {
            kind: media_kind_from_url(&url).to_string(),
            mime: media_mime_from_url(&url).map(str::to_string),
            url,
        })
        .collect()
}

fn collect_media_urls(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            if text.starts_with("http://")
                || text.starts_with("https://")
                || text.starts_with("data:image/")
                || text.starts_with("data:video/")
            {
                out.push(text.to_string());
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_media_urls(value, out);
            }
        }
        Value::Object(map) => {
            if let Some(url) = map.get("url").and_then(Value::as_str) {
                out.push(url.to_string());
            }
            for value in map.values() {
                collect_media_urls(value, out);
            }
        }
        _ => {}
    }
}

fn media_kind_from_url(url: &str) -> &'static str {
    let lower = url.to_ascii_lowercase();
    if lower.contains(".mp4") || lower.contains(".webm") || lower.contains(".mov") {
        "video"
    } else {
        "image"
    }
}

fn media_mime_from_url(url: &str) -> Option<&'static str> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("data:image/png") || lower.contains(".png") {
        Some("image/png")
    } else if lower.starts_with("data:image/jpeg")
        || lower.contains(".jpg")
        || lower.contains(".jpeg")
    {
        Some("image/jpeg")
    } else if lower.starts_with("data:image/webp") || lower.contains(".webp") {
        Some("image/webp")
    } else if lower.starts_with("data:image/gif") || lower.contains(".gif") {
        Some("image/gif")
    } else if lower.starts_with("data:video/mp4") || lower.contains(".mp4") {
        Some("video/mp4")
    } else if lower.starts_with("data:video/webm") || lower.contains(".webm") {
        Some("video/webm")
    } else if lower.starts_with("data:video/quicktime") || lower.contains(".mov") {
        Some("video/quicktime")
    } else {
        None
    }
}

// ----- Run journal -----

#[derive(Deserialize)]
pub(crate) struct RunJournalListParams {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    offset: Option<usize>,
}

fn run_journal_store(st: &AppState) -> Result<&milim_storage::RunJournalStore, ApiError> {
    st.run_journal.as_deref().ok_or_else(|| {
        ApiError(Error::InvalidRequest(
            "run journal is not enabled".to_string(),
        ))
    })
}

/// `GET /runs` — list local goal-attempt journal entries.
pub(crate) async fn runs_list(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Query(params): Query<RunJournalListParams>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let runs = run_journal_store(&st)?
        .list(milim_storage::RunJournalQuery {
            q: params.q.filter(|value| !value.trim().is_empty()),
            status: params.status.filter(|value| !value.trim().is_empty()),
            kind: params.kind.filter(|value| !value.trim().is_empty()),
            workspace: params.workspace.filter(|value| !value.trim().is_empty()),
            limit: params.limit.unwrap_or(50),
            offset: params.offset.unwrap_or(0),
        })
        .map_err(ApiError)?;
    Ok(Json(json!({ "runs": runs })).into_response())
}

/// `GET /runs/{id}` — fetch one journal entry.
pub(crate) async fn run_get(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let run = run_journal_store(&st)?
        .get(&id)
        .map_err(ApiError)?
        .ok_or_else(|| ApiError(Error::ModelNotFound(format!("run {id}"))))?;
    Ok(Json(json!({ "run": run })).into_response())
}

/// `POST /runs` — create a journal entry.
pub(crate) async fn run_create(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(entry): Json<milim_storage::RunJournalEntry>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let run = run_journal_store(&st)?.upsert(&entry).map_err(ApiError)?;
    Ok(Json(json!({ "run": run })).into_response())
}

/// `PUT /runs/{id}` — update/finalize a journal entry.
pub(crate) async fn run_update(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
    Json(mut entry): Json<milim_storage::RunJournalEntry>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    entry.id = id;
    let run = run_journal_store(&st)?.upsert(&entry).map_err(ApiError)?;
    Ok(Json(json!({ "run": run })).into_response())
}

/// `DELETE /runs/{id}` — delete one journal entry.
pub(crate) async fn run_delete(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    Ok(
        Json(json!({ "deleted": run_journal_store(&st)?.delete(&id).map_err(ApiError)? }))
            .into_response(),
    )
}

// ----- MCP servers (external MCP client connections) -----

#[derive(Deserialize)]
pub(crate) struct McpServerUpsert {
    #[serde(default)]
    id: Option<String>,
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Vec<milim_mcp_client::McpEnvVar>,
    #[serde(default = "default_enabled")]
    enabled: bool,
}

/// `GET /mcp/servers` — list configured MCP servers with connection status.
pub(crate) async fn mcp_servers_list(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let list = match &st.mcp {
        Some(hub) => hub.list(),
        None => Vec::new(),
    };
    Ok(Json(json!({ "servers": list })).into_response())
}

/// `POST /mcp/servers` — add or update an MCP server (connects immediately).
pub(crate) async fn mcp_server_upsert(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<McpServerUpsert>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let hub = st
        .mcp
        .as_ref()
        .ok_or_else(|| ApiError(Error::InvalidRequest("MCP client is not enabled".into())))?;
    let cfg = milim_mcp_client::McpServerConfig {
        id: req.id.unwrap_or_default(),
        name: req.name,
        command: req.command,
        args: req.args,
        cwd: req.cwd,
        env: req.env,
        enabled: req.enabled,
    };
    let saved = hub.upsert(cfg).await.map_err(ApiError)?;
    let info = hub.list().into_iter().find(|s| s.id == saved.id);
    Ok(Json(json!({ "server": info })).into_response())
}

/// `POST /mcp/servers/test` — test a draft MCP server without saving/enabling it.
pub(crate) async fn mcp_server_test_draft(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<McpServerUpsert>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let hub = st
        .mcp
        .as_ref()
        .ok_or_else(|| ApiError(Error::InvalidRequest("MCP client is not enabled".into())))?;
    let cfg = milim_mcp_client::McpServerConfig {
        id: req.id.unwrap_or_default(),
        name: req.name,
        command: req.command,
        args: req.args,
        cwd: req.cwd,
        env: req.env,
        enabled: req.enabled,
    };
    Ok(Json(hub.test_config(cfg).await).into_response())
}

/// `POST /mcp/servers/{id}/test` — test a saved MCP server without enabling it.
pub(crate) async fn mcp_server_test_saved(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let hub = st
        .mcp
        .as_ref()
        .ok_or_else(|| ApiError(Error::InvalidRequest("MCP client is not enabled".into())))?;
    let cfg = hub
        .config(&id)
        .ok_or_else(|| ApiError(Error::ModelNotFound(format!("mcp server {id}"))))?;
    Ok(Json(hub.test_config(cfg).await).into_response())
}

/// `DELETE /mcp/servers/{id}` — remove an MCP server (disconnects it).
pub(crate) async fn mcp_server_delete(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let hub = st
        .mcp
        .as_ref()
        .ok_or_else(|| ApiError(Error::InvalidRequest("MCP client is not enabled".into())))?;
    Ok(Json(json!({ "deleted": hub.remove(&id).map_err(ApiError)? })).into_response())
}

// ----- Agents -----

#[derive(Serialize)]
struct AgentRunResponse {
    id: String,
    object: &'static str,
    model: String,
    message: ChatMessage,
    steps: Vec<milim_agents::ToolStep>,
    iterations: usize,
    stopped_at_limit: bool,
}

fn journal_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn run_journal_excerpt(text: &str) -> String {
    const MAX: usize = 4000;
    let mut out: String = text.chars().take(MAX).collect();
    if text.chars().count() > MAX {
        out.push_str("\n[truncated]");
    }
    out
}

fn run_journal_goal(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(ChatMessage::text_content)
        .unwrap_or_else(|| "Agent run".to_string())
}

// ponytail: helper mirrors RunJournalEntry fields; wrap it only if another writer appears.
#[allow(clippy::too_many_arguments)]
fn write_agent_journal(
    st: &AppState,
    journal_id: Option<String>,
    status: &str,
    kind: &str,
    goal: String,
    model: String,
    started_at_ms: i64,
    duration_ms: i64,
    output: String,
    error: Option<String>,
    steps: Vec<milim_agents::ToolStep>,
) {
    if journal_id.is_some() {
        return;
    }
    let Some(journal) = &st.run_journal else {
        return;
    };
    let title = run_journal_excerpt(&goal)
        .lines()
        .next()
        .unwrap_or("Agent run")
        .chars()
        .take(160)
        .collect::<String>();
    let _ = journal.upsert(&milim_storage::RunJournalEntry {
        id: format!("run-agent-{}", uuid::Uuid::new_v4().simple()),
        created_at_ms: started_at_ms,
        updated_at_ms: journal_now_ms(),
        status: status.to_string(),
        kind: kind.to_string(),
        title,
        goal: goal.clone(),
        model,
        duration_ms: Some(duration_ms),
        input_excerpt: run_journal_excerpt(&goal),
        output_excerpt: run_journal_excerpt(&output),
        error,
        tools: steps.into_iter().map(|step| step.name).collect(),
        ..Default::default()
    });
}

#[derive(Debug, Clone, Default)]
struct AgentMemoryContext {
    enabled: bool,
    model: String,
    thread_id: Option<String>,
    thread_label: Option<String>,
    project_locator: Option<String>,
    project_label: Option<String>,
    message_id: Option<String>,
}

const DESKTOP_WORKSPACE_TOOL_NAMES: &[&str] = &[
    "read_file",
    "read_file_anchors",
    "list_dir",
    "write_file",
    "edit_file",
    "patch_file",
    "shell",
];
const HASHLINE_TOOL_NAMES: &[&str] = &["read_file_anchors", "patch_file"];
const SANDBOX_TOOL_NAMES: &[&str] = &["run_command"];
const HOST_COMMAND_TOOL_NAMES: &[&str] = &["shell"];
const COMPUTER_TOOL_NAMES: &[&str] = &[
    "screenshot",
    "mouse_move",
    "mouse_click",
    "key_press",
    "type_text",
    "scroll",
];
const PREVIEW_TOOL_NAMES: &[&str] = &[
    "preview_dom_snapshot",
    "preview_click",
    "preview_type_text",
    "preview_key_press",
    "preview_scroll",
];
const CHILD_THREAD_TOOL_NAMES: &[&str] = &[
    "child_thread_spawn",
    "child_thread_list",
    "child_thread_read",
    "child_thread_wait",
    "child_thread_stop",
];
const CHILD_THREAD_READ_ONLY_TOOL_NAMES: &[&str] = &[
    "read_file",
    "list_dir",
    "http_fetch",
    "current_time",
    "echo",
];
const PLAN_MODE_READ_ONLY_TOOL_NAMES: &[&str] = &["read_file", "list_dir"];
const DEFAULT_CHILD_THREAD_WAIT_MS: u64 = 30_000;
const MAX_CHILD_THREAD_WAIT_MS: u64 = 300_000;
const WORKSPACE_UNAVAILABLE_SYSTEM_PROMPT: &str = concat!(
    "No working folder is selected in Milim. Host filesystem and host shell tools are unavailable. ",
    "If the user asks to create a new file, web app, document, dataset, or other generated artifact ",
    "that is not tied to existing local project files, return it inline as a named fenced code block ",
    "such as ```html file=index.html ... ``` so Milim can capture it in the current chat's artifact panel. ",
    "For browser apps, use index.html plus sibling CSS/JS/TS/TSX files when that is clearer; ",
    "the preview resolves relative links and imports across those artifacts. ",
    "Ask them to pick a folder with the Folder chip only when they want you to read, write, edit, list, ",
    "run commands, or save directly against existing project files."
);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ToolApprovalPolicy {
    Review,
    Guarded,
    Open,
}

#[derive(Clone, Copy, Debug)]
struct ToolRunPolicy {
    approval: ToolApprovalPolicy,
    approval_granted: bool,
    sandbox_enabled: bool,
    computer_use_enabled: bool,
    preview_tools_enabled: bool,
    experimental_hashline_patch: bool,
    plan_mode: bool,
}

impl Default for ToolRunPolicy {
    fn default() -> Self {
        Self {
            approval: ToolApprovalPolicy::Guarded,
            approval_granted: false,
            sandbox_enabled: false,
            computer_use_enabled: false,
            preview_tools_enabled: false,
            experimental_hashline_patch: false,
            plan_mode: false,
        }
    }
}

fn string_extra(req: &ChatCompletionRequest, key: &str) -> Option<String> {
    req.extra
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn bool_extra(req: &ChatCompletionRequest, key: &str) -> bool {
    req.extra.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn tool_run_policy_from_request(req: &ChatCompletionRequest) -> ToolRunPolicy {
    let approval = match string_extra(req, "tool_approval_policy").as_deref() {
        Some("review") => ToolApprovalPolicy::Review,
        Some("open") => ToolApprovalPolicy::Open,
        _ => ToolApprovalPolicy::Guarded,
    };
    ToolRunPolicy {
        approval,
        approval_granted: bool_extra(req, "tool_approval_grant"),
        sandbox_enabled: bool_extra(req, "sandbox_enabled"),
        computer_use_enabled: bool_extra(req, "computer_use_enabled"),
        preview_tools_enabled: bool_extra(req, "preview_tools_enabled"),
        experimental_hashline_patch: bool_extra(req, "experimental_hashline_patch"),
        plan_mode: bool_extra(req, "plan_mode"),
    }
}

fn memory_context_from_request(req: &ChatCompletionRequest, model: String) -> AgentMemoryContext {
    AgentMemoryContext {
        enabled: bool_extra(req, "memory_enabled"),
        model,
        thread_id: string_extra(req, "thread_id"),
        thread_label: string_extra(req, "thread_label"),
        project_locator: string_extra(req, "project_locator"),
        project_label: string_extra(req, "project_label"),
        message_id: string_extra(req, "message_id"),
    }
}

fn workspace_is_selected(st: &AppState) -> bool {
    st.workspace
        .read()
        .ok()
        .and_then(|guard| guard.clone())
        .is_some()
}

fn registry_has_desktop_host_tools(reg: &ToolRegistry) -> bool {
    reg.contains("edit_file") || reg.contains("patch_file") || reg.contains("shell")
}

fn desktop_workspace_unavailable(st: &AppState) -> bool {
    !workspace_is_selected(st)
        && st
            .tools
            .as_ref()
            .map(|reg| registry_has_desktop_host_tools(reg))
            .unwrap_or(false)
}

fn add_workspace_notice_if_needed(messages: &mut Vec<ChatMessage>, workspace_unavailable: bool) {
    if !workspace_unavailable {
        return;
    }
    let insert_at = messages
        .iter()
        .position(|message| message.role != "system")
        .unwrap_or(messages.len());
    messages.insert(
        insert_at,
        ChatMessage::text("system", WORKSPACE_UNAVAILABLE_SYSTEM_PROMPT),
    );
}

/// The effective tool registry for an agent run: the static tools (builtins,
/// host fs/shell, Docker sandbox) plus any tools exposed by connected MCP
/// servers. Rebuilt per-run (cheap clone) so newly-added MCP servers are
/// picked up without restarting the app.
pub(crate) fn agent_registry(st: &AppState) -> ToolRegistry {
    agent_registry_with_memory(st, None, &ToolRunPolicy::default())
}

fn agent_registry_with_memory(
    st: &AppState,
    memory: Option<AgentMemoryContext>,
    policy: &ToolRunPolicy,
) -> ToolRegistry {
    agent_registry_for_mode(st, "all", &[], memory, policy)
}

fn agent_base_registry_with_memory(
    st: &AppState,
    memory: Option<AgentMemoryContext>,
    policy: &ToolRunPolicy,
) -> ToolRegistry {
    let mut reg = st.tools.as_deref().cloned().unwrap_or_default();
    let workspace_unavailable = desktop_workspace_unavailable(st);
    if policy.plan_mode {
        return plan_mode_registry(
            reg,
            workspace_unavailable,
            policy.experimental_hashline_patch,
        );
    }
    if let Some(hub) = &st.mcp {
        for tool in hub.tools() {
            reg.register(tool);
        }
    }
    if let Some(store) = st.schedules.as_ref() {
        register_schedule_tools(&mut reg, store.clone());
    }
    if let (Some(memory), Some(store)) = (memory.clone(), st.memory.as_ref()) {
        if memory.enabled {
            reg.register(Arc::new(MemoryRegisterTool {
                store: store.clone(),
                context: memory,
            }));
        }
    }
    if workspace_unavailable && registry_has_desktop_host_tools(&reg) {
        reg = reg.without(DESKTOP_WORKSPACE_TOOL_NAMES);
    }
    if !policy.sandbox_enabled {
        reg = reg.without(SANDBOX_TOOL_NAMES);
    }
    if !policy.computer_use_enabled {
        reg = reg.without(COMPUTER_TOOL_NAMES);
    }
    if !policy.preview_tools_enabled {
        reg = reg.without(PREVIEW_TOOL_NAMES);
    }
    if !policy.experimental_hashline_patch {
        reg = reg.without(HASHLINE_TOOL_NAMES);
    }
    if policy.approval == ToolApprovalPolicy::Review && !policy.approval_granted {
        reg = ToolRegistry::new();
    } else if policy.approval == ToolApprovalPolicy::Guarded {
        reg = reg.without(HOST_COMMAND_TOOL_NAMES);
    }
    reg
}

fn tools_available(policy: &ToolRunPolicy) -> bool {
    (policy.approval_granted || policy.approval != ToolApprovalPolicy::Review) && !policy.plan_mode
}

fn plan_mode_registry(
    reg: ToolRegistry,
    workspace_unavailable: bool,
    anchored_reads_enabled: bool,
) -> ToolRegistry {
    let mut allowed: Vec<String> = PLAN_MODE_READ_ONLY_TOOL_NAMES
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    if anchored_reads_enabled {
        allowed.push("read_file_anchors".to_string());
    }
    let mut reg = reg.filtered(&allowed);
    if workspace_unavailable {
        reg = reg.without(&["read_file", "list_dir", "read_file_anchors"]);
    }
    reg
}

fn agent_registry_for_mode(
    st: &AppState,
    tool_mode: &str,
    enabled_tools: &[String],
    memory: Option<AgentMemoryContext>,
    policy: &ToolRunPolicy,
) -> ToolRegistry {
    let all = agent_base_registry_with_memory(st, memory.clone(), policy);
    let normalized = milim_agents::normalize_tool_mode(tool_mode, enabled_tools);
    let inherited = match normalized.as_str() {
        "none" => ToolRegistry::new(),
        "custom" if enabled_tools.is_empty() => ToolRegistry::new(),
        "custom" => all.filtered(enabled_tools),
        _ => all,
    };
    let mut reg = inherited.clone();
    if let (Some(memory), Some(supervisor)) = (memory, st.threads.as_ref()) {
        if tools_available(policy) && child_thread_tools_allowed(supervisor, &memory) {
            register_child_thread_tools(
                &mut reg,
                st.clone(),
                supervisor.clone(),
                memory,
                child_registry_for_policy(st, policy, inherited),
            );
        }
    }
    match normalized.as_str() {
        "none" => ToolRegistry::new(),
        "custom" if enabled_tools.is_empty() => ToolRegistry::new(),
        "custom" => reg.filtered(enabled_tools),
        _ => reg,
    }
}

struct MemoryRegisterTool {
    store: Arc<milim_memory::MemoryStore>,
    context: AgentMemoryContext,
}

#[derive(Debug, Deserialize)]
struct MemoryRegisterArgs {
    #[serde(default)]
    scope_kind: Option<String>,
    #[serde(default)]
    scope_label: Option<String>,
    #[serde(default)]
    scope_locator: Option<String>,
    #[serde(default = "default_memory_node_kind")]
    kind: String,
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default = "default_memory_confidence")]
    confidence: f32,
    #[serde(default)]
    source: String,
}

fn default_memory_node_kind() -> String {
    "fact".to_string()
}

fn default_memory_confidence() -> f32 {
    0.85
}

#[async_trait]
impl Tool for MemoryRegisterTool {
    fn name(&self) -> &str {
        "memory_register"
    }

    fn description(&self) -> &str {
        "Register a concise durable memory in the current thread or project graph. Use this only for facts, decisions, preferences, and project context that will likely help future turns."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "scope_kind": {
                    "type": "string",
                    "enum": ["thread", "project"],
                    "description": "Where to store the memory. Use project for repository/workspace facts and thread for conversation-specific facts."
                },
                "scope_label": { "type": "string" },
                "scope_locator": {
                    "type": "string",
                    "description": "Optional override. Usually omit this and let Milim use the active thread/project."
                },
                "kind": {
                    "type": "string",
                    "description": "Memory kind such as fact, decision, preference, task, file, or entity."
                },
                "title": { "type": "string", "description": "Short human-readable title." },
                "body": { "type": "string", "description": "One or two sentences with the useful durable context." },
                "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                "source": { "type": "string", "description": "Optional source label." }
            },
            "required": ["title"]
        })
    }

    async fn invoke(&self, args: Value) -> milim_core::Result<Value> {
        let args: MemoryRegisterArgs = serde_json::from_value(args).map_err(|e| {
            Error::InvalidRequest(format!("invalid memory_register arguments: {e}"))
        })?;
        let scope_kind = args
            .scope_kind
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                if self.context.project_locator.is_some() {
                    "project"
                } else {
                    "thread"
                }
            })
            .to_ascii_lowercase();

        let (locator, label) = match scope_kind.as_str() {
            "project" => {
                let locator = args
                    .scope_locator
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .or_else(|| self.context.project_locator.clone())
                    .ok_or_else(|| {
                        Error::InvalidRequest(
                            "project memory requires an active project folder".to_string(),
                        )
                    })?;
                let label = args
                    .scope_label
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .or_else(|| self.context.project_label.clone())
                    .unwrap_or_else(|| locator.clone());
                (locator, label)
            }
            "thread" => {
                let locator = args
                    .scope_locator
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .or_else(|| self.context.thread_id.clone())
                    .ok_or_else(|| {
                        Error::InvalidRequest(
                            "thread memory requires an active thread id".to_string(),
                        )
                    })?;
                let label = args
                    .scope_label
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .or_else(|| self.context.thread_label.clone())
                    .unwrap_or_else(|| "Current thread".to_string());
                (locator, label)
            }
            _ => {
                return Err(Error::InvalidRequest(
                    "memory_register scope_kind must be thread or project".to_string(),
                ))
            }
        };

        let registration = self
            .store
            .register(
                &self.context.model,
                milim_memory::MemoryScopeInput {
                    kind: scope_kind,
                    label,
                    locator,
                },
                milim_memory::MemoryNodeInput {
                    kind: args.kind,
                    title: args.title,
                    body: args.body,
                    confidence: args.confidence,
                    source: if args.source.trim().is_empty() {
                        "agent".to_string()
                    } else {
                        args.source
                    },
                },
                Vec::new(),
                milim_memory::MemoryEventInput {
                    thread_id: self.context.thread_id.clone().unwrap_or_default(),
                    message_id: self.context.message_id.clone().unwrap_or_default(),
                    summary: String::new(),
                },
            )
            .await?;
        Ok(json!({
            "ok": true,
            "memory": registration.node,
            "scope": registration.scope,
            "memory_notice": registration.notice
        }))
    }
}

fn child_thread_tools_allowed(supervisor: &ThreadSupervisor, context: &AgentMemoryContext) -> bool {
    let Some(thread_id) = context.thread_id.as_deref() else {
        return false;
    };
    supervisor
        .get(thread_id)
        .map(|t| t.is_none())
        .unwrap_or(false)
}

fn register_child_thread_tools(
    reg: &mut ToolRegistry,
    state: AppState,
    supervisor: Arc<ThreadSupervisor>,
    context: AgentMemoryContext,
    child_tools: ToolRegistry,
) {
    reg.register(Arc::new(ChildThreadSpawnTool {
        state: state.clone(),
        supervisor: supervisor.clone(),
        context: context.clone(),
        child_tools,
    }));
    reg.register(Arc::new(ChildThreadListTool {
        supervisor: supervisor.clone(),
        context: context.clone(),
    }));
    reg.register(Arc::new(ChildThreadReadTool {
        supervisor: supervisor.clone(),
    }));
    reg.register(Arc::new(ChildThreadWaitTool {
        supervisor: supervisor.clone(),
    }));
    reg.register(Arc::new(ChildThreadStopTool { supervisor }));
}

fn child_read_only_registry(st: &AppState) -> ToolRegistry {
    let allowed: Vec<String> = CHILD_THREAD_READ_ONLY_TOOL_NAMES
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    let mut reg = st
        .tools
        .as_deref()
        .cloned()
        .unwrap_or_default()
        .filtered(&allowed);
    if desktop_workspace_unavailable(st) {
        reg = reg.without(&["read_file", "list_dir"]);
    }
    reg
}

fn child_registry_for_policy(
    st: &AppState,
    policy: &ToolRunPolicy,
    inherited: ToolRegistry,
) -> ToolRegistry {
    if policy.approval == ToolApprovalPolicy::Open {
        inherited.without(CHILD_THREAD_TOOL_NAMES)
    } else {
        child_read_only_registry(st)
    }
}

fn child_thread_parent_id(context: &AgentMemoryContext) -> milim_core::Result<String> {
    context
        .thread_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| {
            Error::InvalidRequest("child threads require a parent thread id".to_string())
        })
}

fn child_thread_wait_ms(timeout_ms: Option<u64>) -> u64 {
    timeout_ms
        .unwrap_or(DEFAULT_CHILD_THREAD_WAIT_MS)
        .clamp(1, MAX_CHILD_THREAD_WAIT_MS)
}

fn child_thread_title(title: Option<String>, prompt: &str) -> String {
    title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| prompt.chars().take(80).collect())
}

fn child_thread_notice(thread: &milim_agents::AgentThread) -> Value {
    let (event, message) = match thread.status.as_str() {
        milim_agents::THREAD_STATUS_DONE => ("done", None),
        milim_agents::THREAD_STATUS_ERROR | milim_agents::THREAD_STATUS_STOPPED => {
            ("error", thread.error.clone())
        }
        _ => ("started", None),
    };
    json!({
        "event": event,
        "thread": thread,
        "message": message
    })
}

struct ChildThreadSpawnTool {
    state: AppState,
    supervisor: Arc<ThreadSupervisor>,
    context: AgentMemoryContext,
    child_tools: ToolRegistry,
}

struct ChildThreadListTool {
    supervisor: Arc<ThreadSupervisor>,
    context: AgentMemoryContext,
}

struct ChildThreadReadTool {
    supervisor: Arc<ThreadSupervisor>,
}

struct ChildThreadWaitTool {
    supervisor: Arc<ThreadSupervisor>,
}

struct ChildThreadStopTool {
    supervisor: Arc<ThreadSupervisor>,
}

#[derive(Debug, Deserialize)]
struct ChildThreadSpawnArgs {
    prompt: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    wait: bool,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ChildThreadListArgs {
    #[serde(default)]
    parent_thread_id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct ChildThreadReadArgs {
    thread_id: String,
    #[serde(default)]
    include_events: bool,
    #[serde(default)]
    event_limit: Option<usize>,
    #[serde(default)]
    after_seq: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ChildThreadWaitArgs {
    thread_id: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ChildThreadStopArgs {
    thread_id: String,
}

#[async_trait]
impl Tool for ChildThreadSpawnTool {
    fn name(&self) -> &str {
        "child_thread_spawn"
    }

    fn description(&self) -> &str {
        "Start a child thread for parallel work. Open-mode children inherit this run's tools except child-thread tools; other modes stay read-only."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": { "type": "string", "description": "Self-contained task for the child thread." },
                "title": { "type": "string", "description": "Short sidebar title." },
                "agent_id": { "type": ["string", "null"], "description": "Optional named agent id to run as the child." },
                "model": { "type": "string", "description": "Optional model override." },
                "wait": { "type": "boolean", "description": "Wait for the child to finish before returning. Defaults to false." },
                "timeout_ms": { "type": "integer", "minimum": 1, "maximum": 300000 }
            },
            "required": ["prompt"],
            "additionalProperties": false
        })
    }

    async fn invoke(&self, args: Value) -> milim_core::Result<Value> {
        let args: ChildThreadSpawnArgs = serde_json::from_value(args).map_err(|e| {
            Error::InvalidRequest(format!("invalid child_thread_spawn arguments: {e}"))
        })?;
        let parent_id = child_thread_parent_id(&self.context)?;
        let prompt = trim_required_tool_arg(args.prompt, "prompt")?;
        let explicit_model = args
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let mut model = explicit_model
            .clone()
            .unwrap_or_else(|| self.context.model.clone());
        let agent_id = trim_optional_agent_id(args.agent_id);
        let mut system_prompt = None;

        if let Some(agent_id) = agent_id.as_deref() {
            let store =
                self.state.agents.as_ref().ok_or_else(|| {
                    Error::InvalidRequest("named agents are not enabled".to_string())
                })?;
            let agent = store
                .get(agent_id)?
                .ok_or_else(|| Error::ModelNotFound(format!("agent {agent_id}")))?;
            if explicit_model.is_none() && !agent.model.trim().is_empty() {
                model = agent.model;
            }
            if !agent.system_prompt.trim().is_empty() {
                system_prompt = Some(agent.system_prompt);
            }
        }
        model = model.trim().to_string();
        if model.is_empty() {
            model = "default".to_string();
        }
        let available_models = self.state.service.list_models().await?;
        if !available_models.iter().any(|item| item.id == model) {
            return Err(Error::InvalidRequest(format!(
                "child thread model '{model}' is not available. Choose an available model or update the child agent model."
            )));
        }

        let thread = self.supervisor.spawn(
            self.state.service.clone(),
            self.child_tools.clone(),
            ChildRunSpec {
                parent_id,
                title: child_thread_title(args.title, &prompt),
                model,
                agent_id,
                system_prompt,
                prompt,
            },
        )?;

        let thread = if args.wait {
            self.supervisor
                .wait(&thread.id, child_thread_wait_ms(args.timeout_ms))
                .await?
                .unwrap_or(thread)
        } else {
            thread
        };

        Ok(json!({
            "ok": true,
            "thread": thread,
            "child_thread_notice": child_thread_notice(&thread)
        }))
    }
}

#[async_trait]
impl Tool for ChildThreadListTool {
    fn name(&self) -> &str {
        "child_thread_list"
    }

    fn description(&self) -> &str {
        "List child threads for the current parent thread, optionally filtered by status."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "parent_thread_id": { "type": "string" },
                "status": { "type": "string", "enum": ["queued", "running", "done", "stopped", "error"] },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
            },
            "additionalProperties": false
        })
    }

    async fn invoke(&self, args: Value) -> milim_core::Result<Value> {
        let args: ChildThreadListArgs =
            serde_json::from_value(args).unwrap_or(ChildThreadListArgs {
                parent_thread_id: None,
                status: None,
                limit: None,
            });
        let parent_id = match args
            .parent_thread_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            Some(id) => id.to_string(),
            None => child_thread_parent_id(&self.context)?,
        };
        let threads = self.supervisor.children(
            &parent_id,
            args.status.as_deref(),
            args.limit.unwrap_or(50).clamp(1, 50),
        )?;
        Ok(json!({ "ok": true, "threads": threads }))
    }
}

#[async_trait]
impl Tool for ChildThreadReadTool {
    fn name(&self) -> &str {
        "child_thread_read"
    }

    fn description(&self) -> &str {
        "Read one child thread's metadata, summary, error, and optionally stored lifecycle events."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "thread_id": { "type": "string" },
                "include_events": { "type": "boolean" },
                "event_limit": { "type": "integer", "minimum": 1, "maximum": 5000 },
                "after_seq": { "type": "integer", "minimum": 0 }
            },
            "required": ["thread_id"],
            "additionalProperties": false
        })
    }

    async fn invoke(&self, args: Value) -> milim_core::Result<Value> {
        let args: ChildThreadReadArgs = serde_json::from_value(args).map_err(|e| {
            Error::InvalidRequest(format!("invalid child_thread_read arguments: {e}"))
        })?;
        let thread_id = trim_required_tool_arg(args.thread_id, "thread_id")?;
        let thread = self
            .supervisor
            .get(&thread_id)?
            .ok_or_else(|| Error::ModelNotFound(format!("thread {thread_id}")))?;
        if args.include_events {
            let limit = args.event_limit.unwrap_or(DEFAULT_THREAD_EVENT_LIMIT);
            let limit = thread_event_limit(limit);
            let events = if let Some(after_seq) = args.after_seq {
                self.supervisor
                    .events_after(&thread_id, after_seq.max(0), limit)?
            } else {
                self.supervisor.events(&thread_id, limit)?
            };
            let event_count = self.supervisor.event_count(&thread_id)?;
            Ok(json!({
                "ok": true,
                "thread": thread,
                "events": events,
                "event_count": event_count,
                "events_truncated": event_count > events.len()
            }))
        } else {
            Ok(json!({ "ok": true, "thread": thread }))
        }
    }
}

#[async_trait]
impl Tool for ChildThreadWaitTool {
    fn name(&self) -> &str {
        "child_thread_wait"
    }

    fn description(&self) -> &str {
        "Wait until a child thread finishes or the timeout elapses, then return its latest status."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "thread_id": { "type": "string" },
                "timeout_ms": { "type": "integer", "minimum": 1, "maximum": 300000 }
            },
            "required": ["thread_id"],
            "additionalProperties": false
        })
    }

    async fn invoke(&self, args: Value) -> milim_core::Result<Value> {
        let args: ChildThreadWaitArgs = serde_json::from_value(args).map_err(|e| {
            Error::InvalidRequest(format!("invalid child_thread_wait arguments: {e}"))
        })?;
        let thread_id = trim_required_tool_arg(args.thread_id, "thread_id")?;
        let thread = self
            .supervisor
            .wait(&thread_id, child_thread_wait_ms(args.timeout_ms))
            .await?
            .ok_or_else(|| Error::ModelNotFound(format!("thread {thread_id}")))?;
        Ok(json!({
            "ok": true,
            "thread": thread,
            "child_thread_notice": child_thread_notice(&thread)
        }))
    }
}

#[async_trait]
impl Tool for ChildThreadStopTool {
    fn name(&self) -> &str {
        "child_thread_stop"
    }

    fn description(&self) -> &str {
        "Stop a running child thread by id."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "thread_id": { "type": "string" }
            },
            "required": ["thread_id"],
            "additionalProperties": false
        })
    }

    async fn invoke(&self, args: Value) -> milim_core::Result<Value> {
        let args: ChildThreadStopArgs = serde_json::from_value(args).map_err(|e| {
            Error::InvalidRequest(format!("invalid child_thread_stop arguments: {e}"))
        })?;
        let thread_id = trim_required_tool_arg(args.thread_id, "thread_id")?;
        let thread = self
            .supervisor
            .stop(&thread_id)?
            .ok_or_else(|| Error::ModelNotFound(format!("thread {thread_id}")))?;
        Ok(json!({
            "ok": true,
            "thread": thread,
            "child_thread_notice": child_thread_notice(&thread)
        }))
    }
}

fn register_schedule_tools(reg: &mut ToolRegistry, store: Arc<milim_automation::ScheduleStore>) {
    reg.register(Arc::new(ScheduleCreateTool {
        store: store.clone(),
    }));
    reg.register(Arc::new(ScheduleUpdateTool {
        store: store.clone(),
    }));
    reg.register(Arc::new(ScheduleListTool {
        store: store.clone(),
    }));
    reg.register(Arc::new(ScheduleDeleteTool { store }));
}

struct ScheduleCreateTool {
    store: Arc<milim_automation::ScheduleStore>,
}

struct ScheduleUpdateTool {
    store: Arc<milim_automation::ScheduleStore>,
}

struct ScheduleListTool {
    store: Arc<milim_automation::ScheduleStore>,
}

struct ScheduleDeleteTool {
    store: Arc<milim_automation::ScheduleStore>,
}

#[derive(Debug, Deserialize)]
struct ScheduleCreateToolArgs {
    name: String,
    cron: String,
    prompt: String,
    #[serde(default)]
    attachments: Vec<milim_automation::ScheduleAttachment>,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default = "default_true")]
    enabled: bool,
}

#[derive(Debug, Deserialize)]
struct ScheduleUpdateToolArgs {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    cron: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    attachments: Option<Vec<milim_automation::ScheduleAttachment>>,
    #[serde(default)]
    agent_id: Option<Value>,
    #[serde(default)]
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ScheduleListToolArgs {
    #[serde(default)]
    enabled_only: bool,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct ScheduleDeleteToolArgs {
    id: String,
}

fn trim_required_tool_arg(value: String, name: &str) -> milim_core::Result<String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(Error::InvalidRequest(format!("{name} is required")));
    }
    Ok(value)
}

fn trim_optional_agent_id(agent_id: Option<String>) -> Option<String> {
    agent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn find_schedule(
    store: &milim_automation::ScheduleStore,
    id: &str,
) -> milim_core::Result<milim_automation::Schedule> {
    store
        .list()?
        .into_iter()
        .find(|schedule| schedule.id == id)
        .ok_or_else(|| Error::ModelNotFound(format!("schedule {id}")))
}

#[async_trait]
impl Tool for ScheduleCreateTool {
    fn name(&self) -> &str {
        "schedule_create"
    }

    fn description(&self) -> &str {
        "Create a cron automation that runs a saved agent prompt. Use this when the user asks to schedule, automate, run periodically, or create a cron from chat. Cron expressions must use six fields: sec min hour day month dow."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Short human-readable automation name." },
                "cron": { "type": "string", "description": "Six-field cron expression: sec min hour day month dow." },
                "prompt": { "type": "string", "description": "Self-contained prompt to run each time the automation fires." },
                "attachments": {
                    "type": "array",
                    "description": "Optional file attachments whose text content should be included when the automation runs.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string" },
                            "name": { "type": "string" },
                            "mime": { "type": "string" },
                            "size": { "type": "integer" },
                            "content": { "type": "string" },
                            "truncated": { "type": "boolean" },
                            "sourcePath": { "type": "string" }
                        },
                        "required": ["name"],
                        "additionalProperties": false
                    }
                },
                "agent_id": { "type": ["string", "null"], "description": "Optional named agent id. Omit for the default agent." },
                "enabled": { "type": "boolean", "description": "Whether the automation should start enabled. Defaults to true." }
            },
            "required": ["name", "cron", "prompt"],
            "additionalProperties": false
        })
    }

    async fn invoke(&self, args: Value) -> milim_core::Result<Value> {
        let args: ScheduleCreateToolArgs = serde_json::from_value(args).map_err(|e| {
            Error::InvalidRequest(format!("invalid schedule_create arguments: {e}"))
        })?;
        let name = trim_required_tool_arg(args.name, "name")?;
        let cron = trim_required_tool_arg(args.cron, "cron")?;
        let prompt = trim_required_tool_arg(args.prompt, "prompt")?;
        let mut schedule = self.store.create_with_attachments(
            &name,
            &cron,
            trim_optional_agent_id(args.agent_id),
            &prompt,
            args.attachments,
        )?;
        if !args.enabled {
            schedule = self.store.update(milim_automation::ScheduleUpdate {
                id: &schedule.id,
                name: &schedule.name,
                cron: &schedule.cron,
                agent_id: schedule.agent_id.clone(),
                prompt: &schedule.prompt,
                attachments: schedule.attachments.clone(),
                enabled: false,
                last_run: schedule.last_run,
            })?;
        }
        Ok(json!({ "ok": true, "schedule": schedule }))
    }
}

#[async_trait]
impl Tool for ScheduleUpdateTool {
    fn name(&self) -> &str {
        "schedule_update"
    }

    fn description(&self) -> &str {
        "Update an existing cron automation by id. Use null agent_id to clear the named agent and omit fields that should stay unchanged."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Schedule id to update." },
                "name": { "type": "string" },
                "cron": { "type": "string", "description": "Six-field cron expression: sec min hour day month dow." },
                "prompt": { "type": "string" },
                "attachments": {
                    "type": "array",
                    "description": "Replacement file attachments for the automation.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string" },
                            "name": { "type": "string" },
                            "mime": { "type": "string" },
                            "size": { "type": "integer" },
                            "content": { "type": "string" },
                            "truncated": { "type": "boolean" },
                            "sourcePath": { "type": "string" }
                        },
                        "required": ["name"],
                        "additionalProperties": false
                    }
                },
                "agent_id": { "type": ["string", "null"], "description": "Named agent id, or null to clear." },
                "enabled": { "type": "boolean" }
            },
            "required": ["id"],
            "additionalProperties": false
        })
    }

    async fn invoke(&self, args: Value) -> milim_core::Result<Value> {
        let args: ScheduleUpdateToolArgs = serde_json::from_value(args).map_err(|e| {
            Error::InvalidRequest(format!("invalid schedule_update arguments: {e}"))
        })?;
        let id = trim_required_tool_arg(args.id, "id")?;
        let current = find_schedule(&self.store, &id)?;
        let name = args
            .name
            .map(|value| trim_required_tool_arg(value, "name"))
            .transpose()?
            .unwrap_or_else(|| current.name.clone());
        let cron = args
            .cron
            .map(|value| trim_required_tool_arg(value, "cron"))
            .transpose()?
            .unwrap_or_else(|| current.cron.clone());
        let prompt = args
            .prompt
            .map(|value| trim_required_tool_arg(value, "prompt"))
            .transpose()?
            .unwrap_or_else(|| current.prompt.clone());
        let attachments = args
            .attachments
            .unwrap_or_else(|| current.attachments.clone());
        let agent_id = match args.agent_id {
            None => current.agent_id.clone(),
            Some(Value::Null) => None,
            Some(Value::String(value)) => trim_optional_agent_id(Some(value)),
            Some(_) => {
                return Err(Error::InvalidRequest(
                    "agent_id must be a string or null".to_string(),
                ))
            }
        };
        let schedule = self.store.update(milim_automation::ScheduleUpdate {
            id: &id,
            name: &name,
            cron: &cron,
            agent_id,
            prompt: &prompt,
            attachments,
            enabled: args.enabled.unwrap_or(current.enabled),
            last_run: current.last_run,
        })?;
        Ok(json!({ "ok": true, "schedule": schedule }))
    }
}

#[async_trait]
impl Tool for ScheduleListTool {
    fn name(&self) -> &str {
        "schedule_list"
    }

    fn description(&self) -> &str {
        "List saved cron automations."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "enabled_only": { "type": "boolean", "description": "Only return enabled schedules." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
            },
            "additionalProperties": false
        })
    }

    async fn invoke(&self, args: Value) -> milim_core::Result<Value> {
        let args: ScheduleListToolArgs =
            serde_json::from_value(args).unwrap_or(ScheduleListToolArgs {
                enabled_only: false,
                limit: None,
            });
        let mut schedules = self.store.list()?;
        if args.enabled_only {
            schedules.retain(|schedule| schedule.enabled);
        }
        if let Some(limit) = args.limit {
            schedules.truncate(limit.clamp(1, 50));
        }
        Ok(json!({ "ok": true, "schedules": schedules }))
    }
}

#[async_trait]
impl Tool for ScheduleDeleteTool {
    fn name(&self) -> &str {
        "schedule_delete"
    }

    fn description(&self) -> &str {
        "Delete a saved cron automation by id."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Schedule id to delete." }
            },
            "required": ["id"],
            "additionalProperties": false
        })
    }

    async fn invoke(&self, args: Value) -> milim_core::Result<Value> {
        let args: ScheduleDeleteToolArgs = serde_json::from_value(args).map_err(|e| {
            Error::InvalidRequest(format!("invalid schedule_delete arguments: {e}"))
        })?;
        let id = trim_required_tool_arg(args.id, "id")?;
        let deleted = self.store.delete(&id)?;
        if !deleted {
            return Err(Error::ModelNotFound(format!("schedule {id}")));
        }
        Ok(json!({ "ok": true, "deleted": true, "id": id }))
    }
}

/// `POST /agents/run` — run the tool-use loop server-side and return the final
/// message plus the tool steps taken.
pub(crate) async fn agents_run(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<ChatCompletionRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;

    let model = req.model.clone();
    let want_stream = req.wants_stream();
    let reasoning_effort = req.reasoning_effort;
    let journal_id = string_extra(&req, "journal_id");
    let agent_config = agent_run_config_from_request(&req);
    let tool_policy = tool_run_policy_from_request(&req);
    let memory = memory_context_from_request(&req, model.clone());
    let workspace_unavailable = desktop_workspace_unavailable(&st);
    let mut messages = req.messages;
    add_workspace_notice_if_needed(&mut messages, workspace_unavailable);
    let journal_goal = run_journal_goal(&messages);
    let started_at_ms = journal_now_ms();
    let started = Instant::now();

    if want_stream {
        let tools =
            std::sync::Arc::new(agent_registry_with_memory(&st, Some(memory), &tool_policy));
        let stream = milim_agents::run_agent_stream_with_config(
            st.service.clone(),
            tools,
            model,
            messages,
            reasoning_effort,
            agent_config,
        );
        return Ok(Sse::new(agent_sse(stream))
            .keep_alive(KeepAlive::default())
            .into_response());
    }

    let tools = agent_registry_with_memory(&st, Some(memory), &tool_policy);
    let outcome = match milim_agents::run_agent_with_config(
        st.service.as_ref(),
        &tools,
        &model,
        messages,
        reasoning_effort,
        agent_config,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(e) => {
            write_agent_journal(
                &st,
                journal_id,
                "error",
                "agent",
                journal_goal,
                model,
                started_at_ms,
                started.elapsed().as_millis() as i64,
                String::new(),
                Some(e.to_string()),
                Vec::new(),
            );
            return Err(ApiError(e));
        }
    };

    write_agent_journal(
        &st,
        journal_id,
        "done",
        "agent",
        journal_goal,
        model.clone(),
        started_at_ms,
        started.elapsed().as_millis() as i64,
        outcome.message.text_content(),
        None,
        outcome.steps.clone(),
    );

    Ok(Json(AgentRunResponse {
        id: gen_id("agentrun"),
        object: "agent.run",
        model,
        message: outcome.message,
        steps: outcome.steps,
        iterations: outcome.iterations,
        stopped_at_limit: outcome.stopped_at_limit,
    })
    .into_response())
}

/// `GET /agents` — list named agents.
pub(crate) async fn agents_list(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let agents = match &st.agents {
        Some(store) => store.list().map_err(ApiError)?,
        None => Vec::new(),
    };
    Ok(Json(json!({ "agents": agents })).into_response())
}

#[derive(Deserialize)]
pub(crate) struct CreateAgentRequest {
    name: String,
    model: String,
    #[serde(default)]
    system_prompt: String,
    #[serde(default)]
    tool_mode: String,
    #[serde(default)]
    enabled_tools: Vec<String>,
    #[serde(default)]
    skill_mode: String,
    #[serde(default)]
    enabled_skills: Vec<String>,
    #[serde(default)]
    avatar: String,
}

/// `POST /agents` — create a named agent.
pub(crate) async fn agent_create(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<CreateAgentRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = agents_store(&st)?;
    let agent = store
        .create(
            &req.name,
            &req.model,
            &req.system_prompt,
            &req.tool_mode,
            req.enabled_tools,
            &req.skill_mode,
            req.enabled_skills,
            &req.avatar,
        )
        .map_err(ApiError)?;
    Ok(Json(agent).into_response())
}

/// `GET /agents/{id}` — fetch one agent.
pub(crate) async fn agent_get(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = agents_store(&st)?;
    let agent = store
        .get(&id)
        .map_err(ApiError)?
        .ok_or_else(|| ApiError(Error::ModelNotFound(format!("agent {id}"))))?;
    Ok(Json(agent).into_response())
}

/// `POST /agents/{id}/run` — run a named agent's tool-use loop.
pub(crate) async fn agent_run_by_id(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<ChatCompletionRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = agents_store(&st)?;
    let agent = store
        .get(&id)
        .map_err(ApiError)?
        .ok_or_else(|| ApiError(Error::ModelNotFound(format!("agent {id}"))))?;

    let want_stream = req.wants_stream();
    let requested_model = req.model.clone();
    let reasoning_effort = req.reasoning_effort;
    let journal_id = string_extra(&req, "journal_id");
    let agent_config = agent_run_config_from_request(&req);
    let tool_policy = tool_run_policy_from_request(&req);
    let memory = memory_context_from_request(&req, requested_model.clone());
    let mut messages = Vec::new();
    if !agent.system_prompt.is_empty() {
        messages.push(ChatMessage::text("system", agent.system_prompt.clone()));
    }
    let skill_query = req
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(ChatMessage::text_content)
        .unwrap_or_default();
    messages.extend(crate::agent_skill_messages(&st, &agent, &skill_query));
    messages.extend(req.messages);
    let model = if agent.model.is_empty() {
        requested_model
    } else {
        agent.model.clone()
    };
    let memory = AgentMemoryContext {
        model: model.clone(),
        ..memory
    };
    add_workspace_notice_if_needed(&mut messages, desktop_workspace_unavailable(&st));
    let journal_goal = run_journal_goal(&messages);
    let started_at_ms = journal_now_ms();
    let started = Instant::now();

    if want_stream {
        let tools = std::sync::Arc::new(agent_registry_for_mode(
            &st,
            &agent.tool_mode,
            &agent.enabled_tools,
            Some(memory),
            &tool_policy,
        ));
        let stream = milim_agents::run_agent_stream_with_config(
            st.service.clone(),
            tools,
            model,
            messages,
            reasoning_effort,
            agent_config,
        );
        return Ok(Sse::new(agent_sse(stream))
            .keep_alive(KeepAlive::default())
            .into_response());
    }

    let tools = agent_registry_for_mode(
        &st,
        &agent.tool_mode,
        &agent.enabled_tools,
        Some(memory),
        &tool_policy,
    );
    let outcome = match milim_agents::run_agent_with_config(
        st.service.as_ref(),
        &tools,
        &model,
        messages,
        reasoning_effort,
        agent_config,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(e) => {
            write_agent_journal(
                &st,
                journal_id,
                "error",
                "agent",
                journal_goal,
                model,
                started_at_ms,
                started.elapsed().as_millis() as i64,
                String::new(),
                Some(e.to_string()),
                Vec::new(),
            );
            return Err(ApiError(e));
        }
    };

    write_agent_journal(
        &st,
        journal_id,
        "done",
        "agent",
        journal_goal,
        model.clone(),
        started_at_ms,
        started.elapsed().as_millis() as i64,
        outcome.message.text_content(),
        None,
        outcome.steps.clone(),
    );

    Ok(Json(AgentRunResponse {
        id: gen_id("agentrun"),
        object: "agent.run",
        model,
        message: outcome.message,
        steps: outcome.steps,
        iterations: outcome.iterations,
        stopped_at_limit: outcome.stopped_at_limit,
    })
    .into_response())
}

/// `PUT /agents/{id}` — update (upsert) a named agent.
pub(crate) async fn agent_update(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<CreateAgentRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = agents_store(&st)?;
    let agent = milim_agents::AgentDef {
        id,
        name: req.name,
        system_prompt: req.system_prompt,
        model: req.model,
        tool_mode: milim_agents::normalize_tool_mode(&req.tool_mode, &req.enabled_tools),
        enabled_tools: req.enabled_tools,
        skill_mode: milim_agents::normalize_skill_mode(&req.skill_mode, &req.enabled_skills),
        enabled_skills: req.enabled_skills,
        avatar: req.avatar,
    };
    store.upsert(&agent).map_err(ApiError)?;
    Ok(Json(agent).into_response())
}

/// `DELETE /agents/{id}` — remove a named agent.
pub(crate) async fn agent_delete(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = agents_store(&st)?;
    let removed = store.delete(&id).map_err(ApiError)?;
    Ok(Json(json!({ "deleted": removed })).into_response())
}

fn agents_store(st: &AppState) -> Result<&milim_agents::AgentStore, ApiError> {
    st.agents
        .as_deref()
        .ok_or_else(|| ApiError(Error::InvalidRequest("agents are not enabled".to_string())))
}

fn thread_supervisor(st: &AppState) -> Result<Arc<ThreadSupervisor>, ApiError> {
    st.threads
        .as_ref()
        .cloned()
        .ok_or_else(|| ApiError(missing_threads_error()))
}

#[derive(Deserialize)]
pub(crate) struct ThreadReadQuery {
    #[serde(default)]
    include_events: bool,
    #[serde(default)]
    event_limit: Option<usize>,
    #[serde(default)]
    after_seq: Option<i64>,
}

const DEFAULT_THREAD_EVENT_LIMIT: usize = 1000;
const MAX_THREAD_EVENT_LIMIT: usize = 5000;

fn thread_event_limit(limit: usize) -> usize {
    limit.clamp(1, MAX_THREAD_EVENT_LIMIT)
}

#[derive(Deserialize)]
pub(crate) struct ThreadChildrenQuery {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
pub(crate) struct ThreadEventsQuery {
    #[serde(default)]
    after_seq: Option<i64>,
    #[serde(default)]
    event_limit: Option<usize>,
}

/// `GET /threads/{id}` - inspect one child thread.
pub(crate) async fn thread_get(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ThreadReadQuery>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let supervisor = thread_supervisor(&st)?;
    let thread = supervisor
        .get(&id)
        .map_err(ApiError)?
        .ok_or_else(|| ApiError(Error::ModelNotFound(format!("thread {id}"))))?;
    if query.include_events {
        let limit = thread_event_limit(query.event_limit.unwrap_or(DEFAULT_THREAD_EVENT_LIMIT));
        let events = if let Some(after_seq) = query.after_seq {
            supervisor
                .events_after(&id, after_seq.max(0), limit)
                .map_err(ApiError)?
        } else {
            supervisor.events(&id, limit).map_err(ApiError)?
        };
        let event_count = supervisor.event_count(&id).map_err(ApiError)?;
        Ok(Json(json!({
            "thread": thread,
            "events": events,
            "event_count": event_count,
            "events_truncated": event_count > events.len()
        }))
        .into_response())
    } else {
        Ok(Json(json!({ "thread": thread })).into_response())
    }
}

/// `GET /threads/{id}/children` - list children for a parent thread id.
pub(crate) async fn thread_children(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ThreadChildrenQuery>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let supervisor = thread_supervisor(&st)?;
    let threads = supervisor
        .children(
            &id,
            query.status.as_deref(),
            query.limit.unwrap_or(50).clamp(1, 50),
        )
        .map_err(ApiError)?;
    Ok(Json(json!({ "threads": threads })).into_response())
}

/// `GET /threads/{id}/events` - pushed child-thread supervisor events.
pub(crate) async fn thread_events(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ThreadEventsQuery>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let supervisor = thread_supervisor(&st)?;
    let mut events = supervisor.subscribe();
    let event_limit = thread_event_limit(query.event_limit.unwrap_or(DEFAULT_THREAD_EVENT_LIMIT));
    let initial_after_seq = query.after_seq.unwrap_or(0).max(0);
    let stream = async_stream::stream! {
        let mut last_seq = initial_after_seq;
        if let Ok(backfill) = supervisor.child_events_after(&id, last_seq, event_limit) {
            for (thread, event) in backfill {
                last_seq = last_seq.max(event.seq);
                let data = serde_json::to_string(&SupervisorEvent::ChildThreadEvent { thread, event })
                    .unwrap_or_else(|_| "{}".to_string());
                yield Ok::<Event, Infallible>(Event::default().data(data));
            }
        }
        loop {
            match events.recv().await {
                Ok(event) => {
                    if event.thread().parent_id != id {
                        continue;
                    }
                    if let SupervisorEvent::ChildThreadEvent { event: stored, .. } = &event {
                        if stored.seq <= last_seq {
                            continue;
                        }
                        last_seq = stored.seq;
                    }
                    let data = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
                    yield Ok::<Event, Infallible>(Event::default().data(data));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if let Ok(backfill) = supervisor.child_events_after(&id, last_seq, event_limit) {
                        for (thread, event) in backfill {
                            last_seq = last_seq.max(event.seq);
                            let data = serde_json::to_string(&SupervisorEvent::ChildThreadEvent { thread, event })
                                .unwrap_or_else(|_| "{}".to_string());
                            yield Ok::<Event, Infallible>(Event::default().data(data));
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

/// `POST /threads/{id}/stop` - stop a running child thread.
pub(crate) async fn thread_stop(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let supervisor = thread_supervisor(&st)?;
    let thread = supervisor
        .stop(&id)
        .map_err(ApiError)?
        .ok_or_else(|| ApiError(Error::ModelNotFound(format!("thread {id}"))))?;
    Ok(Json(json!({ "thread": thread })).into_response())
}

/// `DELETE /threads/{id}` - delete child-thread rows under a parent or child id.
pub(crate) async fn thread_delete(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let supervisor = thread_supervisor(&st)?;
    let deleted = supervisor.delete_tree(&id).map_err(ApiError)?;
    Ok(Json(json!({ "deleted": deleted.len() })).into_response())
}

// ----- Schedules -----

#[derive(Deserialize)]
pub(crate) struct CreateScheduleRequest {
    name: String,
    cron: String,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    attachments: Vec<milim_automation::ScheduleAttachment>,
}

#[derive(Deserialize)]
pub(crate) struct UpdateScheduleRequest {
    name: String,
    cron: String,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    attachments: Vec<milim_automation::ScheduleAttachment>,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    last_run: Option<i64>,
}

fn default_true() -> bool {
    true
}

/// `GET /schedules` — list cron schedules.
pub(crate) async fn schedules_list(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let schedules = match &st.schedules {
        Some(store) => store.list().map_err(ApiError)?,
        None => Vec::new(),
    };
    Ok(Json(json!({ "schedules": schedules })).into_response())
}

/// `POST /schedules` — create a cron schedule.
/// `GET /schedules/events` - drain completed background schedule runs.
pub(crate) async fn schedule_events(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    Ok(Json(json!({ "events": st.schedule_runs.take() })).into_response())
}

/// `POST /schedules` - create a cron schedule.
pub(crate) async fn schedule_create(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<CreateScheduleRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = st.schedules.as_deref().ok_or_else(|| {
        ApiError(Error::InvalidRequest(
            "schedules are not enabled".to_string(),
        ))
    })?;
    let schedule = store
        .create_with_attachments(
            &req.name,
            &req.cron,
            req.agent_id,
            &req.prompt,
            req.attachments,
        )
        .map_err(ApiError)?;
    Ok(Json(schedule).into_response())
}

/// `DELETE /schedules/{id}` — remove a schedule.
/// `PUT /schedules/{id}` - update a cron schedule.
pub(crate) async fn schedule_update(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<UpdateScheduleRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = st.schedules.as_deref().ok_or_else(|| {
        ApiError(Error::InvalidRequest(
            "schedules are not enabled".to_string(),
        ))
    })?;
    let schedule = store
        .update(milim_automation::ScheduleUpdate {
            id: &id,
            name: &req.name,
            cron: &req.cron,
            agent_id: req.agent_id,
            prompt: &req.prompt,
            attachments: req.attachments,
            enabled: req.enabled,
            last_run: req.last_run,
        })
        .map_err(ApiError)?;
    Ok(Json(schedule).into_response())
}

pub(crate) async fn schedule_delete(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = st.schedules.as_deref().ok_or_else(|| {
        ApiError(Error::InvalidRequest(
            "schedules are not enabled".to_string(),
        ))
    })?;
    if store.delete(&id).map_err(ApiError)? {
        Ok(Json(json!({ "deleted": true })).into_response())
    } else {
        Err(ApiError(Error::ModelNotFound(format!("schedule {id}"))))
    }
}

// ----- Skills -----

/// `GET /skills` — list skills.
pub(crate) async fn skills_list(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let skills = match &st.skills {
        Some(store) => store.list().map_err(ApiError)?,
        None => Vec::new(),
    };
    Ok(Json(json!({ "skills": skills })).into_response())
}

#[derive(Deserialize)]
pub(crate) struct CreateSkillRequest {
    #[serde(default)]
    skill_md: Option<String>,
    #[serde(default)]
    skill_url: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    instructions: Option<String>,
    #[serde(default)]
    source_kind: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default = "default_true")]
    enabled: bool,
}

#[derive(Deserialize)]
pub(crate) struct UpdateSkillRequest {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    instructions: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    source_kind: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct SelectSkillsRequest {
    query: String,
    #[serde(default = "default_skill_select_limit")]
    limit: usize,
}

fn default_skill_select_limit() -> usize {
    3
}

/// `POST /skills` — create a skill from a `SKILL.md` or explicit fields.
pub(crate) async fn skill_create(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<CreateSkillRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = st
        .skills
        .as_deref()
        .ok_or_else(|| ApiError(Error::InvalidRequest("skills are not enabled".to_string())))?;
    let skill = if let Some(md) = req.skill_md {
        store
            .create_from_md_with_source(
                &md,
                req.enabled,
                req.source_kind.as_deref().unwrap_or("pasted"),
                req.source_url,
            )
            .map_err(ApiError)?
    } else if let Some(url) = req.skill_url {
        let raw_url = github_skill_raw_url(&url).map_err(ApiError)?;
        let md = fetch_skill_md(&raw_url).await.map_err(ApiError)?;
        store
            .create_from_md_with_source(&md, req.enabled, "github", Some(url))
            .map_err(ApiError)?
    } else {
        let name = req.name.ok_or_else(|| {
            ApiError(Error::InvalidRequest(
                "missing 'name', 'skill_md', or 'skill_url'".to_string(),
            ))
        })?;
        store
            .create_with_source(
                &name,
                req.description.as_deref().unwrap_or(""),
                req.instructions.as_deref().unwrap_or(""),
                req.enabled,
                req.source_kind.as_deref().unwrap_or("manual"),
                req.source_url,
            )
            .map_err(ApiError)?
    };
    Ok(Json(skill).into_response())
}

/// `POST /skills/select` - keyword-select enabled skills for a query.
pub(crate) async fn skills_select(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<SelectSkillsRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = st
        .skills
        .as_deref()
        .ok_or_else(|| ApiError(Error::InvalidRequest("skills are not enabled".to_string())))?;
    let skills = store
        .select(&req.query, req.limit.clamp(1, 10))
        .map_err(ApiError)?;
    Ok(Json(json!({ "skills": skills })).into_response())
}

/// `GET /skills/{id}` — fetch one skill.
pub(crate) async fn skill_get(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = st
        .skills
        .as_deref()
        .ok_or_else(|| ApiError(Error::InvalidRequest("skills are not enabled".to_string())))?;
    let skill = store
        .get(&id)
        .map_err(ApiError)?
        .ok_or_else(|| ApiError(Error::ModelNotFound(format!("skill {id}"))))?;
    Ok(Json(skill).into_response())
}

/// `PUT /skills/{id}` - update one skill.
pub(crate) async fn skill_update(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<UpdateSkillRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = st
        .skills
        .as_deref()
        .ok_or_else(|| ApiError(Error::InvalidRequest("skills are not enabled".to_string())))?;
    if req.name.trim().is_empty() {
        return Err(ApiError(Error::InvalidRequest(
            "skill name is required".to_string(),
        )));
    }
    let skill = store
        .update(&milim_skills::SkillDef {
            id: id.clone(),
            name: req.name.trim().to_string(),
            description: req.description.trim().to_string(),
            instructions: req.instructions,
            enabled: req.enabled,
            source_kind: req.source_kind.unwrap_or_else(|| "manual".to_string()),
            source_url: req.source_url,
            updated_at: String::new(),
        })
        .map_err(ApiError)?
        .ok_or_else(|| ApiError(Error::ModelNotFound(format!("skill {id}"))))?;
    Ok(Json(skill).into_response())
}

/// `DELETE /skills/{id}` - delete one skill.
pub(crate) async fn skill_delete(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let store = st
        .skills
        .as_deref()
        .ok_or_else(|| ApiError(Error::InvalidRequest("skills are not enabled".to_string())))?;
    Ok(Json(json!({ "deleted": store.delete(&id).map_err(ApiError)? })).into_response())
}

fn github_skill_raw_url(input: &str) -> Result<String, Error> {
    let parsed = reqwest::Url::parse(input.trim())
        .map_err(|e| Error::InvalidRequest(format!("invalid skill URL: {e}")))?;
    if parsed.scheme() != "https" {
        return Err(Error::InvalidRequest("skill URL must be https".to_string()));
    }
    let host = parsed.host_str().unwrap_or_default();
    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    if host == "raw.githubusercontent.com" {
        if segments.len() >= 5 && segments.last() == Some(&"SKILL.md") {
            return Ok(parsed.to_string());
        }
        return Err(Error::InvalidRequest(
            "raw GitHub skill URL must point to SKILL.md".to_string(),
        ));
    }

    if host != "github.com" || segments.len() < 5 {
        return Err(Error::InvalidRequest(
            "only GitHub SKILL.md URLs are supported".to_string(),
        ));
    }

    let owner = segments[0];
    let repo = segments[1];
    let kind = segments[2];
    let branch = segments[3];
    let mut path = segments[4..].join("/");
    match kind {
        "blob" if path.ends_with("SKILL.md") => {}
        "tree" => {
            if !path.ends_with("SKILL.md") {
                path = format!("{}/SKILL.md", path.trim_end_matches('/'));
            }
        }
        _ => {
            return Err(Error::InvalidRequest(
                "GitHub skill URL must be a blob or tree path to SKILL.md".to_string(),
            ));
        }
    }
    Ok(format!(
        "https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"
    ))
}

async fn fetch_skill_md(raw_url: &str) -> Result<String, Error> {
    let response = reqwest::Client::new()
        .get(raw_url)
        .header(USER_AGENT, "milim-skill-import")
        .send()
        .await
        .map_err(|e| Error::Other(format!("failed to fetch skill: {e}")))?;
    if !response.status().is_success() {
        return Err(Error::InvalidRequest(format!(
            "failed to fetch skill: HTTP {}",
            response.status()
        )));
    }
    let text = response
        .text()
        .await
        .map_err(|e| Error::Other(format!("failed to read skill: {e}")))?;
    if text.len() > 256 * 1024 {
        return Err(Error::InvalidRequest(
            "skill is too large; maximum is 256 KiB".to_string(),
        ));
    }
    if !text.contains("name:") {
        return Err(Error::InvalidRequest(
            "fetched file does not look like SKILL.md".to_string(),
        ));
    }
    Ok(text)
}

#[cfg(test)]
mod skill_import_tests {
    use super::github_skill_raw_url;

    #[test]
    fn github_blob_skill_url_becomes_raw() {
        assert_eq!(
            github_skill_raw_url("https://github.com/acme/skills/blob/main/review/SKILL.md")
                .unwrap(),
            "https://raw.githubusercontent.com/acme/skills/main/review/SKILL.md"
        );
    }

    #[test]
    fn github_tree_skill_url_appends_skill_md() {
        assert_eq!(
            github_skill_raw_url("https://github.com/acme/skills/tree/main/review").unwrap(),
            "https://raw.githubusercontent.com/acme/skills/main/review/SKILL.md"
        );
    }

    #[test]
    fn rejects_non_github_or_non_skill_urls() {
        assert!(github_skill_raw_url("https://example.com/SKILL.md").is_err());
        assert!(
            github_skill_raw_url("https://github.com/acme/skills/blob/main/README.md").is_err()
        );
    }
}

// ----- Sandbox -----

#[derive(Deserialize)]
pub(crate) struct SandboxRunRequest {
    image: String,
    command: Vec<String>,
    #[serde(default)]
    network: bool,
}

/// `POST /sandbox/run` — run a command in an isolated container.
pub(crate) async fn sandbox_run(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<SandboxRunRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let backend = milim_sandbox::DockerBackend::new();
    let opts = milim_sandbox::RunOpts {
        network: req.network,
        ..Default::default()
    };
    let out = backend
        .run(&req.image, &req.command, &opts)
        .await
        .map_err(ApiError)?;
    Ok(Json(out).into_response())
}

// ----- Privacy -----

#[derive(Deserialize)]
pub(crate) struct PrivacyScanRequest {
    text: String,
}

/// `POST /privacy/scan` — detect + redact PII in `text`.
pub(crate) async fn privacy_scan(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<PrivacyScanRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let detections = st.privacy.scan_text(&req.text);
    let redaction = st.privacy.redact_text(&req.text);
    Ok(Json(json!({
        "clean": st.privacy.is_clean_text(&req.text),
        "detections": detections,
        "redacted": redaction.text,
        "map": redaction.map,
    }))
    .into_response())
}

#[derive(Deserialize)]
pub(crate) struct PrivacyModeSet {
    mode: String,
}

/// `GET /privacy/mode` — the current outbound privacy gate mode.
pub(crate) async fn privacy_mode_get(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    Ok(Json(json!({ "mode": st.privacy.mode().as_str() })).into_response())
}

/// `POST /privacy/mode` — set the outbound gate (`off` | `redact` | `block`).
/// Applies to requests routed to a remote provider; local backends are exempt.
pub(crate) async fn privacy_mode_set(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<PrivacyModeSet>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let mode = crate::privacy::PrivacyMode::parse(&req.mode);
    st.privacy.set(mode);
    Ok(Json(json!({ "mode": mode.as_str() })).into_response())
}

// ----- Memory -----

fn memory_store(st: &AppState) -> Result<&milim_memory::MemoryStore, ApiError> {
    st.memory
        .as_deref()
        .ok_or_else(|| ApiError(Error::InvalidRequest("memory is not enabled".to_string())))
}

fn default_memory_model() -> String {
    "default".to_string()
}

fn default_top_k() -> usize {
    5
}

#[derive(Deserialize)]
pub(crate) struct MemoryIngestRequest {
    #[serde(default = "default_memory_model")]
    model: String,
    text: String,
}

/// `POST /memory/ingest` — embed and store a memory.
pub(crate) async fn memory_ingest(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<MemoryIngestRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let mem = memory_store(&st)?;
    let id = mem.add(&req.model, &req.text).await.map_err(ApiError)?;
    Ok(Json(json!({ "id": id })).into_response())
}

#[derive(Deserialize)]
pub(crate) struct MemorySearchRequest {
    #[serde(default = "default_memory_model")]
    model: String,
    query: String,
    #[serde(default = "default_top_k")]
    top_k: usize,
}

#[derive(Serialize)]
struct MemorySearchResponse {
    hits: Vec<milim_memory::MemoryHit>,
}

/// `POST /memory/search` — return the most similar stored memories.
pub(crate) async fn memory_search(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<MemorySearchRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let mem = memory_store(&st)?;
    let hits = mem
        .search(&req.model, &req.query, req.top_k)
        .await
        .map_err(ApiError)?;
    Ok(Json(MemorySearchResponse { hits }).into_response())
}

#[derive(Deserialize)]
pub(crate) struct MemoryRegisterRequest {
    #[serde(default = "default_memory_model")]
    model: String,
    scope: milim_memory::MemoryScopeInput,
    node: milim_memory::MemoryNodeInput,
    #[serde(default)]
    edges: Vec<milim_memory::MemoryEdgeInput>,
    #[serde(default)]
    event: milim_memory::MemoryEventInput,
}

/// `POST /memory/register` — create a scoped graph memory.
pub(crate) async fn memory_register(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<MemoryRegisterRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let mem = memory_store(&st)?;
    let registration = mem
        .register(&req.model, req.scope, req.node, req.edges, req.event)
        .await
        .map_err(ApiError)?;
    Ok(Json(registration).into_response())
}

#[derive(Deserialize)]
pub(crate) struct MemoryGraphSearchRequest {
    #[serde(default = "default_memory_model")]
    model: String,
    query: String,
    #[serde(default = "default_top_k")]
    top_k: usize,
    #[serde(default)]
    scopes: Vec<milim_memory::MemoryScopeRef>,
    #[serde(default)]
    include_archived: bool,
}

#[derive(Serialize)]
struct MemoryGraphSearchResponse {
    hits: Vec<milim_memory::MemoryGraphHit>,
}

/// `POST /memory/graph/search` — semantic search over scoped graph memories.
pub(crate) async fn memory_graph_search(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<MemoryGraphSearchRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let mem = memory_store(&st)?;
    let hits = mem
        .search_graph(
            &req.model,
            &req.query,
            &req.scopes,
            req.top_k,
            req.include_archived,
        )
        .await
        .map_err(ApiError)?;
    Ok(Json(MemoryGraphSearchResponse { hits }).into_response())
}

/// `GET /memory/scopes` — list thread/project/global memory scopes.
pub(crate) async fn memory_scopes(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let scopes = memory_store(&st)?.list_scopes().map_err(ApiError)?;
    Ok(Json(json!({ "scopes": scopes })).into_response())
}

#[derive(Deserialize)]
pub(crate) struct MemoryNodesQuery {
    #[serde(default)]
    scope_kind: Option<String>,
    #[serde(default)]
    scope_locator: Option<String>,
    #[serde(default)]
    include_archived: bool,
    #[serde(default = "default_memory_node_limit")]
    limit: usize,
}

fn default_memory_node_limit() -> usize {
    100
}

/// `GET /memory/nodes` — list graph memory nodes, optionally scoped.
pub(crate) async fn memory_nodes(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Query(query): Query<MemoryNodesQuery>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let scope = match (query.scope_kind, query.scope_locator) {
        (Some(kind), Some(locator)) if !kind.trim().is_empty() && !locator.trim().is_empty() => {
            Some(milim_memory::MemoryScopeRef { kind, locator })
        }
        _ => None,
    };
    let nodes = memory_store(&st)?
        .list_nodes(scope, query.include_archived, query.limit)
        .map_err(ApiError)?;
    Ok(Json(json!({ "nodes": nodes })).into_response())
}

#[derive(Deserialize)]
pub(crate) struct MemoryNodeUpdateRequest {
    #[serde(default = "default_memory_model")]
    model: String,
    #[serde(flatten)]
    update: milim_memory::MemoryNodeUpdate,
}

/// `PUT /memory/nodes/{id}` — update one graph memory node.
pub(crate) async fn memory_node_update(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<MemoryNodeUpdateRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let node = memory_store(&st)?
        .update_node(&req.model, &id, req.update)
        .await
        .map_err(ApiError)?
        .ok_or_else(|| ApiError(Error::ModelNotFound(format!("memory node {id}"))))?;
    Ok(Json(node).into_response())
}

/// `DELETE /memory/nodes/{id}` — delete one graph memory node.
pub(crate) async fn memory_node_delete(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let deleted = memory_store(&st)?.delete_node(&id).map_err(ApiError)?;
    Ok(Json(json!({ "deleted": deleted })).into_response())
}

/// `POST /memory/nodes/{id}/archive` — hide one graph memory node without deleting it.
pub(crate) async fn memory_node_archive(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    peer: Peer,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let archived = memory_store(&st)?.archive_node(&id).map_err(ApiError)?;
    Ok(Json(json!({ "archived": archived })).into_response())
}

// ----- Embeddings -----

#[derive(Deserialize)]
#[serde(untagged)]
enum EmbedInput {
    One(String),
    Many(Vec<String>),
}

impl EmbedInput {
    fn into_vec(self) -> Vec<String> {
        match self {
            EmbedInput::One(s) => vec![s],
            EmbedInput::Many(v) => v,
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct OpenAiEmbeddingRequest {
    model: String,
    input: EmbedInput,
}

#[derive(Serialize)]
struct OpenAiEmbeddingItem {
    object: &'static str,
    embedding: Vec<f32>,
    index: usize,
}

#[derive(Serialize)]
struct OpenAiEmbeddingResponse {
    object: &'static str,
    data: Vec<OpenAiEmbeddingItem>,
    model: String,
    usage: Usage,
}

/// `POST /v1/embeddings` and `/embeddings`
pub(crate) async fn openai_embeddings(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<OpenAiEmbeddingRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let inputs = req.input.into_vec();
    let prompt_tokens = inputs
        .iter()
        .map(|s| s.split_whitespace().count() as u32)
        .sum();
    let vectors = st
        .service
        .embed(&req.model, inputs)
        .await
        .map_err(ApiError)?;
    let data = vectors
        .into_iter()
        .enumerate()
        .map(|(index, embedding)| OpenAiEmbeddingItem {
            object: "embedding",
            embedding,
            index,
        })
        .collect();
    Ok(Json(OpenAiEmbeddingResponse {
        object: "list",
        data,
        model: req.model,
        usage: Usage::new(prompt_tokens, 0),
    })
    .into_response())
}

#[derive(Deserialize)]
pub(crate) struct OllamaEmbedRequest {
    model: String,
    input: EmbedInput,
}

#[derive(Serialize)]
struct OllamaEmbedResponse {
    model: String,
    embeddings: Vec<Vec<f32>>,
}

/// `POST /api/embed` and `/api/embeddings` (Ollama)
pub(crate) async fn ollama_embeddings(
    State(st): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    Json(req): Json<OllamaEmbedRequest>,
) -> Result<Response, ApiError> {
    authorize(&st, &headers, peer_addr(peer))?;
    let embeddings = st
        .service
        .embed(&req.model, req.input.into_vec())
        .await
        .map_err(ApiError)?;
    Ok(Json(OllamaEmbedResponse {
        model: req.model,
        embeddings,
    })
    .into_response())
}
