---
id: desktop
path: desktop
label: Desktop app
title: Desktop app
summary: Simple and Workbench modes, threads, projects, composer controls, artifacts, plan mode, goals, search, rendering, settings, and slash commands.
group: Workbench
order: 30
updated: 2026-07-05
---

The first run can open as Simple or Workbench. Simple keeps the chat core visible with model switching, themes, memory, and voice basics; Workbench exposes project, agent, MCP, media, sandbox, schedule, and computer-use controls. In both modes, the Tauri process starts the embedded backend, connects persisted MCP servers, refreshes provider models, and runs schedules in the background. Closing the desktop window hides it to the system tray so those background services keep running; use the tray menu to reopen or quit.

## Interface modes

| Mode | Visible surface |
|---|---|
| Simple | Chat, model switching, themes, memory, and voice basics. |
| Workbench | Simple plus workspace/Git, agents, skills, MCP, schedules with attached file context and visible result threads, media, sandbox, computer use, and the memory manager. |

## Workbench map

| Area | Role |
|---|---|
| Top bar | Theme, update, provider, and global app controls. |
| Sidebar | Projects, threads, pinned groups, archives, unread state, child threads, per-section ellipsis toggles, and quick switching. |
| Thread header | Current model, workspace folder, agent, approval, privacy, memory, sandbox, and computer-use state. |
| Composer | Prompt text, per-thread unsent drafts, thread-local sent-history recall, slash commands, file attachments, voice input, queued sends, and send controls. |
| Run timeline | Reasoning, tool calls, tool results, workspace checkpoint notices, memory notices, child-thread activity, and usage metrics. Built-in tool-agent usage updates after each model request completes; account runtimes remain terminal-only unless their CLIs report more. |
| Side panel | Switches between detected artifacts, a browser/URL preview, and Git status/actions; artifact revisions and the selected mode persist per thread. |

## Session controls

| Control | Behavior |
|---|---|
| Model | Pick any discovered chat, account-runtime, or media-capable model. |
| Folder | Sets the host working folder. Host filesystem, shell, and Git actions refuse to run until a folder is selected. |
| Sandbox | Enables Docker-backed command execution through the isolated `run_command` tool. |
| Computer use | Enables OS-level screen capture plus mouse/keyboard tools when the desktop build includes the feature. |
| Memory | Adds scoped thread/project memory search as cheap turn context. Durable memory writes use `memory_register` only on explicit remember/save requests or already tool-capable turns. |
| Privacy | Sets `off`, `redact`, or `block` for remote-provider and account-runtime traffic. |
| Approval | Sets `review`, `guarded`, or `open` tool execution policy. |
| Plan | Keeps the turn read-only until you approve execution. |
| Goal | Tracks a thread objective, success criteria, constraints, turn count, and continuation prompts. |

## Artifacts

Named artifacts from later assistant messages become selectable revisions of the same logical file or title. Revisions are immutable snapshots from chat history; preview, copy, download, diff review, apply, and save actions use the selected revision. Threads without a selected folder save/apply named artifacts into a persisted per-thread virtual project; threads with a folder write to disk. Extracted code artifacts collapse to compact source rows in the transcript; open the side panel or review a workspace diff to inspect the full source. Inline artifacts, including anonymous code fences, markdown tables, standalone JSON, and standalone CSV, remain display/export content and do not get workspace target paths, batch apply, or save controls. Saved files record the source app session, message turn, and artifact revision when available.

HTTP and HTTPS links rendered in assistant responses open in the system browser. When the side panel is open to artifacts, generated artifacts and localhost, 127.0.0.1, or [::1] URLs from completed shell or sandbox commands update the panel preview; the small browser button can also open or switch that panel to a blank browser state, the selected side-panel mode persists per thread, and the panel accepts public HTTPS URLs. Generated artifacts still preview through sandboxed iframe/srcDoc rendering, with anonymous script and TSX artifacts compiled through a lightweight standalone fallback when no filename is provided. Preview panels can show visual-only activity cues from structured tool events, such as cursor travel, click, scroll, typing, and inspection glow; those cues do not send DOM, webview, OS mouse, or keyboard input. Local Vite previews can force a visual cue for QA by opening the app with `?previewActivity=click`, `move`, `scroll`, `type`, or `inspect`, then opening the side panel. No-folder chats keep named file artifacts in the thread virtual project and stage that project into a managed Node preview app under `~/.milim/runtime/preview-apps/<thread-id>/`; named files can use fence metadata, a standalone filename line immediately before the fence, or a `file=path` first line inside the fence, all named files are kept within the preview size budget, a single anonymous CSS block can fill an imported CSS path, and the staged copy can add Vite entry/style and Tailwind config fallbacks. Threads with a selected folder can start the same runtime controls against that folder directly without staging generated files or writing preview fallback files into the project. Runnable no-folder generated apps auto-open through the managed runtime preview once running, runtime-holding threads show a sidebar marker, restored browser panels keep the managed preview URL, runtime/code follow-ups include the virtual project files as read-only model context, and the runtime detects npm, pnpm, Yarn, or Bun from `packageManager` and lockfiles, requires `scripts.dev`, reports Vite compile failures as runtime errors, and ignores other inline artifacts.

