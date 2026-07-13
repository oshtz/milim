---
id: agents
path: agents
label: Agents
title: Agents, tools, skills, and schedules
summary: Reusable Agent profiles, Worker Runs, tool modes, skills, schedules, and approval policies.
group: Core
order: 50
updated: 2026-07-13
---

Agents are for repeatable behavior, tool access, and longer work. Keep one-off questions in plain chat; save an agent when the same instructions or tool policy should survive across threads.

## Agent building blocks

| Block | Behavior |
|---|---|
| Named Agents | Model-agnostic profiles with name, deterministic avatar seed, system prompt, tool mode, and skill mode. The generated avatar follows the Agent through persona, schedule, and assigned Worker surfaces; unassigned Workers receive deterministic run-local identities. An Agent is a saved role; a Worker is one live instance of that role. |
| Tool modes | `all`, `custom`, or `none`. |
| Skill modes | `auto`, `custom`, or `none`; auto selects enabled skills by keyword, while explicit `@Skill Name` and `/Skill Name` prompt tags inject matching enabled skills for that turn. |
| Run timeline | Start, token, reasoning, tool call, bounded tool result, memory, Worker Run, per-request usage deltas, final usage, and error events render as structured stream parts. Tool results are capped before timeline persistence and again for model replay. Worker events carry monotonic cursors and reload on demand. Runs stop at 100 model turns by default (`stopped_at_limit: true`), and stream-open failures are retried once before surfacing an error. |
| Schedules | Cron schedules capture an explicit model, creation workspace, prompt, files, and optional Agent. Legacy schedules with no model temporarily fall back to their Agent's deprecated saved model; editing persists that fallback. Missing both records a visible error. |
| Tool approval | The UI sends approval policy and grants to the server-side agent loop. |

## Approval modes

| Mode | Server behavior |
|---|---|
| `review` | Tools are withheld until the UI sends an approval grant for the run. |
| `guarded` | Only tools declaring a read-only effect are exposed. Writes, commands, schedules, computer/preview actions, memory writes, and unclassified MCP tools are withheld. This is the default. |
| `open` | Eligible tools are exposed according to the selected folder, sandbox, computer-use, MCP, memory, and skill settings. |

Approval is not just UI decoration. The server rebuilds the effective tool registry per run and removes tools that are not allowed by the current policy.

## Agents, Workers, and Runs

The parent chat is canonical. Delegated work is stored as a Worker Run attached to one parent turn and never becomes a sidebar chat. A Run contains one to four independent tasks; each task creates a Worker. The model sees one `delegate_workers` operation rather than lifecycle tools for spawning, listing, reading, waiting, and stopping children.

Each thread has a delegation policy:

| Policy | Behavior |
|---|---|
| `off` | Delegation is unavailable for that turn. |
| `ask` | The model may freeze an exact task plan. Milim pauses for **Run workers** or **Continue solo** before executing it. This is the default for existing and new threads. |
| `auto` | Independent managed workers run in parallel and their results are joined before the parent answers. Read-only account-runtime turns may instead report native worker activity through the same Run contract. |

The Worker model control uses the searchable model catalog and defaults to the parent chat model.

Desktop keeps delegation controls, approval, live Worker rows, results, stopping, and diff review in the thread's Context card. Delegation and model settings stay collapsed behind a compact Workers summary row until opened, while proposed and running content remains visible automatically. On wide layouts Context can remain open beside the Preview / Code / Git inspector; active proposed or running Runs reveal Context automatically.

Delegation is intended for independent work that benefits from parallelism, not short or sequential steps. Managed Workers receive the current request, selected goal and instructions, workspace and branch, resolved Agent instructions and skills, supported attachments, and their assigned task. They do not receive the full transcript.

Workers are limited to four per Run and sixteen process-wide. Managed Workers have a five-minute deadline; Milim stops unfinished work and preserves available results and visible failures. Stopping the parent stops its active Run, and restart recovery marks unfinished Runs as errors so stale running states are never shown.

Managed Workers are read-only by default. An approved `ask` Run may request write-review access only when the parent uses Review with a grant or Open. Each writer runs against an isolated Git worktree and returns a reviewable diff that is never auto-applied. A non-Git workspace falls back to read-only.

The physical child-thread tables and `/threads/*` routes remain as compatibility storage. Desktop hydration turns legacy child sessions into singleton legacy Runs and hides them from normal navigation.

## Plan mode versus agent mode

| Mode | Use it when |
|---|---|
| Plain chat | You need drafting, comparison, or a short answer without saved behavior. |
| Named agent | The same identity, prompt, tool mode, or skill mode should be reusable across thread models. |
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
    "agent_max_iterations": 100,
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
    "model": "gpt-4.1",
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
