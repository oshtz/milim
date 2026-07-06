//! SQLite database wrapper + a tiny ordered migration runner.
//!
//! Uses rusqlite's `bundled` SQLite (compiled from source, so it works on
//! Windows/Linux/macOS with no system SQLite). The harness subsystems (chat
//! history, agents, memory, …) build their schemas as [`Migration`] lists.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;

use milim_core::{Error, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::crypto::EncryptedStore;

/// One forward-only schema migration.
pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JournalMode {
    Wal,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DatabaseOptions {
    pub journal_mode: JournalMode,
}

impl Default for DatabaseOptions {
    fn default() -> Self {
        Self {
            journal_mode: JournalMode::Wal,
        }
    }
}

/// A handle to an open SQLite database.
pub struct Database {
    conn: Connection,
}

impl Database {
    /// Open (creating if needed) a database file with WAL + foreign keys on.
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with_options(path, DatabaseOptions::default())
    }

    /// Open (creating if needed) a database file with explicit SQLite options.
    pub fn open_with_options(path: &Path, options: DatabaseOptions) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).map_err(sqlite)?;
        Self::configure(&conn, options)?;
        Ok(Self { conn })
    }

    /// Open an ephemeral in-memory database (tests).
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(sqlite)?;
        Self::configure(&conn, DatabaseOptions::default())?;
        Ok(Self { conn })
    }

    fn configure(conn: &Connection, options: DatabaseOptions) -> Result<()> {
        // WAL is irrelevant for :memory: but harmless; foreign keys are opt-in.
        let journal_mode = match options.journal_mode {
            JournalMode::Wal => "WAL",
            JournalMode::Delete => "DELETE",
        };
        let _ = conn.pragma_update(None, "journal_mode", journal_mode);
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(sqlite)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(sqlite)?;
        Ok(())
    }

    /// The underlying connection (for subsystem-specific queries).
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Apply any migrations whose `version` exceeds the current schema version,
    /// in order, recording each in `_migrations`. Idempotent.
    pub fn migrate(&self, migrations: &[Migration]) -> Result<()> {
        self.migrate_scoped("default", migrations)
    }

    /// Apply migrations for one subsystem, allowing shared database files.
    pub fn migrate_scoped(&self, scope: &str, migrations: &[Migration]) -> Result<()> {
        self.ensure_migrations_table(scope)?;
        let current = self.schema_version_scoped(scope)?;
        for m in migrations {
            if m.version > current {
                self.conn
                    .execute_batch("BEGIN IMMEDIATE TRANSACTION;")
                    .map_err(sqlite)?;
                let result = (|| -> Result<()> {
                    self.conn.execute_batch(m.sql).map_err(sqlite)?;
                    self.conn
                        .execute(
                            "INSERT INTO _migrations (scope, version, name) VALUES (?1, ?2, ?3)",
                            params![scope, m.version, m.name],
                        )
                        .map_err(sqlite)?;
                    Ok(())
                })();
                match result {
                    Ok(()) => self.conn.execute_batch("COMMIT;").map_err(sqlite)?,
                    Err(error) => {
                        let _ = self.conn.execute_batch("ROLLBACK;");
                        return Err(error);
                    }
                }
            }
        }
        Ok(())
    }

    fn ensure_migrations_table(&self, scope: &str) -> Result<()> {
        let exists = self.migrations_table_exists()?;
        if !exists {
            self.conn
                .execute_batch(
                    "CREATE TABLE _migrations (
                        scope      TEXT NOT NULL,
                        version    INTEGER NOT NULL,
                        name       TEXT NOT NULL,
                        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
                        PRIMARY KEY (scope, version)
                    );",
                )
                .map_err(sqlite)?;
            return Ok(());
        }

        if self.migrations_table_has_scope()? {
            return Ok(());
        }

        self.conn
            .execute_batch(
                "ALTER TABLE _migrations RENAME TO _migrations_old;
                 CREATE TABLE _migrations (
                    scope      TEXT NOT NULL,
                    version    INTEGER NOT NULL,
                    name       TEXT NOT NULL,
                    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
                    PRIMARY KEY (scope, version)
                 );",
            )
            .map_err(sqlite)?;
        self.conn
            .execute(
                "INSERT INTO _migrations (scope, version, name, applied_at)
                 SELECT ?1, version, name, applied_at FROM _migrations_old",
                params![scope],
            )
            .map_err(sqlite)?;
        self.conn
            .execute_batch("DROP TABLE _migrations_old;")
            .map_err(sqlite)?;
        Ok(())
    }

    fn migrations_table_exists(&self) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_migrations'",
                [],
                |_| Ok(true),
            )
            .optional()
            .map_err(sqlite)
            .map(|v| v.unwrap_or(false))
    }

    fn migrations_table_has_scope(&self) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('_migrations') WHERE name='scope'",
                [],
                |_| Ok(true),
            )
            .optional()
            .map_err(sqlite)
            .map(|v| v.unwrap_or(false))
    }

    /// The highest applied migration version (0 if none).
    pub fn schema_version(&self) -> Result<u32> {
        self.schema_version_scoped("default")
    }

    /// The highest applied migration version for one subsystem (0 if none).
    pub fn schema_version_scoped(&self, scope: &str) -> Result<u32> {
        if !self.migrations_table_exists()? {
            return Ok(0);
        }
        if !self.migrations_table_has_scope()? {
            let v: i64 = self
                .conn
                .query_row(
                    "SELECT COALESCE(MAX(version), 0) FROM _migrations",
                    [],
                    |r| r.get(0),
                )
                .map_err(sqlite)?;
            return Ok(v as u32);
        }
        let v: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM _migrations WHERE scope = ?1",
                params![scope],
                |r| r.get(0),
            )
            .map_err(sqlite)?;
        Ok(v as u32)
    }

    /// A key/value secret store over this DB, encrypting values at rest.
    pub fn secrets<'a>(&'a self, enc: &'a EncryptedStore) -> SecretKv<'a> {
        SecretKv { db: self, enc }
    }
}

