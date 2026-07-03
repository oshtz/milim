//! msk-v1 access keys: canonical payload, minting, and validation.
//!
//! Token layout (matches milim): `msk-v1.<base64url(payload)>.<hex(sig65)>`,
//! where `payload` is the canonical (alphabetically-keyed) JSON of
//! [`AccessKeyPayload`] and `sig65` is the recoverable signature over the
//! domain-separated digest (prefix `"Milim Signed Access"`).

use std::collections::HashSet;

use base64::Engine;
use serde::{Deserialize, Serialize};

use milim_core::Result;

use crate::crypto::{recover_address, sign_with_prefix, ACCESS_PREFIX};

/// The signed payload embedded in an msk-v1 token. Field order is alphabetical
/// so serde's output matches Swift's `JSONEncoder` with `.sortedKeys`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccessKeyPayload {
    /// Audience address (which identity the key authorizes against).
    pub aud: String,
    /// Monotonic counter (for revocation).
    pub cnt: u64,
    /// Optional expiry (unix seconds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp: Option<i64>,
    /// Issued-at (unix seconds).
    pub iat: i64,
    /// Issuer address (must match the recovered signer).
    pub iss: String,
    /// Optional human label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lbl: Option<String>,
    /// Random nonce (for revocation).
    pub nonce: String,
}

/// Mint an `msk-v1` token: serialize the canonical payload, sign it, encode.
pub fn mint_access_key(secret: &[u8], payload: &AccessKeyPayload) -> Result<String> {
    let bytes = serde_json::to_vec(payload)?;
    let sig = sign_with_prefix(&bytes, secret, ACCESS_PREFIX)?;
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes);
    Ok(format!("msk-v1.{}.{}", b64, hex::encode(sig)))
}

/// The outcome of validating a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Validation {
    Valid { issuer: String },
    Invalid(String),
    Revoked,
    Expired,
}

impl Validation {
    pub fn is_valid(&self) -> bool {
        matches!(self, Validation::Valid { .. })
    }
}

/// Validates msk-v1 tokens against an audience, whitelist, and revocations.
#[derive(Debug, Clone, Default)]
pub struct AccessKeyValidator {
    agent_address: String,
    master_address: String,
    whitelist: HashSet<String>,
    revoked: HashSet<String>,
}

impl AccessKeyValidator {
    /// Accept tokens whose audience is the agent or master address.
    pub fn new(agent_address: &str, master_address: &str) -> Self {
        Self {
            agent_address: agent_address.to_lowercase(),
            master_address: master_address.to_lowercase(),
            whitelist: HashSet::new(),
            revoked: HashSet::new(),
        }
    }

    /// Whitelist an issuer address (only whitelisted issuers are accepted).
    pub fn allow_issuer(&mut self, address: &str) -> &mut Self {
        self.whitelist.insert(address.to_lowercase());
        self
    }

    /// Builder form of [`allow_issuer`](Self::allow_issuer).
    pub fn with_issuer(mut self, address: &str) -> Self {
        self.whitelist.insert(address.to_lowercase());
        self
    }

    /// Mark a specific (issuer, nonce, cnt) tuple revoked.
    pub fn revoke(&mut self, issuer: &str, nonce: &str, cnt: u64) -> &mut Self {
        self.revoked
            .insert(format!("{}:{}:{}", issuer.to_lowercase(), nonce, cnt));
        self
    }

    /// Validate using the current wall-clock for expiry.
    pub fn validate(&self, token: &str) -> Validation {
        self.validate_at(token, now_unix())
    }

    /// Validate with an explicit `now` (unix seconds) — deterministic for tests.
    pub fn validate_at(&self, token: &str, now: i64) -> Validation {
        let parts: Vec<&str> = token.splitn(3, '.').collect();
        if parts.len() != 3 || parts[0] != "msk-v1" {
            return Validation::Invalid("unrecognized token format".into());
        }

        let payload_bytes = match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[1])
        {
            Ok(b) => b,
            Err(_) => return Validation::Invalid("invalid payload encoding".into()),
        };
        let signature = match hex::decode(parts[2]) {
            Ok(s) if s.len() == 65 => s,
            _ => return Validation::Invalid("invalid signature encoding".into()),
        };
        let payload: AccessKeyPayload = match serde_json::from_slice(&payload_bytes) {
            Ok(p) => p,
            Err(_) => return Validation::Invalid("malformed payload".into()),
        };

        let recovered = match recover_access_address(&payload_bytes, &signature, &payload.iss) {
            Ok(a) => a,
            Err(_) => return Validation::Invalid("signature recovery failed".into()),
        };

