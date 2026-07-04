//! Shared server state.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use milim_agents::AgentStore;
use milim_automation::ScheduleStore;
use milim_core::config::ServerConfiguration;
use milim_identity::AccessKeyValidator;
use milim_inference::SharedService;
use milim_memory::MemoryStore;
use milim_skills::SkillStore;
use milim_tools::ToolRegistry;
use serde::Serialize;

use crate::companion::MobileCompanionBridge;
use crate::preview_runtime::PreviewRuntimeManager;
use crate::threads::ThreadSupervisor;

pub type TranscriberFactory =
    dyn Fn(String) -> milim_core::Result<Arc<dyn milim_voice::Transcriber>> + Send + Sync;

pub type VadFactory =
    dyn Fn(String) -> milim_core::Result<Arc<dyn milim_voice::VoiceActivityDetector>> + Send + Sync;

#[derive(Clone, Debug, Serialize)]
pub struct ScheduleRunEvent {
    pub id: String,
    pub schedule_id: String,
    pub schedule_name: String,
    pub prompt: String,
    pub response: String,
    pub model: String,
    pub ran_at: i64,
}

#[derive(Default)]
pub struct ScheduleRunQueue {
    events: Mutex<VecDeque<ScheduleRunEvent>>,
}

impl ScheduleRunQueue {
    pub fn push(&self, event: ScheduleRunEvent) {
        let mut events = self.events.lock().expect("schedule run queue poisoned");
        events.push_back(event);
        while events.len() > 100 {
            events.pop_front();
        }
    }

    pub fn take(&self) -> Vec<ScheduleRunEvent> {
        let mut events = self.events.lock().expect("schedule run queue poisoned");
        events.drain(..).collect()
    }
}

/// Cloneable handle to everything request handlers need.
#[derive(Clone)]
pub struct AppState {
    /// The active inference backend.
    pub service: SharedService,
    /// Effective server configuration.
    pub config: Arc<ServerConfiguration>,
    /// Accepted API keys. Empty ⇒ auth disabled (dev/loopback).
    pub api_keys: Arc<HashSet<String>>,
    /// Bypass auth for loopback peers.
    pub trust_loopback: bool,
    /// Process start time (unix seconds), used as the model `created` field.
    pub created: u64,
    /// Root directory for locally installed model and voice assets.
    pub models_dir: Arc<PathBuf>,
    /// Optional msk-v1 access-key validator (secp256k1). When set, valid
    /// `msk-v1` bearer tokens are accepted in addition to static API keys.
    pub access_validator: Option<Arc<AccessKeyValidator>>,
    /// Tools exposed via `/mcp/tools` + `/mcp/call` (and, later, the agent loop).
    pub tools: Option<Arc<ToolRegistry>>,
    /// Optional memory/RAG store exposed via `/memory/ingest` + `/memory/search`.
    pub memory: Option<Arc<MemoryStore>>,
    /// Optional named-agent store exposed via `/agents` + `/agents/{id}/run`.
    pub agents: Option<Arc<AgentStore>>,
    /// Optional child-thread supervisor exposed via child orchestration tools.
    pub threads: Option<Arc<ThreadSupervisor>>,
    /// Optional cron schedule store exposed via `/schedules` (+ firing loop).
    pub schedules: Option<Arc<ScheduleStore>>,
    /// Completed background schedule runs waiting for the desktop to surface.
    pub schedule_runs: Arc<ScheduleRunQueue>,
    /// Optional skills store exposed via `/skills`.
    pub skills: Option<Arc<SkillStore>>,
    /// Optional multi-provider registry exposed via `/providers`.
    pub providers: Option<Arc<crate::providers::ProviderRegistry>>,
    /// Host working-folder root shared with the desktop's filesystem/shell
    /// tools. Set via `POST /workspace` (the GUI's "Folder" chip). When unset,
    /// host tools refuse to run. Shared (not cloned) across handlers + tools.
    pub workspace: Arc<RwLock<Option<PathBuf>>>,
    /// Optional MCP client hub: external MCP servers whose tools are merged
    /// into the agent's registry. Managed via `/mcp/servers`.
    pub mcp: Option<Arc<milim_mcp_client::McpHub>>,
    /// Optional speech-to-text backend exposed via `/audio/transcriptions`.
    pub transcriber: Option<Arc<dyn milim_voice::Transcriber>>,
    /// Optional lazy speech-to-text backend loader keyed by a settings model path.
    pub transcriber_factory: Option<Arc<TranscriberFactory>>,
    /// Cached settings-loaded transcribers. Loading STT models per request is too costly.
    pub transcriber_cache: Arc<RwLock<HashMap<String, Arc<dyn milim_voice::Transcriber>>>>,
    /// Optional voice activity detector exposed via `/audio/vad`.
    pub vad: Option<Arc<dyn milim_voice::VoiceActivityDetector>>,
    /// Optional lazy VAD loader keyed by a settings model path.
    pub vad_factory: Option<Arc<VadFactory>>,
    /// Cached settings-loaded VAD models. Native VAD models are also costly to load.
    pub vad_cache: Arc<RwLock<HashMap<String, Arc<dyn milim_voice::VoiceActivityDetector>>>>,
    /// Computer-use gate (screen capture + mouse/keyboard). Off by default;
    /// flipped via `POST /computer`. The desktop's computer-use tools check it.
    pub computer_use: Arc<AtomicBool>,
    /// Outbound privacy gate. Off by default; set via `POST /privacy/mode`. The
    /// `ProviderRouter` consults it before sending to a remote provider.
    pub privacy: Arc<crate::privacy::PrivacyGate>,
    /// Relay-only mobile companion bridge. Disabled by default and only grants
    /// paired phones permission to submit text to the active desktop composer.
    pub mobile_companion: Option<Arc<MobileCompanionBridge>>,
    /// Managed no-folder preview app runtime rooted under `~/.milim/runtime`.
    pub preview_runtime: Arc<PreviewRuntimeManager>,
}

