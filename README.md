# milim

milim is a model-agnostic software development desktop app for people who switch between models, providers, and subscriptions constantly. It embeds a Rust backend with a local HTTP API, supports OpenAI-compatible, Ollama-compatible, and Anthropic-compatible routes, and brings provider-agnostic dev chat, encrypted provider management, Codex and bring-your-own Claude CLI account runtimes, agents/tools, memory/RAG, media generation, artifact workflows, and outbound privacy controls into one app.

Desktop release artifacts currently target Windows and macOS. Linux packaging is intentionally disabled, but the Rust server and Tauri app remain source-buildable on supported platforms.

## Quickstart

```bash
# build the Rust workspace
cargo build --release

# run the server with an OpenAI-compatible local endpoint, on port 7377
MILIM_REMOTE_BASE_URL=http://localhost:11434/v1 cargo run -p milim-cli -- serve

# in another shell
cargo run -p milim-cli -- status
```

## Usage

Run `milim serve` to expose the local HTTP API, then point OpenAI-compatible clients at `http://127.0.0.1:7377/v1`. Configure the CLI backend with `MILIM_REMOTE_BASE_URL` and optional `MILIM_REMOTE_API_KEY`; for local inference, point it at an external runtime such as Ollama or LM Studio.

For the desktop app:

```bash
corepack enable
pnpm -C apps/desktop install
pnpm -C apps/desktop tauri dev
```

### CLI Commands

| Command | Description |
|---|---|
| `serve [--port N] [--expose]` | Start the HTTP server; `--expose` binds on the LAN and auto-enables `msk-v1` auth if no auth is configured. |
| `status [--url URL] [--port N] [--token T] [--json]` | Probe a running server's health. |
| `models [--url URL] [--port N] [--token T] [--json]` | List models from a running server. |
| `run [--url URL] [--port N] [--token T] [--system S] [--temperature N] [--max-tokens N] <model> [prompt...]` | Chat through the running server: one-shot if a prompt is given, else an interactive REPL. |
| `keys identity` / `keys mint [...]` | Print this machine's address / mint an `msk-v1` access token. |
| `mcp [--url URL] [--port N] [--token T]` | Run the stdio MCP bridge for Claude Desktop and other MCP clients. |
| `version` | Print the version. |

OpenAI-compatible example:

```bash
curl http://127.0.0.1:7377/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3.2","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

Ollama clients can use `http://127.0.0.1:7377/api/chat` or prompt-style `http://127.0.0.1:7377/api/generate`; `/api/chat` accepts `think` and returns `message.thinking` for reasoning models, and empty-prompt `keep_alive` lifecycle calls are forwarded to native Ollama backends when available.

## Backends

The CLI server chooses a backend from the environment. If none is configured, `/v1/models` returns an empty list and chat requests return a setup error instead of a synthetic response.

| Backend | Trigger | Notes |
|---|---|---|
| **Remote / local provider** | `MILIM_REMOTE_BASE_URL` (+ `MILIM_REMOTE_API_KEY`) | Forwards to any OpenAI-compatible endpoint such as Ollama `/v1`, LM Studio `/v1`, vLLM, OpenAI, or OpenRouter. |

Milim does not ship a GGUF runtime. Local GGUF inference belongs in dedicated runtimes such as Ollama or LM Studio; Milim integrates with them through their API surfaces. Ollama thinking models can use Milim reasoning effort controls through `/v1/chat/completions`; LM Studio models with native reasoning metadata use LM Studio's `/api/v1/chat` reasoning settings when no custom tools are attached and `/v1/responses` for Milim function-tool requests, while `gpt-oss` low/medium/high effort keeps using LM Studio's `/v1/responses` path. Structured-output controls are forwarded through OpenAI `response_format`, Ollama `format`, and Responses `text.format` where the selected backend supports them. The desktop app manages encrypted provider records for OpenAI, OpenRouter, Groq, Anthropic, Gemini, Replicate, fal, local Ollama, local LM Studio, and custom OpenAI-compatible endpoints; duplicate provider model ids stay provider-scoped in the picker and route back to the selected provider. Codex and the installed Claude CLI are account runtimes backed by user-installed CLIs; they are separate from saved provider records, appear in the model picker after authentication, and use Milim approval modes with visible tool events.

