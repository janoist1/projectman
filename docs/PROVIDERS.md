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
does not sit at its prompt: the message that caused the resume, else the context pack's short
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

Claude members may choose a fixed model id, a latest-family alias, or a custom id. Their
optional effort (`low`, `medium`, `high`, `xhigh`, `max`) is passed via `--effort` on new and
resumed sessions; unset effort uses Claude Code's own default. Clearing effort with a member
PATCH (`null`) restores that default.

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

**A Codex member never runs in `bypassPermissions`** (decision 19, PM-84). The mode would switch
Codex's sandbox and its questions off, and Codex does not enforce denied tools, so nothing would
stop a push from a local-only repository. The configuration refuses it (invariant
`codex_bypass_not_allowed`), an older configuration that names it reads as `acceptEdits` (logged
as a warning) and the runner maps it to the sandbox of `acceptEdits` should it arrive anyway.

Developers' Codex sessions may write the task worktree's git directory, so commits do not
escalate, while the network stays off. Codex's own sandbox still keeps `.git` read-only in
some cases, so the server allows the routine git steps itself (see Session policy, PM-77).

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
  commit, each a single command (no pipe, no redirection). They may be joined with `&&`, `||`
  or `;` and mixed with read-only steps, which may be whole pipelines, as long as those stay
  in the worktree (`git status && git add -A && git commit -m …; git log --oneline | head -1`,
  PM-77). Every step is judged on its own and the directory never changes: the only `cd` is a
  first one that stays in the worktree. A chain of read-only steps alone is for the next rule;
- read-only commands are allowed for every AI session on a task, inside the session's own
  directory and the task's worktree: `git status`/`diff`/`log`/`show` and similar, `grep`,
  `ls`, `cat`, `find` without actions, `xargs` fed only by a lister (`git ls-files`,
  `git diff --name-only`, `grep -l`, `find`, …), and the project's test, type and format
  checks (PM-69). Patterns that can match `.` and `..` (`.*`) are not followed.

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
