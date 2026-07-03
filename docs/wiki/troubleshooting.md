---
id: troubleshooting
path: troubleshooting
label: Troubleshooting
title: Troubleshooting
summary: Fix missing models, setup errors, workspace tool refusal, sandbox failures, privacy blocks, MCP disconnects, voice setup, computer use, and busy ports.
group: Reference
order: 120
updated: 2026-07-01
---

Start with the current base URL and selected model. Most local issues are either a missing provider, a workspace folder that was never selected, or an optional runtime that is not running yet.

## Diagnostic order

| Question | Next check |
|---|---|
| Can the server answer `/health`? | If no, fix process startup, port, firewall, or desktop embedded-server state first. |
| Does `/v1/models` list the expected model? | If no, fix provider discovery, local runtime startup, or model id before testing chat. |
| Is a workspace folder selected? | If no, file, shell, artifact-save, and workspace tools should refuse to run. |
| Is privacy mode blocking the request? | If yes, switch to `redact`, remove the detected value, or use a local runtime. |
| Is the optional runtime installed? | Voice, TTS, media, sandbox, computer use, Codex, and Claude each have separate setup. |

## Common symptoms

| Symptom | Fix |
|---|---|
| Models list is empty | Start Ollama or LM Studio, add a provider, or set `MILIM_REMOTE_BASE_URL` for CLI/server use. |
| Provider returns 401 | Replace the provider key or verify the account has access to the selected model. |
| Workspace tools are missing | Select a folder. Host filesystem, shell, and Git tools are removed until a workspace exists. |
| Guarded approval cannot run shell | Switch to Open approval or use the Docker sandbox when command execution is appropriate. |
| Sandbox run fails | Start Docker, check `MILIM_DOCKER_BIN`, and verify the daemon can run containers. |
| Computer use is unavailable | Build with the `computer-use` feature and enable the `/computer` gate. |
| MCP tools disappeared | Check `/mcp/servers`; a removed or disconnected server no longer contributes tools. |
| Privacy block error | The server detected PII before a remote send. Use Redact, Off, or a local runtime. |
| Voice setup fails | Confirm native feature flags, model files, and runtime preset installs. |
| Desktop port is busy | The embedded server falls back to a free loopback port and the UI asks Tauri for the actual API base URL. |

## Next reading path

| If you are | Read |
|---|---|
| New user | Quickstart, Models, then Desktop app. |
| Daily operator | Agents, Memory, Privacy, then Voice/media/mobile. |
| Integrator | API, Config, and Overview source links. |
| Release work | Release and verification, then Troubleshooting. |