## Workspace checkpoints

Tool-enabled turns with a selected Git workspace create a Git worktree checkpoint before the assistant can write files or run commands. Assistant messages with a checkpoint expose a restore action that returns the workspace files to their pre-turn content without moving the current branch HEAD.

## Git side panel

The Git side panel appears only for selected folders that are Git repositories. Its branch selector lists local branches, can checkout another local branch, and can create a new branch from the current `HEAD`; checkout failures are reported from Git without changing the worktree.

## Plan mode

Plan mode injects a system instruction that allows read-only inspection and blocks edits, writes, shell commands, computer control, schedule creation, memory registration, and other mutations. The assistant returns a concrete implementation plan. The UI exposes an Execute plan action that sends the approved plan back as a normal run.

## Goals

Goals are thread-level autonomous runs, not saved agent profiles. A goal stores objective, success criteria, constraints, status, last reason, next prompt, turn count, timestamps, and an optional developer max-turn cap. After each visible turn, a controller asks the model whether to continue, complete, or stop as blocked.

## Instructions and compaction

| Feature | Behavior |
|---|---|
| Thread actions | Message rows can branch a new thread from that point, delete a visible message, and edit assistant messages in place. Sidebar rows can branch or export a thread. |
| Per-chat instructions | The composer can attach instructions to the active thread without changing global app defaults. |
| Context compaction | Long chats use tokenizer-backed visible checkpoint messages. Future model calls replay the latest checkpoint summary plus newer turns while the full transcript stays visible. `/compact` creates a checkpoint manually, and auto-compaction uses the same path before long sends. Compaction keeps a bounded recent tail verbatim and caps old attachment/tool bodies in summary prompts. Codex and Claude chats with an existing native thread/session skip Milim auto-compaction and send only per-turn context plus the latest user message. Summary generation rejects truncated or oversized outputs instead of saving incomplete checkpoints. Checkpoints record the usage/cost total at compaction time, the summary-generation cost when available, and the top bar separates lifetime usage from usage since the latest checkpoint. |
| Search operators | Chat search accepts plain text plus `from:user`, `from:assistant`, `in:all`, and `is:archived` filters. |
| Auto thread titles | New chats get first-message titles by default. Optional AI names run after the first reply and need a compatible provider chat model when the chat uses Codex, Claude, or media models. |
| Onboarding | First-run setup chooses Simple or Workbench, connects local/hosted/Codex model sources, and can import Claude/Codex MCP servers and skills as disabled Workbench entries. |
| Theme editor | Themes and custom style settings are persisted with the desktop state. |
| Keyboard shortcuts | App-window shortcuts are configurable; Previous thread defaults to `Ctrl+Tab` on Windows and macOS. |
| Window close | Closing hides Milim to the system tray; minimize keeps normal taskbar behavior. |

## Slash commands

| Command | Behavior |
|---|---|
| `/plan build feature X` | Turn on read-only planning and send the remaining text as the prompt. |
| `/goal build feature X` | Open or prefill the goal panel with a concrete objective. |
| `/model llama3.2` | Set the thread model. |
| `/folder C:\project` | Set the thread working folder. |
| `/sandbox` and `/nosandbox` | Enable or disable sandbox tools. |
| `/computer` and `/nocomputer` | Enable or disable computer-use tools. |
| `/memory` and `/nomemory` | Enable or disable scoped memory. |
| `/privacy redact` | Set the outbound privacy gate to `off`, `redact`, or `block`. |
| `/approval guarded` | Set tool approval to `review`, `guarded`, or `open`. |
| `/agent none` | Switch to a named agent by id/name, or clear the active agent. |
| `/compact` | Summarize prior context into a visible checkpoint and start future model calls from that summary. |
| `/export` | Download the active thread as a Milim JSON export. Use `/export md` for Markdown. |
| `/import` | Pick a Milim JSON or Markdown thread export and import it as a new local thread. |
| `/clear` | Start a fresh chat with current settings. |
