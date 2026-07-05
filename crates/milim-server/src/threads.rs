//! Runtime supervision for Milim child agent threads.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use milim_agents::{
    thread_status_terminal, AgentEvent, AgentThread, ThreadEvent, ThreadStore, THREAD_STATUS_DONE,
    THREAD_STATUS_ERROR, THREAD_STATUS_RUNNING, THREAD_STATUS_STOPPED,
};
use milim_core::api::openai::ChatMessage;
use milim_core::{Error, Result};
use milim_inference::SharedService;
use milim_tools::ToolRegistry;

#[derive(Clone)]
pub struct ThreadSupervisor {
    store: Arc<ThreadStore>,
    handles: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    events: broadcast::Sender<SupervisorEvent>,
}

#[derive(Debug, Clone)]
pub struct ChildRunSpec {
    pub parent_id: String,
    pub title: String,
    pub model: String,
    pub agent_id: Option<String>,
    pub system_prompt: Option<String>,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SupervisorEvent {
    ChildThreadStarted {
        thread: AgentThread,
    },
    ChildThreadDone {
        thread: AgentThread,
    },
    ChildThreadError {
        thread: AgentThread,
        message: String,
    },
    ChildThreadEvent {
        thread: AgentThread,
        event: ThreadEvent,
    },
}

impl SupervisorEvent {
    pub fn thread(&self) -> &AgentThread {
        match self {
            SupervisorEvent::ChildThreadStarted { thread }
            | SupervisorEvent::ChildThreadDone { thread }
            | SupervisorEvent::ChildThreadError { thread, .. }
            | SupervisorEvent::ChildThreadEvent { thread, .. } => thread,
        }
    }
}

impl ThreadSupervisor {
    pub fn new(store: ThreadStore) -> Self {
        let (events, _) = broadcast::channel(512);
        Self {
            store: Arc::new(store),
            handles: Arc::new(Mutex::new(HashMap::new())),
            events,
        }
    }

