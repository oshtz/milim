//! Durable parent/child agent thread records.

use std::sync::Mutex;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use milim_core::{Error, Result};
use milim_storage::{Database, Migration};

pub const THREAD_STATUS_QUEUED: &str = "queued";
pub const THREAD_STATUS_RUNNING: &str = "running";
pub const THREAD_STATUS_DONE: &str = "done";
pub const THREAD_STATUS_STOPPED: &str = "stopped";
pub const THREAD_STATUS_ERROR: &str = "error";

/// Persisted metadata for one child thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentThread {
    pub id: String,
    pub parent_id: String,
    pub root_id: String,
    pub title: String,
    pub status: String,
    pub model: String,
    pub agent_id: Option<String>,
    pub prompt: String,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
}

/// One stored event from a child thread run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadEvent {
    pub id: String,
    pub thread_id: String,
    pub kind: String,
    pub payload: Value,
    pub created_at: String,
}

pub const THREAD_MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "threads",
    sql: "CREATE TABLE threads (
            id          TEXT PRIMARY KEY,
            parent_id   TEXT NOT NULL,
            root_id     TEXT NOT NULL,
            title       TEXT NOT NULL,
            status      TEXT NOT NULL,
            model       TEXT NOT NULL DEFAULT '',
            agent_id    TEXT,
            prompt      TEXT NOT NULL,
            summary     TEXT,
            error       TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
            finished_at TEXT
          );
          CREATE INDEX idx_threads_parent ON threads(parent_id, created_at);
          CREATE INDEX idx_threads_status ON threads(status, updated_at);
          CREATE TABLE thread_events (
            id         TEXT PRIMARY KEY,
            thread_id  TEXT NOT NULL,
            kind       TEXT NOT NULL,
            payload    TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
          );
          CREATE INDEX idx_thread_events_thread ON thread_events(thread_id, created_at);",
}];

/// CRUD over parent/child thread rows.
pub struct ThreadStore {
    db: Mutex<Database>,
}

impl ThreadStore {
    pub fn new(db: Database) -> Result<Self> {
        db.migrate_scoped("threads", THREAD_MIGRATIONS)?;
        Ok(Self { db: Mutex::new(db) })
    }

