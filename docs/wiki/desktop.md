---
id: desktop
path: desktop
label: Desktop app
title: Desktop app
summary: Simple and Workbench modes, threads, projects, composer controls, artifacts, plan mode, goals, search, rendering, settings, and slash commands.
group: Workbench
order: 30
updated: 2026-07-10
---

The first run can open as Simple or Workbench. Simple keeps the dev chat core visible with model switching, themes, memory, and voice basics; Workbench exposes project, agent, MCP, media, sandbox, schedule, and computer-use controls. The sidebar Workbench launcher opens Runs, MCP servers, Skills, and Schedules from one persistent place. In both modes, the Tauri process starts the embedded backend, connects persisted MCP servers, and runs schedules in the background. The model picker loads cached models while one startup task refreshes enabled chat providers, then reconciles automatically; Codex and Claude discovery remain independent from provider availability. Background schedule completions and mobile relay events use shared app notices so they remain visible outside their settings panels. Closing the desktop window hides it to the system tray so those background services keep running; use the tray menu to reopen or quit.

## Interface modes

| Mode | Visible surface |
|---|---|
| Simple | Chat, model switching, themes, memory, and voice basics. |
| Workbench | Simple plus workspace/Git, agents, skills, MCP, schedules with attached file context and visible result threads, media, sandbox, computer use, and the memory manager. |

## Workbench map

| Area | Role |
|---|---|
| Top bar | Theme, update, provider, and global app controls. |
| Sidebar | Projects, threads, pinned groups, archives, unread state, child threads, five-at-a-time per-section ellipsis toggles, quick switching, and the Workbench launcher for Runs, MCP servers, Skills, and Schedules. |
| Thread header | Current model, workspace folder, agent, approval, privacy, memory, sandbox, and computer-use state. |
| Composer | Prompt text, visually highlighted plain-text skill/MCP/file/link tokens, persisted per-thread unsent drafts, thread-local sent-history recall with temporary position feedback, slash commands, file attachments, voice input, queued sends, send controls, and local repository-aware empty-state starters that prefill without submitting. |
| Run timeline | Reasoning, compact live tool activity with expandable details, workspace checkpoint notices, memory notices, child-thread activity, and usage metrics. Built-in tool-agent usage updates after each model request completes; account runtimes remain terminal-only unless their CLIs report more. |
| Run Journal | Searchable goal-attempt history with model/provider, status, excerpts, files, tools, artifacts, and an explicit Attach to composer action. |
| Error fallback | Root UI render crashes show a reloadable error screen instead of a blank app window. |
| Context popover | Top-right popover showing compact workspace, active plan/goal, browser, model, and source state for the current thread. A launcher beside its button opens the active folder in installed local tools. |
| Inspector | One Preview / Code / Git surface. Preview selects between a sandboxed Artifact, an explicitly run App, and a memory-only manual URL when those sources exist; Code keeps the chosen artifact revision and sibling files; Git appears only for repositories. |

## Context menus

The desktop app replaces the default right-click menu on Milim-owned surfaces with app actions for threads, project sections, chat messages, artifacts, preview panels, Git panels, and empty app chrome. Text inputs, textareas, selected text, and links keep the native browser menu for edit, copy, paste, select-all, and link actions. External pages inside the native preview child webview keep their own native context menu; the Milim preview toolbar and panel chrome use the app menu.

User and assistant message bodies render Markdown in the transcript, and message bodies plus the composer use automatic text direction so Hebrew and other RTL text read naturally. While an assistant response is still streaming, the live answer tail renders memoized Markdown blocks with expensive final-pass features disabled, falls back to preserved text for long streams, and switches to full Markdown when the turn finalizes. Long transcripts virtualize offscreen rows so old messages stay in history without keeping every row mounted. Message actions, edit/resend, search, model context, and thread export keep using the raw stored source.

