//! Bearer-token auth with loopback trust (Phase 1).
//!
//! Phase 2 replaces the static key-set with milim's `msk-v1` access-key
//! validation (secp256k1 ecrecover + whitelist/revocation).

use std::net::SocketAddr;

use axum::http::header::AUTHORIZATION;
use axum::http::HeaderMap;

use milim_core::Error;

use crate::error::ApiError;
use crate::state::AppState;

/// Authorize a request, or return a 401 `ApiError`.
///
/// Rules: if neither static keys nor an msk-v1 validator are configured, allow
/// everything (dev). Otherwise accept loopback peers when `trust_loopback` is
/// set, else require either a matching static `Authorization: Bearer <key>` or
/// a valid `msk-v1` access token.
pub fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> Result<(), ApiError> {
    if state.api_keys.is_empty() && state.access_validator.is_none() {
        return Ok(());
    }
    if state.trust_loopback {
        if let Some(addr) = peer {
            if addr.ip().is_loopback() {
                return Ok(());
            }
        }
    }

    if let Some(token) = bearer_token(headers) {
        if state.api_keys.contains(token) {
            return Ok(());
        }
        if let Some(validator) = &state.access_validator {
            if validator.validate(token).is_valid() {
                return Ok(());
            }
        }
    }

    Err(ApiError(Error::Unauthorized(
        "missing or invalid API key".to_string(),
    )))
}

/// Extract the bearer token from the `Authorization` header.
fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
}