impl AppState {
    /// Build state with auth disabled and loopback trusted (dev defaults).
    pub fn new(service: SharedService, config: ServerConfiguration) -> Self {
        Self {
            service,
            config: Arc::new(config),
            api_keys: Arc::new(HashSet::new()),
            trust_loopback: true,
            created: crate::now_unix(),
            models_dir: Arc::new(
                milim_core::paths::Paths::resolve()
                    .models_dir()
                    .to_path_buf(),
            ),
            access_validator: None,
            tools: None,
            memory: None,
            agents: None,
            threads: None,
            schedules: None,
            schedule_runs: Arc::new(ScheduleRunQueue::default()),
            skills: None,
            providers: None,
            workspace: Arc::new(RwLock::new(None)),
            mcp: None,
            transcriber: None,
            transcriber_factory: None,
            transcriber_cache: Arc::new(RwLock::new(HashMap::new())),
            vad: None,
            vad_factory: None,
            vad_cache: Arc::new(RwLock::new(HashMap::new())),
            computer_use: Arc::new(AtomicBool::new(false)),
            privacy: Arc::new(crate::privacy::PrivacyGate::default()),
            mobile_companion: None,
            preview_runtime: Arc::new(PreviewRuntimeManager::new(
                milim_core::paths::Paths::resolve()
                    .root()
                    .join("runtime")
                    .join("preview-apps"),
            )),
        }
    }

    /// Share the computer-use gate with the desktop's computer-use tools.
    pub fn with_computer_use(mut self, gate: Arc<AtomicBool>) -> Self {
        self.computer_use = gate;
        self
    }

    /// Share the outbound privacy gate with the provider router (so the
    /// `/privacy/mode` endpoint and the router read the same mode).
    pub fn with_privacy(mut self, gate: Arc<crate::privacy::PrivacyGate>) -> Self {
        self.privacy = gate;
        self
    }

