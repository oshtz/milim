//! Backend used when no real local or remote model service is configured.

use async_trait::async_trait;

use milim_core::api::openai::Model;
use milim_core::{Error, Result};

use crate::service::{CompletionRequest, EventStream, ModelService};

/// Explicit no-model backend for runtime fallbacks.
#[derive(Debug, Default, Clone)]
pub struct UnavailableBackend;

impl UnavailableBackend {
    pub fn new() -> Self {
        Self
    }
}

const MESSAGE: &str =
    "Choose a model, add a reachable Ollama or LM Studio provider, or configure MILIM_REMOTE_BASE_URL.";

#[async_trait]
impl ModelService for UnavailableBackend {
    fn name(&self) -> &str {
        "unavailable"
    }

    async fn list_models(&self) -> Result<Vec<Model>> {
        Ok(Vec::new())
    }

    async fn stream(&self, req: CompletionRequest) -> Result<EventStream> {
        let requested = req.model.trim();
        let prefix = if requested.is_empty() {
            "No chat model is selected.".to_string()
        } else {
            format!("Chat model '{requested}' is not available.")
        };
        Err(Error::InvalidRequest(format!("{prefix} {MESSAGE}")))
    }

    async fn embed(&self, model: &str, _inputs: Vec<String>) -> Result<Vec<Vec<f32>>> {
        let requested = model.trim();
        let prefix = if requested.is_empty() || requested == "default" {
            "No embedding model is configured.".to_string()
        } else {
            format!("Embedding model '{requested}' is not available.")
        };
        Err(Error::InvalidRequest(format!("{prefix} {MESSAGE}")))
    }
}