    pub fn create(
        &self,
        parent_id: &str,
        title: &str,
        model: &str,
        agent_id: Option<&str>,
        prompt: &str,
    ) -> Result<AgentThread> {
        let id = uuid::Uuid::new_v4().to_string();
        let db = self.db.lock().expect("threads db poisoned");
        let root_id: Option<String> = db
            .conn()
            .query_row(
                "SELECT root_id FROM threads WHERE id = ?1",
                params![parent_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(sqlite)?;
        db.conn()
            .execute(
                "INSERT INTO threads (id, parent_id, root_id, title, status, model, agent_id, prompt)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id,
                    parent_id,
                    root_id.unwrap_or_else(|| parent_id.to_string()),
                    title,
                    THREAD_STATUS_QUEUED,
                    model,
                    agent_id,
                    prompt
                ],
            )
            .map_err(sqlite)?;
        drop(db);
        self.get(&id)?
            .ok_or_else(|| Error::Other("thread insert did not return a row".to_string()))
    }

    pub fn get(&self, id: &str) -> Result<Option<AgentThread>> {
        let db = self.db.lock().expect("threads db poisoned");
        db.conn()
            .query_row(
                "SELECT id, parent_id, root_id, title, status, model, agent_id, prompt,
                        summary, error, created_at, updated_at, finished_at
                 FROM threads WHERE id = ?1",
                params![id],
                row_to_thread,
            )
            .optional()
            .map_err(sqlite)
    }

    pub fn list_children(
        &self,
        parent_id: &str,
        status: Option<&str>,
        limit: usize,
    ) -> Result<Vec<AgentThread>> {
        let db = self.db.lock().expect("threads db poisoned");
        let conn = db.conn();
        let limit = limit.clamp(1, 200) as i64;
        let mut out = Vec::new();
        if let Some(status) = status {
            let mut stmt = conn
                .prepare(
                    "SELECT id, parent_id, root_id, title, status, model, agent_id, prompt,
                            summary, error, created_at, updated_at, finished_at
                     FROM threads
                     WHERE parent_id = ?1 AND status = ?2
                     ORDER BY created_at DESC
                     LIMIT ?3",
                )
                .map_err(sqlite)?;
            for row in stmt
                .query_map(params![parent_id, status, limit], row_to_thread)
                .map_err(sqlite)?
            {
                out.push(row.map_err(sqlite)?);
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, parent_id, root_id, title, status, model, agent_id, prompt,
                            summary, error, created_at, updated_at, finished_at
                     FROM threads
                     WHERE parent_id = ?1
                     ORDER BY created_at DESC
                     LIMIT ?2",
                )
                .map_err(sqlite)?;
            for row in stmt
                .query_map(params![parent_id, limit], row_to_thread)
                .map_err(sqlite)?
            {
                out.push(row.map_err(sqlite)?);
            }
        }
        Ok(out)
    }

    pub fn list(&self, status: Option<&str>, limit: usize) -> Result<Vec<AgentThread>> {
        let db = self.db.lock().expect("threads db poisoned");
        let conn = db.conn();
        let limit = limit.clamp(1, 200) as i64;
        let mut out = Vec::new();
        if let Some(status) = status {
            let mut stmt = conn
                .prepare(
                    "SELECT id, parent_id, root_id, title, status, model, agent_id, prompt,
                            summary, error, created_at, updated_at, finished_at
                     FROM threads
                     WHERE status = ?1
                     ORDER BY created_at DESC
                     LIMIT ?2",
                )
                .map_err(sqlite)?;
            for row in stmt
                .query_map(params![status, limit], row_to_thread)
                .map_err(sqlite)?
            {
                out.push(row.map_err(sqlite)?);
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, parent_id, root_id, title, status, model, agent_id, prompt,
                            summary, error, created_at, updated_at, finished_at
                     FROM threads
                     ORDER BY created_at DESC
                     LIMIT ?1",
                )
                .map_err(sqlite)?;
            for row in stmt
                .query_map(params![limit], row_to_thread)
                .map_err(sqlite)?
            {
                out.push(row.map_err(sqlite)?);
            }
        }
        Ok(out)
    }

    pub fn update_status(
        &self,
        id: &str,
        status: &str,
        summary: Option<&str>,
        error: Option<&str>,
    ) -> Result<Option<AgentThread>> {
        let changed = {
            let db = self.db.lock().expect("threads db poisoned");
            db.conn()
                .execute(
                    "UPDATE threads
                     SET status = ?2,
                         summary = COALESCE(?3, summary),
                         error = COALESCE(?4, error),
                         updated_at = datetime('now'),
                         finished_at = CASE
                           WHEN ?2 IN ('done', 'stopped', 'error') THEN datetime('now')
                           ELSE finished_at
                         END
                     WHERE id = ?1",
                    params![id, status, summary, error],
                )
                .map_err(sqlite)?
        };
        if changed == 0 {
            return Ok(None);
        }
        self.get(id)
    }

    pub fn update_non_terminal_status(&self, status: &str, error: Option<&str>) -> Result<usize> {
        let db = self.db.lock().expect("threads db poisoned");
        db.conn()
            .execute(
                "UPDATE threads
                 SET status = ?1,
                     error = COALESCE(?2, error),
                     updated_at = datetime('now'),
                     finished_at = CASE
                       WHEN ?1 IN ('done', 'stopped', 'error') THEN datetime('now')
                       ELSE finished_at
                     END
                 WHERE status NOT IN ('done', 'stopped', 'error')",
                params![status, error],
            )
            .map_err(sqlite)
    }

    pub fn update_running_status(&self, status: &str, error: Option<&str>) -> Result<usize> {
        let db = self.db.lock().expect("threads db poisoned");
        db.conn()
            .execute(
                "UPDATE threads
                 SET status = ?1,
                     error = COALESCE(?2, error),
                     updated_at = datetime('now'),
                     finished_at = CASE
                       WHEN ?1 IN ('done', 'stopped', 'error') THEN datetime('now')
                       ELSE finished_at
                     END
                 WHERE status = 'running'",
                params![status, error],
            )
            .map_err(sqlite)
    }

    pub fn append_event(&self, thread_id: &str, kind: &str, payload: Value) -> Result<ThreadEvent> {
        let id = uuid::Uuid::new_v4().to_string();
        let payload_json = serde_json::to_string(&payload)?;
        let db = self.db.lock().expect("threads db poisoned");
        db.conn()
            .execute(
                "INSERT INTO thread_events (id, thread_id, kind, payload) VALUES (?1, ?2, ?3, ?4)",
                params![id, thread_id, kind, payload_json],
            )
            .map_err(sqlite)?;
        drop(db);
        self.get_event(&id)?
            .ok_or_else(|| Error::Other("thread event insert did not return a row".to_string()))
    }

    pub fn events(&self, thread_id: &str, limit: usize) -> Result<Vec<ThreadEvent>> {
        let db = self.db.lock().expect("threads db poisoned");
        let mut stmt = db
            .conn()
            .prepare(
                "SELECT id, thread_id, kind, payload, created_at
                 FROM thread_events
                 WHERE thread_id = ?1
                 ORDER BY created_at ASC
                 LIMIT ?2",
            )
            .map_err(sqlite)?;
        let mut out = Vec::new();
        for row in stmt
            .query_map(
                params![thread_id, limit.clamp(1, 5000) as i64],
                row_to_event,
            )
            .map_err(sqlite)?
        {
            out.push(row.map_err(sqlite)?);
        }
        Ok(out)
    }

    pub fn event_count(&self, thread_id: &str) -> Result<usize> {
        let db = self.db.lock().expect("threads db poisoned");
        let count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM thread_events WHERE thread_id = ?1",
                params![thread_id],
                |r| r.get(0),
            )
            .map_err(sqlite)?;
        Ok(count.max(0) as usize)
    }

