# milim

milim is a local-first AI desktop workbench for people who use more than one model. It embeds a Rust backend with a local HTTP API, supports OpenAI-compatible, Ollama-compatible, and Anthropic-compatible routes, and brings provider-agnostic chat, encrypted provider management, Codex/Claude Code account runtimes, agents/tools, memory/RAG, voice, media generation, artifact workflows, and outbound privacy controls into one app.

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
| `serve [--port N] [--expose]` | Start the HTTP server. |
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

Milim does not ship a GGUF runtime. Local GGUF inference belongs in dedicated runtimes such as Ollama or LM Studio; Milim integrates with them through their API surfaces. Ollama thinking models can use Milim reasoning effort controls through `/v1/chat/completions`; LM Studio models with native reasoning metadata use LM Studio's `/api/v1/chat` reasoning settings when no custom tools are attached and `/v1/responses` for Milim function-tool requests, while `gpt-oss` low/medium/high effort keeps using LM Studio's `/v1/responses` path. Structured-output controls are forwarded through OpenAI `response_format`, Ollama `format`, and Responses `text.format` where the selected backend supports them. The desktop app manages encrypted provider records for OpenAI, OpenRouter, Groq, Anthropic, Gemini, Replicate, fal, local Ollama, local LM Studio, and custom OpenAI-compatible endpoints. Codex and Claude Code are account runtimes backed by their installed CLIs; they are separate from saved provider records, appear in the model picker after authentication, and use Milim approval modes with visible tool events.

## API Surface

| Area | Endpoint(s) |
|---|---|
| OpenAI chat/responses/completions/models/embeddings | `POST /v1/chat/completions` (`/chat/completions`), `POST /v1/responses`, `POST /v1/completions` (`/completions`), `GET /v1/models` (`/models`), `POST /v1/embeddings` (`/embeddings`) |
| Ollama chat/generate/tags/embeddings | `POST /api/chat`, `POST /api/generate`, `GET /api/tags`, `POST /api/embed`, `POST /api/embeddings` |
| Anthropic messages | `POST /anthropic/v1/messages`, `POST /anthropic/messages`, `POST /v1/messages` |
| Provider registry | `GET/POST /providers`, `GET /providers/discover`, `DELETE /providers/{id}` |
| Audio | `POST /audio/transcriptions`, `POST /audio/vad`, `POST /audio/speech`, `POST /audio/setup/check`, plus Piper/Kokoro/VAD preset and Piper executable install routes |
| Media generation | `GET /media/models`, `GET /media/model-schema`, `GET /media/status`, `POST /media/generate` |
| MCP | `GET /mcp/tools`, `POST /mcp/call`, `GET/POST /mcp/servers`, `DELETE /mcp/servers/{id}` |
| Agents and threads | `POST /agents/run`, `GET/POST /agents`, `GET/PUT/DELETE /agents/{id}`, `POST /agents/{id}/run`, `/threads/{id}` routes |
| Memory / RAG | `POST /memory/ingest`, `/memory/search`, `/memory/register`, `/memory/graph/search`, plus scope/node routes |
| Privacy filter | `POST /privacy/scan`, `GET/POST /privacy/mode` |
| Skills and schedules | `GET/POST /skills`, `POST /skills/select`, `GET/PUT/DELETE /skills/{id}`, `GET/POST /schedules`, `GET /schedules/events`, `PUT/DELETE /schedules/{id}` |
| Workspace and tools | `GET/POST /workspace`, `GET /workspace/git`, `POST /workspace/git/action`, `GET/POST /computer`, `POST /sandbox/run` |
| Managed preview apps | `GET /preview-apps/{runtime_id}`, `POST /preview-apps/{runtime_id}/stage`, `POST /preview-apps/{runtime_id}/start`, `POST /preview-apps/{runtime_id}/stop`, `POST /preview-apps/{runtime_id}/restart`, `GET /preview-apps/{runtime_id}/logs` |
| Mobile companion | `GET /mobile`, PWA assets under `/mobile/*`, `GET /mobile/status`, `POST /mobile/enabled`, `POST /mobile/pairing`, `POST /mobile/pair`, `GET /mobile/device/status`, `POST /mobile/relay`, `GET/POST /mobile/thread`, `GET /mobile/thread/events`, `GET /mobile/events`, `DELETE /mobile/devices/{id}` |
| Codex account runtime | `GET /codex/account`, `POST /codex/login/device`, `/codex/login/chatgpt-device`, `/codex/login/api-key`, `/codex/logout`, `GET /codex/rate-limits`, `GET /codex/models`, `POST /codex/run` |
| Claude Code runtime | `GET /claude/status`, `POST /claude/run` |
| Health | `GET /health` |

