# Account Runtimes

Milim can use signed-in Codex and Claude Code CLIs as chat runtimes. These are separate from saved OpenAI-compatible, Anthropic, Gemini, Replicate, and fal provider records. The privacy gate scans, redacts, or blocks prompts before either account runtime receives them.

After a Milim chat has a native Codex thread id or Claude session id, Milim lets that runtime own prior context. Later turns send the current per-turn context plus the latest user message instead of replaying the visible Milim transcript or auto-compacting it first. Manual `/compact` still creates a visible Milim checkpoint, but its summary call is ephemeral and the stored native runtime id is cleared afterward.

Workspace Git panel buttons such as diff, fetch, commit, pull, push, publish, checkout branch, and create branch run through Milim's local workspace Git endpoint. The selected chat model is only called when a blank commit message needs a generated subject or when the user asks an agent to review Git state.

CLI calls to an authenticated standalone server should pass `--token` or set `MILIM_API_TOKEN`; desktop account-runtime calls use the desktop app's per-launch bearer token internally.

## Codex

Codex uses the installed Codex CLI app-server.

| Surface | Behavior |
|---|---|
| `GET /codex/account` | Reads the current Codex account state. |
| `POST /codex/login/device` | Starts the ChatGPT browser login flow. This is what the desktop Providers UI uses. |
| `POST /codex/login/chatgpt-device` | Starts the ChatGPT device-code login flow. |
| `POST /codex/login/api-key` | Passes `{ "api_key": "..." }` to Codex app-server login. Milim does not store this key. |
| `POST /codex/logout` | Logs out through Codex app-server. |
| `GET /codex/models` | Lists Codex models and forwards Codex model metadata to the picker. |
| `GET /codex/rate-limits` | Reads Codex account rate-limit state. |
| `POST /codex/run` | Starts or resumes a Codex app-server thread with Milim's selected tool approval and workspace sandbox policy. |

`/codex/run` accepts `model`, `prompt`, optional `cwd`, optional `reasoning_effort`, optional `thread_id`, optional `persist_thread`, and Milim tool approval fields. Milim desktop persists the returned Codex thread id on the Milim chat and sends it back on later turns, so reopening a chat resumes the same Codex app-server thread. One-off side calls omit `persist_thread` and remain ephemeral. Any effort except `auto` is forwarded to Codex as the app-server `effort` field.

The desktop model picker reads Codex `supportedReasoningEfforts`, `defaultReasoningEffort`, and `inputModalities`. Image-capable Codex models show the vision capability when Codex advertises image input. Chat text attachments are forwarded into Codex prompts as bounded attachment context; image attachments currently send metadata and an image-available note, not raw image bytes.

Codex image-generation results are streamed back as:

```json
{ "type": "image", "id": "...", "status": "completed", "url": "data:image/png;base64,..." }
```

Milim renders those as generated image previews in chat. This covers Codex models that emit image-generation items when the installed Codex runtime exposes them.

## Claude Code

Claude Code uses the installed `claude` CLI.

| Surface | Behavior |
|---|---|
| `GET /claude/status` | Checks CLI availability, auth state, account metadata, and model aliases. |
| `POST /claude/run` | Runs `claude -p --output-format stream-json` with Milim's selected tool approval mode. |

Claude auth is handled outside Milim with `claude auth login`.

`/claude/run` accepts `model`, `prompt`, optional `cwd`, optional `reasoning_effort`, optional `session_id`, and Milim tool approval fields. Milim desktop stores one Claude session id per Milim chat and passes it as `--session-id`, so reopening a chat resumes the same Claude Code session. One-off side calls omit `session_id` and use `--no-session-persistence`. Milim maps `low`, `medium`, `high`, `xhigh`, and `max` to Claude Code `--effort`; `auto`, `none`, and `minimal` are omitted. Runs map Milim approval modes onto Claude Code permission modes and do not set a max-turn cap.

Claude Code models in the picker advertise `low`, `medium`, `high`, `xhigh`, and `max` reasoning efforts. The built-in aliases include `sonnet`, `opus`, `haiku`, and `fable`.