    pub fn tree_ids(&self, id: &str) -> Result<Vec<String>> {
        let db = self.db.lock().expect("threads db poisoned");
        let mut ids = Vec::new();
        let mut stmt = db
            .conn()
            .prepare(
                "SELECT id FROM threads
                 WHERE id = ?1 OR parent_id = ?1 OR root_id = ?1",
            )
            .map_err(sqlite)?;
        for row in stmt
            .query_map(params![id], |r| r.get::<_, String>(0))
            .map_err(sqlite)?
        {
            ids.push(row.map_err(sqlite)?);
        }
        Ok(ids)
    }

    pub fn delete_tree(&self, id: &str) -> Result<Vec<String>> {
        let ids = self.tree_ids(id)?;
        if ids.is_empty() {
            return Ok(ids);
        }
        let db = self.db.lock().expect("threads db poisoned");
        db.conn()
            .execute(
                "DELETE FROM thread_events
                 WHERE thread_id IN (
                   SELECT id FROM threads
                   WHERE id = ?1 OR parent_id = ?1 OR root_id = ?1
                 )",
                params![id],
            )
            .map_err(sqlite)?;
        db.conn()
            .execute(
                "DELETE FROM threads
                 WHERE id = ?1 OR parent_id = ?1 OR root_id = ?1",
                params![id],
            )
            .map_err(sqlite)?;
        Ok(ids)
    }

