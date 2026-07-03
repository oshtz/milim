---
id: memory
path: memory
label: Memory
title: Memory and RAG
summary: Classic RAG, scoped graph memory, automatic context injection, manual memory management, and tool-registered memories.
group: Local data
order: 60
updated: 2026-07-01
---

Memory is scoped on purpose. Thread memory is narrow, project memory follows a workspace, and global memory is for durable preferences or facts that should apply everywhere.

## Memory systems

| System | Route | Behavior |
|---|---|---|
| Classic RAG | `/memory/ingest` and `/memory/search` | Embeds text through the configured embedding-capable provider and retrieves nearby memories. |
| Scoped graph memory | `/memory/register` and `/memory/graph/search` | Stores nodes with kind, title, body, confidence, source, archive status, and scope. |
| Memory manager | `/memory/scopes`, `/memory/nodes`, node update/delete/archive routes | Lists, searches, creates, edits, archives, restores, and deletes graph memory nodes. |
| Agent memory tool | `memory_register` | Lets a run save concise facts, decisions, preferences, or project context. |

## Scopes

| Scope | Use it for |
|---|---|
| Thread | Decisions that only matter inside the current conversation. |
| Project | Repo conventions, architecture decisions, and product facts tied to one workspace folder. |
| Global | Durable preferences and facts that should follow you across projects. |

Project memory requires an active project folder. Thread memory requires an active thread id. The server rejects missing scope locators rather than guessing.

## Remote embedding boundary

Embeddings follow the selected provider route. Local Ollama or LM Studio embeddings stay on the machine. Remote embedding calls pass through the same privacy gate as remote chat and media prompts.

## Plan-mode guard

Plan mode disables memory search and memory writes. Planning remains read-only: the assistant can inspect context, but it cannot register durable memory while the plan is still unapproved.

## Register graph memory

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
