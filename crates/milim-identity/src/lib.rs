//! `milim-identity` — secp256k1 identity and `msk-v1` access keys.
//!
//! Byte-for-byte interoperable with milim's Swift identity layer so tokens
//! and addresses round-trip between the two. (Cross-app interop is matched by
//! construction from the source format; verify against a live milim before
//! relying on it in production.)

pub mod access_key;
pub mod crypto;
pub mod local;

pub use access_key::{mint_access_key, AccessKeyPayload, AccessKeyValidator, Validation};
pub use crypto::{derive_address, generate_secret};
pub use local::{random_nonce, LocalIdentity, MintParams};