        let aud = payload.aud.to_lowercase();
        if aud != self.agent_address && aud != self.master_address {
            return Validation::Invalid("audience mismatch".into());
        }
        if !self.whitelist.contains(&payload.iss.to_lowercase()) {
            return Validation::Invalid("issuer not whitelisted".into());
        }

        let revoke_key = format!(
            "{}:{}:{}",
            payload.iss.to_lowercase(),
            payload.nonce,
            payload.cnt
        );
        if self.revoked.contains(&revoke_key) {
            return Validation::Revoked;
        }
        if let Some(exp) = payload.exp {
            if now >= exp {
                return Validation::Expired;
            }
        }

        Validation::Valid { issuer: recovered }
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn recover_access_address(payload_bytes: &[u8], signature: &[u8], issuer: &str) -> Result<String> {
    let issuer = issuer.to_lowercase();
    let recovered = recover_address(payload_bytes, signature, ACCESS_PREFIX)?;
    if recovered.to_lowercase() == issuer {
        return Ok(recovered);
    }
    Err(milim_core::Error::Other("issuer mismatch".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{derive_address, generate_secret};

    fn payload(iss: &str, aud: &str, exp: Option<i64>) -> AccessKeyPayload {
        AccessKeyPayload {
            aud: aud.to_string(),
            cnt: 1,
            exp,
            iat: 1_700_000_000,
            iss: iss.to_string(),
            lbl: Some("test".into()),
            nonce: "abc123".into(),
        }
    }

    #[test]
    fn canonical_payload_is_alphabetical() {
        let p = payload("0xISS", "0xAUD", None);
        let json = String::from_utf8(serde_json::to_vec(&p).unwrap()).unwrap();
        // keys appear in alphabetical order; nil exp omitted.
        assert_eq!(
            json,
            r#"{"aud":"0xAUD","cnt":1,"iat":1700000000,"iss":"0xISS","lbl":"test","nonce":"abc123"}"#
        );
    }

    #[test]
    fn mint_then_validate_round_trip() {
        let secret = generate_secret();
        let iss = derive_address(&secret).unwrap();
        let aud = derive_address(&generate_secret()).unwrap();
        let token = mint_access_key(&secret, &payload(&iss, &aud, None)).unwrap();
        assert!(token.starts_with("msk-v1."));

        let validator = AccessKeyValidator::new(&aud, "0xmaster").with_issuer(&iss);
        assert_eq!(
            validator.validate(&token),
            Validation::Valid { issuer: iss }
        );
    }

    #[test]
    fn rejects_tampered_payload() {
        let secret = generate_secret();
        let iss = derive_address(&secret).unwrap();
        let aud = derive_address(&generate_secret()).unwrap();
        let token = mint_access_key(&secret, &payload(&iss, &aud, None)).unwrap();
        let validator = AccessKeyValidator::new(&aud, "0xm").with_issuer(&iss);

        // Flip a character in the payload segment.
        let mut parts: Vec<String> = token.split('.').map(String::from).collect();
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&parts[1])
            .unwrap();
        let mut tampered = bytes.clone();
        tampered[0] ^= 0x20;
        parts[1] = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&tampered);
        let bad = parts.join(".");
        assert!(!validator.validate(&bad).is_valid());
    }

    #[test]
    fn enforces_audience_whitelist_revocation_expiry() {
        let secret = generate_secret();
        let iss = derive_address(&secret).unwrap();
        let aud = derive_address(&generate_secret()).unwrap();

        // Wrong audience.
        let token = mint_access_key(&secret, &payload(&iss, &aud, None)).unwrap();
        let wrong_aud = AccessKeyValidator::new("0xsomeoneelse", "0xm").with_issuer(&iss);
        assert!(matches!(wrong_aud.validate(&token), Validation::Invalid(_)));

        // Not whitelisted.
        let not_listed = AccessKeyValidator::new(&aud, "0xm");
        assert!(matches!(
            not_listed.validate(&token),
            Validation::Invalid(_)
        ));

        // Expired.
        let exp_token = mint_access_key(&secret, &payload(&iss, &aud, Some(1000))).unwrap();
        let v = AccessKeyValidator::new(&aud, "0xm").with_issuer(&iss);
        assert_eq!(v.validate_at(&exp_token, 2000), Validation::Expired);
        assert!(v.validate_at(&exp_token, 500).is_valid());

        // Revoked.
        let mut v2 = AccessKeyValidator::new(&aud, "0xm").with_issuer(&iss);
        v2.revoke(&iss, "abc123", 1);
        assert_eq!(v2.validate(&token), Validation::Revoked);
    }
}
