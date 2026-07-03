---
id: privacy
path: privacy
label: Privacy
title: Privacy and security
summary: Remote-provider privacy modes, redaction, blocking, deterministic scanning, bearer auth, and CORS boundaries.
group: Local data
order: 70
updated: 2026-07-03
---

Privacy settings are easiest to reason about as a routing question: what stays local, what goes to a provider, and which gate runs before a remote send.

## Privacy modes

| Mode | Server behavior |
|---|---|
| `off` | No scanning, redaction, or blocking. Remote sends are forwarded as-is. |
| `redact` | Detected PII is replaced with reversible `[KIND_N]` placeholders before the remote call, then restored in streamed replies when possible. |
| `block` | Remote sends containing detected PII fail closed before the provider call. |

The scanner is deterministic regex-based detection for common email, phone, token-like, IP, URL, and secret-looking strings. It does not infer names or sensitive meaning from natural language.

## What is enforced server-side

| Route family | Privacy gate |
|---|---|
| Remote chat providers | Enforced before the provider router sends a completion request. |
| Remote embeddings | Enforced before embedding inputs leave the machine. |
| Remote media providers | Enforced before Replicate, fal, or OpenRouter media prompts are sent. |
| Codex runtime | Enforced before `/codex/run` forwards a prompt to the Codex app-server. |
| Claude Code runtime | Enforced before `/claude/run` forwards a prompt to the `claude` CLI. |
| Local Ollama or LM Studio | Not scanned by Milim because the configured local runtime receives the prompt on the machine. |

The gate is process-global. The desktop syncs the active setting through `POST /privacy/mode`, and the router reads that same setting when a remote request is about to leave.

## Data boundary

| Route | Boundary |
|---|---|
| Local Ollama or LM Studio | Prompt, files, and embeddings stay on the machine unless that runtime is configured otherwise. |
| Hosted model provider | Messages, selected context, embedding inputs, and tool-visible text go to the provider after the privacy mode is applied. |
| Media provider | Prompt text and model parameters go to Replicate, fal, OpenRouter media, or the selected media backend after the privacy mode is applied. |
| Mobile companion | Paired phone text, files, and photos enter the active desktop thread; the desktop still controls the final model send and privacy gate. |
| MCP tools | External MCP servers run as configured local child processes or remotes; treat each configured server as its own trust boundary. |

## Auth and CORS

The desktop app disables loopback trust and uses a per-launch bearer token for its embedded server. Standalone server auth supports static bearer tokens or `msk-v1` access keys when configured. Empty CORS allow-list means no browser origins are allowed; configured origins are explicit.

```bash Scan text before sending
curl http://127.0.0.1:7377/privacy/scan \
  -H "Content-Type: application/json" \
  -d '{"text":"email me at person@example.com"}'
```

```bash Block remote sends with detected PII
curl http://127.0.0.1:7377/privacy/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"block"}'
```
