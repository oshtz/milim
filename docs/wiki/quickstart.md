---
id: quickstart
path: quickstart
label: Quickstart
title: Quickstart
summary: Connect a model, pick a workspace folder, run the desktop app or CLI server, and send a first useful prompt.
group: Start
order: 20
updated: 2026-07-03
---

Aim for one complete loop first: connect a model, select a workspace folder, send a prompt that needs context, and check that the answer or artifact lands where you expect.

## First run checklist

| Step | What to check |
|---|---|
| Install or run | Use a release build for normal use. Use `pnpm -C apps/desktop tauri dev` only when working on the app. |
| Choose a surface | Simple is focused chat; Workbench adds project, agent, MCP, media, sandbox, schedules, and computer-use controls. |
| Add a model source | Configure a hosted provider, start Ollama or LM Studio, or set `MILIM_REMOTE_BASE_URL` for the CLI server path. |
| Select a workspace | Pick the folder before asking for file reads, shell commands, Git actions, or artifact saves. |
| Set privacy | Use Off for local-only tests, Redact for cautious remote work, and Block when remote sends must fail closed on detected PII. |
| Send a useful prompt | Ask for a repo map, failing-test diagnosis, or small docs edit. A generic hello only proves chat works. |
| Verify the result | Check model name, tool timeline, selected folder, artifacts, memory notices, and privacy mode before longer runs. |

## Desktop app

```powershell Run the desktop app
corepack enable
pnpm -C apps/desktop install
pnpm -C apps/desktop tauri dev
```

The desktop app embeds the server in-process. There is no separate `milim serve` process for normal desktop use.

On first run, pick Simple or Workbench. The choice only sets the initial visible surface and can be changed later.

## CLI server

```powershell Run the CLI server
cargo build --release
$env:MILIM_REMOTE_BASE_URL = "http://localhost:11434/v1"
cargo run -p milim-cli -- serve
cargo run -p milim-cli -- status
cargo run -p milim-cli -- models
```

```powershell OpenAI-compatible chat
curl http://127.0.0.1:7377/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d '{"model":"llama3.2","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

## CLI commands

| Command | Use |
|---|---|
| `serve [--port N] [--expose]` | Start the HTTP server. |
| `status [--url URL] [--port N] [--token T] [--json]` | Probe a running server. |
| `models [--url URL] [--port N] [--token T] [--json]` | List server models. |
| `run [--url URL] [--port N] [--token T] <model> [prompt...]` | One-shot chat or interactive REPL through a running server. |
| `keys identity` | Print this machine identity address. |
| `keys mint [--audience A] [--label L] [--expires-secs N]` | Mint an `msk-v1` access token. |
| `mcp [--url URL] [--port N] [--token T]` | Run a stdio MCP bridge to the local server. |
| `version` | Print the binary version. |

## Before a longer run

| Signal | Meaning |
|---|---|
| Models list is empty | The app is running, but no provider or local API runtime is configured yet. |
| Tools refuse the folder | The thread has no workspace folder. Use the folder control or `/folder C:\path\to\repo`. |
| Remote send is blocked | Privacy is set to `block` and the scanner detected PII or a secret-looking value. |
| Sandbox fails | Docker is not installed, not running, or cannot start the default container. |
| Account runtime is missing | Codex or Claude Code must be installed and authenticated outside the provider key registry. |