/// Built-in migration providing the `secrets` table used by [`SecretKv`].
pub const SECRETS_MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "secrets",
    sql: "CREATE TABLE secrets (k TEXT PRIMARY KEY, v BLOB NOT NULL);",
}];

const SESSIONS_STATE_KEY: &str = "milim.sessions";
const SESSIONS_META_KEY: &str = "milim.sessions.meta";

const USER_DATA_MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "user_json_state",
        sql: "CREATE TABLE IF NOT EXISTS user_json_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
    );",
    },
    Migration {
        version: 2,
        name: "user_session_rows",
        sql: "CREATE TABLE IF NOT EXISTS user_sessions (
            id TEXT PRIMARY KEY,
            session_json TEXT NOT NULL,
            sort_order INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );",
    },
    Migration {
        version: 3,
        name: "user_session_message_rows",
        sql: "CREATE TABLE IF NOT EXISTS user_session_messages (
            session_id TEXT NOT NULL,
            message_index INTEGER NOT NULL,
            message_json TEXT NOT NULL,
            PRIMARY KEY (session_id, message_index),
            FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE CASCADE
        );",
    },
];

/// Encrypted key/value store (API keys, OAuth tokens, agent secrets).
pub struct SecretKv<'a> {
    db: &'a Database,
    enc: &'a EncryptedStore,
}

impl SecretKv<'_> {
    /// Store (upsert) an encrypted value.
    pub fn put(&self, key: &str, value: &[u8]) -> Result<()> {
        let blob = self.enc.encrypt(value)?;
        self.db
            .conn
            .execute(
                "INSERT INTO secrets (k, v) VALUES (?1, ?2)
                 ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                params![key, blob],
            )
            .map_err(sqlite)?;
        Ok(())
    }

    /// Fetch and decrypt a value, if present.
    pub fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let blob: Option<Vec<u8>> = self
            .db
            .conn
            .query_row("SELECT v FROM secrets WHERE k = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(sqlite)?;
        match blob {
            Some(b) => Ok(Some(self.enc.decrypt(&b)?)),
            None => Ok(None),
        }
    }

    /// Delete a value. Returns whether a row was removed.
    pub fn delete(&self, key: &str) -> Result<bool> {
        let n = self
            .db
            .conn
            .execute("DELETE FROM secrets WHERE k = ?1", params![key])
            .map_err(sqlite)?;
        Ok(n > 0)
    }
}

pub struct UserDataStore {
    db: Mutex<Database>,
}

impl UserDataStore {
    pub fn new(db: Database) -> Result<Self> {
        db.migrate_scoped("user_data", USER_DATA_MIGRATIONS)?;
        Ok(Self { db: Mutex::new(db) })
    }

