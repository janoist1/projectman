# projectman — architecture

projectman is a browser app that runs and tracks a team made of humans and AI members
(Claude Code sessions). The team works through a configurable pipeline of stages
(e.g. development → code review → integration → QA → client test → merge → release),
every step is attributed, and everything that waits for a human lands in one inbox.
It starts on the owner's Mac (reachable from a phone through Tailscale) and moves to a
server later.

## Hard constraints

1. **Subscription, never API billing.** AI members are real, interactive Claude Code
   sessions (the `claude` CLI in a pseudo-terminal) logged in with the owner's Claude
   subscription. The runner removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
   `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` from the
   child environment. We do not use the Agent SDK or `claude -p` for member work
   (Anthropic announced, then paused, moving those off plan limits). The app never
   collects or stores Claude credentials; a colleague who runs AI members does it on
   their own Claude login (a later phase).
2. **English source code.** Identifiers, comments, file names, commit messages: English.
   Hungarian (the UI language) lives only in locale files
   (`apps/web/src/i18n/hu.ts`, `packages/templates/src/locales/hu.ts`). Data written by
   people and agents (task titles, notes, messages) is in the project's language.
3. **No real `claude` in automated tests.** Tests use a fake CLI that speaks the same
   protocol (hooks, transcript, stdin).

## Concepts

- **Project** — a workspace directory with one or more git repos, a team and a pipeline.
- **Member** — human or AI, identified by a unique **handle** (`fe-1`, `qa`, `owner`) and
  a display name ("Anna · fe-1"). AI members have a role (developer, code_review, qa,
  devops, communication, project_manager, …), a model, a permission mode, a capacity,
  role instructions and a **sponsor**: the human whose subscription runs them.
- **Team limits** — `maxConcurrentAi` caps working AI sessions (protects the
  subscription); new AI work pauses above `pauseAbovePlanUsagePercent`. The number of
  developer sessions is capped by the hired developers' capacity. Optional **temp
  workers** ("beugró"): when every developer is busy, a temporary developer is hired for
  one task and retired when it is done.
- **Pipeline** — ordered **stages** (id, display name, kind, owners, optional **gate**)
  grouped into **board columns**. Owners can be humans, AI members or both. Gates use a
  fixed catalogue of conditions: `check_passed(check)`, `pr_merged`,
  `human_approval(approvers)`. A gate must hold before a task may enter the stage.
- **Task** — key (`AR-21`), title, markdown description, stage, status, assignee
  (developer), repo, checks (`code_review`, `security_review`, `qa`, `client_test`),
  links (PRs, branches, issues, prerequisites), visibility (internal/shared).
- **Work item & session** — every AI member works in a **fresh Claude Code session per
  work item**: (member × task), (member × meeting) or (member × general). A developer's
  task session lives through the whole pipeline; feedback about that task resumes the
  same session (`claude --resume`). Standing roles (code review, QA, devops, …) work the
  same way: persistent identity and memory, fresh session per work item. Compaction is
  only a fallback inside a long session.
- **Context pack** — assembled when a session starts: the project's own `CLAUDE.md`
  (loaded by Claude Code from the working directory), the member's identity and role
  instructions, the team roster, how to use the team tools, the rules of the current
  stage, the member's memory (`--append-system-prompt`), and for tasks a kick-off brief
  (title, description, links, prerequisites, recent timeline) typed as the first message.
- **Team messages** — members message each other through the team tools (MCP). A message
  about a task is delivered to the recipient's session for that task (created or resumed);
  to humans it goes to their inbox/notifications. Injected messages are prefixed
  `[team message from <handle> about <KEY>]` so transcripts can be parsed.
- **Inbox ("Rád vár")** — everything waiting for a human: tool permission requests
  (Claude Code `PermissionRequest` hook, answered from the browser), gate decisions
  (merge, release), questions from AI members (`ask_human`), approvals.
- **Timeline** — append-only attributed events per task and project ("who did what").
- **Customization repository** — project configuration (team, pipeline, limits, role
  instructions) is YAML in a **separate git repository**, independent from the app
  source. Every change is a commit (author + reason); an admin can revert any version.
  Runtime state (tasks, sessions, events, inbox) lives in SQLite.

## Invariants (always enforced, whoever changes the configuration)

