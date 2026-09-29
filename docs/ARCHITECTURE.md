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
   their own Claude login (a later phase). Codex members (see Providers) run on the
   owner's ChatGPT login the same way; the runner also removes `CODEX_API_KEY` and
   `OPENAI_API_KEY`, for every session.
2. **English source code.** Identifiers, comments, file names, commit messages: English.
   Hungarian (the UI language) lives only in locale files
   (`apps/web/src/i18n/hu.ts`, `packages/templates/src/locales/hu.ts`). Data written by
   people and agents (task titles, notes, messages) is in the project's language.
3. **No real `claude` or `codex` in automated tests.** Tests use fake CLIs that speak the
   same protocol (hooks, transcript, stdin): `apps/server/test/fixtures/fake-claude.mjs`
   and `fake-codex.mjs`.

## Concepts

- **Project** — a workspace directory with one or more git repos, a team and a pipeline.
- **Member** — human or AI, identified by a unique **handle** (`fe-1`, `qa`, `owner`) and
  a display name ("Anna · fe-1"). AI members have one role, a model, a permission mode, a
  capacity, role instructions, an optional **schedule** (cron in the project's time zone,
  e.g. a "daily worker") and a **sponsor**: the human whose subscription runs them.
- **Duties and roles** — a fixed code-backed catalogue of 26 duties defines holder eligibility,
  English AI prompt fragments, tool policy and stage/gate/meeting/event integration metadata.
  Roles bundle duty ids and prompt-only extra responsibilities. The 20 built-in roles have
  default bundles; `team.roleOverrides` replaces a built-in bundle, and deleting its entry
  restores the default. Custom roles store `duties` and `instructions` in `team.yaml`.
  Eligibility is the intersection of the duties' holders: release approval and final decision
  require humans; all other duties allow humans and AI. One AI holds one role; humans union
  duties across several roles. Access levels remain separate from responsibilities.
- **Team limits** — `maxConcurrentAi` caps working AI sessions (protects the
  subscription); new AI work pauses above `pauseAbovePlanUsagePercent`. The number of
  delivery sessions is capped by the duty holders' capacity. Optional **temp
  workers**: when every eligible duty holder is busy, a temporary member of the configured
  role (developer by default) is hired for one task and retired when it is done.
- **Pipeline** — ordered **stages** (id, display name, kind, optional duty, optional owners override, optional **gate**)
  grouped into **board columns**. Owners can be humans, AI members or both. Gates use a
  fixed catalogue of conditions: `check_passed(check)`, `pr_merged`,
  `human_approval(approvers | duty)`. Duty gates resolve only human holders. Explicit member
  lists, including empty stage owner overrides, retain their existing meaning. A gate must hold before a task may enter the stage.
- **Task** — key (`AR-21`), title, markdown description, stage, status, assignee
  (work stage owner), repo, checks (`code_review`, `security_review`, `qa`, `client_test`),
  links (PRs, branches, issues, prerequisites), visibility (internal/shared).
- **Work item & session** — every AI member works in a **fresh Claude Code session per
  work item**: (member × task), (member × meeting) or (member × general). A developer's
  task session lives through the whole pipeline; feedback about that task resumes the
  same session (`claude --resume`). Standing roles (code review, QA, devops, …) work the
  same way: persistent identity and memory, fresh session per work item. Compaction is
  only a fallback inside a long session.
- **Context pack** — assembled when a session starts: the project's own `CLAUDE.md`
  (loaded by Claude Code from the working directory), the member's identity and role
  instructions (duty fragments, role extra responsibilities, then member instructions), the team roster, how to use the team tools, the rules of the current
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
- **Customization repository** — project configuration (team, custom roles, pipeline,
  limits, role instructions) is YAML in a **separate git repository**, independent from the
  app source. Every change is a commit (author + reason); an admin can revert any version.
  Runtime state (tasks, sessions, events, inbox) lives in SQLite.

## Invariants (always enforced, whoever changes the configuration)

- handles are unique; at least one human owner exists;
- stage owners, gate approvers and AI sponsors refer to existing members;
- gate approvers and sponsors are humans — an AI never approves a gate;
- every release stage requires a human approval; changing its approvers, release approval
  bundles or their membership is owner-only; `team.releaseFourEyes` (default off) is also
  owner-only and excludes assignees and PR authors from release approval;