The composer keeps prompt storage plain text. Recognized `@Skill Name`, `/Skill Name`, and `/server__tool` tags render as compact pills, while workspace `@file` references and bare HTTP(S) URLs render with link-like highlighting in the editor mirror layer; MCP slash suggestions insert the visible tag only and do not force a tool call or bypass approval/exposure policy.

Image attachments are preserved as image content parts for provider chat and server-side agent runs when the backend supports vision. Codex and Claude account runtimes still receive prompt text plus attachment metadata because their bridge APIs are prompt-string only. Desktop file attachments come from the native file picker or workspace-relative `@file` suggestions under the selected folder; binary images are sent as image data, not decoded as text.

## Session controls

Hot Swap makes the Milim thread canonical rather than any provider session. Selecting a compatible chat model changes the next turn immediately without resetting workspace, memory, artifacts, previews, approvals, goals, or queued messages. A preflight appears only when the target needs context compaction, cannot receive current image/tool context, is unavailable, or has a native Codex/Claude session behind the Milim transcript.

For a stale native session, **Fresh** starts from Milim's complete context while **Resume** keeps the native session and injects turns added since it last completed successfully. The latest assistant response offers **Continue with**, **Review with**, and **Retry with**. Continue and Review prepare editable drafts; Review is read-only for that turn only. Coding retries run from the pre-turn checkpoint in an isolated Git worktree and expose their diff in the Git inspector before it can be applied to the original workspace.

**Undo changes** restores the latest code-changing turn's checkpoint, removes that assistant response, retains the user request, and clears stale account-runtime state.

| Control | Behavior |
|---|---|
| Model | Pick any discovered chat, account-runtime, or media-capable model. The chip shows provider, runtime lane, setup status, capabilities, favorite state, and reasoning effort where supported. |
| Folder | Sets the host working folder. Host filesystem, shell, Git actions, and the quick-summary workspace launcher refuse to run until a folder is selected. |
| Sandbox | Enables Docker-backed command execution through the isolated `run_command` tool. |
| Computer use | Enables OS-level screen capture plus mouse/keyboard tools when the desktop build includes the feature. |
| Memory | Adds scoped thread/project memory search as cheap turn context. Durable memory writes use `memory_register` only on explicit remember/save requests or already tool-capable turns. |
| Privacy | Sets `off`, `redact`, or `block` for remote-provider and account-runtime traffic. |
| Approval | Sets `review`, `guarded`, or `open` tool execution policy. |
| Plan | Keeps the turn read-only until you approve execution. |
| Goal | Tracks a thread objective, success criteria, constraints, turn count, and continuation prompts. |

## Artifacts

Named artifacts from later assistant messages become selectable revisions of the same logical file or title. Revisions are immutable snapshots from chat history; preview, copy, download, diff review, apply, and save actions use the selected revision. Threads without a selected folder save/apply named artifacts into a persisted per-thread virtual project; threads with a folder write to disk. Extracted code artifacts collapse to compact source rows in the transcript; open the side panel or review a workspace diff to inspect the full source. Inline artifacts, including anonymous code fences, markdown tables, standalone JSON, and standalone CSV, remain display/export content and do not get workspace target paths, batch apply, or save controls. Saved files record the source app session, message turn, and artifact revision when available.

HTTP and HTTPS links rendered in chat message bodies open in the system browser. The inspector's native URL source accepts public HTTPS and loopback HTTP (`localhost`, `127.0.0.1`, or `[::1]`) pages. It reuses one incognito child webview for the active App or URL source, reflects real navigations and redirects in the address bar, and enables Back, Forward, reload, and scoped preview tools only after the child webview reports page-load readiness. Generated artifacts preview separately through sandboxed iframe/srcDoc rendering, with anonymous script and TSX artifacts compiled through a lightweight standalone fallback when no filename is provided. Artifact selection, historical revision, App state, and manual URL/history are independent per thread; manual URL history stays memory-only so query strings are not persisted. Runtime updates can make an App source available but do not replace an explicitly selected URL or historical revision.

