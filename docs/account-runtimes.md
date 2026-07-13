# Account Runtimes

Milim can use signed-in Codex and bring-your-own Claude CLI tools as chat runtimes. These are separate from saved OpenAI-compatible, Anthropic, Gemini, Replicate, and fal provider records. The privacy gate scans, redacts, or blocks text before either account runtime receives it. Image pixels cannot be scanned or redacted, so account-runtime images require Privacy Off.

After a Milim chat has a native Codex thread id or Claude session id, Milim lets that runtime own prior context. Later turns send the current per-turn context plus the latest user message instead of replaying the visible Milim transcript or auto-compacting it first. Manual `/compact` still creates a visible Milim checkpoint, but its summary call is ephemeral and the stored native runtime id is cleared afterward.

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

`/codex/run` accepts `model`, `prompt`, optional `images`, optional `cwd`, optional `reasoning_effort`, optional `thread_id`, optional `persist_thread`, and Milim tool approval fields. A request is valid when the prompt is non-empty or at least one image is present. Each image is `{ "media_type": "image/png", "data": "<base64>" }`; PNG, JPEG, WebP, and GIF are accepted up to 2 MB each. Milim validates the bytes after the privacy check, writes only those bytes into a private temporary per-turn directory, sends Codex app-server `localImage` inputs, and deletes the directory when the turn ends. Caller-supplied filesystem paths are never accepted as image inputs.

Milim desktop persists the returned Codex thread id on the Milim chat and sends it back on later turns, so reopening a chat resumes the same Codex app-server thread. One-off side calls omit `persist_thread` and remain ephemeral. Any effort except `auto` is forwarded to Codex as the app-server `effort` field.

The desktop model picker reads Codex `supportedReasoningEfforts`, `defaultReasoningEffort`, and `inputModalities`. Image-capable Codex models show Vision when Codex advertises image input; missing modality metadata remains unknown and does not block an attempted send. Text attachments remain bounded prompt context, while image attachments are sent as real multimodal inputs.

Codex image-generation results are streamed back as:

```json
{ "type": "image", "id": "...", "status": "completed", "url": "data:image/png;base64,..." }
```

Milim renders those as generated image previews in chat. This covers Codex models that emit image-generation items when the installed Codex runtime exposes them.

## Installed Claude CLI

Milim does not include Claude Code, does not provide Anthropic credentials, and is not affiliated with or endorsed by Anthropic. This integration only invokes the user's separately installed official Claude CLI on the local machine. Use of Claude and Claude Code is governed by Anthropic's terms.

Claude CLI integration boundaries:

- Milim invokes the local `claude` executable.
- Milim does not bundle Claude Code, proxy Claude access, or sell Claude access.
- Authentication is handled by the official Claude CLI, for example with `claude auth login`.
- Milim does not manage, store, or receive Claude credentials.
- Claude CLI usage remains subject to Anthropic's terms.
- Some permission modes may allow Claude to run local tools and commands.
- Stale-session recovery asks before stopping a matching local Claude CLI process.

| Surface | Behavior |
|---|---|
| `GET /claude/status` | Checks installed CLI availability, auth state, account metadata, model aliases, and optional per-alias image capability metadata. |
| `POST /claude/run` | Runs `claude -p --input-format stream-json --output-format stream-json` with Milim's selected tool approval mode. |

`/claude/run` accepts `model`, `prompt`, the same optional base64 `images` array as Codex, optional `cwd`, optional `reasoning_effort`, optional `session_id`, optional `allow_session_recovery`, and Milim tool approval fields. A request may be image-only. Milim pipes a native user message containing text and Anthropic base64 image blocks into the CLI; no OCR or prompt-only image note is used. Milim desktop stores one Claude session id per Milim chat. New native sessions pass it as `--session-id`; existing Claude project transcripts pass it as `--resume`, so reopening a chat restores the same installed Claude CLI session instead of colliding with the existing transcript file. One-off side calls omit `session_id` and use `--no-session-persistence`.

If Claude reports that a persisted session id is already in use, Milim emits a recovery-required event and asks before trying to stop a matching local `claude`/`node` process for that exact session id and retrying once. Milim does not delete Claude session registry files by default.

Milim maps `low`, `medium`, `high`, `xhigh`, and `max` to Claude CLI `--effort`; `auto`, `none`, and `minimal` are omitted. Runs map Milim approval modes onto Claude permission modes and do not set a max-turn cap. Open mode maps to Claude's `bypassPermissions` mode, which may run tools and commands without additional Claude prompts; use it only in trusted workspaces.

Claude CLI models in the picker advertise image input plus `low`, `medium`, `high`, `xhigh`, and `max` reasoning efforts. The built-in aliases include `sonnet`, `opus`, `haiku`, and `fable`.
