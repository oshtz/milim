---
id: overview
path:
label: Overview
title: milim docs wiki
summary: Start here for model-agnostic development, model/provider switching, the embedded backend, local API, providers, agents, tools, memory, privacy, voice, media, mobile companion, and release workflow.
group: Start
order: 10
updated: 2026-07-09
---

milim is a model-agnostic software development desktop app with an embedded Rust backend and local HTTP API. The desktop app is a Tauri shell that embeds the same Axum server used by the CLI, then layers dev chat, inline model switching, Simple and Workbench chat modes, providers, agents, tools, memory, voice, media, a paired mobile companion, update checks, and local persistence on top.

## Start here

| Use case | Read |
|---|---|
| First run | Quickstart, then Models, then Desktop app. Stop when you can connect a provider, pick a folder, ask for an edit or test, switch models, and continue the same thread. |
| Daily workbench | Desktop app, Agents, Memory, and Privacy explain the controls you touch every day. |
| API integration | API, Models, Config, and Troubleshooting cover compatibility routes and stored state. |
| Release or support | Release, Config, and Troubleshooting cover build checks, local state, and failure triage. |

## App model

| Part | Boundary |
|---|---|
| Desktop app | Tauri 2, Vite, React, TypeScript, Simple/Workbench UI modes, persisted UI state, and per-launch bearer auth. |
| Embedded server | Axum HTTP server with OpenAI, Anthropic, Ollama, provider, workspace, agent, memory, MCP, media, mobile, and privacy routes. |
| Local data | Provider records, settings, threads, memories, schedules, and runtime state live under the Milim home directory. |
| Remote traffic | Hosted chat, embeddings, media, Codex, and installed Claude CLI calls pass through explicit routing and the privacy gate. |

## Source map

| Source | Path |
|---|---|
| Server router | [crates/milim-server/src/lib.rs](https://github.com/oshtz/milim/blob/main/crates/milim-server/src/lib.rs) |
| Desktop API client | [apps/desktop/src/api.ts](https://github.com/oshtz/milim/blob/main/apps/desktop/src/api.ts) |
| Embedded Tauri server | [apps/desktop/src-tauri/src/lib.rs](https://github.com/oshtz/milim/blob/main/apps/desktop/src-tauri/src/lib.rs) |
| Thread/session state | [apps/desktop/src/sessions/store.ts](https://github.com/oshtz/milim/blob/main/apps/desktop/src/sessions/store.ts) |
| Account runtimes | [docs/account-runtimes.md](https://github.com/oshtz/milim/blob/main/docs/account-runtimes.md) |

## Local-first line

Local-first does not mean local-only. milim can talk to OpenAI, Anthropic, Gemini, OpenRouter, Ollama, LM Studio, Replicate, fal, Codex, and the installed Claude CLI. The important boundary is explicit routing: local API runtimes stay on the machine, provider models use Milim's tool-agent loop when workspace or tool context is active, Codex and Claude use their account-runtime bridges, and remote sends can pass through the server-side privacy gate before leaving it.
