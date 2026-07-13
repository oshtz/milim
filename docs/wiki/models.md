---
id: models
path: models
label: Models
title: Models and providers
summary: Model-agnostic dev chat routing across OpenAI-compatible APIs, Anthropic, Gemini, Replicate, fal, Ollama, LM Studio, Codex, and Claude runtime bridges.
group: Core
order: 40
updated: 2026-07-14
---

Model routing is provider-agnostic and centered on the active dev thread. The provider registry stores enabled remotes and their model metadata, then the desktop model picker merges local API runtime models, provider models, account runtime models, and media-capable models. Duplicate provider model ids stay provider-scoped in the picker and route back to the selected provider; provider sections with fewer visible models appear first.

On desktop startup, the picker reads the cached catalog while a single live refresh checks enabled chat providers. It reads the catalog once more after that refresh completes, without requiring a trip through provider settings. Provider, Codex, and Claude discovery are isolated so a slow or unavailable lane does not suppress successful lanes.

The model chip and picker classify the selected model into one runtime lane: plain chat, Milim tools, Codex runtime, Claude runtime, or media. Switching models changes the next turn for the active thread without resetting workspace context, memory, previews, artifacts, approvals, or queued messages.

Worker routing is a separate thread setting. A thread may choose an optional Worker model; otherwise managed Workers inherit the parent model. Saved Agents remain portable roles: their instructions and resolved skills transfer to the selected Worker runtime, while Milim still governs Worker access independently. In Auto, provider and local parents use Milim-managed Workers. Read-only Codex and Claude turns may normalize native worker activity into Milim Runs; write-capable account-runtime turns use managed read-only Workers so only the parent edits the workspace. If a runtime cannot report reliable worker lineage, Milim falls back to managed Workers or ordinary tool activity instead of inventing a parent/child relationship.

## Favorites and reasoning effort

Favorites are the only model shortcut. The picker switches between Models and Favorites, and each model keeps its own persisted reasoning-effort choice. Agents do not pin models, so changing the thread model keeps the active Agent enabled and changes the model used by its next interactive run.

Hot Swap assesses the selected target before committing the change. Full-parity swaps stay one-click. Smaller context windows, explicitly unsupported image/tool input, unavailable setup, or stale account-runtime history open a preflight. Unknown image capability allows an attempted send without falsely claiming support; explicit false blocks the capability claim, and explicit provider metadata wins over model-name fallbacks. Codex and Claude native sessions can receive image pixels, so account-runtime targets are no longer degraded solely because they are account runtimes.

## Provider kinds

| Kind | Examples | Implements |
|---|---|---|
| OpenAI-compatible | OpenAI, OpenRouter, Groq, Ollama, LM Studio, vLLM, custom `/v1` servers | Chat, Responses, legacy completions, model list, embeddings, structured output, and reasoning plus vision/tool-use metadata where provided. |
| Anthropic | Claude Messages API through a stored provider key | Chat, streaming, model routing, token usage, and native base64 or URL image blocks. |
| Gemini | Google Generative Language API | Chat, model discovery, model routing, inline image bytes, and genuine Gemini Files API URIs. Arbitrary web image URLs are rejected instead of downloaded server-side. |
| Replicate | Remote image/video provider | Media model catalog, schemas, generation status polling. |
| fal | Remote image/video provider | Queued generation, status polling, normalized media results. |
| Local API runtimes | Ollama and LM Studio on this machine | Chat, prompt generation, Ollama `keep_alive` lifecycle calls, Responses or completions where the runtime exposes them, model list, embeddings, structured output, native vision/tool-use labels where available, and reasoning effort for supported local reasoning models. |
| Codex and Claude runtime | Installed CLIs, not provider API keys | Resumable agent-style turns with real image input, visible tool events, and Milim approval modes. |

Requests to OpenRouter include its app-attribution headers with `https://milim.ai/` as the identifier and `milim` as the display title.

