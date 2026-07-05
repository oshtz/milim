//! Multi-provider LLM routing.
//!
//! A registry of OpenAI-compatible providers (OpenAI, OpenRouter, Groq, local
//! Ollama / LM Studio, …) whose API keys are stored **encrypted at rest**
//! (`milim-storage` AES-GCM), plus a [`ProviderRouter`] that dispatches each
//! request to whichever provider serves the requested model — falling back to
//! the default backend otherwise.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use milim_core::api::openai::{
    Model, ModelCapabilities, ModelPricing, ModelReasoningMetadata, ReasoningEffort,
};
use milim_core::{Error, Result};
use milim_inference::anthropic::AnthropicBackend;
use milim_inference::gemini::GeminiBackend;
use milim_inference::remote::RemoteBackend;
use milim_inference::{CompletionRequest, EventStream, ModelService, SharedService};
use milim_storage::EncryptedStore;

use crate::privacy::{self, PrivacyGate, PrivacyMode};

fn default_true() -> bool {
    true
}

/// Provider wire protocol.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    #[default]
    #[serde(rename = "openai_compatible", alias = "open_ai_compatible")]
    OpenAiCompatible,
    Anthropic,
    Gemini,
    Replicate,
    Fal,
}

impl ProviderKind {
    pub fn is_chat(self) -> bool {
        matches!(
            self,
            ProviderKind::OpenAiCompatible | ProviderKind::Anthropic | ProviderKind::Gemini
        )
    }
}

/// A configured provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: ProviderKind,
    /// Base URL including the version segment, e.g. `https://api.openai.com/v1`.
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Model ids the provider serves (cached on add/refresh).
    #[serde(default)]
    pub models: Vec<String>,
    /// Provider-supplied per-token pricing keyed by model id. Only trusted for
    /// OpenRouter, whose models API exposes prompt/completion prices.
    #[serde(default)]
    pub pricing: BTreeMap<String, ModelPricing>,
    /// Provider-supplied context/token limits keyed by model id.
    #[serde(default)]
    pub model_context: BTreeMap<String, ModelContextMetadata>,
    /// Provider-supplied or inferred reasoning controls keyed by model id.
    #[serde(default)]
    pub model_reasoning: BTreeMap<String, ModelReasoningMetadata>,
    /// Provider-supplied model capabilities keyed by model id.
    #[serde(default)]
    pub model_capabilities: BTreeMap<String, ModelCapabilities>,
    /// Last connection error from the model fetch (so the UI can explain an
    /// empty model list — e.g. server down, bad key, wrong URL).
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelContextMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_prompt_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_completion_tokens: Option<u32>,
}

struct Runtime {
    cfg: Provider,
    backend: SharedService,
}

fn backend_for(cfg: &Provider) -> SharedService {
    let api_key = cfg.api_key.clone().filter(|k| !k.is_empty());
    match cfg.kind {
        ProviderKind::OpenAiCompatible => Arc::new(RemoteBackend::new(
            cfg.name.clone(),
            cfg.base_url.clone(),
            api_key,
        )),
        ProviderKind::Anthropic => Arc::new(AnthropicBackend::new(
            cfg.name.clone(),
            cfg.base_url.clone(),
            api_key,
        )),
        ProviderKind::Gemini => Arc::new(GeminiBackend::new(
            cfg.name.clone(),
            cfg.base_url.clone(),
            api_key,
        )),
        ProviderKind::Replicate | ProviderKind::Fal => Arc::new(RemoteBackend::new(
            cfg.name.clone(),
            cfg.base_url.clone(),
            api_key,
        )),
    }
}

/// Encrypted on-disk persistence for the provider list (keys included).
struct ProviderStore {
    enc: EncryptedStore,
    path: std::path::PathBuf,
}

impl ProviderStore {
    fn open(dir: &Path) -> Self {
        let _ = std::fs::create_dir_all(dir);
        let key = read_or_make_key(&dir.join("providers.key"));
        Self {
            enc: EncryptedStore::from_key(&key),
            path: dir.join("providers.enc"),
        }
    }

