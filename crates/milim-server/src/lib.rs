//! `milim-server` — the axum HTTP server exposing the public API contract.
//!
//! Mirrors milim's OpenAI/Ollama-compatible surface so existing clients work
//! unchanged: streamed and non-streamed chat completions, model listing, and
//! embeddings, with bearer auth + loopback trust, CORS, and a body-size cap.

mod auth;
mod claude_bridge;
mod codex_bridge;
pub mod companion;
mod error;
pub mod mcp_bridge;
pub mod preview_runtime;
pub mod privacy;
pub mod providers;
mod routes;
mod sse;
mod state;
pub mod threads;
mod translate;

use std::future::Future;
use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::routing::{delete, get, post, put};
use axum::Router;

use milim_core::api::openai::ChatMessage;
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;

pub use state::AppState;

/// Assemble the application router with all routes and middleware.
pub fn build_router(state: AppState) -> Router {
    let body_limit = state.config.max_request_body_bytes;
    let cors = build_cors(&state.config.allowed_origins);

    Router::new()
        .route("/health", get(routes::health))
        // Mobile companion: phone capture and active-thread mirror.
        .route("/mobile", get(routes::mobile_companion_page))
        .route("/mobile/", get(routes::mobile_companion_page))
        .route(
            "/mobile/manifest.webmanifest",
            get(routes::mobile_companion_manifest),
        )
        .route(
            "/mobile/sw.js",
            get(routes::mobile_companion_service_worker),
        )
        .route("/mobile/icon.svg", get(routes::mobile_companion_icon))
        .route("/mobile/icon.png", get(routes::mobile_companion_icon_png))
        .route(
            "/mobile/wordmark.svg",
            get(routes::mobile_companion_wordmark),
        )
        .route("/mobile/status", get(routes::mobile_companion_status))
        .route("/mobile/enabled", post(routes::mobile_companion_enabled))
        .route("/mobile/pairing", post(routes::mobile_companion_pairing))
        .route("/mobile/pair", post(routes::mobile_companion_pair))
        .route(
            "/mobile/device/status",
            get(routes::mobile_companion_device_status),
        )
        .route("/mobile/relay", post(routes::mobile_companion_relay))
        .route(
            "/mobile/thread",
            get(routes::mobile_companion_thread).post(routes::mobile_companion_thread_update),
        )
        .route(
            "/mobile/thread/events",
            get(routes::mobile_companion_thread_events),
        )
        .route("/mobile/events", get(routes::mobile_companion_events))
        .route(
            "/mobile/devices/{id}",
            delete(routes::mobile_companion_device_revoke),
        )
        // Model listing (OpenAI + Ollama)
        .route("/v1/models", get(routes::openai_models))
        .route("/models", get(routes::openai_models))
        .route("/audio/transcriptions", post(routes::audio_transcriptions))
        .route("/audio/vad", post(routes::audio_vad))
        .route("/audio/speech", post(routes::audio_speech))
        .route("/audio/setup/check", post(routes::audio_setup_check))
        .route(
            "/audio/piper/presets/download",
            post(routes::audio_piper_preset_download),
        )
        .route(
            "/audio/kokoro/presets/download",
            post(routes::audio_kokoro_preset_download),
        )
        .route(
            "/audio/vad/presets/download",
            post(routes::audio_vad_preset_download),
        )
        .route(
            "/audio/piper/executable/install",
            post(routes::audio_piper_executable_install),
        )
        // Provider registry (OpenAI-compatible remotes)
        .route(
            "/providers",
            get(routes::providers_list).post(routes::provider_upsert),
        )
        .route("/providers/discover", get(routes::providers_discover))
        .route("/providers/{id}", delete(routes::provider_delete))
        // Media generation through encrypted remote provider credentials
        .route("/media/models", get(routes::media_models))
        .route("/media/model-schema", get(routes::media_model_schema))
        .route("/media/status", get(routes::media_status))
        .route("/media/generate", post(routes::media_generate))
        // Host working folder (drives the filesystem/shell tools)
        .route(
            "/workspace",
            get(routes::workspace_get).post(routes::workspace_set),
        )
        .route("/workspace/git", get(routes::workspace_git_status))
        .route("/workspace/git/action", post(routes::workspace_git_action))
        // Managed preview apps for no-folder chat artifacts.
        .route("/preview-apps/{thread_id}", get(routes::preview_app_get))
        .route(
            "/preview-apps/{thread_id}/stage",
            post(routes::preview_app_stage),
        )
        .route(
            "/preview-apps/{thread_id}/start",
            post(routes::preview_app_start),
        )
        .route(
            "/preview-apps/{thread_id}/stop",
            post(routes::preview_app_stop),
        )
        .route(
            "/preview-apps/{thread_id}/restart",
            post(routes::preview_app_restart),
        )
        .route(
            "/preview-apps/{thread_id}/logs",
            get(routes::preview_app_logs),
        )
        // Computer-use gate (screen capture + mouse/keyboard)
        .route(
            "/computer",
            get(routes::computer_get).post(routes::computer_set),
        )
        .route("/api/tags", get(routes::ollama_tags))
        // Chat completions
        .route("/v1/chat/completions", post(routes::openai_chat))
        .route("/chat/completions", post(routes::openai_chat))
        .route("/v1/completions", post(routes::openai_completions))
        .route("/completions", post(routes::openai_completions))
        .route("/v1/responses", post(routes::openai_responses))
        .route("/api/chat", post(routes::ollama_chat))
        .route("/api/generate", post(routes::ollama_generate))
        // Anthropic Messages
        .route("/anthropic/v1/messages", post(routes::anthropic_messages))
        .route("/anthropic/messages", post(routes::anthropic_messages))
        .route("/v1/messages", post(routes::anthropic_messages))
        // Codex app-server bridge (separate from OpenAI-compatible providers)
        .route("/codex/account", get(routes::codex_account))
        .route("/codex/login/device", post(routes::codex_login_device))
        .route(
            "/codex/login/chatgpt-device",
            post(routes::codex_login_chatgpt_device),
        )
        .route("/codex/login/api-key", post(routes::codex_login_api_key))
        .route("/codex/logout", post(routes::codex_logout))
        .route("/codex/rate-limits", get(routes::codex_rate_limits))
        .route("/codex/models", get(routes::codex_models))
        .route("/codex/run", post(routes::codex_run))
        // Claude Code CLI bridge (separate from Anthropic API-key providers)
        .route("/claude/status", get(routes::claude_status))
        .route("/claude/run", post(routes::claude_run))
        // MCP tools (server bridge: exposes our tools to MCP clients)
        .route("/mcp/tools", get(routes::mcp_tools))
        .route("/mcp/call", post(routes::mcp_call))
        // MCP client: external MCP servers whose tools we consume
        .route(
            "/mcp/servers",
            get(routes::mcp_servers_list).post(routes::mcp_server_upsert),
        )
        .route("/mcp/servers/{id}", delete(routes::mcp_server_delete))
        // Agents (server-side tool-use loop + named agents)
        .route("/agents/run", post(routes::agents_run))
        .route(
            "/agents",
            get(routes::agents_list).post(routes::agent_create),
        )
        .route(
            "/agents/{id}",
            get(routes::agent_get)
                .put(routes::agent_update)
                .delete(routes::agent_delete),
        )
        .route("/agents/{id}/run", post(routes::agent_run_by_id))
        .route(
            "/threads/{id}",
            get(routes::thread_get).delete(routes::thread_delete),
        )
        .route("/threads/{id}/children", get(routes::thread_children))
        .route("/threads/{id}/events", get(routes::thread_events))
        .route("/threads/{id}/stop", post(routes::thread_stop))
        // Memory / RAG
        .route("/memory/ingest", post(routes::memory_ingest))
        .route("/memory/search", post(routes::memory_search))
        .route("/memory/register", post(routes::memory_register))
        .route("/memory/graph/search", post(routes::memory_graph_search))
        .route("/memory/scopes", get(routes::memory_scopes))
        .route("/memory/nodes", get(routes::memory_nodes))
        .route(
            "/memory/nodes/{id}",
            put(routes::memory_node_update).delete(routes::memory_node_delete),
        )
        .route(
            "/memory/nodes/{id}/archive",
            post(routes::memory_node_archive),
        )
        // Privacy filter
        .route("/privacy/scan", post(routes::privacy_scan))
        .route(
            "/privacy/mode",
            get(routes::privacy_mode_get).post(routes::privacy_mode_set),
        )
        // Sandbox (isolated command execution)
        .route("/sandbox/run", post(routes::sandbox_run))
        // Skills
        .route(
            "/skills",
            get(routes::skills_list).post(routes::skill_create),
        )
        .route("/skills/select", post(routes::skills_select))
        .route(
            "/skills/{id}",
            get(routes::skill_get)
                .put(routes::skill_update)
                .delete(routes::skill_delete),
        )
        // Schedules (cron)
        .route(
            "/schedules",
            get(routes::schedules_list).post(routes::schedule_create),
        )
        .route("/schedules/events", get(routes::schedule_events))
        .route(
            "/schedules/{id}",
            put(routes::schedule_update).delete(routes::schedule_delete),
        )
        // Embeddings
        .route("/v1/embeddings", post(routes::openai_embeddings))
        .route("/embeddings", post(routes::openai_embeddings))
        .route("/api/embed", post(routes::ollama_embeddings))
        .route("/api/embeddings", post(routes::ollama_embeddings))
        // Middleware (applied outermost-first)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .layer(RequestBodyLimitLayer::new(body_limit))
        .with_state(state)
}