At desktop startup, the picker loads the cached catalog while one live refresh checks enabled chat providers, then reconciles automatically when that refresh finishes. Provider, Codex, and Claude discovery fail independently so one unavailable runtime does not hide the others.

Milim does not include Claude Code, does not provide Anthropic credentials, and is not affiliated with or endorsed by Anthropic. This integration only invokes the user's separately installed official Claude CLI on the local machine. Use of Claude and Claude Code is governed by Anthropic's terms. Users must install the Claude CLI separately, authenticate through Claude's own tooling, and Milim does not manage or receive Claude credentials.

Claude CLI integration boundaries:

- Milim invokes the local `claude` executable.
- Milim does not bundle Claude Code, proxy Claude access, or sell Claude access.
- Authentication is handled by the official Claude CLI.
- Milim does not read Claude credentials.
- Claude CLI usage remains subject to Anthropic's terms.
- Open mode for Claude CLI maps to Claude's `bypassPermissions` mode, which may run tools and commands without additional Claude prompts; use it only in trusted workspaces.
- Stale-session recovery asks before stopping a matching local Claude CLI process and does not delete Claude session registry files by default.

## API Surface

| Area | Endpoint(s) |
|---|---|
| OpenAI chat/responses/completions/models/embeddings | `POST /v1/chat/completions` (`/chat/completions`), `POST /v1/responses`, `POST /v1/completions` (`/completions`), `GET /v1/models` (`/models`), `POST /v1/embeddings` (`/embeddings`) |
| Ollama chat/generate/tags/embeddings | `POST /api/chat`, `POST /api/generate`, `GET /api/tags`, `POST /api/embed`, `POST /api/embeddings` |
| Anthropic messages | `POST /anthropic/v1/messages`, `POST /anthropic/messages`, `POST /v1/messages` |
| Provider registry | `GET/POST /providers`, `GET /providers/discover`, `DELETE /providers/{id}` |
| Media generation | `GET /media/models`, `GET /media/model-schema`, `GET /media/status`, `POST /media/generate` |
| MCP | `GET /mcp/tools`, `POST /mcp/call`, `GET/POST /mcp/servers`, `POST /mcp/servers/test`, `POST /mcp/servers/{id}/test`, `DELETE /mcp/servers/{id}` |
| Agents and Worker Runs | `POST /agents/run`, `GET/POST /agents`, `GET/PUT/DELETE /agents/{id}`, `POST /agents/{id}/run`, preferred `/worker-runs/*`, and compatibility `/threads/*` routes |
| Memory / RAG | `POST /memory/ingest`, `/memory/search`, `/memory/register`, `/memory/graph/search`, plus scope/node routes |
| Privacy filter | `POST /privacy/scan`, `GET/POST /privacy/mode` |
| Skills and schedules | `GET/POST /skills`, `POST /skills/select`, `GET/PUT/DELETE /skills/{id}`, `GET/POST /schedules`, `GET /schedules/events`, `PUT/DELETE /schedules/{id}` |
| Workspace and tools | `GET/POST /workspace`, `GET /workspace/git`, `POST /workspace/git/action`, `GET/POST /computer`, `POST /sandbox/run` |
| Managed preview apps | `GET /preview-apps/{runtime_id}`, read-only `POST /preview-apps/{runtime_id}/preflight`, compatibility `POST /preview-apps/{runtime_id}/stage`, explicit `POST /preview-apps/{runtime_id}/start`, `POST /preview-apps/{runtime_id}/stop`, `POST /preview-apps/{runtime_id}/restart`, and cursor-based `GET /preview-apps/{runtime_id}/logs?after_seq=` |
| Mobile companion | `GET /mobile`, PWA assets under `/mobile/*`, `GET /mobile/status`, `POST /mobile/enabled`, `POST /mobile/pairing`, `POST /mobile/pair`, `GET /mobile/device/status`, `POST /mobile/relay`, `GET/POST /mobile/thread`, `GET /mobile/thread/events`, `GET /mobile/events`, `DELETE /mobile/devices/{id}` |
| Codex account runtime | `GET /codex/account`, `POST /codex/login/device`, `/codex/login/chatgpt-device`, `/codex/login/api-key`, `/codex/logout`, `GET /codex/rate-limits`, `GET /codex/models`, `POST /codex/run` |
| Installed Claude CLI | `GET /claude/status`, `POST /claude/run` |
| Health | `GET /health` |

