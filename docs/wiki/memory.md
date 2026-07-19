---
id: memory
path: memory
label: Memory
title: Memory and RAG
summary: Personal and Project semantic memory, cheap context injection, archive recovery, and explicit tool-registered memories.
group: Local data
order: 60
updated: 2026-07-12
---

The normal memory library has two scopes. **Personal** follows you across projects; **Project** uses a sanitized Git-origin identity when one exists, so clones and worktrees of the same remote share memory. Different origins stay isolated. Outside Git, Project falls back to the canonical folder path. Existing exact-folder and thread-scoped memories remain searchable and can be moved into Personal or Project from the library's Legacy view.

When Memory is enabled, normal chat turns search scoped memory and inject only the retrieved hits as model context. That recall path does not force the agent/tool loop by itself. Durable writes use `memory_register` only when the user explicitly asks to remember/save/store context, or when the turn is already running through a tool-capable agent path.

## Memory systems

| System | Route | Behavior |
|---|---|---|
| Classic RAG | `/memory/ingest` and `/memory/search` | Embeds text through the configured embedding-capable provider and retrieves nearby memories. |
| Scoped semantic memory | `/memory/register` and `/memory/graph/search` | Retains the compatible lower-level node API used by retrieval and legacy data. |
| Memory library | `/memory/scopes`, `/memory/nodes`, node update/delete/archive routes | Searches, adds, edits, archives, restores, permanently deletes, and moves legacy entries. |
| Agent memory tool | `memory_register` | Saves `content` plus an optional `title` to `personal` or `project`; it defaults to Project when a folder exists and Personal otherwise. |

## Scopes

| Scope | Use it for |
|---|---|
| Personal | Durable preferences and facts that should follow you across projects. |
| Project | Repo conventions, architecture decisions, and product facts tied to one workspace folder. |

Project memory requires an active project folder. Each enabled turn searches Personal, the stable Project identity, the legacy exact-folder identity, and legacy memories from that same thread; results are deduplicated by memory node id before at most five relevant entries are injected. New writes use only the stable identity. Changing a repository's origin starts a new stable scope while legacy folder memories remain readable. No migration rewrites existing records, and new thread-scoped memories are not created.

## Remote embedding boundary

Embeddings follow the selected provider route. Local Ollama or LM Studio embeddings stay on the machine. Remote embedding calls pass through the same privacy gate as remote chat and media prompts.

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