/// Assemble the phone-facing companion router only. This is intentionally
/// narrower than the local API so it can be exposed through Tailscale Serve.
pub fn build_mobile_companion_router(state: AppState) -> Router {
    let body_limit = state.config.max_request_body_bytes;

    Router::new()
        .route("/mobile", get(routes::mobile_companion_page))
        .route("/mobile/", get(routes::mobile_companion_page))
        .route(
            "/mobile/manifest.webmanifest",
            get(routes::mobile_companion_manifest),
        )
        .route(
            "/mobile/sw.js",
            get(routes::mobile_companion_service_worker),
        )
        .route("/mobile/icon.svg", get(routes::mobile_companion_icon))
        .route("/mobile/icon.png", get(routes::mobile_companion_icon_png))
        .route(
            "/mobile/wordmark.svg",
            get(routes::mobile_companion_wordmark),
        )
        .route("/mobile/pair", post(routes::mobile_companion_pair))
        .route(
            "/mobile/device/status",
            get(routes::mobile_companion_device_status),
        )
        .route("/mobile/relay", post(routes::mobile_companion_relay))
        .route("/mobile/thread", get(routes::mobile_companion_thread))
        .route(
            "/mobile/thread/events",
            get(routes::mobile_companion_thread_events),
        )
        .layer(TraceLayer::new_for_http())
        .layer(RequestBodyLimitLayer::new(body_limit))
        .with_state(state)
}