    fn load(&self) -> Vec<Provider> {
        let Ok(blob) = std::fs::read(&self.path) else {
            return Vec::new();
        };
        let Ok(plain) = self.enc.decrypt(&blob) else {
            return Vec::new();
        };
        serde_json::from_slice(&plain).unwrap_or_default()
    }

    fn save(&self, providers: &[Provider]) {
        let plain = match serde_json::to_vec(providers) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("providers serialize failed: {e}");
                return;
            }
        };
        match self.enc.encrypt(&plain) {
            Ok(blob) => {
                if let Err(e) = std::fs::write(&self.path, blob) {
                    tracing::warn!("providers write failed: {e}");
                }
            }
            Err(e) => tracing::warn!("providers encrypt failed: {e}"),
        }
    }
}

fn read_or_make_key(path: &Path) -> [u8; 32] {
    if let Ok(b) = std::fs::read(path) {
        if b.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&b);
            return k;
        }
    }
    let k = EncryptedStore::random_key();
    let _ = std::fs::write(path, k);
    k
}

/// Live provider registry: the source of truth for the router + the CRUD API.
pub struct ProviderRegistry {
    inner: Arc<RwLock<Vec<Runtime>>>,
    local: SharedService,
    store: ProviderStore,
}

impl ProviderRegistry {
    /// Load persisted providers (with their cached model lists) from `dir`.
    /// Cheap + synchronous: model lists are refreshed on upsert, not here.
    pub fn open(dir: &Path, local: SharedService) -> Self {
        let store = ProviderStore::open(dir);
        let runtimes = store
            .load()
            .into_iter()
            .map(|cfg| Runtime {
                backend: backend_for(&cfg),
                cfg,
            })
            .collect();
        Self {
            inner: Arc::new(RwLock::new(runtimes)),
            local,
            store,
        }
    }

    /// A `ModelService` view that routes by model → provider, applying the
    /// outbound privacy `gate` to any request bound for a remote provider.
    pub fn router(&self, gate: Arc<PrivacyGate>) -> ProviderRouter {
        ProviderRouter {
            inner: self.inner.clone(),
            local: self.local.clone(),
            privacy: gate,
        }
    }

    /// All providers (keys included — callers redact before returning to UIs).
    pub async fn list(&self) -> Vec<Provider> {
        self.inner
            .read()
            .await
            .iter()
            .map(|r| r.cfg.clone())
            .collect()
    }

    /// Insert or update a provider, fetching its model list. Preserves the
    /// stored key when `cfg.api_key` is `None` (the UI omits it on edit).
    pub async fn upsert(&self, mut cfg: Provider) -> Provider {
        if cfg.api_key.is_none() {
            cfg.api_key = self
                .inner
                .read()
                .await
                .iter()
                .find(|r| r.cfg.id == cfg.id)
                .and_then(|r| r.cfg.api_key.clone());
        }
        let backend = backend_for(&cfg);
        if cfg.kind.is_chat() {
            match backend.list_models().await {
                Ok(ms) => {
                    let trust_pricing = is_openrouter_provider(&cfg);
                    cfg.model_context = collect_model_context(&ms);
                    cfg.model_reasoning = collect_model_reasoning(&ms, &cfg);
                    cfg.model_capabilities = collect_model_capabilities(&ms);
                    cfg.pricing = collect_pricing(&ms, trust_pricing);
                    cfg.models = ms.into_iter().map(|m| m.id).collect();
                    cfg.last_error = None;
                }
                Err(e) => {
                    cfg.models = Vec::new();
                    cfg.pricing = BTreeMap::new();
                    cfg.model_context = BTreeMap::new();
                    cfg.model_reasoning = BTreeMap::new();
                    cfg.model_capabilities = BTreeMap::new();
                    cfg.last_error = Some(e.to_string());
                }
            }
        } else {
            cfg.models = Vec::new();
            cfg.pricing = BTreeMap::new();
            cfg.model_context = BTreeMap::new();
            cfg.model_reasoning = BTreeMap::new();
            cfg.model_capabilities = BTreeMap::new();
            cfg.last_error = None;
        }

        let mut w = self.inner.write().await;
        if let Some(r) = w.iter_mut().find(|r| r.cfg.id == cfg.id) {
            r.cfg = cfg.clone();
            r.backend = backend;
        } else {
            w.push(Runtime {
                cfg: cfg.clone(),
                backend,
            });
        }
        self.store
            .save(&w.iter().map(|r| r.cfg.clone()).collect::<Vec<_>>());
        cfg
    }

