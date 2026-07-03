---
id: agents
path: agents
label: Agents
title: Agents, tools, skills, and schedules
summary: Reusable agent profiles, tool modes, skill modes, run timelines, child threads, schedules, and approval policies.
group: Workbench
order: 50
updated: 2026-07-03
---

Agents are for repeatable behavior, tool access, and longer work. Keep one-off questions in plain chat; save an agent when the same instructions or tool policy should survive across threads.

## Agent building blocks

| Block | Behavior |
|---|---|
| Named agents | Saved profiles with name, avatar text, system prompt, model override, tool mode, and skill mode. |
| Tool modes | `all`, `custom`, or `none`. |
| Skill modes | `auto`, `custom`, or `none`; auto selects enabled skills by keyword. |
| Run timeline | Start, token, reasoning, tool call, tool result, memory, child-thread, usage, and error events render as structured stream parts. |
| Schedules | Cron schedules can run prompts with optional agent profiles and attached file context; due schedules fire in the background loop and land completed results as desktop threads. |
| Tool approval | The UI sends approval policy and grants to the server-side agent loop. |

## Approval modes

| Mode | Server behavior |
|---|---|
| `review` | Tools are withheld until the UI sends an approval grant for the run. |
| `guarded` | Host command tools are removed, while safer read and scoped tools can remain. This is the default. |
| `open` | Eligible tools are exposed according to the selected folder, sandbox, computer-use, MCP, memory, and skill settings. |

Approval is not just UI decoration. The server rebuilds the effective tool registry per run and removes tools that are not allowed by the current policy.

## Subagents and child threads

Parent runs can expose child-thread tools when the run has a parent thread id and child-thread storage is configured.

| Tool | Use |
|---|---|
| `child_thread_spawn` | Start a child thread for parallel research, inspection, review, or Open-mode worker tasks. |
| `child_thread_list` | List children for the current parent thread, optionally filtered by status. |
| `child_thread_read` | Read child metadata, summary, error, and optionally stored lifecycle events. |
| `child_thread_wait` | Wait for a child thread to finish or time out. |
| `child_thread_stop` | Stop a running child thread. |

Child threads cannot spawn more children. In `open` approval mode they inherit the parent run's effective tools after folder, sandbox, computer-use, MCP, memory, and named-agent filters are applied. In `guarded` and ungranted `review` runs they stay read-only: they can inspect and fetch context, but cannot write files or run shell commands.

## Plan mode versus agent mode

| Mode | Use it when |
|---|---|
| Plain chat | You need drafting, comparison, or a short answer without saved behavior. |
| Named agent | The same role, model, prompt, tool mode, or skill mode should be reusable. |
| Plan mode | You want read-only inspection before risky file or shell work. |
| Goal run | You want the thread to continue toward explicit success criteria across turns. |
| Schedule | The same prompt and saved file context should run on a clock without manually opening a thread. |

## Agent API

```bash Run an ad-hoc agent
curl http://127.0.0.1:7377/agents/run \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "stream": true,
    "tool_approval_policy": "guarded",
    "sandbox_enabled": true,
    "messages": [{"role": "user", "content": "Run tests and summarize failures."}]
  }'
```

```bash Create a schedule
curl http://127.0.0.1:7377/schedules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "weekday check",
    "cron": "0 0 9 * * Mon-Fri",
    "prompt": "Summarize project status.",
    "agent_id": null,
    "attachments": [
      {
        "id": "notes",
        "name": "notes.md",
        "mime": "text/markdown",
        "size": 18,
        "content": "# Notes\nShip docs."
      }
    ]
  }'
```