Standalone auth is configured in `~/.milim/config/server.json`: set `authRequired: true` to accept locally minted `msk-v1` keys, add static bearer secrets under `apiKeys`, or trust extra signed-key issuers under `accessKeyIssuers`. CLI client commands accept `--url`, `--port`, and `--token` (`MILIM_API_TOKEN`) when calling an authenticated server. The desktop app disables loopback trust and uses a per-launch bearer token for its embedded server. Empty CORS allow-list means no browser origins are allowed; set explicit origins at `~/.milim/config/server.json` when needed.

## Workspace Layout

```text
crates/
  milim-core/       serde DTOs, config, paths, errors
  milim-inference/  ModelService trait plus remote, Anthropic, Gemini, and test backends
  milim-storage/    SQLite persistence plus AES-GCM encryption
  milim-identity/   secp256k1 identity plus msk-v1 access keys
  milim-tools/      tool registry plus filesystem and built-in tools
  milim-agents/     tool-use agents and subagent workers backed by persisted child threads
  milim-memory/     embedding vector store, scoped graph memory, RAG
  milim-automation/ cron-scheduled agent runs
  milim-skills/     local skill registry
  milim-privacy/    regex PII filter plus reversible redaction gate
  milim-sandbox/    Docker-backed isolated command runner
  milim-mcp-client/ external MCP stdio client bridge
  milim-voice/      STT/TTS/VAD contracts and providers
  milim-server/     axum HTTP server
  milim-cli/        the `milim` binary
apps/
  desktop/          Tauri 2 + Vite/React/TypeScript desktop app
  site/             Vite/React Cloudflare Pages site for milim.ai
```

## Desktop App

The Tauri app embeds the server in-process; the app is the server, so there is no separate `serve` process. Closing the desktop window hides it to the system tray so the embedded backend keeps running; use the tray menu to reopen or quit.

```bash
pnpm -C apps/desktop install
pnpm -C apps/desktop tauri dev
```

Shipped UI:

