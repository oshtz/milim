---
id: models
path: models
label: Models
title: Models and providers
summary: Provider-agnostic routing across OpenAI-compatible APIs, Anthropic, Gemini, Replicate, fal, Ollama, LM Studio, Codex, and Claude runtime bridges.
group: Workbench
order: 40
updated: 2026-07-02
---

Model routing is provider-agnostic. The provider registry stores enabled remotes and their model metadata, then the desktop model picker merges local API runtime models, provider models, account runtime models, and media-capable models.

## Provider kinds

| Kind | Examples | Implements |
|---|---|---|
| OpenAI-compatible | OpenAI, OpenRouter, Groq, Ollama, LM Studio, vLLM, custom `/v1` servers | Chat, Responses, legacy completions, model list, embeddings, structured output, and reasoning metadata where provided. |
| Anthropic | Claude Messages API through a stored provider key | Chat, streaming, model routing, token usage. |
| Gemini | Google Generative Language API | Chat, model discovery, model routing. |
| Replicate | Remote image/video provider | Media model catalog, schemas, generation status polling. |
| fal | Remote image/video provider | Queued generation, status polling, normalized media results. |
| Local API runtimes | Ollama and LM Studio on this machine | Chat, prompt generation, Ollama `keep_alive` lifecycle calls, Responses or completions where the runtime exposes them, model list, embeddings, structured output, and reasoning effort for supported local reasoning models. |
| Codex and Claude runtime | Installed CLIs, not provider API keys | Resumable agent-style turns with visible tool events and Milim approval modes. |

## Choose a backend

| Goal | Route | Why |
|---|---|---|
| Best local privacy | Ollama or LM Studio | Prompts stay on your machine unless that runtime is configured otherwise. |
| General reasoning | OpenAI, Anthropic, Gemini, or OpenRouter | Use hosted providers when quality, context length, or latency matters more than staying fully local. |
| Local reasoning control | Ollama thinking models or LM Studio `gpt-oss` | Ollama uses `/v1/chat/completions`; LM Studio `gpt-oss` uses `/v1/responses` for `low`, `medium`, and `high` effort. |
| Media workflow | Replicate, fal, or OpenRouter media models | Use image/video generation from the same milim surface. |
| Agent coding loop | Codex or Claude runtime | Use account runtimes when you want resumable turns and visible tool events in the thread UI. |

## Account runtimes

Codex and Claude Code are separate from saved provider records. They are backed by installed CLIs, appear in the model picker after authentication, and reuse the active Milim chat session when the runtime exposes a native session id.

| Runtime | Setup | Session behavior |
|---|---|---|
| Codex | Use `/codex/login/device`, `/codex/login/chatgpt-device`, or `/codex/login/api-key`. | Milim stores the returned Codex thread id on the Milim chat when persistence is enabled. |
| Claude Code | Install `claude` and run `claude auth login` outside Milim. | Milim stores one Claude session id per Milim chat and passes it as `--session-id`. |

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