    pub fn get_json(&self, key: &str) -> Result<Option<String>> {
        let db = self
            .db
            .lock()
            .map_err(|_| Error::Other("user data DB lock poisoned".into()))?;
        db.conn()
            .query_row(
                "SELECT value_json FROM user_json_state WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()
            .map_err(sqlite)
    }

    pub fn get_sessions_snapshot(&self) -> Result<Option<String>> {
        let db = self
            .db
            .lock()
            .map_err(|_| Error::Other("user data DB lock poisoned".into()))?;
        let conn = db.conn();
        let mut sessions = session_rows(conn)?;
        if let Some(legacy) = get_json_locked(conn, SESSIONS_STATE_KEY)? {
            if should_migrate_sessions_snapshot(&legacy, &sessions)? {
                set_sessions_snapshot_locked(conn, &legacy)?;
                sessions = session_rows(conn)?;
            }
        }
        let mut root = get_json_locked(conn, SESSIONS_META_KEY)?
            .as_deref()
            .map(parse_json)
            .transpose()?
            .unwrap_or_else(|| {
                if sessions.is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::json!({ "state": {}, "version": 0 })
                }
            });
        if root.is_null() {
            return Ok(None);
        }
        let state = root
            .get_mut("state")
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| Error::Other("invalid sessions metadata".into()))?;
        state.insert("sessions".to_string(), serde_json::Value::Array(sessions));
        serde_json::to_string(&root).map(Some).map_err(json_error)
    }

    pub fn set_sessions_snapshot(&self, value_json: &str) -> Result<()> {
        let db = self
            .db
            .lock()
            .map_err(|_| Error::Other("user data DB lock poisoned".into()))?;
        let conn = db.conn();
        let sessions = session_rows(conn)?;
        if should_ignore_default_sessions_snapshot(value_json, &sessions)? {
            return Ok(());
        }
        set_sessions_snapshot_locked(conn, value_json)
    }

    pub fn delete_sessions_snapshot(&self) -> Result<bool> {
        let db = self
            .db
            .lock()
            .map_err(|_| Error::Other("user data DB lock poisoned".into()))?;
        let conn = db.conn();
        let removed_sessions = conn
            .execute("DELETE FROM user_session_messages", [])
            .map_err(sqlite)?
            + conn
                .execute("DELETE FROM user_sessions", [])
                .map_err(sqlite)?;
        let removed_meta = conn
            .execute(
                "DELETE FROM user_json_state WHERE key IN (?1, ?2)",
                params![SESSIONS_STATE_KEY, SESSIONS_META_KEY],
            )
            .map_err(sqlite)?;
        Ok(removed_sessions + removed_meta > 0)
    }

    pub fn set_json(&self, key: &str, value_json: &str) -> Result<()> {
        serde_json::from_str::<serde_json::Value>(value_json)
            .map_err(|e| Error::InvalidRequest(format!("invalid JSON for {key}: {e}")))?;
        let db = self
            .db
            .lock()
            .map_err(|_| Error::Other("user data DB lock poisoned".into()))?;
        db.conn()
            .execute(
                "INSERT INTO user_json_state (key, value_json, updated_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at_ms = excluded.updated_at_ms",
                params![key, value_json, now_ms()],
            )
            .map_err(sqlite)?;
        Ok(())
    }

    pub fn delete_json(&self, key: &str) -> Result<bool> {
        let db = self
            .db
            .lock()
            .map_err(|_| Error::Other("user data DB lock poisoned".into()))?;
        let changed = db
            .conn()
            .execute("DELETE FROM user_json_state WHERE key = ?1", params![key])
            .map_err(sqlite)?;
        Ok(changed > 0)
    }

    pub fn import_json_entries(&self, entries: BTreeMap<String, String>) -> Result<()> {
        let db = self
            .db
            .lock()
            .map_err(|_| Error::Other("user data DB lock poisoned".into()))?;
        for (key, value) in entries {
            serde_json::from_str::<serde_json::Value>(&value)
                .map_err(|e| Error::InvalidRequest(format!("invalid JSON for {key}: {e}")))?;
            if key == SESSIONS_STATE_KEY {
                let sessions = session_rows(db.conn())?;
                if should_migrate_sessions_snapshot(&value, &sessions)? {
                    set_sessions_snapshot_locked(db.conn(), &value)?;
                }
                continue;
            }
            db.conn()
                .execute(
                    "INSERT OR IGNORE INTO user_json_state (key, value_json, updated_at_ms)
                     VALUES (?1, ?2, ?3)",
                    params![key, value, now_ms()],
                )
                .map_err(sqlite)?;
        }
        Ok(())
    }
}