- code review, security review and QA results from the assignee or a linked PR's attributed
  author fail with `self_review_forbidden`, regardless of their duties;
- missing stage/gate duty holders are errors; missing recommended duties (retro facilitation)
  are warnings, returned with additive issue severity and never blocking config loading;
- releases happen only on an approver's explicit decision;
- every role a member holds (and the temp workers' role) is a built-in or custom role that
  this kind of member may hold; custom role ids are unique and never reuse a built-in id; a
  custom role cannot be removed while anyone holds it.

See `packages/shared/src/config/invariants.ts`.

## Runtime architecture

```
browser (React) ── REST /api, websocket /ws ──▶ server (Fastify, Node)
                                                 ├─ domain services ─▶ SQLite (runtime state)
                                                 ├─ config store ────▶ customization git repo (YAML)
                                                 ├─ github ──────────▶ gh CLI (owner's login)
                                                 └─ runner ──▶ node-pty ──▶ claude | codex (interactive TUI)
claude ── HTTP hooks  POST /hooks/:token ─────▶ runner (state machine, permission broker)
codex ─── command hooks ─▶ forwarder ─▶ POST /hooks/:token ─▶ runner
claude | codex ── MCP (http)  /mcp/:token ────▶ team tools ─▶ domain
claude | codex ── transcript JSONL ────────────▶ runner transcript watcher ─▶ chat events
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

## Providers

An AI member runs in one of two agent CLIs, set per member (`provider` in `team.yaml`,
default `claude`): **Claude Code** on the sponsor's Claude plan, or **OpenAI Codex CLI**
on the sponsor's ChatGPT plan. Both run as interactive TUIs in a PTY. The runner drives
them through provider adapters (`apps/server/src/runner/providers`); the PTY session,
message queue, state machine, permission broker and transcript tailer are shared, and
each adapter declares its capabilities.

|                   | Claude Code                                     | Codex (codex-cli 0.159.1)                                                          |
| ----------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Conversation id   | ours (`--session-id`), resume with `--resume`   | Codex's own, learned from the first hook (`provider_session_id`); `codex resume`   |
| Hooks             | HTTP hooks (SessionStart through the forwarder) | command hooks running the forwarder; the PermissionRequest one prints the decision |
| Ready for input   | first SessionStart hook                         | composer on screen (SessionStart only fires with the first turn)                   |
| Kick-off brief    | typed with bracketed paste                      | the prompt argument; later messages typed, Enter more than 120 ms after the paste  |
| System prompt     | `--append-system-prompt`                        | `-c developer_instructions=…`                                                      |
| Project rules     | `CLAUDE.md`                                     | `AGENTS.md`, else `CLAUDE.md` (`project_doc_fallback_filenames`)                   |
| Allow for session | session rules in the hook answer                | remembered by the runner (Codex rejects `updatedPermissions`)                      |
| Transcript        | `~/.claude/projects/…/<id>.jsonl`               | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`                             |
| Plan usage        | `get_usage` probe of `claude -p`                | rate limits of the newest `token_count` records in the transcripts                 |
| Login check       | `claude auth status`                            | `codex login status`                                                               |

Codex is started as `codex [resume] --no-alt-screen --no-daemon
--dangerously-bypass-hook-trust --enable hooks -c … --sandbox <s> --ask-for-approval <a>
[--model <m>] -- [<id>] [<brief>]`. Every setting is a per-process `-c` override (update
check off, the directory trusted, hooks, the team MCP server with its tools pre-approved,
developer instructions); nothing is written to `~/.codex`. The bypass flag lets our own
hooks run without the one-time review in `/hooks`; it also runs any other enabled hooks
of the user's Codex config and of the trusted project's `.codex/` folder, the same
exposure as pre-trusting a Claude Code workspace. Claude model aliases (`opus`, …) are
not passed to Codex; such members get projectman's default, `gpt-6.1-sol` at `medium`
reasoning effort, rather than the owner's interactive Codex default (which may be the most
expensive model at the highest effort). A member may name any Codex model explicitly. The CLI is `CODEX_BIN` (default
`codex` on `PATH`); transcripts are read from `CODEX_HOME` (default `~/.codex`).

