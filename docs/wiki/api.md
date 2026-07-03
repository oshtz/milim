---
id: api
path: api
label: API
title: HTTP API surface
summary: OpenAI-compatible, Anthropic-compatible, Ollama-compatible, providers, audio, media, workspace, MCP, agents, threads, memory, privacy, skills, schedules, mobile, and account runtime routes.
group: Reference
order: 90
updated: 2026-07-03
---

The standalone server accepts static bearer keys or `msk-v1` access keys when configured in `~/.milim/config/server.json`. The desktop app uses its own per-launch bearer token and resolves the actual loopback port through Tauri.

## Compatible APIs

| API | Endpoint | Use |
|---|---|---|
| OpenAI chat | `POST /v1/chat/completions` | OpenAI-compatible SDKs and tools. |
| OpenAI responses | `POST /v1/responses` | Responses-compatible clients, including `input`, `instructions`, `tools`, streaming, reasoning effort, and `text.format`. |
| OpenAI completions | `POST /v1/completions` | Legacy prompt-completion clients. |
| OpenAI models | `GET /v1/models` | Model discovery. |
| OpenAI embeddings | `POST /v1/embeddings` | Embedding-compatible clients. |
| Anthropic messages | `POST /anthropic/v1/messages` | Claude Messages-compatible clients. |
| Ollama chat | `POST /api/chat` | Ollama clients that speak `/api/chat`. |
| Ollama generate | `POST /api/generate` | Ollama prompt-style generation, including `prompt`, `suffix`, `raw`, `options`, `think`, and `format`; empty-prompt `keep_alive` lifecycle calls are forwarded to native Ollama backends when available. |
| Ollama tags | `GET /api/tags` | Ollama-style model discovery. |

Structured-output controls are passed through to the selected backend: OpenAI `response_format`, Responses `text.format`, and Ollama `format` are normalized onto the internal completion request where supported.

Root aliases are also mounted for OpenAI chat, completions, models, and embeddings: `/chat/completions`, `/completions`, `/models`, and `/embeddings`.

## Route groups

| Area | Routes |
|---|---|
| Provider registry | `GET/POST /providers`, `GET /providers/discover`, `DELETE /providers/{id}` |
| Audio | `POST /audio/transcriptions`, `POST /audio/vad`, `POST /audio/speech`, `POST /audio/setup/check`, Piper/Kokoro/VAD preset installs, and Piper executable install routes |
| Media | `GET /media/models`, `GET /media/model-schema`, `GET /media/status`, `POST /media/generate` |
| Workspace | `GET/POST /workspace`, `GET /workspace/git`, `POST /workspace/git/action` (`diff`, sync, commit, checkpoint, restore checkpoint) |
| MCP | `GET /mcp/tools`, `POST /mcp/call`, `GET/POST /mcp/servers`, `DELETE /mcp/servers/{id}` |
| Agents | `POST /agents/run`, `GET/POST /agents`, `GET/PUT/DELETE /agents/{id}`, `POST /agents/{id}/run` |
| Threads | `GET /threads/{id}` (`include_events=true&event_limit=N` returns `event_count` and `events_truncated`), `DELETE /threads/{id}`, `GET /threads/{id}/children`, `GET /threads/{id}/events`, `POST /threads/{id}/stop` |
| Memory | `POST /memory/ingest`, `POST /memory/search`, `POST /memory/register`, `POST /memory/graph/search`, `GET /memory/scopes`, `GET /memory/nodes` |
| Privacy | `POST /privacy/scan`, `GET/POST /privacy/mode` |
| Sandbox and computer | `POST /sandbox/run`, `GET/POST /computer` |
| Skills and schedules | `GET/POST /skills`, `POST /skills/select`, `GET/PUT/DELETE /skills/{id}`, `GET/POST /schedules`, `GET /schedules/events`, `PUT/DELETE /schedules/{id}` |
| Mobile companion | `GET /mobile`, PWA assets under `/mobile/*`, `GET /mobile/status`, `POST /mobile/enabled`, `POST /mobile/pairing`, `POST /mobile/pair`, `GET /mobile/device/status`, `POST /mobile/relay`, `GET/POST /mobile/thread`, `GET /mobile/thread/events`, `GET /mobile/events`, `DELETE /mobile/devices/{id}` |
| Account runtimes | `GET /codex/account`, `POST /codex/login/device`, `POST /codex/login/chatgpt-device`, `POST /codex/login/api-key`, `POST /codex/logout`, `GET /codex/rate-limits`, `GET /codex/models`, `POST /codex/run`, `GET /claude/status`, `POST /claude/run` |

`POST /schedules` and `PUT /schedules/{id}` accept an optional `attachments` array using the desktop chat attachment shape (`id`, `name`, `mime`, `size`, `content`, `truncated`, `sourcePath`). Saved attachment content is appended to the scheduled prompt each time the automation fires. `GET /schedules/events` drains completed background run results for the desktop to land as local threads.

## msk-v1 keys

`msk-v1` keys are signed local access tokens. The token layout is `msk-v1.<base64url(payload)>.<hex(sig65)>`. The payload is canonical JSON with alphabetical keys, and the signature is a secp256k1 recoverable signature over the `"Milim Signed Access"` domain-separated digest.

| Payload field | Meaning |
|---|---|
| `aud` | Audience address the key authorizes against. |
| `cnt` | Monotonic counter used with revocation. |
| `exp` | Optional Unix-seconds expiry. |
| `iat` | Issued-at Unix timestamp. |
| `iss` | Issuer address, which must match the recovered signer. |
| `lbl` | Optional human label. |
| `nonce` | Random nonce used with revocation. |

```powershell Mint an msk-v1 key
cargo run -p milim-cli -- keys identity
cargo run -p milim-cli -- keys mint --label local-client --expires-secs 86400
```

Set `authRequired: true` in `server.json` to make `milim serve` accept keys minted by this machine. Use `--audience` when minting a key for a different Milim identity. Omitting it mints for this machine's own address.

## Common failures

| Status | Usually means |
|---|---|
| 401 | Missing or invalid bearer token or access key. |
| 404 | Route group is not mounted in this build or the id does not exist. |
| 409 | Local state rejected the requested mutation. |
| 422 | JSON shape or enum value is invalid. |
| 500 | Provider, runtime, database, Docker, or external process failed. |