Built-in tool safety is enforced server-side. Each run captures its workspace and preview target, Guarded mode exposes only tools declared read-only, and direct `POST /mcp/call` is read-only even though `GET /mcp/tools` returns the full catalog for agent configuration. The desktop resets tool approval to Guarded whenever a chat's workspace folder changes, so Open permission does not carry across project boundaries. Filesystem tools reject traversal through symlinks/junctions, use atomic replacement for writes, and support bounded ranged reads. `http_fetch` permits public HTTP(S) destinations only. Host and Docker commands have time/output limits; Docker runs also use no-network, memory, CPU, PID, capability, and read-only-root restrictions by default.

Standalone auth is configured in `~/.milim/config/server.json`: set `authRequired: true` to accept locally minted `msk-v1` keys, add static bearer secrets under `apiKeys`, or trust extra signed-key issuers under `accessKeyIssuers`. `milim serve --expose` persists `authRequired: true` and prints an immediate `MILIM_API_TOKEN` when no auth is already configured. CLI client commands accept `--url`, `--port`, and `--token` (`MILIM_API_TOKEN`) when calling an authenticated server. The desktop app disables loopback trust and uses a per-launch bearer token for its embedded server. Empty CORS allow-list means no browser origins are allowed; set explicit origins at `~/.milim/config/server.json` when needed.

## Workspace Layout

```text
crates/
  milim-core/       serde DTOs, config, paths, errors
  milim-inference/  ModelService trait plus remote, Anthropic, Gemini, and test backends
  milim-storage/    SQLite persistence plus AES-GCM encryption
  milim-identity/   secp256k1 identity plus msk-v1 access keys
  milim-tools/      tool registry plus filesystem and built-in tools
  milim-agents/     tool-use Agents and durable Worker Runs
  milim-memory/     embedding vector store, scoped semantic memory, RAG
  milim-automation/ cron-scheduled agent runs
  milim-skills/     local skill registry
  milim-privacy/    regex PII filter plus reversible redaction gate
  milim-sandbox/    Docker-backed isolated command runner
  milim-mcp-client/ external MCP stdio client bridge
  milim-server/     axum HTTP server
  milim-cli/        the `milim` binary
apps/
  desktop/          Tauri 2 + Vite/React/TypeScript desktop app
  site/             Vite/React Cloudflare Pages site for milim.ai
```

## Desktop App

The Tauri app embeds the server in-process; the app is the server, so there is no separate `serve` process. Closing the desktop window hides it to the system tray so the embedded backend keeps running; use the tray menu to reopen or quit.

If a desktop UI render crash reaches the app root, Milim shows a reloadable error screen instead of a blank window.

```bash
pnpm -C apps/desktop install
pnpm -C apps/desktop tauri dev
```

Shipped UI:

- Unified first-run setup follows Model, Defaults, optional Context, and Ready. Advanced features are always available; the collapsed sidebar Tools launcher opens MCP servers, Skills, and Schedules.
- The first product loop is dev chat: connect a provider or account runtime, pick a workspace folder, ask for an edit or test run, switch models inline, and continue the same thread without resetting workspace context, memory, previews, artifacts, approvals, or queued messages.
- Hot Swap keeps the Milim thread canonical while models change: compatible switches stay immediate, lossy handoffs show a compact preflight, stale Codex/Claude sessions offer Fresh or Resume, and the latest response can be continued, reviewed read-only, or retried with another model. Coding retries use the pre-turn Git checkpoint in an isolated worktree whose reviewed diff can be applied back to the original workspace.
- Empty chats show local, repository-aware starter prompts derived from the active branch, worktree state, and recent commits; selecting one only prefills the composer.
- Desktop profile data uses verified SQLite WAL mode. Session persistence stores only changed session/message rows, while durable Worker Runs remain canonical in `threads.db` instead of the UI snapshot.
- Chat sessions with row-backed desktop persistence, Markdown-rendered user and assistant message bodies with raw source preserved for actions, memoized live Markdown streaming for normal assistant tails with preserved-text fallback for long streams before full Markdown finalize, browser-opening message links, reasoning blocks, virtualized long transcripts, compact live tool activity with expandable details, syntax-highlighted short code snippets, collapsed generated code artifacts, attachments, a compact interruptible and reorderable queued-send tray, persisted thread-local composer drafts and history recall with transient position feedback, first-message and optional AI thread titles, copy with transient confirmation, regenerate/edit-and-resend, in-place assistant edits, message deletion, branch-from-message, JSON/Markdown thread export/import, filtered search, custom right-click menus for app objects while preserving native text/link editing menus, tokenizer-backed context compaction checkpoints that reject truncated summaries, keep a bounded recent tail verbatim, cap old attachment/tool bodies in summary prompts, and track lifetime/since-checkpoint usage totals, persisted sidebar/context/inspector state with five-at-a-time per-section thread reveals, response metrics that update after each built-in tool-agent model request, generated artifact previews with thread-local revision cycling, built-in scoped preview tools for the active DOM-capable preview surface, no-folder virtual project files with review/apply and versioned artifact sources, visual-only preview activity cues for tool events with click-through browser-preview overlays, native App/URL previews that yield to overlapping app dialogs and popovers, inline/display-only handling for anonymous code and markdown tables, lightweight anonymous script/TSX preview fallbacks, managed no-folder Node preview apps from named file metadata with package-manager detection, a required `dev` script, Vite entry/style and Tailwind config fallbacks, full named-file staging within the preview size budget, and selected-folder Node preview apps that run that folder directly without staged-file rewrites. Runnable apps never execute on generation: the inspector first shows a read-only command/scope/fingerprint review, then requires an explicit Run; managed files are staged only after that confirmation. Runtime state distinguishes active from ready, survives transient polling failures, reports compile failures without discarding the last URL, and supports a cancellable install/start lifecycle. The unified Preview / Code / Git / Workers inspector keeps artifact revisions, app state, Worker Runs, and memory-only manual URL history independent per thread.
- Image attachments are forwarded as image content parts to provider chat and server-side agent runs when the selected backend supports vision; Codex and Claude account runtimes remain prompt-text only. Desktop attachment reads are limited to files picked in the native dialog or workspace-relative files under the selected folder, and binary images are not decoded as text.
- Provider onboarding for OpenAI, OpenRouter, Groq, Ollama, LM Studio, custom OpenAI-compatible remotes, Anthropic, Gemini, and Replicate/fal media with encrypted key storage and model capability metadata, including native local vision/tool-use labels where available; account-runtime onboarding for Codex and the installed Claude CLI, with per-chat native session persistence, consent-gated Claude session recovery, Milim approval modes, and visible tool events. The model chip is the sole visible model selector; its picker shows provider, runtime lane, setup status, capabilities, Favorites, per-model reasoning effort, and whether the next turn is plain chat, Milim tools, Codex runtime, Claude runtime, or media.
- Per-model reasoning effort controls where the provider, local runtime, or account runtime advertises supported effort levels.
- Model-agnostic Agents store reusable roles with deterministic avatar seeds; the same generated identity follows persona, schedule, and assigned Worker surfaces without image files. Workers are live instances grouped into durable Runs on the canonical parent chat. Each thread defaults to Ask delegation and can switch Off/Ask/Auto or choose a Worker model. Ask freezes an exact approval plan; Auto joins parallel results before the parent answer. Workers never appear as sidebar chats. Approved writers use isolated Git worktrees with explicit diff apply; non-Git workspaces fall back to read-only. Schedules remain single-agent.
- Memory/RAG with Personal and workspace-bound Project libraries, at most five relevant entries injected per enabled turn, archive/recovery controls, legacy thread-memory recovery, explicit tool-capable writes, and provider-routed embeddings behind the same remote privacy gate.
- Workspace and Git panels with guarded fetch/diff/commit/sync actions, local branch switching and creation, model-generated commit subjects when the message is left blank, turn-level Git worktree checkpoints with restore actions, a unified Preview / Code / Git / Workers inspector, and a persisted thread-local Context card for grouped environment, task, live activity, model, usage, privacy, memory, and source state. Its reserved 300px slot pushes the transcript while the summary remains a compact floating card; it can coexist with the inspector on wide layouts and becomes mutually exclusive with it on narrow layouts. An adjacent workspace launcher opens the active folder in installed local tools; filesystem/shell tools remain rooted to the selected folder, generated-file diff review/apply/save-to-workspace flows use selected artifact revisions, Docker sandbox runs remain isolated, preview DOM tools require an active ready surface, optional computer-use controls OS input, and Review/Guarded/Open gate tool execution.
- The latest code-changing turn exposes Undo changes, which restores its pre-turn checkpoint, removes the assistant response, retains the original request, and clears native runtime state that no longer matches the workspace.
- Privacy gate with Off, Redact, and Block modes enforced server-side before remote-provider and account-runtime calls.
- Image/video generation through configured remote providers with model schema controls, status polling, and result previews.
- Mobile companion for paired phones, with restart-proof pairing, persisted phone URL base, startup Tailscale Serve repair when the bridge is enabled, in-app QR scanning, active desktop theme mirroring, Markdown-rendered live thread viewing/switching through a project-aware mobile sidebar, compact Worker plan approval/progress/results/stop controls, new-thread/stop/regenerate/rename/archive/delete controls, mobile file/photo attachments, model switching, phone sends through the desktop composer/model path, pairing, enable/disable, queued events, device revocation, and a Tailscale Serve setup helper that opens Tailscale download when missing and creates phone-reachable tailnet HTTPS URLs where available.
- Searchable settings with section status indicators, themes with contrast validation for custom palettes, custom style settings, configurable app-window keyboard shortcuts (Previous thread defaults to `Ctrl+Tab` on Windows/macOS and opens a compact recent-thread switcher), Ctrl/Cmd `+` and `-` UI scaling with transient title-bar controls, optional active Codex/Claude account usage in the title bar, resizable sidebar/inspector dividers that snap closed when dragged 96px past their minimum, reopen when that same drag reverses, and reset with double-click or Enter, frameless window controls, close-to-tray background mode, persisted window state, shared app notices for background events, and startup plus background GitHub Release update checks for Windows/macOS artifacts with checksum verification and a top-bar one-click install action.

## Test

```bash
cargo test
cargo clippy --workspace --all-targets
pnpm -C apps/desktop verify
pnpm -C apps/desktop verify:tester-ready
pnpm -C apps/site build
```

## Release Artifacts

The release workflow publishes stable Windows portable EXE and macOS universal DMG/app zip artifacts:

- `milim-windows-x64-portable.exe`
- `milim-macos-universal.dmg`
- `milim.app.zip`

Linux release packaging is intentionally disabled in `apps/desktop/scripts/package-release.mjs`.

Release builds run desktop verification on both macOS and Windows, require Apple signing secrets for macOS artifacts, intentionally enable Tauri's macOS private API for transparent preview activity overlay windows, and publish `manifest.json` plus an aggregate `SHA256SUMS.txt` from the current release run. Updater assets are verified with SHA-256 sidecars and the aggregate checksum file.

## License

MIT.