Permission modes map to Codex's sandbox and approval policy; anything the sandbox does
not allow (writes elsewhere, network) is an escalation that reaches the PermissionRequest
hook and so the inbox:

| Permission mode       | Codex sandbox        | Approval     | Effect                                                  |
| --------------------- | -------------------- | ------------ | ------------------------------------------------------- |
| `default`             | `read-only`          | `on-request` | reads freely; every edit and write is asked             |
| `acceptEdits`, `auto` | `workspace-write`    | `on-request` | edits and commands in the workspace run; the rest asked |
| `plan`                | `read-only`          | `never`      | research only; nothing is asked or written              |
| `bypassPermissions`   | `danger-full-access` | `never`      | no sandbox, no questions                                |

The session policy unions the actual duties: editing duties use the task worktree and
read-only duties pre-approve reading tools. The policy needs no Codex counterpart for its read-only tools: reading and
`git diff`/`log`/`show` run inside the sandbox without asking (`gh pr view`/`diff` need
network, so they are asked). The team tools are pre-approved for every role.

Login: before spawning, the runner checks the provider's login (cached briefly). A CLI
that is not logged in with a subscription, or is logged in with an API key, is refused
with `provider_not_logged_in` (the domain answers 409 with `details.provider`). A login
lost mid-session (Claude Code: "Login expired · Please run /login"; Codex: a turn failing
with `unauthorized`) emits an `auth_error` runner event, stops the session and leaves it
`failed` with the message as its activity.

Plan usage is per provider: new AI work pauses above `pauseAbovePlanUsagePercent` of the
plan of the member's own provider.

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
| `apps/server/src/runner`                                                       | PTY sessions, provider adapters (Claude Code, Codex), hooks, permission waiting, transcripts, plan usage, login checks.    |
| `apps/server/src/mcp`                                                          | Team tools MCP server (`/mcp/:token`).                                                                                     |
| `apps/server/src/github`                                                       | `gh`-based PR lookups and polling.                                                                                         |
| `apps/server/src/context`, `src/worktree`                                      | Context pack, member memory, git worktrees.                                                                                |
| `apps/server/src/{db,domain,api,auth,config,ws}`, `src/app.ts`, `src/index.ts` | Persistence, domain services, scheduler, REST, websocket, auth, customization repo, composition.                           |
| `apps/web`                                                                     | React UI (board, team, session chat + terminal, inbox, settings), i18n.                                                    |

## Later phases (not in v1)

Meetings (standup, refinement, planning, demo, retro with per-meeting screens; led by the
project manager or whoever starts the meeting); the scheduler that runs members' schedules;
the watchdog's monitoring; observations and the retro feedback loop run by the coach
(humans and optionally AI members, evidence-based, internal by default) — these roles
already exist and work with the team tools; the system agent that changes configuration
through a fixed list of typed operations within owner-set limits; inviting humans and
colleagues' own subscriptions; GitHub issue creation and project mirroring; web push
notifications; surviving server restarts; server deployment.

## Duty customization and compatibility

The settings matrix groups duties by direction, delivery, quality, release, communication
and team. Columns show roles in use and custom roles, their holders and prompt-only extras.
Missing coverage is red, incompatible cells show why they are disabled, and a read-only
people view shows the union of each person's duties. Config PATCH accepts `roleOverrides`,
`roles` and `releaseFourEyes` atomically, using the existing version conflict check. The role
catalogue API adds resolved `duties` and `instructions`.

Schema version remains 1. Old explicit owners and approvers load unchanged. Old custom
roles without duties resolve in memory to research (or final decision for legacy human-only
roles); the legacy `holders` field is accepted but explicit duties determine eligibility.
Existing member instructions remain prompt-only text. New hires do not copy role prompts.
PR links persist member authors in SQLite so reassignment cannot enable self-review.
A link without explicit attribution defaults to the assignee when it is attached; unknown
external authors cannot be matched to team members until attributed. See
[the design note](design/duties.md) for defaults and integration boundaries.