    /// Re-fetch the model list for every enabled provider. Called at startup so
    /// providers populate (or surface a connection error) without a manual
    /// re-save — the T3-style "add a key, models light up" behavior.
    pub async fn refresh_all(&self) {
        let configs: Vec<Provider> = {
            let r = self.inner.read().await;
            r.iter()
                .filter(|rt| rt.cfg.enabled)
                .filter(|rt| rt.cfg.kind.is_chat())
                .map(|rt| rt.cfg.clone())
                .collect()
        };
        for cfg in configs {
            let backend = backend_for(&cfg);
            let (models, pricing, model_context, model_reasoning, model_capabilities, err) =
                match backend.list_models().await {
                    Ok(ms) => {
                        let model_context = collect_model_context(&ms);
                        let model_reasoning = collect_model_reasoning(&ms, &cfg);
                        let model_capabilities = collect_model_capabilities(&ms);
                        let pricing = collect_pricing(&ms, is_openrouter_provider(&cfg));
                        (
                            ms.into_iter().map(|m| m.id).collect::<Vec<_>>(),
                            pricing,
                            model_context,
                            model_reasoning,
                            model_capabilities,
                            None,
                        )
                    }
                    Err(e) => (
                        Vec::new(),
                        BTreeMap::new(),
                        BTreeMap::new(),
                        BTreeMap::new(),
                        BTreeMap::new(),
                        Some(e.to_string()),
                    ),
                };
            let mut w = self.inner.write().await;
            if let Some(rt) = w.iter_mut().find(|rt| rt.cfg.id == cfg.id) {
                rt.cfg.models = models;
                rt.cfg.pricing = pricing;
                rt.cfg.model_context = model_context;
                rt.cfg.model_reasoning = model_reasoning;
                rt.cfg.model_capabilities = model_capabilities;
                rt.cfg.last_error = err;
            }
        }
        let snapshot = self
            .inner
            .read()
            .await
            .iter()
            .map(|rt| rt.cfg.clone())
            .collect::<Vec<_>>();
        self.store.save(&snapshot);
    }

    /// Remove a provider. Returns whether one was removed.
    pub async fn delete(&self, id: &str) -> bool {
        let mut w = self.inner.write().await;
        let n = w.len();
        w.retain(|r| r.cfg.id != id);
        let removed = w.len() != n;
        if removed {
            self.store
                .save(&w.iter().map(|r| r.cfg.clone()).collect::<Vec<_>>());
        }
        removed
    }
}

fn is_openrouter_provider(provider: &Provider) -> bool {
    provider.kind == ProviderKind::OpenAiCompatible
        && (provider.name.trim().eq_ignore_ascii_case("openrouter")
            || provider
                .base_url
                .to_ascii_lowercase()
                .contains("openrouter.ai/"))
}

fn collect_pricing(models: &[Model], trusted: bool) -> BTreeMap<String, ModelPricing> {
    if !trusted {
        return BTreeMap::new();
    }
    models
        .iter()
        .filter_map(|model| {
            model
                .pricing
                .clone()
                .map(|pricing| (model.id.clone(), pricing))
        })
        .collect()
}

fn collect_model_context(models: &[Model]) -> BTreeMap<String, ModelContextMetadata> {
    models
        .iter()
        .filter_map(|model| {
            if model.context_length.is_none()
                && model.max_prompt_tokens.is_none()
                && model.max_completion_tokens.is_none()
            {
                return None;
            }
            Some((
                model.id.clone(),
                ModelContextMetadata {
                    context_length: model.context_length,
                    max_prompt_tokens: model.max_prompt_tokens,
                    max_completion_tokens: model.max_completion_tokens,
                },
            ))
        })
        .collect()
}