    fn get_event(&self, id: &str) -> Result<Option<ThreadEvent>> {
        let db = self.db.lock().expect("threads db poisoned");
        db.conn()
            .query_row(
                "SELECT id, thread_id, kind, payload, created_at FROM thread_events WHERE id = ?1",
                params![id],
                row_to_event,
            )
            .optional()
            .map_err(sqlite)
    }
}

pub fn thread_status_terminal(status: &str) -> bool {
    matches!(
        status,
        THREAD_STATUS_DONE | THREAD_STATUS_STOPPED | THREAD_STATUS_ERROR
    )
}

fn row_to_thread(r: &rusqlite::Row) -> rusqlite::Result<AgentThread> {
    Ok(AgentThread {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        root_id: r.get(2)?,
        title: r.get(3)?,
        status: r.get(4)?,
        model: r.get(5)?,
        agent_id: r.get(6)?,
        prompt: r.get(7)?,
        summary: r.get(8)?,
        error: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
        finished_at: r.get(12)?,
    })
}

fn row_to_event(r: &rusqlite::Row) -> rusqlite::Result<ThreadEvent> {
    let payload: String = r.get(3)?;
    Ok(ThreadEvent {
        id: r.get(0)?,
        thread_id: r.get(1)?,
        kind: r.get(2)?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        created_at: r.get(4)?,
    })
}

fn sqlite(e: rusqlite::Error) -> Error {
    Error::Other(format!("sqlite: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> ThreadStore {
        ThreadStore::new(Database::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn create_list_and_update_child_threads() {
        let s = store();
        let thread = s
            .create("parent-1", "Research", "test-echo", None, "look this up")
            .unwrap();
        assert_eq!(thread.parent_id, "parent-1");
        assert_eq!(thread.root_id, "parent-1");
        assert_eq!(thread.status, THREAD_STATUS_QUEUED);

        let running = s
            .update_status(&thread.id, THREAD_STATUS_RUNNING, None, None)
            .unwrap()
            .unwrap();
        assert_eq!(running.status, THREAD_STATUS_RUNNING);

        let done = s
            .update_status(&thread.id, THREAD_STATUS_DONE, Some("finished"), None)
            .unwrap()
            .unwrap();
        assert_eq!(done.summary.as_deref(), Some("finished"));
        assert!(done.finished_at.is_some());

        let children = s.list_children("parent-1", None, 20).unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].id, thread.id);
        assert!(s
            .list_children("parent-1", Some(THREAD_STATUS_DONE), 20)
            .unwrap()
            .iter()
            .any(|t| t.id == thread.id));
    }

    #[test]
    fn stores_thread_events() {
        let s = store();
        let thread = s
            .create("parent-1", "Research", "test-echo", None, "look this up")
            .unwrap();
        let event = s
            .append_event(&thread.id, "final", serde_json::json!({"content": "done"}))
            .unwrap();
        assert_eq!(event.thread_id, thread.id);
        assert_eq!(event.payload["content"], "done");

        let events = s.events(&thread.id, 20).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "final");
        assert_eq!(s.event_count(&thread.id).unwrap(), 1);
    }

    #[test]
    fn deletes_parent_thread_tree_and_events() {
        let s = store();
        let child = s
            .create("parent-1", "Research", "test-echo", None, "look this up")
            .unwrap();
        let grandchild = s
            .create(&child.id, "Follow-up", "test-echo", None, "look deeper")
            .unwrap();
        s.append_event(&child.id, "final", serde_json::json!({"content": "done"}))
            .unwrap();
        s.append_event(
            &grandchild.id,
            "final",
            serde_json::json!({"content": "deeper"}),
        )
        .unwrap();

        let deleted = s.delete_tree("parent-1").unwrap();

        assert!(deleted.contains(&child.id));
        assert!(deleted.contains(&grandchild.id));
        assert!(s.list_children("parent-1", None, 20).unwrap().is_empty());
        assert!(s.events(&child.id, 20).unwrap().is_empty());
        assert!(s.events(&grandchild.id, 20).unwrap().is_empty());
    }
}
