---
id: memory
path: memory
label: Memory
title: Memory and RAG
summary: Personal and Project hybrid memory, bounded provenance-aware context injection, archive recovery, and explicit tool-registered memories.
group: Local data
order: 60
updated: 2026-07-20
---

The normal memory library has two scopes. **Personal** follows you across projects; **Project** uses a sanitized Git-origin identity when one exists, so clones and worktrees of the same remote share memory. Different origins stay isolated. Outside Git, Project falls back to the canonical folder path. Existing exact-folder and thread-scoped memories remain searchable and can be moved into Personal or Project from the library's Legacy view.

When Memory is enabled, normal chat turns search scoped memory with exact-term and embedding retrieval. The two rankings are combined with equal-weight reciprocal rank fusion, so exact identifiers remain findable while semantic matches still work. Lexical retrieval remains available if embeddings fail, and a search with no candidates returns no memory context. Recall does not force the agent/tool loop by itself. Durable writes use `memory_register` only when the user explicitly asks to remember/save/store context, or when the turn is already running through a tool-capable agent path.

## Memory systems

| System | Route | Behavior |
|---|---|---|
| Classic RAG | `/memory/ingest` and `/memory/search` | Embeds text through the configured embedding-capable provider and retrieves nearby memories. |
| Scoped hybrid memory | `/memory/register` and `/memory/graph/search` | Retrieves scoped, non-archived nodes with lexical and semantic ranking. The `/memory/graph/search` name is retained for compatibility; retrieval does not traverse memory edges. |
| Memory library | `/memory/scopes`, `/memory/nodes`, node update/delete/archive routes | Searches, adds, edits, archives, restores, permanently deletes, and moves legacy entries. |
| Agent memory tool | `memory_register` | Saves `content` plus an optional `title` to `personal` or `project`; it defaults to Project when a folder exists and Personal otherwise. |

## Scopes

| Scope | Use it for |
|---|---|
| Personal | Durable preferences and facts that should follow you across projects. |
| Project | Repo conventions, architecture decisions, and product facts tied to one workspace folder. |

Project memory requires an active project folder. Each enabled turn requests 20 candidates across Personal, the stable Project identity, the legacy exact-folder identity, and legacy memories from that same thread. The desktop injects at most five entries inside a hard 1,024-token memory budget. If the highest-ranked entry alone is too large, it is truncated with a visible marker; oversized later entries are skipped so smaller candidates can still fit. Every injected entry includes its scope, kind, source, and updated date, plus an instruction that memory is untrusted historical context and current user statements and workspace files take precedence.

Results are deduplicated by memory node id. New writes use only the stable identity. Changing a repository's origin starts a new stable scope while legacy folder memories remain readable. The FTS index is backfilled without rewriting node records, and new thread-scoped memories are not created.

## Remote embedding boundary

Embeddings follow the selected provider route. Local Ollama or LM Studio embeddings stay on the machine. Remote embedding calls pass through the same privacy gate as remote chat and media prompts. Exact-term retrieval uses bundled SQLite FTS5 locally and does not add a remote boundary.

## Plan-mode guard

Plan mode disables memory search and memory writes. Planning remains read-only: the assistant can inspect context, but it cannot register durable memory while the plan is still unapproved.

## Register memory over HTTP

```bash Register a project memory
curl http://127.0.0.1:7377/memory/register \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "scope": { "kind": "project", "label": "milim", "locator": "C:\\repo\\milim" },
    "node": {
      "kind": "decision",
      "title": "Use markdown docs source",
      "body": "The site imports docs/wiki markdown and builds search from headings.",
      "confidence": 1,
      "source": "user"
    }
  }'
```