- First-run Simple or Workbench mode. Simple keeps the chat surface calm; Workbench exposes workspace, agents, MCP, memory, media, sandbox, schedules, and computer-use controls.
- Chat sessions with row-backed desktop persistence, streaming markdown, browser-opening response links, reasoning blocks, compact live tool activity with expandable details, syntax-highlighted short code snippets, collapsed generated code artifacts, attachments, queued sends, first-message and optional AI thread titles, thread-local composer drafts and history recall, copy/regenerate/edit-and-resend, in-place assistant edits, message deletion, branch-from-message, JSON/Markdown thread export/import, filtered search, custom right-click menus for app objects while preserving native text/link editing menus, tokenizer-backed context compaction checkpoints that reject truncated summaries, keep a bounded recent tail verbatim, cap old attachment/tool bodies in summary prompts, and track lifetime/since-checkpoint usage totals, persisted sidebar/side-panel state, response metrics that update after each built-in tool-agent model request, generated artifact previews with thread-local revision cycling, built-in scoped preview tools when the side panel is visible, no-folder virtual project files with review/apply and versioned artifact sources, visual-only preview activity cues for tool events, inline/display-only handling for anonymous code and markdown tables, lightweight anonymous script/TSX preview fallbacks, managed no-folder Node preview apps from named file metadata with package-manager detection, a required `dev` script, Vite entry/style and Tailwind config fallbacks, full named-file staging within the preview size budget, selected-folder Node preview apps that share one runtime per project folder and run that folder directly without staged-file rewrites, auto-opened running runtime previews for runnable generated apps with sidebar runtime markers, persisted preview URLs, read-only virtual preview file context for runtime follow-ups, compile-error status reporting, and manually openable native URL previews with a side-panel address bar.
- Provider onboarding for OpenAI, OpenRouter, Groq, Ollama, LM Studio, custom OpenAI-compatible remotes, Anthropic, Gemini, and Replicate/fal media with encrypted key storage and model capability metadata; account-runtime onboarding for Codex and Claude Code through their installed CLIs, with per-chat native session persistence, Milim approval modes, and visible tool events.
- Per-model reasoning effort controls where the provider, local runtime, or account runtime advertises supported effort levels.
- Agents, schedules with attached file context and visible result threads, skills, external MCP servers, tool timelines, worker supervision, child threads that inherit Open-mode tools but stay read-only in safer modes, unfinished child-thread restart sweep to `error` and graceful shutdown marking running children `stopped`, bounded tool-result replay to keep agent loops efficient, stop controls, plan mode, goal runs, and server-side tool-use runs.
- Memory/RAG with scoped graph memory, searchable memories injected as cheap turn context, explicit/tool-capable memory writes, and provider-routed embeddings behind the same remote privacy gate.
- Workspace and Git panels with guarded fetch/diff/commit/sync actions, local branch switching and creation, model-generated commit subjects when the message is left blank, turn-level Git worktree checkpoints with restore actions, a shared side panel that switches between artifacts, browser, and Git, filesystem/shell tools rooted to a selected folder, generated-file diff review/apply/save-to-workspace flows for selected artifact revisions, Docker sandbox runs, automatic preview-side-panel DOM tools scoped to the active preview, optional OS-level computer-use screen/input control, and Review/Guarded/Open tool approval modes.
- Privacy gate with Off, Redact, and Block modes enforced server-side before remote-provider and account-runtime calls.
- Voice input, push-to-talk, active-app dictation, STT, VAD, TTS, Piper/Kokoro preset installs, and native ORT provider options behind feature flags where needed.
- Image/video generation through configured remote providers with model schema controls, status polling, and result previews.
- Mobile companion for paired phones, with restart-proof pairing, persisted phone URL base, startup Tailscale Serve repair when the bridge is enabled, in-app QR scanning, active desktop theme mirroring, Markdown-rendered live thread viewing/switching through a project-aware mobile sidebar, new-thread/stop/regenerate/rename/archive/delete controls, mobile file/photo attachments, model switching, phone sends through the desktop composer/model path, pairing, enable/disable, queued events, device revocation, and a Tailscale Serve setup helper that opens Tailscale download when missing and creates phone-reachable tailnet HTTPS URLs where available.
- Themes, custom style settings, configurable app-window keyboard shortcuts (Previous thread defaults to `Ctrl+Tab` on Windows/macOS), frameless window controls, close-to-tray background mode, persisted window state, and GitHub Release update checks for Windows/macOS artifacts with checksum verification and a top-bar one-click install action.

Whisper STT, native VAD, and native TTS are opt-in build features because they require native toolchains and model files:

```bash
MILIM_WHISPER_MODEL=/path/to/ggml-*.bin cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features whisper
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features native-vad
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --features native-tts
```

## Test

```bash
cargo test
cargo clippy --workspace --all-targets
pnpm -C apps/desktop verify
pnpm -C apps/desktop verify:tester-ready
pnpm -C apps/desktop verify:native-vad
pnpm -C apps/desktop verify:native-tts
pnpm -C apps/site build
```

## Release Artifacts

The release workflow publishes stable Windows portable EXE and macOS universal DMG/app zip artifacts:

- `milim-windows-x64-portable.exe`
- `milim-macos-universal.dmg`
- `milim.app.zip`

Linux release packaging is intentionally disabled in `apps/desktop/scripts/package-release.mjs`.

Updater assets are verified with SHA-256 sidecars and an aggregate `SHA256SUMS.txt`.

## License

MIT.