Runnable generated apps never start automatically. Choose App, select **Review run**, and inspect the scope, working folder, package manager, install requirement, exact install and dev commands, and source fingerprint. **Run** is enabled only for that current preflight. Once healthy, the review collapses into a Ready status control and one-click Stop action; select Ready to reopen the details and Restart action. No-folder projects are atomically staged into Milim's managed runtime directory only after Run; selected-folder previews execute in that folder and warn when dependency installation may modify it. Stop covers installation and the dev server, and restart cannot let an older run overwrite newer state. The runtime probes its loopback URL rather than trusting console text, distinguishes active-but-unhealthy from stopped, preserves the last URL through compile failures and polling disconnects, and returns to ready after recovery. **Prepare fix** adds an editable queued message containing the selected revision and recent failure evidence; it does not send, replace the composer draft, or remove attachments.

Milim registers one active preview surface across artifact iframes, native URL previews, and managed runtime previews, and only enables scoped tools when that surface is ready and DOM-capable: `preview_dom_snapshot`, `preview_click`, `preview_type_text`, `preview_key_press`, and `preview_scroll`. These tools operate only inside the active preview and remain separate from opt-in OS-level `/computer` control. Blank browser, markdown, code, loading, error, and Git states do not expose preview DOM tools. Preview activity cues are visual-only; browser cues use a transparent click-through overlay. Native App and URL webviews hide while an overlapping app dialog or popover is open, then restore at the current bounds without resetting navigation. For local QA, open the app with `?previewActivity=click`, `move`, `scroll`, `type`, or `inspect`, optionally with `previewActivityX` and `previewActivityY`, then open the inspector.

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
| Thread actions | Message rows can copy with temporary confirmation, branch a new thread from that point, delete a visible message, and edit assistant messages in place. Sidebar rows can branch or export a thread. |
| Per-chat instructions | The composer can attach instructions to the active thread without changing global app defaults. |
| Context compaction | Long chats use tokenizer-backed visible checkpoint messages. Future model calls replay the latest checkpoint summary plus newer turns while the full transcript stays visible. `/compact` creates a checkpoint manually, and auto-compaction uses the same path before long sends. Compaction keeps a bounded recent tail verbatim and caps old attachment/tool bodies in summary prompts. Codex and Claude chats with an existing native thread/session skip Milim auto-compaction and send only per-turn context plus the latest user message. Summary generation rejects truncated or oversized outputs instead of saving incomplete checkpoints. Checkpoints record the usage/cost total at compaction time, the summary-generation cost when available, and the top bar separates lifetime usage from usage since the latest checkpoint. |
| Search operators | Chat search accepts plain text plus `from:user`, `from:assistant`, `in:all`, and `is:archived` filters. |
| Auto thread titles | New chats get first-message titles by default. Optional AI names run after the first reply and need a compatible provider chat model when the chat uses Codex, Claude, or media models. |
| Onboarding | First-run setup chooses Simple or Workbench, connects local/hosted/Codex model sources, and can import Claude/Codex MCP servers and skills as disabled Workbench entries. MCP imports preserve `cwd`, non-secret env, and secret placeholders; use Test connection after filling required secrets. |
| Settings | Settings search returns individual controls, jumps to the matched row, and section navigation shows warning status for incomplete setup. |
| Theme editor | Themes and custom style settings are persisted with the desktop state. Custom palettes must pass core text contrast checks before saving, low-contrast preset/custom themes are marked in the theme grid, and custom theme cards expose an edit button. |
| Keyboard shortcuts | App-window shortcuts are configurable; Previous thread defaults to `Ctrl+Tab` on Windows and macOS, switches to the last viewed thread immediately, and shows a compact recent-thread switcher for repeated presses. Ctrl/Cmd `+` and `-` scale the UI and reveal a temporary top-bar control for further adjustments or reset. Sidebar and inspector dividers reset on double-click or Enter. Voice push-to-talk uses the same press-to-record flow. |
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