fn collect_model_capabilities(models: &[Model]) -> BTreeMap<String, ModelCapabilities> {
    models
        .iter()
        .filter_map(|model| {
            model
                .capabilities
                .clone()
                .map(|capabilities| (model.id.clone(), capabilities))
        })
        .collect()
}

fn collect_model_reasoning(
    models: &[Model],
    provider: &Provider,
) -> BTreeMap<String, ModelReasoningMetadata> {
    models
        .iter()
        .filter_map(|model| {
            let reasoning = model
                .reasoning
                .clone()
                .or_else(|| fallback_model_reasoning(provider, &model.id))?;
            Some((model.id.clone(), reasoning))
        })
        .collect()
}

fn fallback_model_context(provider: &Provider, model: &str) -> ModelContextMetadata {
    let id = model.to_ascii_lowercase();
    let context_length = match provider.kind {
        ProviderKind::Anthropic => Some(200_000),
        ProviderKind::Gemini => Some(32_768),
        ProviderKind::OpenAiCompatible => {
            if id.contains("gpt-4o")
                || id.contains("gpt-4.1")
                || id.starts_with("o1")
                || id.starts_with("o3")
                || id.contains("/o1")
                || id.contains("/o3")
            {
                Some(128_000)
            } else if id.contains("gpt-3.5") {
                Some(16_385)
            } else {
                Some(32_768)
            }
        }
        ProviderKind::Replicate | ProviderKind::Fal => None,
    };
    ModelContextMetadata {
        context_length,
        max_prompt_tokens: None,
        max_completion_tokens: None,
    }
}

fn fallback_model_reasoning(provider: &Provider, model: &str) -> Option<ModelReasoningMetadata> {
    let id = model.to_ascii_lowercase();
    match provider.kind {
        ProviderKind::Anthropic => {
            if id.contains("claude-4")
                || id.contains("claude-sonnet-4")
                || id.contains("claude-opus-4")
            {
                Some(reasoning_meta(
                    &[
                        ReasoningEffort::Low,
                        ReasoningEffort::Medium,
                        ReasoningEffort::High,
                        ReasoningEffort::Xhigh,
                        ReasoningEffort::Max,
                    ],
                    Some(ReasoningEffort::High),
                    true,
                    true,
                ))
            } else {
                None
            }
        }
        ProviderKind::Gemini => {
            if id.contains("gemini-3") {
                Some(reasoning_meta(
                    &[
                        ReasoningEffort::Low,
                        ReasoningEffort::Medium,
                        ReasoningEffort::High,
                    ],
                    Some(ReasoningEffort::High),
                    true,
                    true,
                ))
            } else if id.contains("gemini-2.5-flash") {
                Some(reasoning_meta(
                    &[
                        ReasoningEffort::None,
                        ReasoningEffort::Minimal,
                        ReasoningEffort::Low,
                        ReasoningEffort::Medium,
                        ReasoningEffort::High,
                        ReasoningEffort::Xhigh,
                    ],
                    None,
                    true,
                    false,
                ))
            } else if id.contains("gemini-2.5") {
                Some(reasoning_meta(
                    &[
                        ReasoningEffort::Minimal,
                        ReasoningEffort::Low,
                        ReasoningEffort::Medium,
                        ReasoningEffort::High,
                        ReasoningEffort::Xhigh,
                    ],
                    None,
                    true,
                    true,
                ))
            } else {
                None
            }
        }
        ProviderKind::OpenAiCompatible => {
            if is_ollama_provider(provider) {
                local_ollama_reasoning(model)
            } else if is_lm_studio_provider(provider) {
                local_lm_studio_reasoning(model)
            } else if is_local_provider(provider) || !looks_reasoning_model(model) {
                None
            } else {
                Some(reasoning_meta(
                    &[
                        ReasoningEffort::None,
                        ReasoningEffort::Minimal,
                        ReasoningEffort::Low,
                        ReasoningEffort::Medium,
                        ReasoningEffort::High,
                        ReasoningEffort::Xhigh,
                    ],
                    Some(ReasoningEffort::Medium),
                    true,
                    false,
                ))
            }
        }
        ProviderKind::Replicate | ProviderKind::Fal => None,
    }
}

