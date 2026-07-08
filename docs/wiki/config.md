---
id: config
path: config
label: Config
title: Config, storage, and build flags
summary: Milim home, runtime asset directory, server config, persisted databases, provider records, desktop state, and native build variants.
group: Reference
order: 100
updated: 2026-07-03
---

Configuration is intentionally local. The desktop app embeds the server, stores secrets encrypted on disk, and keeps optional native runtimes behind explicit build flags.

## Default locations

| Item | Default |
|---|---|
| Milim home | OS app-data location resolved by `milim-core` paths. |
| Server config | `~/.milim/config/server.json` for standalone CLI/server use. |
| Identity key | `~/.milim/identity/master.key`. |
| Provider records | SQLite storage with encrypted secret fields. |
| Runtime assets | Milim runtime directory for voice, TTS, and related downloaded assets. |
| Schedules | `schedules.db` under the Milim root. |
| Agents and child threads | `agents.db` and `threads.db` under the Milim root. |

## Desktop session state

The desktop UI hydrates through the canonical `milim.sessions` user-state key, but the Tauri store now persists each chat session as a `user_sessions` SQLite row and each transcript message as a `user_session_messages` row keyed by session id and message index. Non-session metadata such as the active id, queued messages, sidebar organization, and archive retention stays in a small `milim.sessions.meta` JSON entry. Legacy `milim.sessions` blobs are migrated into rows on first session read. During active generation, desktop session persistence skips the full session snapshot and flushes the final state when the turn ends; unsent composer drafts use the separate tiny `milim.sessionDrafts` user-state key.

The remaining storage work is:

| Phase | Behavior |
|---|---|
| Queue/sidebar rows | Move queued messages and sidebar state out of metadata JSON when their write volume justifies it. |
| Usage reads | Store checkpoint and response metrics separately from raw message text for cheaper usage summaries. |

## Server config

| Setting | Behavior |
|---|---|
| Port | Standalone server defaults to `7377`; desktop discovers its embedded loopback port through Tauri. |
| Expose | `milim serve --expose` binds beyond loopback and auto-enables `msk-v1` auth when no auth is configured. |
| CORS | Empty allow-list means no browser origins are allowed. |
| Auth | `authRequired: true` accepts locally minted `msk-v1` keys; `apiKeys` accepts static bearer secrets; `accessKeyIssuers` trusts additional signed-key issuers. |

## Build variants

```powershell Native feature builds
$env:MILIM_WHISPER_MODEL = "C:\models\ggml-base.bin"
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features whisper
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features native-vad
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features native-tts
```

## Narrow resets

| Problem | Smallest reset |
|---|---|
| Bad provider key | Delete or update that provider record. |
| Broken MCP server | Remove the MCP server through `/mcp/servers/{id}` or the desktop UI. |
| Bad theme | Reset desktop theme settings, not the whole app state. |
| Stale memory | Archive or delete the specific memory node. |
| Stuck schedule | Disable or delete the schedule row. |