/// Serve on a freshly-bound socket at `addr`.
pub async fn serve(state: AppState, addr: SocketAddr) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    serve_listener(state, listener).await
}

/// Serve on an already-bound listener (lets callers learn the port first).
pub async fn serve_listener(
    state: AppState,
    listener: tokio::net::TcpListener,
) -> std::io::Result<()> {
    serve_listener_with_graceful_shutdown(state, listener, shutdown_signal()).await
}

/// Serve on an already-bound listener with a caller-provided shutdown signal.
pub async fn serve_listener_with_graceful_shutdown<S>(
    state: AppState,
    listener: tokio::net::TcpListener,
    shutdown: S,
) -> std::io::Result<()>
where
    S: Future<Output = ()> + Send + 'static,
{
    let app = build_router(state.clone());
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(with_graceful_shutdown(state, shutdown))
    .await
}

/// Await a shutdown signal and stop active child threads before the server exits.
pub async fn with_graceful_shutdown<S>(state: AppState, shutdown: S)
where
    S: Future<Output = ()>,
{
    shutdown.await;
    if let Some(threads) = state.threads.as_ref() {
        if let Err(err) = threads.stop_running_children("stopped by server shutdown") {
            tracing::warn!("failed to stop child threads during shutdown: {err}");
        }
    }
}

async fn shutdown_signal() {
    if let Err(err) = tokio::signal::ctrl_c().await {
        tracing::warn!("failed to install Ctrl-C shutdown handler: {err}");
        std::future::pending::<()>().await;
    }
}

/// Serve only the phone-facing companion surface on an already-bound listener.
pub async fn serve_mobile_companion_listener(
    state: AppState,
    listener: tokio::net::TcpListener,
) -> std::io::Result<()> {
    let app = build_mobile_companion_router(state);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
}

/// Build a CORS layer. An empty allow-list yields a permissive dev policy
/// (loopback tooling); a non-empty list restricts to those origins.
fn build_cors(origins: &[String]) -> CorsLayer {
    if origins.is_empty() {
        return CorsLayer::new();
    }
    let allow = origins
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect::<Vec<axum::http::HeaderValue>>();
    CorsLayer::new()
        .allow_origin(allow)
        .allow_methods(Any)
        .allow_headers(Any)
}