fn local_ollama_reasoning(model: &str) -> Option<ModelReasoningMetadata> {
    let id = model.trim().to_ascii_lowercase();
    if is_gpt_oss_model(&id) {
        return Some(reasoning_meta(
            &[
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
            ],
            Some(ReasoningEffort::Medium),
            true,
            true,
        ));
    }
    if looks_local_thinking_model(&id) {
        Some(reasoning_meta(
            &[
                ReasoningEffort::None,
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::Max,
            ],
            Some(ReasoningEffort::Medium),
            true,
            false,
        ))
    } else {
        None
    }
}

fn local_lm_studio_reasoning(model: &str) -> Option<ModelReasoningMetadata> {
    let id = model.trim().to_ascii_lowercase();
    is_gpt_oss_model(&id).then(|| {
        reasoning_meta(
            &[
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
            ],
            Some(ReasoningEffort::Medium),
            true,
            true,
        )
    })
}

fn reasoning_meta(
    efforts: &[ReasoningEffort],
    default_effort: Option<ReasoningEffort>,
    default_enabled: bool,
    mandatory: bool,
) -> ModelReasoningMetadata {
    ModelReasoningMetadata {
        supported_efforts: efforts.to_vec(),
        default_effort,
        default_enabled: Some(default_enabled),
        mandatory: Some(mandatory),
    }
}

fn is_local_provider(provider: &Provider) -> bool {
    let base = provider.base_url.to_ascii_lowercase();
    provider.name.to_ascii_lowercase().contains("ollama")
        || provider.name.to_ascii_lowercase().contains("lm studio")
        || provider.name.to_ascii_lowercase().contains("lmstudio")
        || base.contains("localhost:")
        || base.contains("127.0.0.1:")
}

fn is_ollama_provider(provider: &Provider) -> bool {
    let base = provider.base_url.to_ascii_lowercase();
    provider.name.to_ascii_lowercase().contains("ollama") || base.contains(":11434/")
}

fn is_lm_studio_provider(provider: &Provider) -> bool {
    let name = provider.name.to_ascii_lowercase();
    let base = provider.base_url.to_ascii_lowercase();
    name.contains("lm studio") || name.contains("lmstudio") || base.contains(":1234/")
}

fn is_gpt_oss_model(model: &str) -> bool {
    model.contains("gpt-oss")
}