fn get_json_locked(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT value_json FROM user_json_state WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(sqlite)
}

fn parse_json(value_json: &str) -> Result<serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(value_json)
        .map_err(|e| Error::InvalidRequest(format!("invalid sessions JSON: {e}")))
}

fn json_error(e: serde_json::Error) -> Error {
    Error::Other(format!("json: {e}"))
}

fn session_rows(conn: &Connection) -> Result<Vec<serde_json::Value>> {
    let messages_by_session = session_messages_by_id(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT session_json FROM user_sessions ORDER BY sort_order ASC, updated_at_ms DESC",
        )
        .map_err(sqlite)?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite)?;
    let mut sessions = Vec::new();
    for row in rows {
        let mut session = parse_json(&row.map_err(sqlite)?)?;
        let messages = session
            .get("id")
            .and_then(serde_json::Value::as_str)
            .and_then(|id| messages_by_session.get(id))
            .cloned()
            .unwrap_or_default();
        let obj = session
            .as_object_mut()
            .ok_or_else(|| Error::Other("invalid session row".into()))?;
        obj.insert("messages".to_string(), serde_json::Value::Array(messages));
        sessions.push(session);
    }
    Ok(sessions)
}

fn session_messages_by_id(conn: &Connection) -> Result<BTreeMap<String, Vec<serde_json::Value>>> {
    let mut stmt = conn
        .prepare(
            "SELECT session_id, message_json
             FROM user_session_messages
             ORDER BY session_id ASC, message_index ASC",
        )
        .map_err(sqlite)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite)?;
    let mut messages = BTreeMap::<String, Vec<serde_json::Value>>::new();
    for row in rows {
        let (session_id, message_json) = row.map_err(sqlite)?;
        messages
            .entry(session_id)
            .or_default()
            .push(parse_json(&message_json)?);
    }
    Ok(messages)
}

#[derive(Debug)]
struct StoredSessionRow {
    session_json: String,
    sort_order: i64,
    messages: Vec<String>,
}

fn stored_session_rows(conn: &Connection) -> Result<BTreeMap<String, StoredSessionRow>> {
    let mut rows = BTreeMap::new();
    let mut stmt = conn
        .prepare("SELECT id, session_json, sort_order FROM user_sessions")
        .map_err(sqlite)?;
    let session_rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(sqlite)?;
    for row in session_rows {
        let (id, session_json, sort_order) = row.map_err(sqlite)?;
        rows.insert(
            id,
            StoredSessionRow {
                session_json,
                sort_order,
                messages: Vec::new(),
            },
        );
    }

    let mut stmt = conn
        .prepare(
            "SELECT session_id, message_json
             FROM user_session_messages
             ORDER BY session_id ASC, message_index ASC",
        )
        .map_err(sqlite)?;
    let message_rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite)?;
    for row in message_rows {
        let (session_id, message_json) = row.map_err(sqlite)?;
        if let Some(session) = rows.get_mut(&session_id) {
            session.messages.push(message_json);
        }
    }
    Ok(rows)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SessionSnapshotStats {
    sessions: usize,
    messages: usize,
    updated_at_ms: i64,
}