/// Current unix time in whole seconds.
pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Current time formatted as RFC-3339 (for Ollama `created_at`).
pub fn rfc3339_now() -> String {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Generate a response id like `chatcmpl-<hex>`.
pub fn gen_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

pub(crate) fn agent_skill_messages(
    state: &AppState,
    agent: &milim_agents::AgentDef,
    query: &str,
) -> Vec<ChatMessage> {
    let Some(store) = state.skills.as_ref() else {
        return Vec::new();
    };
    let skills = match milim_agents::normalize_skill_mode(&agent.skill_mode, &agent.enabled_skills)
        .as_str()
    {
        "none" => Vec::new(),
        "custom" => agent
            .enabled_skills
            .iter()
            .filter_map(|id| store.get(id).ok().flatten())
            .filter(|skill| skill.enabled)
            .collect(),
        _ => store.select(query, 3).unwrap_or_default(),
    };
    skill_instruction_message(&skills).into_iter().collect()
}

fn skill_instruction_message(skills: &[milim_skills::SkillDef]) -> Option<ChatMessage> {
    let body = skills
        .iter()
        .filter(|skill| skill.enabled)
        .map(|skill| {
            format!(
                "## {}\nWhen to use: {}\nInstructions:\n{}",
                skill.name, skill.description, skill.instructions
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    if body.trim().is_empty() {
        return None;
    }
    Some(ChatMessage::text(
        "system",
        format!(
            "Use these installed skills when relevant. Follow their instructions only if they help with the user's current request.\n\n{body}"
        ),
    ))
}

/// Run any schedules due at `now_unix` once, returning how many fired. Each
/// schedule runs its (optional) agent's tool-use loop with its prompt, then is
/// marked as run. Factored out from the loop so it's deterministically testable.
pub async fn fire_due(state: &AppState, now_unix: i64) -> usize {
    let Some(schedules) = state.schedules.as_ref() else {
        return 0;
    };
    let due = match schedules.due(now_unix) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("schedule due() failed: {e}");
            return 0;
        }
    };

    let mut fired = 0;
    for s in due {
        let mut messages = Vec::new();
        let mut model = "default".to_string();
        let prompt = milim_automation::prompt_with_attachments(&s.prompt, &s.attachments);
        if let Some(agent_id) = &s.agent_id {
            if let Some(agents) = &state.agents {
                if let Ok(Some(agent)) = agents.get(agent_id) {
                    if !agent.system_prompt.is_empty() {
                        messages.push(ChatMessage::text("system", agent.system_prompt.clone()));
                    }
                    messages.extend(agent_skill_messages(state, &agent, &prompt));
                    if !agent.model.is_empty() {
                        model = agent.model.clone();
                    }
                }
            }
        }
        messages.push(ChatMessage::text("user", prompt));

        let tools = routes::agent_registry(state);
        match milim_agents::run_agent(state.service.as_ref(), &tools, &model, messages, None).await
        {
            Ok(outcome) => {
                state.schedule_runs.push(state::ScheduleRunEvent {
                    id: format!("{}-{now_unix}-{fired}", s.id),
                    schedule_id: s.id.clone(),
                    schedule_name: s.name.clone(),
                    prompt: s.prompt.clone(),
                    response: outcome.message.text_content(),
                    model: model.clone(),
                    ran_at: now_unix,
                });
                let _ = schedules.mark_ran(&s.id, now_unix);
                fired += 1;
            }
            Err(e) => tracing::warn!("schedule {} failed: {e}", s.id),
        }
    }
    fired
}

/// Run the background scheduler loop (checks for due schedules every 30s).
pub async fn scheduler_loop(state: AppState) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        ticker.tick().await;
        let n = fire_due(&state, now_unix() as i64).await;
        if n > 0 {
            tracing::info!("scheduler fired {n} run(s)");
        }
    }
}

/// Spawn the background scheduler loop on the currently entered Tokio runtime.
pub fn spawn_scheduler(state: AppState) {
    tokio::spawn(scheduler_loop(state));
}

#[cfg(test)]
mod tests {
    use super::*;

    use milim_core::config::ServerConfiguration;
    use milim_inference::test_backend::TestBackend;
    use milim_storage::Database;
    use std::sync::Arc;

    #[test]
    fn agent_skill_messages_respect_agent_mode() {
        let store = milim_skills::SkillStore::new(Database::open_in_memory().unwrap()).unwrap();
        let skill = store
            .create("Review", "Use for review", "Check regressions first.")
            .unwrap();
        let state = AppState::new(Arc::new(TestBackend::new()), ServerConfiguration::default())
            .with_skills(store);
        let mut agent = milim_agents::AgentDef {
            id: "agent-1".to_string(),
            name: "Reviewer".to_string(),
            system_prompt: String::new(),
            model: "test-echo".to_string(),
            tool_mode: "all".to_string(),
            enabled_tools: Vec::new(),
            skill_mode: "custom".to_string(),
            enabled_skills: vec![skill.id],
            avatar: String::new(),
        };

        let messages = agent_skill_messages(&state, &agent, "please review");
        assert_eq!(messages.len(), 1);
        assert!(messages[0]
            .text_content()
            .contains("Check regressions first."));

        agent.skill_mode = "none".to_string();
        assert!(agent_skill_messages(&state, &agent, "please review").is_empty());
    }
}