fn looks_local_thinking_model(model: &str) -> bool {
    model.contains("qwen3")
        || model.contains("deepseek-r")
        || model.contains("deepseek-v3.1")
        || model.contains("reason")
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

/// Routes generation by model: a provider that serves the model, else local.
pub struct ProviderRouter {
    inner: Arc<RwLock<Vec<Runtime>>>,
    local: SharedService,
    privacy: Arc<PrivacyGate>,
}

#[async_trait]
impl ModelService for ProviderRouter {
    fn name(&self) -> &str {
        "router"
    }

    async fn list_models(&self) -> Result<Vec<Model>> {
        let mut out = self.local.list_models().await.unwrap_or_default();
        for r in self.inner.read().await.iter() {
            if !r.cfg.enabled || !r.cfg.kind.is_chat() {
                continue;
            }
            for m in &r.cfg.models {
                let context = r
                    .cfg
                    .model_context
                    .get(m)
                    .cloned()
                    .unwrap_or_else(|| fallback_model_context(&r.cfg, m));
                out.push(Model {
                    id: m.clone(),
                    object: "model".to_string(),
                    created: 0,
                    owned_by: r.cfg.name.clone(),
                    context_length: context.context_length,
                    max_prompt_tokens: context.max_prompt_tokens,
                    max_completion_tokens: context.max_completion_tokens,
                    pricing: None,
                    reasoning: r
                        .cfg
                        .model_reasoning
                        .get(m)
                        .cloned()
                        .or_else(|| fallback_model_reasoning(&r.cfg, m)),
                    capabilities: r.cfg.model_capabilities.get(m).cloned(),
                    architecture: None,
                });
            }
        }
        Ok(out)
    }

    async fn stream(&self, mut req: CompletionRequest) -> Result<EventStream> {
        let backend = {
            let guard = self.inner.read().await;
            guard
                .iter()
                .find(|r| {
                    r.cfg.enabled && r.cfg.kind.is_chat() && r.cfg.models.contains(&req.model)
                })
                .map(|r| r.backend.clone())
        };
        // Local backends never leave the machine, so they bypass the gate.
        let Some(remote) = backend else {
            return self.local.stream(req).await;
        };
        // Remote: enforce the outbound privacy gate before sending.
        match self.privacy.mode() {
            PrivacyMode::Off => remote.stream(req).await,
            PrivacyMode::Block => {
                let dets = self.privacy.scan_request(&req);
                if dets.is_empty() {
                    remote.stream(req).await
                } else {
                    Err(Error::InvalidRequest(format!(
                        "blocked by the privacy gate: outbound message contains {} ({} item(s)). Switch the gate to Redact or Off to send this to a remote provider.",
                        privacy::kinds_summary(&dets),
                        dets.len()
                    )))
                }
            }
            PrivacyMode::Redact => {
                let map = self.privacy.redact_request(&mut req);
                let inner = remote.stream(req).await?;
                Ok(if map.is_empty() {
                    inner
                } else {
                    privacy::unredact_stream(inner, map)
                })
            }
        }
    }

    async fn ollama_keep_alive(
        &self,
        model: &str,
        keep_alive: Option<serde_json::Value>,
    ) -> Result<bool> {
        let backend = {
            let guard = self.inner.read().await;
            guard
                .iter()
                .find(|r| {
                    r.cfg.enabled && r.cfg.kind.is_chat() && r.cfg.models.iter().any(|m| m == model)
                })
                .map(|r| r.backend.clone())
        };
        match backend {
            Some(remote) => remote.ollama_keep_alive(model, keep_alive).await,
            None => self.local.ollama_keep_alive(model, keep_alive).await,
        }
    }

    async fn embed(&self, model: &str, inputs: Vec<String>) -> Result<Vec<Vec<f32>>> {
        let backend = {
            let guard = self.inner.read().await;
            guard
                .iter()
                .find(|r| {
                    r.cfg.enabled && r.cfg.kind.is_chat() && r.cfg.models.iter().any(|m| m == model)
                })
                .map(|r| r.backend.clone())
        };
        let Some(remote) = backend else {
            return self.local.embed(model, inputs).await;
        };
        match self.privacy.mode() {
            PrivacyMode::Off => remote.embed(model, inputs).await,
            PrivacyMode::Block => {
                let detections = inputs
                    .iter()
                    .flat_map(|input| self.privacy.scan_text(input))
                    .collect::<Vec<_>>();
                if detections.is_empty() {
                    remote.embed(model, inputs).await
                } else {
                    Err(Error::InvalidRequest(format!(
                        "blocked by the privacy gate: embedding input contains {} ({} item(s)). Switch the gate to Redact or Off to send this to a remote provider.",
                        privacy::kinds_summary(&detections),
                        detections.len()
                    )))
                }
            }
            PrivacyMode::Redact => {
                let inputs = inputs
                    .into_iter()
                    .map(|input| self.privacy.redact_text(&input).text)
                    .collect();
                remote.embed(model, inputs).await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Clone)]
    struct RecordingBackend {
        inputs: Arc<Mutex<Vec<Vec<String>>>>,
    }

    #[async_trait]
    impl ModelService for RecordingBackend {
        fn name(&self) -> &str {
            "recording"
        }

        async fn list_models(&self) -> Result<Vec<Model>> {
            Ok(vec![Model::local("text-embedding-3-small", 0)])
        }

        async fn stream(&self, _req: CompletionRequest) -> Result<EventStream> {
            Ok(Box::pin(futures::stream::empty()))
        }

        async fn embed(&self, _model: &str, inputs: Vec<String>) -> Result<Vec<Vec<f32>>> {
            self.inputs.lock().unwrap().push(inputs.clone());
            Ok(inputs
                .iter()
                .map(|input| vec![input.len() as f32])
                .collect())
        }
    }

    fn provider(name: &str, kind: ProviderKind, base_url: &str) -> Provider {
        Provider {
            id: name.to_string(),
            name: name.to_string(),
            kind,
            base_url: base_url.to_string(),
            api_key: None,
            enabled: true,
            models: Vec::new(),
            pricing: BTreeMap::new(),
            model_context: BTreeMap::new(),
            model_reasoning: BTreeMap::new(),
            model_capabilities: BTreeMap::new(),
            last_error: None,
        }
    }

    #[test]
    fn fallback_reasoning_metadata_for_known_direct_models() {
        let openai = provider(
            "OpenAI",
            ProviderKind::OpenAiCompatible,
            "https://api.openai.com/v1",
        );
        let meta = fallback_model_reasoning(&openai, "gpt-5").unwrap();
        assert!(meta.supported_efforts.contains(&ReasoningEffort::High));

        let anthropic = provider(
            "Anthropic",
            ProviderKind::Anthropic,
            "https://api.anthropic.com/v1",
        );
        let meta = fallback_model_reasoning(&anthropic, "claude-sonnet-4-20250514").unwrap();
        assert_eq!(meta.mandatory, Some(true));

        let gemini = provider(
            "Gemini",
            ProviderKind::Gemini,
            "https://generativelanguage.googleapis.com/v1beta",
        );
        let meta = fallback_model_reasoning(&gemini, "gemini-2.5-flash").unwrap();
        assert!(meta.supported_efforts.contains(&ReasoningEffort::None));
    }

    #[test]
    fn local_provider_reasoning_metadata_is_runtime_specific() {
        let ollama = provider(
            "Ollama",
            ProviderKind::OpenAiCompatible,
            "http://localhost:11434/v1",
        );
        let meta = fallback_model_reasoning(&ollama, "deepseek-r1").unwrap();
        assert!(meta.supported_efforts.contains(&ReasoningEffort::Max));
        assert_eq!(meta.mandatory, Some(false));

        let meta = fallback_model_reasoning(&ollama, "gpt-oss:20b").unwrap();
        assert_eq!(
            meta.supported_efforts,
            vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High
            ]
        );
        assert_eq!(meta.mandatory, Some(true));

        let lm_studio = provider(
            "LM Studio",
            ProviderKind::OpenAiCompatible,
            "http://localhost:1234/v1",
        );
        assert!(fallback_model_reasoning(&lm_studio, "openai/gpt-oss-20b").is_some());
        assert!(fallback_model_reasoning(&lm_studio, "deepseek-r1").is_none());

        let custom = provider(
            "custom",
            ProviderKind::OpenAiCompatible,
            "http://localhost:9999/v1",
        );
        assert!(fallback_model_reasoning(&custom, "deepseek-r1").is_none());
    }

    #[tokio::test]
    async fn router_routes_embeddings_to_provider_and_redacts_inputs() {
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let mut cfg = provider(
            "OpenAI",
            ProviderKind::OpenAiCompatible,
            "https://api.openai.com/v1",
        );
        cfg.models = vec!["text-embedding-3-small".to_string()];
        let privacy = Arc::new(PrivacyGate::default());
        privacy.set(PrivacyMode::Redact);
        let router = ProviderRouter {
            inner: Arc::new(RwLock::new(vec![Runtime {
                cfg,
                backend: Arc::new(RecordingBackend {
                    inputs: inputs.clone(),
                }),
            }])),
            local: Arc::new(milim_inference::unavailable::UnavailableBackend::new()),
            privacy,
        };

        let vectors = router
            .embed(
                "text-embedding-3-small",
                vec!["email person@example.com".to_string()],
            )
            .await
            .unwrap();

        assert_eq!(vectors.len(), 1);
        let inputs = inputs.lock().unwrap();
        assert_eq!(inputs.len(), 1);
        assert!(inputs[0][0].contains("[EMAIL_1]"));
        assert!(!inputs[0][0].contains("person@example.com"));
    }
}
