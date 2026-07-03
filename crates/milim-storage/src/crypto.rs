//! At-rest encryption primitive (AES-256-GCM, pure Rust).
//!
//! milim encrypts whole databases with SQLCipher (CommonCrypto on macOS).
//! For cross-platform builds without an OpenSSL/SQLCipher native dependency we
//! encrypt sensitive *values* at the application layer instead; whole-DB
//! SQLCipher remains a documented future swap. The on-disk blob is
//! `nonce(12) || ciphertext+tag`.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use milim_core::{Error, Result};
use rand::RngCore;

const NONCE_LEN: usize = 12;

/// An AES-256-GCM encryptor bound to a single 32-byte key.
#[derive(Clone)]
pub struct EncryptedStore {
    cipher: Aes256Gcm,
}

impl EncryptedStore {
    /// Build from a raw 32-byte key.
    pub fn from_key(key: &[u8; 32]) -> Self {
        Self {
            cipher: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key)),
        }
    }

    /// Generate a fresh random 32-byte key (e.g. to persist in the OS keychain).
    pub fn random_key() -> [u8; 32] {
        let mut k = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut k);
        k
    }

    /// Encrypt `plaintext`, returning `nonce || ciphertext`.
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext)
            .map_err(|_| Error::Other("encryption failed".to_string()))?;
        let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    /// Decrypt a `nonce || ciphertext` blob. Fails on a wrong key or tampering.
    pub fn decrypt(&self, blob: &[u8]) -> Result<Vec<u8>> {
        if blob.len() < NONCE_LEN {
            return Err(Error::Other("ciphertext too short".to_string()));
        }
        let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
        self.cipher
            .decrypt(Nonce::from_slice(nonce), ciphertext)
            .map_err(|_| Error::Other("decryption failed (wrong key or tampered data)".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let store = EncryptedStore::from_key(&EncryptedStore::random_key());
        let blob = store.encrypt(b"secret token").unwrap();
        assert_eq!(store.decrypt(&blob).unwrap(), b"secret token");
        // Nonce prefix means ciphertext differs from plaintext and isn't reused.
        let blob2 = store.encrypt(b"secret token").unwrap();
        assert_ne!(blob, blob2);
    }

    #[test]
    fn wrong_key_fails() {
        let a = EncryptedStore::from_key(&EncryptedStore::random_key());
        let b = EncryptedStore::from_key(&EncryptedStore::random_key());
        let blob = a.encrypt(b"x").unwrap();
        assert!(b.decrypt(&blob).is_err());
    }

    #[test]
    fn tampering_fails() {
        let store = EncryptedStore::from_key(&[7u8; 32]);
        let mut blob = store.encrypt(b"payload").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xFF;
        assert!(store.decrypt(&blob).is_err());
    }
}