- handles are unique; at least one human owner exists;
- stage owners, gate approvers and AI sponsors refer to existing members;
- gate approvers and sponsors are humans — an AI never approves a gate;
- every release stage requires a human approval; changing its approvers is owner-only;
- releases happen only on an approver's explicit decision.

See `packages/shared/src/config/invariants.ts`.

## Runtime architecture

```
browser (React) ── REST /api, websocket /ws ──▶ server (Fastify, Node)
                                                 ├─ domain services ─▶ SQLite (runtime state)
                                                 ├─ config store ────▶ customization git repo (YAML)
                                                 ├─ github ──────────▶ gh CLI (owner's login)
                                                 └─ runner ──▶ node-pty ──▶ claude (interactive TUI)
claude ── HTTP hooks  POST /hooks/:token ─────▶ runner (state machine, permission broker)
claude ── MCP (http)  /mcp/:token ────────────▶ team tools ─▶ domain
claude ── transcript JSONL (~/.claude/projects/…) ─▶ runner transcript watcher ─▶ chat events
```

- One HTTP port (default 4700, bound to 127.0.0.1). `/hooks` and `/mcp` accept only
  localhost connections with a per-session random token. Everything under `/api` and
  `/ws` requires a login cookie. Remote access goes through Tailscale (`tailscale serve`).
- `claude` is started with: `--session-id <uuid>` (new) or `--resume <uuid>`,
  `--append-system-prompt`, `--mcp-config` (team server), `--settings` (HTTP hooks and
  pre-allowed team tools), `--model`, `--permission-mode`, `-n <display name>`.
- Session states come from hooks: SessionStart → idle, UserPromptSubmit → working,
  PermissionRequest → waiting_permission (blocking HTTP call answered by the inbox
  decision, with a timeout), Stop → idle, SessionEnd/exit → exited.
- User and team messages are typed into the PTY with bracketed paste only when the
  session is idle; otherwise they queue.
- v1: sessions do not survive a server restart; the conversation does (transcript), and
  a later message resumes it with `--resume`.

## Storage

`PROJECTMAN_HOME` (default `~/.projectman`):

```
db.sqlite            runtime state
customization/       git repo: projects/<KEY>/{project,team,pipeline}.yaml
memory/<KEY>/<handle>.md   AI member memory (durable learnings)
worktrees/<KEY>/…    git worktrees created for tasks (when a task names a repo)
logs/
```

SQLite tables: users, auth_sessions, projects (key, config version), tasks, task_links,
timeline_events, sessions, team_messages, inbox_items, member_state, counters.

## GitHub

Tasks live in our database; GitHub is used for what it does best: pull requests,
reviews, checks, merges, releases, branch protection. v1 tracks PRs linked to tasks
(`gh` polling). Later: create an issue from a task, optional mirror to a GitHub Project.

## Module map

| Path                                                                           | Responsibility                                                                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`                                                              | Domain types, config schema + invariants, REST DTOs, route table, websocket protocol (zod). Source of truth for contracts. |
| `packages/templates`                                                           | Factory team + pipeline templates; locale files for default display names.                                                 |
| `apps/server/src/contracts`                                                    | Interfaces between server modules.                                                                                         |
| `apps/server/src/runner`                                                       | PTY sessions, HTTP hooks, permission waiting, transcript parsing, plan usage.                                              |
| `apps/server/src/mcp`                                                          | Team tools MCP server (`/mcp/:token`).                                                                                     |
| `apps/server/src/github`                                                       | `gh`-based PR lookups and polling.                                                                                         |
| `apps/server/src/context`, `src/worktree`                                      | Context pack, member memory, git worktrees.                                                                                |
| `apps/server/src/{db,domain,api,auth,config,ws}`, `src/app.ts`, `src/index.ts` | Persistence, domain services, scheduler, REST, websocket, auth, customization repo, composition.                           |
| `apps/web`                                                                     | React UI (board, team, session chat + terminal, inbox, settings), i18n.                                                    |

## Later phases (not in v1)

Project manager member and meetings (standup, refinement, planning, demo, retro with
per-meeting screens; led by the PM or whoever starts the meeting); observations and the
retro feedback loop (humans and optionally AI members, evidence-based, internal by
default); the system agent that changes configuration through a fixed list of typed
operations within owner-set limits; inviting humans and colleagues' own subscriptions;
GitHub issue creation and project mirroring; web push notifications; surviving server
restarts; server deployment.
