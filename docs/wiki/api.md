---
id: api
path: api
label: API
title: HTTP API surface
summary: OpenAI-compatible, Anthropic-compatible, Ollama-compatible, providers, media, workspace, MCP, Agents, Worker Runs, memory, privacy, skills, schedules, mobile, and account runtime routes.
group: Reference
order: 90
updated: 2026-07-13
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
| Ollama chat | `POST /api/chat` | Ollama clients that speak `/api/chat`, including `think` and streamed or final `message.thinking`. |
| Ollama generate | `POST /api/generate` | Ollama prompt-style generation, including `prompt`, `suffix`, `raw`, `options`, `think`, and `format`; empty-prompt `keep_alive` lifecycle calls are forwarded to native Ollama backends when available. |
| Ollama tags | `GET /api/tags` | Ollama-style model discovery. |

Structured-output controls are passed through to the selected backend: OpenAI `response_format`, Responses `text.format`, and Ollama `format` are normalized onto the internal completion request where supported.

Multimodal compatibility inputs remain provider-native: OpenAI Chat uses `image_url` content parts, Responses accepts `input_image`, Ollama accepts message `images`, and Anthropic Messages accepts base64 or HTTP(S) URL image sources. Malformed or unsupported Anthropic sources return an invalid-request error instead of being discarded. Gemini receives uploaded bytes as `inline_data`; only genuine `generativelanguage.googleapis.com/.../files/...` URIs become `file_data`, and arbitrary web image URLs fail validation without a server-side downloader.

Root aliases are also mounted for OpenAI chat, completions, models, and embeddings: `/chat/completions`, `/completions`, `/models`, and `/embeddings`.

## Route groups

| Area | Routes |
|---|---|
| Provider registry | `GET/POST /providers`, `GET /providers/discover`, `DELETE /providers/{id}` |
| Media | `GET /media/models`, `GET /media/model-schema`, `GET /media/status`, `POST /media/generate` |
| Workspace | `GET/POST /workspace`, `GET /workspace/git`, `POST /workspace/git/action` (`diff`, sync, commit, checkpoint, restore checkpoint, create/apply/remove Hot Swap retry worktree) |
| Managed preview apps | `GET /preview-apps/{runtime_id}`, `POST /preview-apps/{runtime_id}/stage`, `POST /preview-apps/{runtime_id}/start`, `POST /preview-apps/{runtime_id}/stop`, `POST /preview-apps/{runtime_id}/restart`, `GET /preview-apps/{runtime_id}/logs` |
| MCP | `GET /mcp/tools`, `POST /mcp/call`, `GET/POST /mcp/servers`, `POST /mcp/servers/test`, `POST /mcp/servers/{id}/test`, `DELETE /mcp/servers/{id}` |
| Agents | `POST /agents/run`, `GET/POST /agents`, `GET/PUT/DELETE /agents/{id}`, `POST /agents/{id}/run` |
| Worker Runs | `GET/POST /worker-runs`, `GET /worker-runs/{id}`, `GET /worker-runs/{id}/events`, `POST /worker-runs/{id}/start`, `POST /worker-runs/{id}/stop`; writer diff review/apply routes are scoped to a worker in the Run. |
| Threads | `GET /threads/{id}` (`include_events=true&event_limit=N` returns `event_count` and `events_truncated`), `DELETE /threads/{id}`, `GET /threads/{id}/children`, `GET /threads/{id}/events`, `POST /threads/{id}/stop` |
| Memory | `POST /memory/ingest`, `POST /memory/search`, `POST /memory/register`, `POST /memory/graph/search`, `GET /memory/scopes`, `GET /memory/nodes` |
| Privacy | `POST /privacy/scan`, `GET/POST /privacy/mode` |
| Sandbox and computer | `POST /sandbox/run`, `GET/POST /computer` |
| Skills and schedules | `GET/POST /skills`, `POST /skills/select`, `GET/PUT/DELETE /skills/{id}`, `GET/POST /schedules`, `GET /schedules/events`, `PUT/DELETE /schedules/{id}` |
| Mobile companion | `GET /mobile`, PWA assets under `/mobile/*`, `GET /mobile/status`, `POST /mobile/enabled`, `POST /mobile/pairing`, `POST /mobile/pair`, `GET /mobile/device/status`, `POST /mobile/relay`, `GET/POST /mobile/thread`, `GET /mobile/thread/events`, `GET /mobile/events`, `DELETE /mobile/devices/{id}` |
| Account runtimes | `GET /codex/account`, `POST /codex/login/device`, `POST /codex/login/chatgpt-device`, `POST /codex/login/api-key`, `POST /codex/logout`, `GET /codex/rate-limits`, `GET /codex/models`, `POST /codex/run`, `GET /claude/status`, `POST /claude/run` |

`GET /mcp/tools` is the complete agent-configuration catalog and each entry includes an `effect` (`read_only`, `mutating`, `command`, or `unknown`). `GET /mcp/tools?callable=true` returns the read-only subset that `POST /mcp/call` can invoke; mutations must run through an agent with Review approval or Open mode. External MCP tools use stable id-derived namespaces, cannot shadow first-party tools, and default to `unknown` unless their MCP annotations explicitly mark them read-only. Previous display-name-derived MCP names remain accepted as non-advertised aliases for saved custom-agent selections.

`http_fetch` accepts public HTTP(S) destinations only, validates every redirect, applies DNS/address checks, and limits transfer time and body size. It rejects loopback, private, link-local, multicast, and metadata-service addresses.

`POST /schedules` and `PUT /schedules/{id}` require a provider/local API `model` for deterministic unattended execution; `codex:*` and `claude:*` account models are rejected. The optional `attachments` array uses the desktop chat shape (`id`, `name`, `mime`, `size`, `content`, `dataUrl`, `truncated`, `sourcePath`). Text content is appended to the scheduled prompt and stored image data becomes a real image part each time the automation fires. A legacy image without `dataUrl` records a visible error asking for reattachment. Existing schedules may have an empty model for compatibility; the runner falls back to their linked Agent's deprecated model, and records a visible error if neither exists. `GET /schedules/events` drains completed results for the desktop to land as local threads.

`POST /codex/run` and `POST /claude/run` accept an optional `images` array of `{ "media_type": "image/png", "data": "<base64 bytes>" }`. PNG, JPEG, WebP, and GIF are limited to 2 MB each, and either a non-empty `prompt` or at least one valid image is required. Codex materializes validated bytes into temporary per-turn files and sends app-server `localImage` inputs; Claude pipes a native multimodal user message with base64 image blocks through `--input-format stream-json`. Account-runtime images require Privacy Off.

The built-in `memory_register` tool accepts `content`, optional `title`, and optional `scope` (`personal` or `project`). The lower-level `/memory/*` HTTP routes remain compatible with scoped node records.

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

Set `authRequired: true` in `server.json` to make `milim serve` accept keys minted by this machine. `milim serve --expose` saves that setting and prints a one-time token when no auth is already configured. Use `--audience` when minting a key for a different Milim identity. Omitting it mints for this machine's own address.

## Common failures

| Status | Usually means |
|---|---|
| 401 | Missing or invalid bearer token or access key. |
| 404 | Route group is not mounted in this build or the id does not exist. |
| 409 | Local state rejected the requested mutation. |
| 422 | JSON shape or enum value is invalid. |
| 500 | Provider, runtime, database, Docker, or external process failed. |
