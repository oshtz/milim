//! Wire-format DTOs for the public HTTP API.
//!
//! These define the contract clients depend on, so field names and shapes
//! mirror the upstream specs (OpenAI Chat Completions, Ollama) exactly. The
//! server layer translates between these and the backend-neutral generation
//! types in `milim-inference`.

pub mod anthropic;
pub mod ollama;
pub mod openai;