## Runtime lanes

| Lane | When it appears | What happens next |
|---|---|---|
| Plain chat | No workspace, tool, preview, schedule, agent, or memory-write context is active. | The provider/local model answers directly. |
| Milim tools | A provider/local model is selected while workspace, sandbox, computer-use, preview tools, schedule intent, active agent, or memory-write intent is active. | The model runs through Milim's tool-agent loop with visible tool events and approval policy. |
| Codex runtime | A Codex account model is selected. | Milim sends the turn through the Codex account-runtime bridge. |
| Claude runtime | An installed Claude CLI model is selected. | Milim sends the turn through the Claude CLI bridge. |
| Media | An image/video model is selected. | Milim uses the media generation flow. |

## Choose a backend

| Goal | Route | Why |
|---|---|---|
| Best local privacy | Ollama or LM Studio | Prompts stay on your machine unless that runtime is configured otherwise. |
| General reasoning | OpenAI, Anthropic, Gemini, or OpenRouter | Use hosted providers when quality, context length, or latency matters more than staying fully local. |
| Local reasoning control | Ollama thinking models or LM Studio models with reasoning metadata | Ollama uses `/v1/chat/completions`; LM Studio uses `/api/v1/chat` for advertised native reasoning options without custom tools and `/v1/responses` when Milim function tools are attached. `gpt-oss` still uses `/v1/responses` for `low`, `medium`, and `high` effort. |
| Media workflow | Replicate, fal, or OpenRouter media models | Use image/video generation from the same milim surface. |
| Development coding loop | Any capable provider model, Codex runtime, or Claude runtime | Use provider models for Milim's tool loop, or account runtimes when you want their native resumable bridge. |

## Account runtimes

Codex and the installed Claude CLI are separate from saved provider records. They are backed by user-installed CLIs, appear in the model picker after authentication, and reuse the active Milim chat session when the runtime exposes a native session id. Milim does not include Claude Code, provide Anthropic credentials, or manage Claude credentials; it only invokes the separately installed official Claude CLI.

| Runtime | Setup | Session behavior |
|---|---|---|
| Codex | Use `/codex/login/device`, `/codex/login/chatgpt-device`, or `/codex/login/api-key`. | Milim stores the returned Codex thread id on the Milim chat when persistence is enabled. |
| Installed Claude CLI | Install Anthropic's official `claude` CLI separately and run `claude auth login` outside Milim. | Milim stores one Claude session id per Milim chat, uses `--session-id` for new native sessions and `--resume` for existing project transcripts, and asks before stopping a matching local Claude CLI process if Claude reports the session is already in use. |

Codex model metadata is authoritative when `inputModalities` is present. Claude aliases advertise image input. For OpenAI, Anthropic, Gemini, and Groq families without explicit metadata, the picker uses conservative current-family Vision labels; custom compatible servers with unknown metadata are allowed to attempt standard `image_url` parts but cannot be guaranteed.

The repo-level account runtime reference lives at `docs/account-runtimes.md`.

## Provider setup failures

| Failure | Likely cause |
|---|---|
| No models | Provider discovery failed, the local runtime is stopped, or the base URL points at the wrong API shape. |
| 401 or 403 | The key is missing, expired, or attached to an account that cannot use the selected model. |
| 404 model | The provider works, but the selected model id does not exist for that provider. |
| Connection refused | The local runtime is not listening on the configured host/port. |
| Streaming stalls | Check proxy buffering, provider rate limits, and whether the selected model supports streaming. |

## CLI backend selection

| Environment | Use |
|---|---|
| `MILIM_REMOTE_BASE_URL` | OpenAI-compatible base URL used by CLI/server fallback. |
| `MILIM_REMOTE_API_KEY` | Optional bearer key for `MILIM_REMOTE_BASE_URL`. |

If no CLI backend is configured, `/v1/models` returns an empty list and chat requests return a setup error instead of a synthetic response.
