# Agent providers

An AI member runs in one of two agent CLIs, set per member (`provider` in `team.yaml`,
default `claude`): **Claude Code** on the sponsor's Claude plan, or **OpenAI Codex CLI**
on the sponsor's ChatGPT plan (decision 15). Both run as interactive TUIs in a PTY, never
through the Agent SDK, `claude -p`, `codex exec` or the Codex app server. The runner drives
them through provider adapters (`apps/server/src/runner/providers/`); the PTY session,
message queue, state machine, permission broker and transcript tailer are shared, and each
adapter declares its capabilities.

## Differences

|                   | Claude Code                                     | Codex (codex-cli 0.159.1)                                                          |
| ----------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Conversation id   | ours (`--session-id`), resume with `--resume`   | Codex's own, learned from the first hook (`provider_session_id`); `codex resume`   |
| Hooks             | HTTP hooks (SessionStart through the forwarder) | command hooks running the forwarder; the PermissionRequest one prints the decision |
| Ready for input   | first SessionStart hook                         | composer on screen, or the first SessionStart hook (it fires with the first turn)  |
| Kick-off brief    | typed with bracketed paste                      | the prompt argument; later messages typed, Enter more than 120 ms after the paste  |
| Resume: 1st input | typed once SessionStart arrives                 | the prompt argument of `codex resume <id> -- <prompt>`                             |
| System prompt     | `--append-system-prompt`                        | `-c developer_instructions=…`                                                      |
| Project rules     | `CLAUDE.md`                                     | `AGENTS.md`, else `CLAUDE.md` (`project_doc_fallback_filenames`)                   |
| Allow for session | session rules in the hook answer                | remembered by the runner (Codex rejects `updatedPermissions`)                      |
| Transcript        | `~/.claude/projects/…/<id>.jsonl`               | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`                             |
| Plan usage        | `get_usage` probe of `claude -p`                | rate limits of the newest `token_count` records in the transcripts                 |
| Login check       | `claude auth status`                            | `codex login status`                                                               |

## A resumed session's first input

A task session that starts again resumes its conversation and is given a first input, so that it
does not sit at its prompt: the messages that caused the resume (all the waiting ones, whole), else the context pack's short
continue message (restarted; the task and its stage; check `git status` and the task's comments).
General chats resume without one. Codex takes it as the prompt of `codex resume <id> -- <prompt>`,
which starts the first turn by itself, so nothing depends on recognising the composer under the
history of a resumed screen; SessionStart (any `source`) then makes the session ready for queued
messages, as the composer does. Claude Code reports SessionStart at launch, for a resume too, so its
first input is typed like the brief; a prompt argument would add nothing.

## Claude Code

`claude` is started with `--session-id <uuid>` (new) or `--resume <uuid>`,
`--append-system-prompt`, `--mcp-config` (the team server), `--settings` (HTTP hooks,
pre-allowed and denied tools), `--model`, `--effort`, `--permission-mode`, `--add-dir`
(extra readable directories such as the developer's worktree for a reviewer) and
`-n <display name>`. The runner pre-accepts the workspace trust dialog for session
directories.

A session in a task's own worktree (a developer's) runs its shell commands in Claude Code's
sandbox, the first step of PM-87: the session spec carries `sandbox` (`WORKTREE_SANDBOX` in
`domain/session-policy.ts`) and the runner turns it into the `sandbox` settings probed in
PM-126 (see Sandboxes below). Commands then run without asking as long as they write only the
worktree (with the shared git directory, minus hooks and config), the temp directory, the npm
cache and `~/.projectman-dev`, and reach only the npm registry; a command that fails there is
not retried outside the sandbox. The tests may listen on local ports (decision 24). The sandbox
cannot open pseudo-terminals, so the server's PTY tests (`*.integration.test.ts`,
`golden-path-*`) are left out there with a notice (`apps/server/vitest.config.ts`); the
integrating session runs the full suite.

Every other legacy session reads only (PM-167, decision 28: „Homokozó, a CLI-k saját kerítése”):
the reviewer, QA, the security reviewer, the analyst, the architect, the designer, devops, chats,
meetings and scheduled runs, any session whose placement is `read_only` or a review copy without
the test opt-in. It runs in the member's own mode (Auto stays Auto, `plan` stays `plan`) and in a
sandbox from `sessionSandbox` (see Sandboxes below) that writes only the temp directory: the
working directory and every `--add-dir` directory are `denyWrite`, and the Claude adapter denies
`Edit(//<dir>/**)` there too (which also covers `Write` and `NotebookEdit`), since the sandbox
does not bind the built-in file tools. Reads, git queries, `npm test` and `npm run typecheck` then
run without asking, and a write fails at once. Vite writes a bundled copy of a TypeScript
configuration next to it, so projectman's `npm test` runs `vitest run --configLoader runner`,
which writes nothing; other caches go to `$TMPDIR`. A question the CLI still asks goes to the
member's approver (PM-165); with `none` it is refused.

Claude members may choose a fixed model id, a latest-family alias, or a custom id. Their
optional effort (`low`, `medium`, `high`, `xhigh`, `max`) is passed via `--effort` on new and
resumed sessions; unset effort uses Claude Code's own default. Clearing effort with a member
PATCH (`null`) restores that default.

### Permission mode and who decides (PM-165)

The owner's principle (PM-162): the philosophy of the CLIs is the base, and the server decides
on its own only where the CLI does not cover a case or the owner asked for it.

- **The mode is the CLI's.** The member's `permissionMode` (`default`, `acceptEdits`, `auto`,
  `plan`) goes to `--permission-mode` as it is; there is no mapping of our own, and Claude Code
  enforces it, `auto` included (its classifier, PM-134's sandbox for the shell).
- **When the CLI asks anyway** (the `PermissionRequest` hook), `InboxService.decide` answers:
  1. `commandVerdict` first (publishing denied, routine steps and read-only commands allowed);
  2. then the member's `approver`: `human` (or none stored) puts the question in the sponsor's or
     owner's inbox, as before; `none` refuses at once with
     no inbox item, and the agent is told not to retry in another form and to use `ask_human` with
     a reason if it really needs it (`APPROVER_NONE_REFUSAL`). The refusal is a `permission_refused`
     timeline event (`by: 'approver_none'`); `ai` (PM-169) is the next section.
- **The AI decider (PM-169, `approver: 'ai'`).** `routePermissionRequest` (`packages/shared`) sends
  the question to the AI members holding `boundary_authorization` (never the member itself, never one
  on leave, only with `team.boundary.enabled`), unless it is one of the owner's categories: then,
  and when no such decider is at work, it goes to the sponsor or an owner exactly as for `human`.
  `permissionOwnerCategory` reads the text of the request (publishing, a release or deploy, the
  live instance and its port, credentials, `sudo`/`launchctl`/`brew`/`chmod` and other lasting
  changes of the host, a file tool writing outside the session's directories); it is a cautious
  filter, not proof, and the decider's duty text sends doubtful cases to a person anyway. The
  item is a `permission` item assigned to the decider, with `payload.delegation` (`pending_lead`,
  `leads`, `leadDeadline` after `team.boundary.leadTimeoutSeconds`); the owner does not see it as
  waiting, may still answer it, and sees the decision under the recent items. The decider is woken
  by a team message with the exact input (`permission_delegated` domain event) and answers with the
  team tool `decide_permission_request` (`allow`, `deny` or `escalate`, a reason is required;
  `InboxService.resolveDelegated`, the one way an AI resolves an inbox item, only for a delegated
  permission item and only for a chosen, live, independent decider before the deadline,
  `canDecidePermission`). The hook keeps waiting up to `permissionTimeoutMs`; an `escalate`, the
  deadline, a decider that went on leave or delegation switched off hand the item to the
  sponsor or owners (`payload.delegation.state` `pending_owner`, a `permission_escalated` event;
  `InboxService.sweepDelegations` runs every second and on configuration changes). Nothing
  here is ever an allowance by itself. The decision is a `permission_resolved` event in the
  decider's name with `delegated: true` and the reason, and the inbox item's resolution carries
  who, when and the reason.
- **Auto mode's own refusals.** The `PermissionDenied` hook (in `HTTP_HOOK_EVENTS`; payload
  `tool_name`, `tool_input`, `denial_reason`) fires when the classifier refuses a call; the
  runner passes it to `PermissionBroker.refused`, which writes a `permission_refused` event
  (`by: 'classifier'`, `reason` from `denial_reason`). It cannot block and has no answer.
- **Hard denials, in every mode.** `permissions.deny` in `--settings` holds in `auto` and
  `bypassPermissions` too: `git push`, `gh pr create`, `gh pr merge` (a repository without GitHub),
  `Read` and `Edit` of the user's credentials (`~/.ssh`, `~/.config/gh`, `~/.claude/.credentials.json`,
  `~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.claude/hooks`, `~/.claude.json`,
  `~/.codex`, `~/.npmrc`; not the whole `~/.claude`: the member's saved tool outputs under
  `projects/` and the plan mode's `plans/` live there) and of the sensitive parts of the app home (database,
  cookie secret, logs, customization repository, members' memory, publishing identity, spool), and
  `WebFetch` of `localhost` and `127.0.0.1`. `domain/session-policy.ts` (`sensitivePaths`,
  `HARD_DENIED_HOSTS`) lists them, `SessionPolicy.filesystem.deniedPaths` and
  `network.deniedHosts` carry them, `runner/providers/claude/policy.ts` renders the rules. The
  whole app home is not denied: worktrees, workspaces and attachments live there, and deny wins
  over allow. Read rules also cover Grep and Glob (best effort, per the Claude Code docs).
- **Codex members too:** `decide` is provider-neutral, so approver `none` refuses a Codex member's
  escalation the same way (after `commandVerdict`). Only the deny rules and `autoMode` are Claude's.
- **`autoMode` in `--settings`** (`environment`, `hard_deny`, both with `$defaults`) is prose for
  the classifier only; the deny rules are what hold.
- **The managed VM profile is unchanged:** no deny rules, no `autoMode`, no approver path (decision 26).

Server-side decisions, with the reason each exists (the CLI covers none of them):

| Decision                                       | Why the CLI does not cover it                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commandVerdict` before anything else          | The CLI cannot know the team's routine steps (a worktree's install, `git add`/`commit`, read-only commands) or that this repository is local-only                 |
| The approver (`human` / `ai` / `none`)         | The CLI asks "the user"; who that is on a team (sponsor, owner, a deciding AI member, nobody) is the app's concept, and the owner asked for nobody as the default |
| The `none` refusal text and its timeline event | The CLI has no "nobody answers" mode; the agent must learn the refusal is final and where to go next                                                              |
| The list of denied files and hosts             | The CLI has no list of the credentials and the live instance's data of this installation; the owner decided they stay out of reach                                |
| `PermissionDenied` to the timeline             | The CLI's classifier decisions are otherwise invisible to the people following the work                                                                           |
| Managed VM profile: no inner limits            | The boundary is outside the CLI (decisions 25 and 26)                                                                                                             |

The same denied paths are the sandbox's `denyRead` (PM-167), so a shell command does not read
them either. Residual risk: port 4800 stays reachable from the shell up to the VM (decision 24).
Codex ignores the deny rules (its sandbox is its own, PM-166). See `SECURITY.md`.

## Codex

Codex is started as `codex [resume] --no-alt-screen --no-daemon
--dangerously-bypass-hook-trust --enable hooks -c … --sandbox <s> --ask-for-approval <a>
[--model <m>] -- [<id>] [<brief>]`. Every setting is a per-process `-c` override (update
check off, the directory trusted, hooks, the team MCP server with its tools pre-approved,
developer instructions); nothing is written to `~/.codex`.

The bypass flag lets our own hooks run without the one-time review in `/hooks`; it also runs
any other enabled hooks of the user's Codex config and of the trusted project's `.codex/`
folder, the same exposure as pre-trusting a Claude Code workspace (backlog PM-49).

Claude model aliases (`opus`, …) are not passed to Codex; such members get projectman's
default, `gpt-6.1-sol` at `medium` reasoning effort, rather than the owner's interactive
Codex default (which may be the most expensive model at the highest effort). A member may
name any Codex model explicitly. Codex maps effort `max` to `xhigh`. The CLI is `CODEX_BIN`
(default `codex` on `PATH`); transcripts are read from `CODEX_HOME` (default `~/.codex`).

Permission modes map to Codex's sandbox and approval policy; anything the sandbox does not
allow (writes elsewhere, network) is an escalation that reaches the PermissionRequest hook
and so the inbox:

| Permission mode       | Codex sandbox     | Approval     | Effect                                                  |
| --------------------- | ----------------- | ------------ | ------------------------------------------------------- |
| `default`             | `read-only`       | `on-request` | reads freely; every edit and write is asked             |
| `acceptEdits`, `auto` | `workspace-write` | `on-request` | edits and commands in the workspace run; the rest asked |
| `plan`                | `read-only`       | `never`      | research only; nothing is asked or written              |
| `bypassPermissions`   | `workspace-write` | `on-request` | not for Codex: read as `acceptEdits`                    |

In a reading placement (a reviewer, an analyst, a chat; PM-167) every mode but `plan` gets
`read-only` and `on-request`; an escalation goes through `commandVerdict` to the approver.

**A Codex member never runs in `bypassPermissions`** (decision 19, PM-84). The mode would switch
Codex's sandbox and its questions off, and Codex does not enforce denied tools, so nothing would
stop a push from a local-only repository. The configuration refuses it (invariant
`codex_bypass_not_allowed`), an older configuration that names it reads as `acceptEdits` (logged
as a warning) and the runner maps it to the sandbox of `acceptEdits` should it arrive anyway.

Developers' Codex sessions get no extra writable roots, and the network stays off. The
shared git directory is not made writable (PM-131): it never let `git commit` through, since
Codex's sandbox denies the worktree's index lock, but it let an agent write the repository's
hooks and configuration, which run when the host uses git there. The routine git steps
escalate, and the server allows them itself (see Session policy, PM-77).

## Session policy

The session policy (`apps/server/src/domain/session-policy.ts`) is the union of the member's
duties: editing duties work in the task worktree, read-only duties pre-approve reading tools,
and developer roles get everyday git and npm commands pre-approved. Reviewers get the
developer's worktree as an extra readable directory. The team tools are pre-approved for
every role. Codex needs no counterpart for the read-only tools: reading and
`git diff`/`log`/`show` run inside its sandbox without asking (`gh pr view`/`diff` need
network, so they are asked).

The task worktree belongs to the task's repository: the task's own `repo`, else the project's
only repository (`effectiveRepo` in `packages/shared`, PM-68). The placement, the denied tools,
the readable directories and the command rules below all use that one rule. A role
that edits never runs in the workspace root: when the project has several repositories and the
task names none, its session does not start (`repo_required`) until a person chooses one. Roles
that only read may run in the workspace root. A project without repositories has no worktree to
give, so its tasks work in the workspace root.

System decisions that never reach a human (`commandVerdict`, recorded in the inbox history and
the timeline like any other answer):

- publishing from a local-only repository (no GitHub in its config) is denied, whatever else
  the command says and even when it cannot be parsed;
- a developer's routine steps in the task's own worktree are allowed: a lockfile install,
  `git add`, `git commit` with a message and `git merge --ff-only` of the default branch or a
  commit, each one command, which may carry `2>&1` and be piped into readers that filter its
  output (`npm install … 2>&1 | tail -3`; a `tee` or any other writer after the pipe still goes
  to a human, PM-105). They may be joined with `&&`, `||`
  or `;` and mixed with read-only steps, which may be whole pipelines, as long as those stay
  in the worktree (`git status && git add -A && git commit -m …; git log --oneline | head -1`,
  PM-77). Every step is judged on its own and the directory never changes: the only `cd` is a
  first one that stays in the worktree. A chain of read-only steps alone is for the next rule;
- read-only commands are allowed for every AI session on a task, inside the session's own
  directory and the task's worktree: `git status`/`diff`/`log`/`show` and similar, `grep`,
  `ls`, `cat`, `find` without actions, `xargs` fed only by a lister (`git ls-files`,
  `git diff --name-only`, `grep -l`, `find`, …), and the project's test, type and format
  checks (PM-69). Patterns that can match `.` and `..` (`.*`) are not followed.

### Task attachments (PM-113)

A task session reads the files attached to its task with its own tools, after `read_attachment`
gave it the path. Only that task's attachment directory (`PROJECTMAN_HOME/attachments/<KEY>/<TASK>`,
resolved) is opened up, never the storage root or the rest of `PROJECTMAN_HOME`, and never for
writing:

- Claude Code: the allow rule `Read(//<dir>/**)` and the deny rule `Edit(//<dir>/**)` in
  `--settings`, on every start and resume. Not `--add-dir`: in `acceptEdits` mode Claude Code
  accepts edits in an extra working directory without asking. A directory whose path holds
  characters that mean something in a rule gets no rules (reading then asks a human).
- Codex: nothing is added. Its sandbox reads everywhere (see the probe below) and writes only in
  the working directory; the attachment directory is never a writable root.
- Both: read-only commands inside that directory (`file`, `ls`, `cat` …) pass the command rule
  below like those in the working directory.

The agents' readers tell an image or a PDF by the path's extension (Claude Code's Read), so
`read_attachment` gives such a file as `<id>.<ext>`, a hard link to the stored file made on the
first request and removed with it (recovery removes one left behind). Opening an attachment of
another task may ask a human first. Automated tests run the fake CLIs only
(`test/attachment-permissions.integration.test.ts`).

Checked by hand on 2026-10-01 (macOS, a development instance with its own home, a developer member
on each provider in `acceptEdits` mode, a task with an owner's PNG attached):

| Step                                      | Claude Code                          | Codex                                    |
| ----------------------------------------- | ------------------------------------ | ---------------------------------------- |
| Open the attached image                   | `Read` on `<id>.png`, without asking | `view_image` on the path, without asking |
| Describe it (text, colours, shape)        | exact                                | exact                                    |
| Attach a picture of its working directory | yes, in its own name                 | yes, in its own name                     |
| Delete its own attachment / the owner's   | yes / refused                        | yes / refused                            |
| Attach `/etc/hosts`, `../logo.png`        | refused (`forbidden`)                | refused (`forbidden`)                    |

No permission request reached the inbox in either session.

`git -C <dir>` counts as plain `git` when `<dir>` is the directory the command runs in (the
session's working directory, or where a `cd` of the chain has led), however it is spelled. A
`-C` to any other directory, a second `-C`, `-c`, `--git-dir` and `--work-tree` are not
followed, and neither is a `-C` in front of what `xargs` runs.

The allow rules read the command with a strict parser (`domain/shell-words.ts`): quotes are
understood, every `$`, backtick, subshell, unknown redirection or unclear construct refuses the
rule, and anything it does not recognise goes to a human. A newline inside quotes is text (a
commit message of several lines); a backslash before one in double quotes is a line
continuation, removed as the shell removes it. A newline outside quotes, a carriage return and
every other control character are refused. Denied tools are enforced through
Claude Code's settings; Codex relies on its sandbox and the PermissionRequest hook, which is
why a Codex member never runs in `bypassPermissions`.

## Managed VM profile (PM-141)

The question-free profile for the verified managed VM ([VM.md](VM.md), decisions 25 and 26). It is
a separate **execution profile**, not a permission-mode migration and not a strict-sandbox claim:
`SessionPolicy.execution = { profile: 'managed_vm', boundary }` (absent means legacy) with the new
`member_workspace` placement (`use`: `work` on the task branch, `review` on a pinned round, `home`
without a repository). The member's `permissionMode` is only read: `plan` stays research-only, every
other value runs question-free; leaving the profile restores exactly what was configured. Nothing in
an existing installation changes: the legacy, default and plan settings, the command broker, the
PM-134 sandbox and the denied operations are the legacy path's alone.

**It runs only on a proven boundary.** The installation's owner selects it
(`PROJECTMAN_EXECUTION_PROFILE=managed_vm`, read only in `index.ts`; an unknown value stops the
server, and so does a missing `PROJECTMAN_WORKSPACES=member` or readiness report setting). The
setting alone proves nothing: at **every** start and resume the domain and the runner ask the
`ManagedVmBoundary` (`createReadinessBoundary`) which reads the root-owned readiness report of
`deploy/vm/verify.sh` (`PROJECTMAN_VM_READINESS_REPORT`, at most
`PROJECTMAN_VM_REPORT_MAX_AGE_MINUTES` old, default one day): the host must be Linux, the report
ready by `evaluateVmReadiness()` **and** its `launcher` and `domain-gate` checks passed
(`evaluateManagedVmActivation`). The baseline report of PM-137 lists those two as unverified, so on
it, and on the Mac, a start is refused with `managed_vm_unavailable` (`details.reason`:
`no_boundary`, `platform`, `no_report`, `bad_report`, `not_ready`, `profile_mismatch`,
`provider_version`, `ambient_config`); nothing is prepared or spawned, and there is no fallback to a
legacy start. A repository file, an environment flag or a member setting is never an input.

|                         | Claude Code                                                                                                                                                        | Codex                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| No local approval       | `--permission-mode bypassPermissions` (or `plan`), `skipDangerousModePermissionPrompt` in `--settings` so the first-use confirmation does not wait in the terminal | `--sandbox danger-full-access --ask-for-approval never` (or `read-only` for `plan`)               |
| Inner limits            | none: no tool rules except `mcp__team__*`, no deny rules, no `sandbox` settings, the PM-134 sandbox is not passed                                                  | none: no writable roots, nothing of the legacy mapping                                            |
| Protected start (PM-49) | `--strict-mcp-config` (only this session's team server), `--setting-sources user` (project settings and `.mcp.json` are left out)                                  | every hook event and the team server are `-c` overrides; the VM's own files are inspected (below) |
| Hooks                   | kept (HTTP hooks, SessionStart through the forwarder): the state of the session is followed as before                                                              | kept (command hooks through the forwarder)                                                        |

A `PermissionRequest` that reaches a managed VM session anyway is **not** shown to a human and not
judged by the command rules (`commandVerdict` is the legacy path's): the runner (and, one step
further, the inbox's broker) refuses it at once with the way forward (`MANAGED_VM_NO_LOCAL_APPROVAL`),
and the session carries on. A question for a person at the terminal (`AskUserQuestion`,
`request_user_input`) is not a permission and is handled as before. The context pack leaves out the
"Commands that run without asking" section and says the member works freely; the business limits
(owner exceptions, publishing, cost) apply at the domain, network and operation gate (BOUNDARY.md),
not as deny rules in the CLI.

**Versions and the VM's own configuration** are checked before each spawn, on the CLI that would run
(`<cli> --version`) and on the files that would override the protected start:

- The installed version must be one of `MANAGED_VM_PROVIDER_VERSIONS` in `packages/shared`
  (`2.1.284` and `0.159.1` today, kept equal to `deploy/vm/profile.env` by a test). Another version is
  refused: the flags above were written for these, and a newer release may read them differently.
- No managed policy (`/etc/claude-code/managed-settings.json` and `.d/*.json`, the macOS path, Codex's
  `/etc/codex/*.toml`) may exist with content, and the provider's user configuration
  (`$CLAUDE_CONFIG_DIR/settings.json`, `$CODEX_HOME/config.toml`) and Codex's `<cwd>/.codex/config.toml`
  may not set hooks, MCP servers, `ask`/`deny` rules or a default mode, the sandbox, approval policy,
  features, profiles or credentials/endpoints. Only names are reported, never values. Codex's own
  bookkeeping (`[notice]`, `[projects]`) and Claude settings that only add allow rules or choose a
  model stand.
- A conversation of the other profile is never resumed: the session row keeps the profile it last ran
  in (`sessions.execution_profile`, migration 14, not part of the public `Session`). A change starts a
  new conversation in the directory the new profile places it in, and voids the session's unconsumed
  boundary requests (`policy_changed`). An "allow for this session" lives only in a process, so it
  does not outlive it; the old working directory is never reused.
- The worker environment drops `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `SSH_ASKPASS`, `GIT_ASKPASS` and the
  GitHub token variables on top of the billing variables every session loses.

**Not yet proven by hand** (the adapters are tested against the fake CLIs only; the real CLIs were
not run): that Claude Code 2.1.284 accepts `skipDangerousModePermissionPrompt` from `--settings` and
`--setting-sources user`, whether writes to `.git`/`.claude` still prompt in `bypassPermissions`, the
managed-policy and Codex file locations above, and that Codex 0.159.1 shows no confirmation for
`danger-full-access`. These are the first things of the human trial in [VM.md](VM.md); an answer
that differs changes the adapter, not the contract.

## Conversations across the move to the VM (PM-143)

A conversation belongs to the machine, the directory and the provider environment it ran in: a Claude Code
transcript lives in the home of the account that ran it, keyed by the working directory, and a Codex rollout in
that account's `CODEX_HOME`. The move ([MIGRATION.md](MIGRATION.md)) therefore keeps the **history** and starts
**new conversations**:

- The transcripts the database names are copied into the package and, by `apply`, into
  `<home>/migrated/transcripts/<session id>/`; the session rows point at the copies, so the session page still
  shows the old conversation (a transcript missing on the old machine stays empty, and the report says how many).
- Nothing is resumed from the old environment: the moved rows are all of the `legacy` execution profile, and the
  managed VM profile never resumes across profiles (above). A member's next task or message starts a new
  conversation in the VM workspace from the task brief and the member's memory (`memory/<KEY>/<handle>.md`
  moved with the data); the old row keeps its history.
- No personal CLI home is copied. Claude Code's and Codex's logins, settings and trust files on the Mac are not
  part of the package; the VM's providers are logged in anew by a person, and the VM's own configuration must stay
  free of the settings the profile refuses.

## Login and plan usage

Before spawning, the runner checks the provider's login (cached briefly). A CLI that is not
logged in with a subscription, or is logged in with an API key, is refused with
`provider_not_logged_in` (the domain answers 409 with `details.provider`). A login lost
mid-session (Claude Code: "Login expired · Please run /login"; Codex: a turn failing with
`unauthorized`) emits an `auth_error` runner event, stops the session and leaves it `failed`
with the message as its activity.

Plan usage is per provider: Claude's from Claude Code's usage probe, ChatGPT's from the rate
limits Codex records in its transcripts (nothing is spent to read either). New AI work pauses
above `pauseAbovePlanUsagePercent` of the plan of the member's own provider.

The runner strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CODEX_API_KEY`, `OPENAI_API_KEY` and
common OpenAI/Azure endpoint overrides from every session's environment.

## Sandboxes: what the CLIs enforce (PM-126 probe)

**Strict feasibility remains unverified.** The 00af6f0 probe reported results on
2026-10-01 / macOS 14.6 arm64 / Claude Code 2.1.284 / Codex 0.159.1. It placed the fake app
home beside worktrees, whereas `buildApp` puts worktrees beneath the app home. It exercised
shell commands, not built-in file tools, and classified every command failure as denial.
Those observations do not certify the PM-87 boundary or establish supported minimum versions.

The PM-127 policy migration uses semantic grants for both providers. All domain starts,
including resumed, scheduled and non-task starts, supply `SessionPolicy`; the Codex adapter
no longer parses Claude tool patterns. Historical `permissionMode` configuration still loads
and maps centrally. A read-only placement does not become writable through `acceptEdits`,
`auto` or `bypassPermissions`; explicit `default`/`plan` remain stricter.

This is preparatory: active policies use legacy enforcement. Strict policies currently fail
before spawning either CLI, rather than silently using legacy settings. The probe versions
below are evidence for that probe, not certified minimum versions for full PM-87 isolation.
PM-126 review and PM-49 hook isolation remain activation prerequisites. Decision 24 accepts
local port binding for tests; it also accepts the resulting local-port reachability described
below. No live instance settings are changed by this migration.

The revised [manual procedure](SANDBOX-PROBE.md) and `scripts/sandbox-probe.sh` use nested
worktrees, fictional data and positive host controls. The script never starts an agent CLI;
real verification is interactive and subscription-only. Automated tests use temporary repos
and no real agent CLI. No revised native run has yet been recorded here.

| CLI / OS / policy                                                           | Shell file boundary                                         | Built-in file tools | Own git / protected shared git                                                     | Network / test servers                                            | Strict minimum                        |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| Claude 2.1.223 / macOS                                                      | Unverified                                                  | Unverified          | Unverified                                                                         | Unverified                                                        | Not established                       |
| Claude 2.1.284 / macOS 14.6 arm64 / old probe settings                      | Reported sibling-folder denial; nested exception unverified | Unverified          | Reported commit allowed, hooks/config blocked; other protected metadata unverified | Reported npm allowed; local binding also opened other local ports | Not established; local-port conflict  |
| Codex 0.159.1 / macOS 14.6 arm64 / legacy settings plus writable shared git | Reported broad reads, limited writes                        | Unverified          | Reported index lock blocked but hooks/config writable                              | Reported network/binding blocked; npm used warm cache             | Fails the strict policy as configured |
| Codex 0.159.1 / macOS / restricted-read permission profile                  | Unverified                                                  | Unverified          | Unverified                                                                         | Unverified                                                        | Not established                       |
| Claude 2.1.223 and 2.1.284 / Linux                                          | Unverified                                                  | Unverified          | Unverified                                                                         | Unverified                                                        | Not established                       |
| Codex 0.159.1 / Linux                                                       | Unverified                                                  | Unverified          | Unverified                                                                         | Unverified                                                        | Not established                       |
| Any later proposed release / macOS or Linux                                 | Repeat full procedure                                       | Repeat              | Repeat                                                                             | Repeat                                                            | No inferred support                   |

The old settings used Claude `denyRead` for sibling live/secret folders, `allowWrite` for
`~/.npm`, strict npm-only networking and `allowLocalBinding: true`. The old report says boolean
`allowUnsandboxedCommands: false` worked where the string `"deny"` caused prompts; acceptance
and enforcement of either type remain version-specific observations to reproduce.

Current source differs from that probe: `WORKTREE_SANDBOX` allows npm/development-data writes
and local binding. Codex's normal session spec
no longer grants the shared git root (PM-131), but its legacy sandbox does not implement the
required restricted-read policy. Command-rule approval of Codex escalations is host execution,
not strict isolation. PM-134's transitional Claude setup is not the final PM-128/129 proof.

### The sandboxes the server hands out (PM-167)

`sessionSandbox(policy)` (`domain/session-policy.ts`) computes them per session from the actual
paths; `buildSandboxSettings` renders them, and `test/cli-sandbox.integration.test.ts` checks the
exact `--settings` the fake CLI receives:

| Session                                               | `filesystem`                                                                                                               | `network`                                   | `excludedCommands`         | Extra deny rules                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------- | ---------------------------------- |
| Developer (`task_worktree`)                           | `allowWrite: ~/.npm, ~/.projectman-dev`; `denyRead`: `sensitivePaths`                                                      | `registry.npmjs.org`, local binding allowed | none                       | none                               |
| Reader (`read_only`, review copy without test opt-in) | `allowWrite: []` (temp only); `denyWrite`: working directory and every `--add-dir` directory; `denyRead`: `sensitivePaths` | `registry.npmjs.org`, local binding allowed | `gh pr view`, `gh pr diff` | `Edit(//<dir>/**)` per `denyWrite` |
| Managed VM profile, sessions behind the VM boundary   | none (the boundary is outside the CLI)                                                                                     |                                             |                            |                                    |
| Codex                                                 | not rendered: Codex's own `--sandbox` (`read-only` for a reader, unchanged)                                                |                                             |                            |                                    |

Every one also has `enabled`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands: false`,
`failIfUnavailable` and `strictAllowlist`. A `denyWrite` directory a rule cannot name as it is
refuses the start. The temp directory is the sandbox's own `$TMPDIR`. **Manual run on the owner's
machine: pending** (the PM-167 part of `SANDBOX-PROBE.md`); record its result here.

Current [Claude documentation](https://code.claude.com/docs/en/sandboxing) describes Seatbelt
on macOS and bubblewrap/socat on Linux, with an additional seccomp filter for Unix sockets.
It assigns built-in Read/Edit/Write to permission rules, separately from Bash isolation.
It documents `strictAllowlist` from 2.1.219; that is a feature floor, not a project minimum.
The parent-denial/own-worktree exception and each tool still need versioned tests.
Current [Codex security docs](https://learn.chatgpt.com/docs/agent-approvals-security) describe
Seatbelt on macOS and bubblewrap/seccomp on Linux. Record dependency/kernel support and
startup refusal on each tested host; current docs are not old-release evidence.

The host half of the git attack is reproduced by `apps/server/test/sandbox-probe.test.js`:
the actual worktree manager executes planted `post-checkout`, shared `core.hooksPath`, and
`core.fsmonitor` programs in fictional repos. Native sandbox planting is a separate manual
step, still unverified. General shared `.git` writes are therefore not a safe workaround for
blocked add/commit; protected metadata and other sessions' refs require narrow git operations.

Outstanding gates: complete version/OS evidence; built-in tool boundaries; settings/hook/MCP
merging (PM-49); no exceptional execution or unavailable-sandbox fallback; fresh-cache npm and
GitHub; forbidden-domain redirects/raw IP/IPv6/Unix sockets; test self-connections without
arbitrary app-port access; trusted runner connections without exposing member tokens.
Decision 24 and the strict local-port requirement remain in conflict. HTTP login and session
tokens do not prove network isolation. Moving the live listener is not a verified fix.
If native controls fail, the manual procedure lists concrete isolation/git-service alternatives
for an explicit owner decision; general unsandboxed execution is not an alternative.