    pub fn store(&self) -> Arc<ThreadStore> {
        self.store.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SupervisorEvent> {
        self.events.subscribe()
    }

    pub fn spawn(
        &self,
        service: SharedService,
        tools: ToolRegistry,
        spec: ChildRunSpec,
    ) -> Result<AgentThread> {
        let thread = self.store.create(
            &spec.parent_id,
            &spec.title,
            &spec.model,
            spec.agent_id.as_deref(),
            &spec.prompt,
        )?;
        let thread = self
            .store
            .update_status(&thread.id, THREAD_STATUS_RUNNING, None, None)?
            .unwrap_or(thread);
        if let Ok(event) = self.store.append_event(&thread.id, "started", json!({})) {
            let _ = self.events.send(SupervisorEvent::ChildThreadEvent {
                thread: thread.clone(),
                event,
            });
        }
        let _ = self.events.send(SupervisorEvent::ChildThreadStarted {
            thread: thread.clone(),
        });

        let id = thread.id.clone();
        let task_id = id.clone();
        let task_thread = thread.clone();
        let store = self.store.clone();
        let handles = self.handles.clone();
        let events = self.events.clone();
        let handle = tokio::spawn(async move {
            run_child_thread(store, events, service, Arc::new(tools), task_thread, spec).await;
            let _ = handles.lock().map(|mut h| h.remove(&task_id));
        });
        self.handles
            .lock()
            .expect("thread handles poisoned")
            .insert(id, handle);
        Ok(thread)
    }

    pub fn get(&self, id: &str) -> Result<Option<AgentThread>> {
        self.store.get(id)
    }

    pub fn children(
        &self,
        parent_id: &str,
        status: Option<&str>,
        limit: usize,
    ) -> Result<Vec<AgentThread>> {
        self.store.list_children(parent_id, status, limit)
    }

    pub fn events(&self, thread_id: &str, limit: usize) -> Result<Vec<ThreadEvent>> {
        self.store.events(thread_id, limit)
    }

    pub fn event_count(&self, thread_id: &str) -> Result<usize> {
        self.store.event_count(thread_id)
    }

    pub async fn wait(&self, id: &str, timeout_ms: u64) -> Result<Option<AgentThread>> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let thread = self.store.get(id)?;
            if thread
                .as_ref()
                .map(|t| thread_status_terminal(&t.status))
                .unwrap_or(true)
            {
                return Ok(thread);
            }
            if Instant::now() >= deadline {
                return Ok(thread);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub fn stop(&self, id: &str) -> Result<Option<AgentThread>> {
        if let Some(handle) = self
            .handles
            .lock()
            .expect("thread handles poisoned")
            .remove(id)
        {
            handle.abort();
        }
        let thread =
            self.store
                .update_status(id, THREAD_STATUS_STOPPED, None, Some("stopped by parent"))?;
        if let Some(thread) = thread.as_ref() {
            let _ = self.events.send(SupervisorEvent::ChildThreadError {
                thread: thread.clone(),
                message: thread
                    .error
                    .clone()
                    .unwrap_or_else(|| "stopped by parent".to_string()),
            });
        }
        Ok(thread)
    }

    pub fn delete_tree(&self, id: &str) -> Result<Vec<String>> {
        let ids = self.store.tree_ids(id)?;
        if ids.is_empty() {
            return Ok(ids);
        }
        let mut handles = self.handles.lock().expect("thread handles poisoned");
        for thread_id in &ids {
            if let Some(handle) = handles.remove(thread_id) {
                handle.abort();
            }
        }
        drop(handles);
        self.store.delete_tree(id)
    }
}

fn emit_thread_event(
    store: &ThreadStore,
    events: &broadcast::Sender<SupervisorEvent>,
    thread: &AgentThread,
    kind: &str,
    payload: Value,
) {
    if let Ok(event) = store.append_event(&thread.id, kind, payload) {
        let _ = events.send(SupervisorEvent::ChildThreadEvent {
            thread: thread.clone(),
            event,
        });
    }
}

async fn run_child_thread(
    store: Arc<ThreadStore>,
    events: broadcast::Sender<SupervisorEvent>,
    service: SharedService,
    tools: Arc<ToolRegistry>,
    mut thread: AgentThread,
    spec: ChildRunSpec,
) {
    let mut messages = Vec::new();
    if let Some(system_prompt) = spec.system_prompt.filter(|p| !p.trim().is_empty()) {
        messages.push(ChatMessage::text("system", system_prompt));
    }
    messages.push(ChatMessage::text(
        "system",
        "You are a Milim child thread. Do the delegated task with the tools Milim exposes to you and return a concise final report. Do not spawn other child threads.",
    ));
    messages.push(ChatMessage::text("user", spec.prompt));

    let mut stream = Box::pin(milim_agents::run_agent_stream(
        service, tools, spec.model, messages, None,
    ));
    let mut text = String::new();
    let mut final_text = None;

    while let Some(event) = stream.next().await {
        match event {
            AgentEvent::Token { text: chunk } => {
                text.push_str(&chunk);
                emit_thread_event(&store, &events, &thread, "token", json!({ "text": chunk }));
            }
            AgentEvent::Reasoning { text } => {
                emit_thread_event(
                    &store,
                    &events,
                    &thread,
                    "reasoning",
                    json!({ "text": text }),
                );
            }
            AgentEvent::UsageDelta { usage } => {
                emit_thread_event(
                    &store,
                    &events,
                    &thread,
                    "usage_delta",
                    json!({ "usage": usage }),
                );
            }
            AgentEvent::ToolCall {
                call_id,
                name,
                arguments,
            } => {
                emit_thread_event(
                    &store,
                    &events,
                    &thread,
                    "tool_call",
                    json!({ "call_id": call_id, "name": name, "arguments": arguments }),
                );
            }
            AgentEvent::ToolResult {
                call_id,
                name,
                result,
            } => {
                emit_thread_event(
                    &store,
                    &events,
                    &thread,
                    "tool_result",
                    json!({ "call_id": call_id, "name": name, "result": result }),
                );
            }
            AgentEvent::Final { content } => {
                final_text = Some(content.clone());
                emit_thread_event(
                    &store,
                    &events,
                    &thread,
                    "final",
                    json!({ "content": content }),
                );
            }
            AgentEvent::Done {
                iterations,
                stopped_at_limit,
                usage,
            } => {
                let summary = final_text
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| text.trim());
                let event = store.append_event(
                    &thread.id,
                    "done",
                    json!({
                        "iterations": iterations,
                        "stopped_at_limit": stopped_at_limit,
                        "usage": usage
                    }),
                );
                if let Ok(Some(done)) =
                    store.update_status(&thread.id, THREAD_STATUS_DONE, Some(summary), None)
                {
                    thread = done;
                }
                if let Ok(event) = event {
                    let _ = events.send(SupervisorEvent::ChildThreadEvent {
                        thread: thread.clone(),
                        event,
                    });
                }
                let _ = events.send(SupervisorEvent::ChildThreadDone { thread });
                return;
            }
            AgentEvent::Error { message } => {
                let event = store.append_event(&thread.id, "error", json!({ "message": message }));
                if let Ok(Some(error_thread)) =
                    store.update_status(&thread.id, THREAD_STATUS_ERROR, None, Some(&message))
                {
                    thread = error_thread;
                }
                if let Ok(event) = event {
                    let _ = events.send(SupervisorEvent::ChildThreadEvent {
                        thread: thread.clone(),
                        event,
                    });
                }
                let _ = events.send(SupervisorEvent::ChildThreadError { thread, message });
                return;
            }
            AgentEvent::Start { .. }
            | AgentEvent::MemoryRegistered { .. }
            | AgentEvent::ChildThreadStarted { .. }
            | AgentEvent::ChildThreadDone { .. }
            | AgentEvent::ChildThreadError { .. } => {}
        }
    }

    let message = "child thread ended without a terminal event";
    if let Ok(Some(error_thread)) =
        store.update_status(&thread.id, THREAD_STATUS_ERROR, None, Some(message))
    {
        let _ = events.send(SupervisorEvent::ChildThreadError {
            thread: error_thread,
            message: message.to_string(),
        });
    }
}

pub fn missing_threads_error() -> Error {
    Error::InvalidRequest("child thread storage is not configured".to_string())
}