fn session_updated_at_ms(session: &serde_json::Value) -> i64 {
    session
        .get("updatedAt")
        .or_else(|| session.get("updated_at_ms"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or_default()
}

fn session_snapshot_stats(sessions: &[serde_json::Value]) -> SessionSnapshotStats {
    SessionSnapshotStats {
        sessions: sessions.len(),
        messages: sessions
            .iter()
            .filter_map(|session| {
                session
                    .get("messages")
                    .and_then(serde_json::Value::as_array)
                    .map(Vec::len)
            })
            .sum(),
        updated_at_ms: sessions
            .iter()
            .map(session_updated_at_ms)
            .max()
            .unwrap_or_default(),
    }
}

fn session_snapshot_stats_from_json(value_json: &str) -> Result<SessionSnapshotStats> {
    let root = parse_json(value_json)?;
    let sessions = root
        .get("state")
        .and_then(serde_json::Value::as_object)
        .and_then(|state| state.get("sessions"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            Error::InvalidRequest("sessions state must include a sessions array".into())
        })?;
    Ok(session_snapshot_stats(sessions))
}

fn should_migrate_sessions_snapshot(
    value_json: &str,
    current_sessions: &[serde_json::Value],
) -> Result<bool> {
    let incoming = session_snapshot_stats_from_json(value_json)?;
    let current = session_snapshot_stats(current_sessions);
    Ok(current.sessions == 0
        || incoming.sessions > current.sessions
        || (incoming.sessions == current.sessions && incoming.messages > current.messages)
        || (incoming.sessions == current.sessions
            && incoming.messages == current.messages
            && incoming.updated_at_ms > current.updated_at_ms))
}

fn should_ignore_default_sessions_snapshot(
    value_json: &str,
    current_sessions: &[serde_json::Value],
) -> Result<bool> {
    let current = session_snapshot_stats(current_sessions);
    if current.sessions <= 1 && current.messages == 0 {
        return Ok(false);
    }

    let root = parse_json(value_json)?;
    let sessions = root
        .get("state")
        .and_then(serde_json::Value::as_object)
        .and_then(|state| state.get("sessions"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            Error::InvalidRequest("sessions state must include a sessions array".into())
        })?;
    let Some(session) = sessions.first().filter(|_| sessions.len() == 1) else {
        return Ok(false);
    };
    let messages = session
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    let title = session
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    Ok(messages == 0 && title == "New chat")
}

fn set_sessions_snapshot_locked(conn: &Connection, value_json: &str) -> Result<()> {
    let mut root = parse_json(value_json)?;
    let state = root
        .get_mut("state")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| Error::InvalidRequest("sessions state must be an object".into()))?;
    let sessions = state
        .remove("sessions")
        .and_then(|value| value.as_array().cloned())
        .ok_or_else(|| {
            Error::InvalidRequest("sessions state must include a sessions array".into())
        })?;
    let meta_json = serde_json::to_string(&root).map_err(json_error)?;
    let now = now_ms();

    conn.execute_batch("BEGIN IMMEDIATE TRANSACTION;")
        .map_err(sqlite)?;
    let result = (|| -> Result<()> {
        let existing = stored_session_rows(conn)?;
        let mut incoming_ids = BTreeSet::new();
        for (index, session) in sessions.iter().enumerate() {
            let id = session
                .get("id")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| Error::InvalidRequest("session row is missing id".into()))?;
            if !incoming_ids.insert(id.to_string()) {
                return Err(Error::InvalidRequest(format!("duplicate session id: {id}")));
            }
            let mut session_meta = session.clone();
            let messages = session_meta
                .as_object_mut()
                .and_then(|object| object.remove("messages"))
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            let session_json = serde_json::to_string(&session_meta).map_err(json_error)?;
            let message_jsons = messages
                .iter()
                .map(serde_json::to_string)
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(json_error)?;
            let sort_order = index as i64;
            let changed = existing.get(id).is_none_or(|row| {
                row.session_json != session_json
                    || row.sort_order != sort_order
                    || row.messages != message_jsons
            });
            if !changed {
                continue;
            }
            conn.execute(
                "INSERT INTO user_sessions (id, session_json, sort_order, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                    session_json = excluded.session_json,
                    sort_order = excluded.sort_order,
                    updated_at_ms = excluded.updated_at_ms",
                params![id, session_json, sort_order, now],
            )
            .map_err(sqlite)?;
            conn.execute(
                "DELETE FROM user_session_messages WHERE session_id = ?1",
                params![id],
            )
            .map_err(sqlite)?;
            for (message_index, message_json) in message_jsons.iter().enumerate() {
                conn.execute(
                    "INSERT INTO user_session_messages (session_id, message_index, message_json)
                     VALUES (?1, ?2, ?3)",
                    params![id, message_index as i64, message_json],
                )
                .map_err(sqlite)?;
            }
        }
        for id in existing.keys() {
            if !incoming_ids.contains(id) {
                conn.execute("DELETE FROM user_sessions WHERE id = ?1", params![id])
                    .map_err(sqlite)?;
            }
        }
        conn.execute(
            "INSERT INTO user_json_state (key, value_json, updated_at_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at_ms = excluded.updated_at_ms",
            params![SESSIONS_META_KEY, meta_json, now],
        )
        .map_err(sqlite)?;
        conn.execute(
            "DELETE FROM user_json_state WHERE key = ?1",
            params![SESSIONS_STATE_KEY],
        )
        .map_err(sqlite)?;
        Ok(())
    })();

    match result {
        Ok(()) => conn.execute_batch("COMMIT;").map_err(sqlite),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn sqlite(e: rusqlite::Error) -> Error {
    Error::Other(format!("sqlite: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_apply_once_and_track_version() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.schema_version().unwrap(), 0);
        db.migrate(SECRETS_MIGRATIONS).unwrap();
        assert_eq!(db.schema_version().unwrap(), 1);
        // Idempotent: re-running doesn't error or double-apply.
        db.migrate(SECRETS_MIGRATIONS).unwrap();
        assert_eq!(db.schema_version().unwrap(), 1);
    }

    #[test]
    fn secret_kv_round_trips_and_persists() {
        let dir = std::env::temp_dir().join(format!("milim-storage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("test.db");
        let key = EncryptedStore::random_key();

        {
            let db = Database::open(&path).unwrap();
            db.migrate(SECRETS_MIGRATIONS).unwrap();
            let enc = EncryptedStore::from_key(&key);
            let kv = db.secrets(&enc);
            kv.put("openai", b"sk-123").unwrap();
            assert_eq!(kv.get("openai").unwrap().unwrap(), b"sk-123");
            assert!(kv.get("missing").unwrap().is_none());
        }

        // Reopen the file with the same key: data survives.
        {
            let db = Database::open(&path).unwrap();
            let enc = EncryptedStore::from_key(&key);
            let kv = db.secrets(&enc);
            assert_eq!(kv.get("openai").unwrap().unwrap(), b"sk-123");
            assert!(kv.delete("openai").unwrap());
            assert!(kv.get("openai").unwrap().is_none());
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_key_cannot_read_secret() {
        let db = Database::open_in_memory().unwrap();
        db.migrate(SECRETS_MIGRATIONS).unwrap();
        let enc = EncryptedStore::from_key(&[1u8; 32]);
        db.secrets(&enc).put("k", b"v").unwrap();

        let other = EncryptedStore::from_key(&[2u8; 32]);
        assert!(db.secrets(&other).get("k").is_err());
    }

    #[test]
    fn scoped_migrations_do_not_collide() {
        let db = Database::open_in_memory().unwrap();
        let a = [Migration {
            version: 1,
            name: "a_table",
            sql: "CREATE TABLE a_table (id TEXT PRIMARY KEY);",
        }];
        let b = [Migration {
            version: 1,
            name: "b_table",
            sql: "CREATE TABLE b_table (id TEXT PRIMARY KEY);",
        }];

        db.migrate_scoped("a", &a).unwrap();
        db.migrate_scoped("b", &b).unwrap();

        let a_exists: bool = db
            .conn()
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='a_table'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        let b_exists: bool = db
            .conn()
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='b_table'",
                [],
                |_| Ok(true),
            )
            .unwrap();
        assert!(a_exists);
        assert!(b_exists);
        assert_eq!(db.schema_version_scoped("a").unwrap(), 1);
        assert_eq!(db.schema_version_scoped("b").unwrap(), 1);
    }

    #[test]
    fn syncable_open_uses_delete_journal_mode() {
        let dir =
            std::env::temp_dir().join(format!("milim-syncable-db-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("milim.db");

        let db = Database::open_with_options(
            &path,
            DatabaseOptions {
                journal_mode: JournalMode::Delete,
            },
        )
        .unwrap();

        let mode: String = db
            .conn()
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "delete");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_json_state_round_trips_by_key() {
        let db = Database::open_in_memory().unwrap();
        let store = UserDataStore::new(db).unwrap();

        store
            .set_json(
                "milim.sessions",
                r#"{"state":{"sessions":[],"activeId":"a"},"version":0}"#,
            )
            .unwrap();

        assert_eq!(
            store.get_json("milim.sessions").unwrap().as_deref(),
            Some(r#"{"state":{"sessions":[],"activeId":"a"},"version":0}"#)
        );
    }

    #[test]
    fn user_sessions_snapshot_uses_rows_and_metadata() {
        let db = Database::open_in_memory().unwrap();
        let store = UserDataStore::new(db).unwrap();
        let snapshot = r#"{"state":{"sessions":[{"id":"a","title":"A","messages":[{"role":"user","content":"hello"}]},{"id":"b","title":"B","messages":[{"role":"assistant","content":"hi"}]}],"activeId":"b","sidebar":{"sessionOrder":["b","a"]}},"version":0}"#;

        store.set_sessions_snapshot(snapshot).unwrap();

        assert!(store.get_json("milim.sessions").unwrap().is_none());
        {
            let db = store.db.lock().unwrap();
            let session_json: String = db
                .conn()
                .query_row(
                    "SELECT session_json FROM user_sessions WHERE id = 'a'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let session: serde_json::Value = serde_json::from_str(&session_json).unwrap();
            assert!(session.get("messages").is_none());
            let message_count: i64 = db
                .conn()
                .query_row("SELECT COUNT(*) FROM user_session_messages", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(message_count, 2);
        }
        let restored = store.get_sessions_snapshot().unwrap().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&restored).unwrap();
        assert_eq!(parsed["state"]["sessions"][0]["id"], "a");
        assert_eq!(
            parsed["state"]["sessions"][0]["messages"][0]["content"],
            "hello"
        );
        assert_eq!(parsed["state"]["sessions"][1]["id"], "b");
        assert_eq!(parsed["state"]["activeId"], "b");
        assert_eq!(parsed["state"]["sidebar"]["sessionOrder"][0], "b");
    }

    #[test]
    fn user_sessions_set_keeps_unchanged_session_rows() {
        let db = Database::open_in_memory().unwrap();
        let store = UserDataStore::new(db).unwrap();
        let snapshot = r#"{"state":{"sessions":[{"id":"a","title":"A","updatedAt":10,"messages":[{"role":"user","content":"hello"}]}],"activeId":"a"},"version":0}"#;

        store.set_sessions_snapshot(snapshot).unwrap();
        {
            let db = store.db.lock().unwrap();
            db.conn()
                .execute(
                    "UPDATE user_sessions SET updated_at_ms = 123 WHERE id = 'a'",
                    [],
                )
                .unwrap();
        }

        store.set_sessions_snapshot(snapshot).unwrap();

        let updated_at_ms: i64 = store
            .db
            .lock()
            .unwrap()
            .conn()
            .query_row(
                "SELECT updated_at_ms FROM user_sessions WHERE id = 'a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(updated_at_ms, 123);
    }

    #[test]
    fn user_sessions_set_diffs_upserts_and_deletes_rows() {
        let db = Database::open_in_memory().unwrap();
        let store = UserDataStore::new(db).unwrap();
        let initial = r#"{"state":{"sessions":[{"id":"a","title":"A","messages":[{"role":"user","content":"old"}]},{"id":"b","title":"B","messages":[{"role":"assistant","content":"remove"}]}],"activeId":"a"},"version":0}"#;
        let next = r#"{"state":{"sessions":[{"id":"a","title":"A","messages":[{"role":"user","content":"new"}]},{"id":"c","title":"C","messages":[]}],"activeId":"c"},"version":0}"#;

        store.set_sessions_snapshot(initial).unwrap();
        store.set_sessions_snapshot(next).unwrap();

        let db = store.db.lock().unwrap();
        let session_ids: Vec<String> = db
            .conn()
            .prepare("SELECT id FROM user_sessions ORDER BY sort_order ASC")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        assert_eq!(session_ids, vec!["a".to_string(), "c".to_string()]);
        let message: String = db
            .conn()
            .query_row(
                "SELECT message_json FROM user_session_messages WHERE session_id = 'a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(message.contains("new"));
        let removed_messages: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM user_session_messages WHERE session_id = 'b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(removed_messages, 0);
    }

    #[test]
    fn user_sessions_get_migrates_legacy_blob() {
        let db = Database::open_in_memory().unwrap();
        let store = UserDataStore::new(db).unwrap();
        let legacy = r#"{"state":{"sessions":[{"id":"legacy","title":"Legacy"}],"activeId":"legacy"},"version":0}"#;
        store.set_json("milim.sessions", legacy).unwrap();

        let restored = store.get_sessions_snapshot().unwrap().unwrap();
        let restored: serde_json::Value = serde_json::from_str(&restored).unwrap();
        assert_eq!(restored["state"]["sessions"][0]["id"], "legacy");
        assert_eq!(
            restored["state"]["sessions"][0]["messages"],
            serde_json::json!([])
        );
        assert_eq!(restored["state"]["activeId"], "legacy");
        assert!(store.get_json("milim.sessions").unwrap().is_none());
        assert!(store.delete_sessions_snapshot().unwrap());
        assert!(store.get_sessions_snapshot().unwrap().is_none());
    }

    #[test]
    fn user_sessions_get_prefers_newer_legacy_blob_when_counts_tie() {
        let db = Database::open_in_memory().unwrap();
        let store = UserDataStore::new(db).unwrap();
        let current = r#"{"state":{"sessions":[{"id":"current","title":"Current","updatedAt":1,"messages":[{"role":"user","content":"old"}]}],"activeId":"current"},"version":0}"#;
        let legacy = r#"{"state":{"sessions":[{"id":"legacy","title":"Legacy","updatedAt":2,"messages":[{"role":"user","content":"new"}]}],"activeId":"legacy"},"version":0}"#;

        store.set_sessions_snapshot(current).unwrap();
        store.set_json("milim.sessions", legacy).unwrap();

        let restored = store.get_sessions_snapshot().unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&restored).unwrap(),
            serde_json::from_str::<serde_json::Value>(legacy).unwrap()
        );
        assert!(store.get_json("milim.sessions").unwrap().is_none());
    }

    #[test]
    fn user_sessions_get_prefers_richer_legacy_blob_over_default_row() {
        let db = Database::open_in_memory().unwrap();
        let store = UserDataStore::new(db).unwrap();
        let default = r#"{"state":{"sessions":[{"id":"new","title":"New chat","messages":[]}],"activeId":"new"},"version":0}"#;
        let legacy = r#"{"state":{"sessions":[{"id":"legacy","title":"Legacy","messages":[{"role":"user","content":"saved"}]}],"activeId":"legacy"},"version":0}"#;

        store.set_sessions_snapshot(default).unwrap();
        store.set_json("milim.sessions", legacy).unwrap();

        let restored = store.get_sessions_snapshot().unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&restored).unwrap(),
            serde_json::from_str::<serde_json::Value>(legacy).unwrap()
        );
        assert!(store.get_json("milim.sessions").unwrap().is_none());
    }

    #[test]
    fn user_sessions_set_ignores_startup_default_over_richer_rows() {
        let db = Database::open_in_memory().unwrap();
        let store = UserDataStore::new(db).unwrap();
        let saved = r#"{"state":{"sessions":[{"id":"saved","title":"Saved","messages":[{"role":"user","content":"keep"}]}],"activeId":"saved"},"version":0}"#;
        let startup_default = r#"{"state":{"sessions":[{"id":"new","title":"New chat","messages":[]}],"activeId":"new"},"version":0}"#;

        store.set_sessions_snapshot(saved).unwrap();
        store.set_sessions_snapshot(startup_default).unwrap();

        let restored = store.get_sessions_snapshot().unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&restored).unwrap(),
            serde_json::from_str::<serde_json::Value>(saved).unwrap()
        );
    }

    #[test]
    fn user_json_bulk_import_migrates_richer_sessions_even_with_stale_legacy_key() {
        let db = Database::open_in_memory().unwrap();
        let store = UserDataStore::new(db).unwrap();
        let default = r#"{"state":{"sessions":[{"id":"new","title":"New chat","messages":[]}],"activeId":"new"},"version":0}"#;
        let stale = r#"{"state":{"sessions":[]},"version":0}"#;
        let legacy = r#"{"state":{"sessions":[{"id":"legacy","title":"Legacy","messages":[{"role":"user","content":"saved"}]}],"activeId":"legacy"},"version":0}"#;

        store.set_sessions_snapshot(default).unwrap();
        store.set_json("milim.sessions", stale).unwrap();
        store
            .import_json_entries(BTreeMap::from([(
                "milim.sessions".to_string(),
                legacy.to_string(),
            )]))
            .unwrap();

        let restored = store.get_sessions_snapshot().unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&restored).unwrap(),
            serde_json::from_str::<serde_json::Value>(legacy).unwrap()
        );
        assert!(store.get_json("milim.sessions").unwrap().is_none());
    }

    #[test]
    fn user_json_bulk_import_keeps_existing_when_input_is_empty() {
        let db = Database::open_in_memory().unwrap();
        let store = UserDataStore::new(db).unwrap();

        store
            .set_json("milim.sessions", r#"{"state":{"sessions":[]},"version":0}"#)
            .unwrap();
        store.import_json_entries(BTreeMap::new()).unwrap();

        assert!(store.get_json("milim.sessions").unwrap().is_some());
    }

    #[test]
    fn user_json_bulk_import_preserves_existing_keys() {
        let db = Database::open_in_memory().unwrap();
        let store = UserDataStore::new(db).unwrap();

        store
            .set_json("milim.settings", r#"{"state":{"theme":"db"},"version":0}"#)
            .unwrap();
        store
            .import_json_entries(BTreeMap::from([(
                "milim.settings".to_string(),
                r#"{"state":{"theme":"legacy"},"version":0}"#.to_string(),
            )]))
            .unwrap();

        assert_eq!(
            store.get_json("milim.settings").unwrap().as_deref(),
            Some(r#"{"state":{"theme":"db"},"version":0}"#)
        );
    }
}
