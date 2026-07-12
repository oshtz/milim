//! `milim-storage` — SQLite persistence + at-rest encryption.
//!
//! Phase 2 foundation for the harness. Provides a [`Database`] wrapper over
//! bundled SQLite with an ordered [`Migration`] runner, and an
//! [`EncryptedStore`] (AES-256-GCM) used by [`SecretKv`] to keep API keys,
//! OAuth tokens, and agent secrets encrypted at rest.

mod crypto;
mod db;

pub use crypto::EncryptedStore;
pub use db::{
    Database, DatabaseOptions, JournalMode, Migration, SecretKv, UserDataStore, SECRETS_MIGRATIONS,
};