    /// Attach the relay-only mobile companion bridge.
    pub fn with_mobile_companion(mut self, bridge: Arc<MobileCompanionBridge>) -> Self {
        self.mobile_companion = Some(bridge);
        self
    }

    /// Share a working-folder cell with host filesystem/shell tools so the
    /// `/workspace` endpoint and the tools read/write the same root.
    pub fn with_workspace(mut self, workspace: Arc<RwLock<Option<PathBuf>>>) -> Self {
        self.workspace = workspace;
        self
    }

    /// Attach an MCP client hub (external MCP servers' tools).
    pub fn with_mcp(mut self, mcp: Arc<milim_mcp_client::McpHub>) -> Self {
        self.mcp = Some(mcp);
        self
    }

    /// Attach a speech-to-text backend for `/audio/transcriptions`.
    pub fn with_transcriber(mut self, transcriber: Arc<dyn milim_voice::Transcriber>) -> Self {
        self.transcriber = Some(transcriber);
        self
    }

    /// Attach a lazy speech-to-text loader for settings-selected model paths.
    pub fn with_transcriber_factory(mut self, factory: Arc<TranscriberFactory>) -> Self {
        self.transcriber_factory = Some(factory);
        self
    }

    /// Attach a voice activity detector for `/audio/vad`.
    pub fn with_vad(mut self, vad: Arc<dyn milim_voice::VoiceActivityDetector>) -> Self {
        self.vad = Some(vad);
        self
    }

    /// Attach a lazy voice activity detector loader for settings-selected model paths.
    pub fn with_vad_factory(mut self, factory: Arc<VadFactory>) -> Self {
        self.vad_factory = Some(factory);
        self
    }

    /// Attach a multi-provider registry for the `/providers` endpoints.
    pub fn with_providers(mut self, providers: Arc<crate::providers::ProviderRegistry>) -> Self {
        self.providers = Some(providers);
        self
    }

    /// Attach a skills store.
    pub fn with_skills(mut self, skills: SkillStore) -> Self {
        self.skills = Some(Arc::new(skills));
        self
    }

    /// Attach a named-agent store.
    pub fn with_agents(mut self, agents: AgentStore) -> Self {
        self.agents = Some(Arc::new(agents));
        self
    }

    /// Attach the child-thread supervisor.
    pub fn with_threads(mut self, threads: ThreadSupervisor) -> Self {
        self.threads = Some(Arc::new(threads));
        self
    }

    /// Attach a cron schedule store.
    pub fn with_schedules(mut self, schedules: ScheduleStore) -> Self {
        self.schedules = Some(Arc::new(schedules));
        self
    }

    /// Attach a tool registry for the MCP endpoints.
    pub fn with_tools(mut self, tools: ToolRegistry) -> Self {
        self.tools = Some(Arc::new(tools));
        self
    }

    /// Attach a memory/RAG store for the memory endpoints.
    pub fn with_memory(mut self, memory: MemoryStore) -> Self {
        self.memory = Some(Arc::new(memory));
        self
    }

    /// Attach an msk-v1 access-key validator.
    pub fn with_access_validator(mut self, validator: AccessKeyValidator) -> Self {
        self.access_validator = Some(Arc::new(validator));
        self
    }

    /// Replace the local model asset root.
    pub fn with_models_dir(mut self, models_dir: PathBuf) -> Self {
        self.models_dir = Arc::new(models_dir);
        self
    }

    /// Replace the accepted API-key set.
    pub fn with_api_keys(mut self, keys: impl IntoIterator<Item = String>) -> Self {
        self.api_keys = Arc::new(keys.into_iter().collect());
        self
    }

    /// Toggle loopback auth bypass (off forces key checks even on localhost).
    pub fn with_loopback_trust(mut self, trust: bool) -> Self {
        self.trust_loopback = trust;
        self
    }
}
