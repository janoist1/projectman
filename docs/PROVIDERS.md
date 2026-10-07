# Agent providers

## NanoGPT (PM-329)

NanoGPT uses the interactive Codex CLI with a custom Responses model provider at
`https://nano-gpt.com/api/v1`, not `--oss`. The default model is
`z-ai/glm-5.3-flash-uncensored`; effort defaults to medium. Codex >= 0.159.1 is required:
older 0.117–0.125 releases had MCP issues with custom providers (openai/codex #19871).
The installation secret comes from PM-328's store, only at launch and resume. A dedicated
0700 `PROJECTMAN_HOME/providers/nanogpt/codex-home` keeps transcripts separate and rejects
`auth.json`; there is no ChatGPT fallback. The key is excluded from CLI shell environments.
Missing keys or incomplete setup defer automatic starts; key changes refresh readiness and
retry them. Deletion does not stop an existing session. Hook, terminal, team MCP, permission
and resume behavior follow Codex, without a ChatGPT plan gauge. Managed VM is unsupported
until PM-331. Real-key tool, effort and process-environment checks are performed by the owner.
Both Codex and NanoGPT pass `-c notify=[]` so project configuration cannot install a
notification command running outside the CLI sandbox. Acceptance of this override by
Codex 0.159.1 remains part of the owner's manual check.
NanoGPT startup also uses `inspectAmbientConfig` to reject override-capable settings in
`/etc/codex`, its dedicated Codex home and the workspace's `.codex/config.toml`.
The `nanogpt_setup_incomplete` error exposes only configuration file and key names.
Nonempty workspace `.codex` directories and dedicated-home `hooks.json` files are refused;
escaped quoted TOML roots fail closed in the shared inspector.

NanoGPT disables plugins, remote plugins, ChatGPT apps, tool suggestions and skill-triggered
MCP installation with per-process feature overrides. Analytics and feedback are disabled.
Its authentication store is ephemeral; no keychain login is loaded. The environment filter
removes `CODEX_ACCESS_TOKEN` from every provider's children, since it otherwise takes
precedence over the selected authentication store. These settings apply on resume too.
Codex 0.159.1 still fetches the public announcement from
`raw.githubusercontent.com/openai/codex/main/announcement_tip.toml`: this unconditional GET
has no authentication or provider key and has no disable setting in that release.
Before repeating a manual probe, the owner must clear the probe home's previously downloaded
`codex-home/.tmp` plugins. Check that no ChatGPT or plugin-marketplace request or plugin
download remains; the public announcement request may remain.

NanoGPT requests for commands outside the sandbox never receive automatic command-policy
approval, even for reads or routine worktree steps. Publishing and in-place editing denials
remain unconditional. This prevents installation lifecycle scripts and Git hooks from
running outside the sandbox without an approver's decision, where they could expose the
CLI's key. The inbox shows the command; inspect the scripts and hooks before approving it.
Use a `human` approver for NanoGPT developers (`ai` is permitted but not recommended).
With the default `approver: 'none'`, requested commits are refused: the shared Git index
lock lives outside the worktree sandbox. See SECURITY.md for the unresolved same-user
process-environment risks. The PM-356 local permission profile denies the secret store
and other `sensitivePaths`; approved host commands remain outside that boundary.

### Investigating a missing team MCP or a 429 (PM-377)

The launch arguments retain `mcp_servers.team`; the disabled `apps` feature concerns
ChatGPT connectors. Fake CLI tests cover argument delivery and simulated team calls,
not whether a real custom model receives and invokes the team tools. No configuration
change is justified by the available evidence. After deployment, the integrator checks
the first NanoGPT member session's tool list and a read-only `get_task` call. Record the
CLI version, MCP startup status, model-visible tool names and the call outcome, without
URLs containing session tokens, keys or raw request bodies. A text-only `TEAM_OK` response
is insufficient evidence. If the failure persists, investigate it on a follow-up card;
this manual deployment check does not block the PM-377 implementation handover.

An empty `task_complete` error ends the runner turn even if no Stop hook follows.
NanoGPT quota failures additionally fail and stop the session, alert the owners once per
provider hold, and defer the affected task's continuation for the same member. The adapter
reads the documented [subscription usage endpoint](https://docs.nano-gpt.com/api-reference/endpoint/subscription-usage)
with the existing managed key, a ten-second timeout and redirects refused. Weekly
`percentUsed` is a fraction and `resetAt` is epoch milliseconds. At least 99% with a known
reset holds all NanoGPT starts and message wakeups until that reset, without inference
retries. Initially known lower usage gives one fifteen-minute rate hold
(`NANOGPT_RATE_HOLD_MS`). An unavailable or degraded usage response, or exhausted usage
without a reset, holds indefinitely while only the read-only usage probe retries. A later
known lower usage releases an unknown hold immediately. NanoGPT's measured usage is shown
in the gauges but does not apply the configurable plan-usage pause threshold.
The hold is in memory and is lost on server restart. Persisted quota deferrals restore an
unknown hold without a new alert; only a usage probe can allow inference to resume. A new
429 also arms the hold for sessions without a deferral. A generic 429 alone does not distinguish
subscription exhaustion from upstream throttling. Never enable paid overage as part of
diagnosis. NanoGPT's
[support page](https://nano-gpt.com/support) describes input-token allowances, model
multipliers and rate limits; the account's actual allowance must be checked separately.

An AI member runs in one of two agent CLIs, set per member (`provider` in `team.yaml`,
default `claude`): **Claude Code** on the sponsor's Claude plan, or **OpenAI Codex CLI**
on the sponsor's ChatGPT plan (decision 15). Both run as interactive TUIs in a PTY, never
through the Agent SDK, `claude -p`, `codex exec` or the Codex app server. The runner drives
them through provider adapters (`apps/server/src/runner/providers/`); the PTY session,
message queue, state machine, permission broker and transcript tailer are shared, and each
adapter declares its capabilities.

## Differences

|                     | Claude Code                                                      | Codex (codex-cli 0.159.1)                                                          |
| ------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Conversation id     | ours (`--session-id`), resume with `--resume`                    | Codex's own, learned from the first hook (`provider_session_id`); `codex resume`   |
| Hooks               | HTTP hooks (SessionStart through the forwarder)                  | command hooks running the forwarder; the PermissionRequest one prints the decision |
| Ready for input     | first SessionStart hook                                          | composer on screen, or the first SessionStart hook (it fires with the first turn)  |
| Kick-off brief      | typed with bracketed paste                                       | the prompt argument; later messages typed, Enter more than 120 ms after the paste  |
| Resume: 1st input   | typed once SessionStart arrives                                  | the prompt argument of `codex resume <id> -- <prompt>`                             |
| System prompt       | `--append-system-prompt`                                         | `-c developer_instructions=…`                                                      |
| Project rules       | `CLAUDE.md`                                                      | `AGENTS.md`, else `CLAUDE.md` (`project_doc_fallback_filenames`)                   |
| Allow for session   | session rules in the hook answer                                 | remembered by the runner (Codex rejects `updatedPermissions`)                      |
| Transcript          | `~/.claude/projects/…/<id>.jsonl`                                | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`                             |
| Plan usage          | `get_usage` probe of `claude -p`                                 | rate limits of the newest `token_count` records in the transcripts                 |
| Token usage         | `message.usage` of assistant entries; subagents                  | `token_count` records (`total_token_usage`, `last_token_usage`); subagents not     |
|                     | from their own file at `SubagentStop`                            | measured                                                                           |
| Login check         | `claude auth status`                                             | `codex login status`                                                               |
| Compaction (PM-213) | `/compact <instruction>` typed; PreCompact and PostCompact hooks | not done: its compaction command was not checked                                   |
| Pause (PM-218)      | halting hook answer `{continue:false}` at the next tool hook     | the running tool ends, then one Esc, confirmed by the `Interrupt` hook             |

## Compaction at the end of a round (PM-213)

When a member's round on a card ends (the card leaves the stage the member worked it in), the
server has Claude Code compact the member's conversation into a summary: it types
`/compact <instruction>` once the session is idle (`COMPACT_INSTRUCTION`, `apps/server/src/context`,
names what to keep: the card, decisions, changed files and commits, open questions and unfixed
findings; not file contents or command output). The rule and its timing are in
[ARCHITECTURE.md](ARCHITECTURE.md); this is what the runner relies on in the CLI.

- **Hooks.** PreCompact and PostCompact (both in Claude Code 2.1.284) are HTTP hooks like the others.
  The payload's `trigger` is `manual` (the typed command) or `auto` (the agent's own, in the middle of
  a turn). The session is `working` (activity "Compacting the conversation") from PreCompact; after a
  manual compaction PostCompact makes it idle, since no Stop hook follows a slash command, while an
  auto one goes on with its turn. `/compact` sends no UserPromptSubmit, so PreCompact is what tells the
  input queue the command got through.
- **Time limits** (`SessionTiming`): the command must start (PreCompact) within
  `compactStartTimeoutMs` (10 s) and end (PostCompact) within `compactTimeoutMs` (300 s). Past either
  the runner logs, emits `compaction` `abandoned`, and the session takes messages again (a command
  that started is ended as idle; one that never started changed no state, and held the queue back
  until now, so no message ran into it); a dialog over the prompt or an error cannot hold it. Text left in the prompt box by a swallowed
  command is not cleaned up.
- **Same conversation.** A compaction writes a `compact_boundary` entry and a summary into the same
  transcript file, and the session id stays: `--resume` of that id continues from the summary.
- **Last measured context** (the threshold of a compaction at resume): the latest main-conversation
  step's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
  (`ClaudeUsageCounter.takeContext`). A subagent's steps do not count.
- **Not verified here (needs the real CLI, the integrating session's manual trial).** Whether the
  compaction's own summarising call is written to the transcript as an assistant entry with
  `usage`. The usage counter counts every assistant entry with a model and `usage`, so if it is
  there it is in the session's consumption (PM-178); if Claude Code does not write it, that
  consumption is not measured and there is nothing to read it from. It also decides whether the
  measured context right after a compaction can briefly show the pre-compaction size (until the
  next step measures it again).
- **Codex.** Unchanged: its compaction command was not checked, so Codex members are never
  compacted (`COMPACTING_PROVIDERS` in `contracts/runner.ts` lists the providers that are).

## Pausing a session (PM-218)

`SessionRunner.pause(sessionId, { forceAfterMs? })`, `forcePause(sessionId)` and
`release(sessionId, { nudge? })` (`apps/server/src/runner/pause.ts` and `session.ts`) stop a session at a
safe point, keep what is typed to it back, and let it through again. The domain side (who asks, the
deadline, the timeline) is PM-219; this is what the runner does and relies on in the CLIs.

- **While it is stopping** the input queue is held: a message being typed is finished (with its Enter),
  nothing new is typed, and messages queued meanwhile wait. `session_pausing` is emitted at once
  (`waitingFor`: the tool that is running, or `null`), `session_paused` when the session has stopped
  (`point`, `tool`). A second `pause` joins the first (the first call's deadline stays).
- **Stopped** means: the state is idle, waiting for permission or waiting for input; nothing is being
  typed or awaiting its submit confirmation; no compaction is typed or running. It is checked after
  every state signal, when a typed message ends and after an abandoned compaction, never from the
  submit confirmation alone. A session already stopped settles at once (`idle`, `waiting_permission`,
  `waiting_input`).
- **Pause points** (`PausePoint`): `idle`, `turn_end` (the turn ended on its own while stopping),
  `after_tool` (a tool finished and the turn was halted after it), `before_tool` (the next tool call was
  turned away, it did not run), `interrupted` (Esc, see below), `waiting_permission`, `waiting_input`,
  `exited` (the process ended meanwhile). `tool` is the main agent's tool that was running or turned away.
- **Claude Code.** The halting answer is `{"continue": false, "stopReason": …}` on the PreToolUse and
  PostToolUse (and PostToolUseFailure) hooks. A PreToolUse one makes the tool not run: the agent gets an
  error result worded by `PAUSED_BEFORE_TOOL`; after a PostToolUse one the turn ends with
  `PAUSED_AFTER_TOOL`. The Stop hook still runs afterwards (2.1.284), and that is what makes the
  session idle. A subagent's hooks (payload `agent_id`) are never halted: only the main agent's tools
  count, and the pause waits for the main agent. With parallel tools the first halting answer wins and
  the pause waits until no main-agent tool is left. A question forwarded to the team inbox (PM-199)
  loses to a halt: the call is turned away by the halt text.
  A sandboxed session's forwarder prints a response only for events that can answer
  (`DECIDING_EVENTS` in `claude/args.ts`); PostToolUse and PostToolUseFailure were added for this.
- **Codex.** Codex has no halting output, so a running tool is waited for, and then one Esc ends the
  turn; the `Interrupt` hook confirms it and the session is idle. The Esc goes out only while the state
  is `working`, after the hook response of the tool's Post hook, so it does not race it.
- **Confirmation and fallback.** One Esc is sent, never a second one. The confirmation is the hook
  (Codex) or the transcript's `interruptedAt` newer than the last prompt (Claude Code); after
  `interruptConfirmMs` (5 s) the runner looks at the screen and, when the prompt box is up and no
  "esc to interrupt" hint shows (`ProviderAdapter.workingVisible`: both CLIs keep the prompt on screen
  while they work, so the prompt alone says nothing), treats the turn as interrupted; if even that fails
  the pause stays stopping until a stop or `release`.
  A Claude turn halted without its Stop hook (`haltStopMs`, 5 s) is settled the same way from the screen,
  and only when no main-agent tool is left running (parallel tools: the turn goes on until the last one).
- **A turn the transcript ended (PM-343).** A main-conversation assistant entry with `stop_reason`
  `end_turn` marks the turn over until a later assistant entry, a prompt or a compaction begins. While it
  is marked, the main agent's tool hooks (a late `ToolSearch`, say) are ignored and cannot reopen the
  turn; a session still `working` `turnEndGraceMs` (5 s) later is closed (whatever the screen shows) as if
  the Stop hook had come; a forced pause takes such a session as stopped without an Esc (an Esc already
  sent is settled by it). A dropped call is remembered by its `tool_use_id`: a turn that begins with no
  prompt (a background task's notification) can show its first tool hook before the transcript is read,
  and when the transcript then shows that call the turn begins with it (replayed as a running tool). A
  ghost call has no transcript entry and is never replayed.
- **Forced.** `pause` with `forceAfterMs` (when it passes) and `forcePause` send the one Esc as soon as
  the session is `working`; a tool that is running is cut (`interrupted`, `tool` the one cut). A
  compaction asked for and running is not waited for: the Esc cancels it and it is given up at once.
  A human's own Esc during the stopping also reports `interrupted`. A pause that is already stopped
  is not forced.
- **Refused tools.** A tool whose approval is denied (a decision, the timeout, a failure) sends no
  PostToolUse, so it stops counting as running at the denial; the pause does not wait for it.
- **Release.** `release` lets the input through again. A stopped session types the `nudge` first, then
  what waited. A session still stopping has its pause taken back: pending `pause` promises resolve to
  `null`; if a halting answer or Esc already went out (the turn is ending) the nudge is typed after the
  turn, otherwise it is dropped (the session never stopped, so nothing needs a nudge). `release` returns
  false when there is no pause.
- **Not verified here (needs the real CLIs, the integrating session's manual trial).** That Claude Code
  2.1.284 honours `continue:false` from a PreToolUse and a PostToolUse hook exactly as documented while a
  `sleep 60` runs, and that Codex's Esc during a tool leaves the composer ready. The runner's PTY tests
  (`runner.integration.test.ts`, `codex.integration.test.ts`, "pausing") use the fake CLIs
  (`LONGTOOL` keyword) and cannot run in the agent sandbox.

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

**Reach (PM-208).** The session runs under the owner's account, so by default it would load the
owner's claude.ai connectors (Gmail, Drive, Calendar, ClickUp, ...) and Claude in Chrome (the
owner's logged-in browser). Every session, new or resumed, therefore also gets
`--strict-mcp-config` (only the `--mcp-config` team server; no connectors, no `.mcp.json`) and
`--no-chrome`. No per-member MCP server exists yet; one would be added to `buildMcpConfig`.
Codex startup checks loaded sandbox settings and resolves the user configuration's
MCP server names (PM-356). It disables each user server before installing `team`, and
unresolved names refuse startup. Every Codex/NanoGPT launch disables `plugins`,
`remote_plugin`, `apps`, `tool_suggest`, `skill_mcp_dependency_install`, `computer_use`,
`browser_use` and `browser_use_external`. User hooks and workspace `.codex/` execution
are separate work (PM-49 and PM-357).

**Prompt suggestions (PM-345).** Claude Code's prompt suggestion runs a "suggestion mode" step after
a turn that can put an `AskUserQuestion` ("Topic: Suggestion") at the terminal, which the runner
would forward as the member's own question (PM-199) and hold the card with `waiting-answer`. Every
session therefore starts with `promptSuggestionEnabled: false` in `--settings` (the setting that
`/config` shows as "Prompt suggestions", also `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`; found in
Claude Code 2.1.287). It also saves the extra model call. No detection of such a call is
kept: no structural mark that tells it from a member's question is known, and its text is not reliable.

**Built-in tools and skills (PM-221).** A tool's description and the skill list are read in every
step (a fresh member session started at 44.4k tokens after PM-208), and several built-in tools act
with the owner's account or reach their other sessions. Every session, new or resumed, therefore
gets `--tools "<list>"` (`claudeBuiltinTools` in `providers/claude/policy.ts`, one comma-separated
value because the flag is variadic) and, in `--settings`, `disableBundledSkills: true` plus
`skillOverrides` (`"off"`) for the owner's claude.ai account skills (`anthropic-skills:<name>`;
`--disable-slash-commands` is not used: PM-213 types `/compact`). The MCP tools (team) are not
part of `--tools`. What stays and why:

| Tool            | Why it stays                                                        | Roles |
| --------------- | ------------------------------------------------------------------- | ----- |
| Read, Bash      | the work itself                                                     | all   |
| Edit, Write     | changing files; a reading role has them too (below)                 | all   |
| TaskStop        | ends a background command the session started                       | all   |
| WebFetch/Search | documentation (the network rules and denied hosts still limit them) | all   |
| Agent           | the cheap subagent (PM-179)                                         | all   |
| ToolSearch      | the team tools are deferred; without it they cannot be reached      | all   |
| AskUserQuestion | PM-199 forwards its call to the inbox's waiting list                | all   |

One list for every role and for the managed VM profile, the same settings too. A reading role
(`read_only`, `review_copy`) keeps Edit and Write on purpose (the architect's decision on PM-221):
it had them before, its prompts name them (a file in `$TMPDIR`; without them it would need a
here-document, which waits for a human), and what it must not change is kept by the deny rules and
the sandbox (PM-167, PM-188), not by this list. Left out (among others): Artifact,
ArtifactComments, ArtifactData (publish with the owner's account), Workflow, ScheduleWakeup,
ReportFindings, SendFeedback, SendMessage and ListAgents (reach the machine's other Claude
sessions, around the team channel), Cron*, RemoteTrigger, PushNotification, EnterWorktree,
ExitWorktree, EnterPlanMode, ExitPlanMode, DesignSync, NotebookEdit, Skill, Grep and Glob. Claude
Code 2.1.284 has no separate Grep and Glob tool: the search goes through Bash, so the cheap
subagent has Read and Bash only and its prompt says so. A new Claude Code version's new tool stays
out until it is added to the list. Role tool rules (`tools.files`, `tools.shell`) still decide
what is allowed without asking; `--tools` only decides what exists. A test keeps the generated
prompts from naming a tool that is left out.

A session in a task's own worktree (a developer's) runs its shell commands in Claude Code's
sandbox, the first step of PM-87: the session spec carries `sandbox` (`sessionSandbox` in
`domain/session-policy.ts`, computed per session) and the runner turns it into the `sandbox`
settings probed in PM-126 (see Sandboxes below). Commands then run without asking as long as they
read only their own work below the home (PM-153), write only the worktree (with the shared git
directory, minus hooks, config, the default branch and the integrating checkout's `HEAD` and
`index`), the temp directory and the member's own npm cache and development data (PM-193; not
the user's `~/.npm` and `~/.projectman-dev`), and reach only the npm registry; a command that fails there is not retried outside the sandbox. The tests may listen on
local ports (decision 24). The sandbox
cannot open pseudo-terminals, so the server's PTY tests (`*.integration.test.ts`,
`golden-path-*`) are left out there; the integrating session runs the full suite. The leaving out
needs an explicit signal (PM-194): `apps/server/vitest.config.ts` skips those files only when it
cannot open a PTY **and** `PROJECTMAN_SKIP_PTY_TESTS=1` is set, with a notice that the run is not
complete. The server sets it in the `env` of every Claude session's sandbox (`SANDBOX_PTY_ENV`: a
developer's and a reader's) and the system prompt says so; Codex sessions do not get it (Codex's
sandbox is its own). Without the variable a PTY that cannot be opened (a native module broken by a
Node update, say) stops the run at the start with a message, so the full run before a merge cannot
pass with the 11 files silently missing. With the variable set but a PTY that opens, the tests run:
it permits the skipping, it does not demand it. Claude Code 2.1.284's sandbox settings have no
`allowPty` key (the setting exists in its sandbox runtime, but the CLI does not pass it on), so the
PTY tests cannot run in the sandbox yet; that needs a newer CLI. The server therefore runs them
itself (PM-217): when a card enters review, `src/full-test` runs the repository's `reviewTest`
command in its own sandbox, the Anthropic Sandbox Runtime (`@anthropic-ai/sandbox-runtime`, `srt`,
macOS Seatbelt) with `allowPty`, outside every member's session (see "Full test before review" in
ARCHITECTURE.md). Its settings come from `fullTestSandbox` in `domain/session-policy.ts`: reads only
the checkout and its git directory below the home, writes only its own run directory in the temp
directory, no network (but listening on local ports), and a small allow list of environment variables.

A development instance started in such a sandbox has no PTY for its own sessions either, so
`PROJECTMAN_TERMINAL=pipe` (PM-267) makes the runner start the CLIs with plain pipes
(`runner/pipe-spawn.ts`) instead of node-pty. This works only with the fake CLIs
(`test/fixtures/fake-claude.mjs`, `fake-codex.mjs`, which also exit when their standard input
closes): the real `claude` and `codex` are not interactive without a terminal, and the live instance
and the managed VM never run this way. `parseTerminalMode` (`app.ts`, called by `index.ts`) refuses
`pipe` when `PROJECTMAN_HOME` is unset or is the live home (`~/.projectman`; a directory below it,
like a member's `member-caches/…/projectman-dev`, is fine), when `CLAUDE_BIN` or `CODEX_BIN` is not
set explicitly, when `PROJECTMAN_BOUNDARY_CONFIG` is set, or with the `managed_vm` profile. Whether
the two binaries are really fakes cannot be checked; requiring them explicitly only rules out an
accidental default. Sessions started through the launcher are not affected.

`scripts/lib/instance.mjs` (PM-269) starts such a throwaway development instance for members and
scripts: `startInstance()` runs the server and Vite on free ports with the data and logs in one
directory (a new temporary one by default, removed by `stop()`), the fake CLIs and
`PROJECTMAN_TERMINAL=pipe`, and offers `api`, `invite` (a non-admin account), `startSession`, `say`,
`waitIdle` and `setFakeCalls` (the calls of a fake Claude "CALLS" turn, in `fake-claude-calls.json`).
Its children run under `scripts/lib/child-guard.mjs`, so nothing stays running after the parent is
killed. It refuses a data directory in the live home (`~/.projectman`, except the members' `worktrees`
and `member-caches`) and port 4800. `npm run demo` is built on it. Its tests are
`apps/server/test/instance.test.ts`.

Every other legacy session reads only (PM-167, decision 28: „Homokozó, a CLI-k saját kerítése”):
the reviewer, QA, the security reviewer, the analyst, the architect, the designer, devops, chats,
meetings and scheduled runs, any session whose placement is `read_only` or a review copy without
the test opt-in. It runs in the member's own mode (Auto stays Auto, `plan` stays `plan`) and in a
sandbox from `sessionSandbox` (see Sandboxes below) that writes only the temp directory: the
working directory, every `--add-dir` directory and the installation's other checkouts (the
project's workspace, the app home with every member's worktree and workspace, the server's own
checkout, `~/projectman-live` on the owner's machine; PM-188) are `denyWrite`, and the Claude
adapter denies `Edit(//<dir>/**)` there too (which also covers `Write` and `NotebookEdit`), since
the sandbox does not bind the built-in file tools. Reads, git queries, `npm test` and `npm run typecheck` then
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
them either. The database is the glob `<appHome>/db.sqlite*`: it takes `db.sqlite`, its `-wal`
and `-shm` files and any copy next to it (`db.sqlite.bak-…`). Claude Code renders a glob into
macOS Seatbelt as it is (2.1.284 lists it under "Denied" in `/sandbox`); its Linux sandbox
(bubblewrap) leaves out the glob patterns it does not support and lists them in `/sandbox`
(unverified for this one), and then the database files stay readable from the shell on Linux
until they are named one by one. The `Read` deny rules of the file tools take the glob on both. Residual risk: port 4800 stays reachable from the shell up to the VM
(decision 24).
Codex ignores the deny rules (its sandbox is its own, PM-166). See `SECURITY.md`.

### Questions at the terminal (PM-199)

Nobody reads a member's terminal, and a dialog there shows up nowhere in the app: a session that waits
in `waiting_input` holds its messages back (nothing is typed into a waiting terminal). So Claude Code's
`AskUserQuestion`, called by a session that has a member, is turned away: the PreToolUse hook (or, for
a call that reaches it, the PermissionRequest hook) answers a denial that says the question went to the
inbox, and the broker's `forwardQuestion` asks the humans one inbox question per question of the
call, as `ask_human` would (options with their descriptions as consequences; the sponsor or the
owners). The answer comes back as a team message, and the session never leaves `working`. A call the
broker cannot take is left to the terminal as before. The PreToolUse hook is a deciding hook for the
sandboxed (forwarder) start for this reason. The system prompt tells members to use `ask_human`.
Codex's `request_user_input` stays at the terminal (its adapter has no refusal answer).

A session that stays in `waiting_input` for 10 minutes (`INPUT_STALL_MS`) with no open question or alert
of its own gets one `session_input` alert for the owners ("Rád vár"): a dialog nobody saw, or a stray
hook. Nothing else is done to the session. Each hook that puts a session into that wait is logged
(`session waits for input at its terminal`) with the conversation id, agent id and type, transcript,
tool use id and whether the prompt is visible on the screen, to find where a stray one comes from.

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

For local Codex and NanoGPT sessions, these mode names select an inline `projectman`
permission profile extending `:read-only` (PM-356), not a `--sandbox` argument. It reads
the filesystem except `sensitivePaths` and the adapter's Codex home. Writing modes add
`:workspace_roots` with `.git`, `.codex` and `.agents` read-only, plus the explicit portable
writable roots. Denied roots and their children are never added as writable roots.
The CLI must be at least 0.159.1; loaded sandbox/profile configuration refuses startup
with `codex_setup_incomplete`, and ambiguous user MCP configuration with `mcp_config`.
Administrator configuration with any content is refused. Errors report paths and key
names only. No local launch supplies `--sandbox`, `sandbox_mode` or
`sandbox_workspace_write`: the native probe confirmed `--sandbox` overrides the profile.
The `managed_vm` profile retains its existing sandbox arguments; its VM is the boundary.

The runner resolves the real CLI file on the session PATH. If it is beneath a denied
directory, only its official `packages/standalone` installation ancestor may be reopened
read-only, after the denials; an ancestor containing a denied path is never reopened.
This also applies to NanoGPT's shared executable despite its different Codex home.
Unknown installation layouts inside denied directories refuse launch with `cli_location`
in the provider's setup error; details identify the real executable path. Use the official
standalone installer or install outside the denied directories. In a task worktree the
writing profile also makes the shared `objects`, `refs` and `logs` and the worktree's own admin
directory writable (PM-399), so `git add` and `git commit` work in the sandbox; the
configuration, hooks, `objects/info`, the admin directory's links and the integrating checkout's
files stay read-only (PM-131; see SECURITY.md). Routine git steps that escalate still use the
command-approval path (PM-77).

**A Codex member never runs in `bypassPermissions`** (decision 19, PM-84). The mode would switch
Codex's sandbox and its questions off, and Codex does not enforce denied tools, so nothing would
stop a push from a local-only repository. The configuration refuses it (invariant
`codex_bypass_not_allowed`), an older configuration that names it reads as `acceptEdits` (logged
as a warning) and the runner maps it to the sandbox of `acceptEdits` should it arrive anyway.

Developers' Codex sessions get one extra writable root, the parent of the machine's heavy-run
queue folder (`AgentSandbox.portable`, PM-346), and the queue variables
(`PROJECTMAN_HEAVY_LOCK_DIR`, `npm_config_prefer_offline`) through
`shell_environment_policy.set.<NAME>`, so their `npm test` waits in the queue like the Claude
members'. Both are left out in the managed VM profile. The network stays off. The roots
are filesystem write entries in the permission profile. A command run outside the sandbox
after a question still queues, and the CLI stops one that cannot use the queue (exit 78).

Codex and NanoGPT sessions in a developer's own placement also receive the member's
`npm-cache` and `projectman-dev` directories through `AgentSandbox.portable`, with
`npm_config_cache` and `PROJECTMAN_HOME` set through `shell_environment_policy.set`.
These are the same private cache and development-data paths Claude uses (PM-193);
denied paths remain excluded. Only a writing sandbox grants write access to these roots;
plan mode keeps the variables without granting writes. Reading placements and the managed
VM receive neither these member-directory variables nor these local write roots.

A Codex session whose sandbox writes (`workspace-write`, a developer's own placement, outside the
managed VM; PM-339) also gets its own **session folder** and its own **temporary directory**, both made
by the server before the process starts and removed with the session:

- the folder (`$PROJECTMAN_SESSION_DIR`, as for a Claude member; `PLAYWRIGHT_BROWSERS_PATH` with it) is
  a writable root, so the member can put an image there, open it with the built-in `view_image`
  (`tools.view_image = true`: not a sandboxed command, so it asks nothing) and `attach_file` it;
- the temporary directory (`SessionFolders.allocateTmp`, `<tmpRoot>/<session id>.<6 random hex digits>`,
  `AgentSandbox.portable.tmpDir`) is a writable root and every command's `TMPDIR`
  (`shell_environment_policy.set.TMPDIR`); the permission profile omits `:slash_tmp` and
  `:tmpdir`, closing the shared `/tmp` and the CLI's own `$TMPDIR`. Under both lay the other
  members' session folders, the server's full-test run directories and the Claude members' `/tmp/claude-<uid>`,
  which a Codex member could write otherwise. The path is short on purpose
  (`/tmp/projectman-<uid>-tmp/<instance hash>/<session id>.<6 hex>`, about 72 bytes on macOS, about 91 with a
  `tsx` socket's `/tsx-<uid>/<pid>.pipe`): a Unix
  socket's path is 104 bytes at most and tools such as `tsx` open one in `TMPDIR`, which the session folder's
  long path would not allow. The root is a sibling of the queue folder's parent `/tmp/projectman-<uid>`, never
  below it or above it: that parent is writable for every member's commands (PM-346), so a path in it could be
  pre-empted or read by any member (the domain leaves Codex without a folder, and logs an error, when
  `PROJECTMAN_HEAVY_LOCK_DIR` makes them overlap, also through a link: the paths are compared canonically). The root is 0700 and no member's sandbox names it. The
  directory is new at every start (random name, made by `SessionFolders.make` without `recursive`, so a link
  or directory put there beforehand is an error that stops the start), because the Seatbelt rule covers the
  path itself: a process of an earlier run could re-make a removed path, even as a link. It is removed when
  the process ends, swept at the server's start, and the empty root is removed at the server's stop.

A read-only session (the default mode, `plan`) gets neither: Codex's read-only sandbox takes no
writable root, and the mode changes only with a restart. A tool that writes a hard-coded `/tmp` path stops
after the closing; give it a targeted writable root, do not reopen `/tmp`. The PM-356
native probe allowed own TMPDIR writes and denied shared `/tmp` and the original CLI tmp.
The member-level development acceptance still checks attachments, caches and the heavy-run
queue.

The shared git directory is not made writable as a whole (PM-131): that let an agent write the
repository's hooks and configuration, which run when the host uses git there. Since PM-399 the
profile grants only what `git commit` writes (the shared `objects`, `refs`, `logs` and the
worktree's own admin directory) and keeps the configuration, hooks, `objects/info`, the admin
directory's `commondir`, `gitdir`, `config.worktree` and the integrating checkout's files
read-only. Without it the v2026.10.7 profile made `git add` and `git commit` fail with EPERM,
also when approved. The profile semantics (a nested `read` under a `write` root) are to be
checked in a live Codex session. Other routine git steps that escalate are allowed by the
server itself (see Session policy, PM-77).

## Gemini (agy) (PM-323 probe)

Antigravity CLI (`agy`) is the Gemini branch of PM-319. The adapter (PM-326) lives in
`runner/providers/gemini`: interactive PTY, per-conversation configuration, PreInvocation
instruction injection, fail-closed PreToolUse decisions, subscription login checks and
`transcript_full.jsonl` parsing. It uses `AGY_BIN` (default `agy`) and an explicit
`PROJECTMAN_HOME/providers/gemini` root, without changing HOME or workspace `.agents` files.
The initial brief is typed after screen readiness; continuation uses `--conversation`.
Owner decisions T1–T4 prefill onboarding, disable self-updates, wait for inbox decisions,
and temporarily allow role shell rules without a sandbox (PM-361). Managed VM support is
deferred to PM-331. The fake CLI covers this protocol without running real agy.

### Permission modes in projectman (PM-327)

The projectman `PreToolUse` hook enforces these modes; agy's `--mode` flag is not the gate.
Commands currently run without a sandbox (PM-326, owner decision T4).

| Mode                | Hook behavior                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`           | Reads inside allowed roots run; edits ask. Role-approved commands run; other commands ask.                                                                                                                                                         |
| `acceptEdits`       | Workspace edits run; commands behave as above.                                                                                                                                                                                                     |
| `auto`              | Behaves as `acceptEdits`: there is no classifier or sandbox. Commands outside the role's allowlist ask, using the member's approver setting.                                                                                                       |
| `plan`              | File edits are denied. Currently, role-approved commands of workspace roles can still run without a sandbox, because the shell allowlist is checked before the plan denial. Reading placements deny all commands. PM-367 corrects this limitation. |
| `bypassPermissions` | Not selectable.                                                                                                                                                                                                                                    |

Native session controls have a narrow adapter exception in every mode, including `plan`
(PM-376): `command_status` accepts an opaque `CommandId` of 1–128 ASCII letters, digits,
underscores or hyphens, with finite numeric or short alphabetic options; `schedule` accepts
integer `DurationSeconds` from 1 to 600 and a nonempty `Prompt` of at most 2000 characters;
`manage_task` accepts only `Action: 'status'` and a task identifier containing this conversation's
UUID, ending in `task-<digits>`. Absolute task identifiers must remain under this session's
`antigravity-cli` root in every resolved path form. Invalid inputs ask, as do extra fields on
`schedule` and `manage_task`;
`toolAction` and `toolSummary` string metadata are accepted. `send_command_input`, `wait`,
`wait_5_seconds` and other task actions still ask. Foreground waiting with `command_status`
remains the main path for long checks; scheduled wakeups are bounded below idle closure.

The UI explains the `auto` and `plan` limitations beside the selected mode, including read-only
profile settings and the hiring preview. `default` and `acceptEdits` need no provider note.

### Probe findings

This chapter records what a real run showed, so the adapter does not guess. The probe ran on
2026-10-05 on the owner's Mac, in the owner's presence, as 38 small runs in 19 conversations on
`gemini-3.8-flash-low` with a logged-in Google account. The binary was **agy 1.2.17**: the
card said 1.2.7, but the background updater had replaced it. Afterwards 98% of the five-hour
and 99.7% of the weekly Gemini window remained.

Samples are in `apps/server/test/fixtures/gemini/` (secret-free: account names are
`<account>`, work folders are `/tmp/pm-agy-probe/...`, OAuth `state`/`code_challenge` are
redacted). Paths below are relative to it. Files named `*.RECONSTRUCTED.json` were rebuilt
from printed summaries plus the real common fields; all others are raw captures. `screens/` is
emulated with minor artifacts, `screens-raw/` holds the exact bytes of three of them (ready, logged out, trust).

**Does this work on a remote engine?** The adapter's machine-dependent parts (the `agy` binary
and its updater, the keyring login, the `--gemini_dir`, the transcript files, the PTY) would
run on the engine, like Claude Code and Codex today. Nothing crosses the server/engine
boundary that does not already. No inventory entry in `docs/ARCHITECTURE.md` changes with
this card (it ships no code); PM-326 adds the entries.

### Summary for the adapter design

1. **Per-process configuration exists: `--gemini_dir <absolute dir>`** (Q1). Hooks and MCP are
   read from there, the Google login survives, `~/.gemini` stays untouched.
2. **Hooks are a reliable gate** (Q4). `deny` always wins; a handler that overruns its timeout
   is killed and the tool does not run. Proposed design: `toolPermission: always-proceed` plus a
   blocking `PreToolUse` hook that prints `allow` or `deny` from the runner's tool decision
   (PM-325). The hook is the single gate.
3. **`--sandbox` is too strict for development** (Q8): no network, no `ps`, no shell writes to
   the workspace. Gemini members would run unsandboxed with the hook as the gate (the same
   broad host-read exposure that legacy Codex settings had before PM-356). Commands get the full parent
   environment plus agy's own `ANTIGRAVITY_CSRF_TOKEN` and friends.
4. **Instructions** (Q11): `AGENTS.md` and `GEMINI.md` are read, `CLAUDE.md` is not; there is no
   system-prompt flag; a `PreInvocation` hook can inject an ephemeral message.
5. **Hazards:** a background updater can replace `~/.local/bin/agy` on any start; a fresh
   `--gemini_dir` repeats onboarding including the data-use consent screen.

Open, owner decision pending (asked on PM-323, none is decided yet):

- who completes the consent screen, or may projectman seed `cache/onboarding.json`;
- pin the version with `--release_base_url`;
- is a hook that holds a session for minutes acceptable while an inbox approval is pending
  (the alternative is `request-review` plus a hook `ask`, with the adapter pressing `1` or
  `4` in the dialog);
- run without `--sandbox`.

### Q1. Per-process configuration

```
agy --app_data_dir /abs --log-file L models        -> "Failed to start: must not be absolute", exit 1
agy --app_data_dir ../../../private/tmp/.../app1   -> models listed, but rewrote config/projects/default-cli-project.json in the real ~/.gemini
agy --gemini_dir /abs/gd1 --log-file L models      -> models listed, exit 0, ~/.gemini unchanged
HOME=/abs/home1 agy models                         -> exit 1 "Please sign in"
XDG_CONFIG_HOME=/abs/xdg agy --gemini_dir gd4 models -> nothing created in the XDG dir
agy --foo_bar models                               -> "flags provided but not defined" (so --gemini_dir is a real flag)
```

- `--gemini_dir <absolute dir>` is a hidden flag that replaces `~/.gemini` for that process.
  Hooks come from `<dir>/config/hooks.json`, MCP servers from `<dir>/config/mcp_config.json`;
  settings, transcripts, conversations and caches go to `<dir>/antigravity-cli/` (Q9).
- The login survives: the token is in the macOS keyring, and the log shows `keyringAuth: loaded
token ... authenticated via keyring ... Auth succeeded` even for an empty `--gemini_dir`.
  Overriding `HOME` loses it; `XDG_CONFIG_HOME` is ignored.
- Do **not** use `--app_data_dir`: it only takes a path relative to `~/.gemini` and still writes
  the global `config/projects/default-cli-project.json`.
- Whether the keyring login works on a Linux server (no macOS keyring) was not probed; see Q2.

**Where hooks are read from** (evidence: the startup log line `hooks_manager: loaded N named
hooks from M hooks.json file(s)`, and `agy -p "/hooks"`, which lists each hook's source file):

| Location                           | Result                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `<dir>/config/hooks.json`          | loaded                                                                       |
| `<dir>/antigravity-cli/hooks.json` | also loaded                                                                  |
| `<workspace>/.agents/hooks.json`   | loaded when a conversation starts, and in print mode even if not yet trusted |

A member's agent can write its own workspace `hooks.json`; a global `deny` beat a workspace
`allow`, and on a name clash `/hooks` listed the global one. So the gate lives in the
`--gemini_dir`, which the member's session does not write.

**`hooks.json` format.** The top-level key is the hook _name_. `PreToolUse` and `PostToolUse`
need a `matcher` wrapper (`"matcher": ""` matches all); `PreInvocation`, `PostInvocation` and
`Stop` are flat lists. Handlers run through `sh -c` with the cwd set to the folder that holds
`hooks.json`. Sample: `config/hooks.capture.json`.

**MCP.** `config/mcp_config.http.json`:
`{"mcpServers":{"probe":{"url":"http://127.0.0.1:47123/mcp","headers":{"Authorization":"Bearer <token>"}}}}`.
The static headers go on every request. agy connects at **every** start, even for `agy models`:
`POST server/discover`, `POST initialize` (clientInfo `antigravity-client`), `GET` for SSE,
`notifications/initialized`, two `/.well-known/oauth-protected-resource` probes, `tools/list`
(`mcp/client-handshake.sample.jsonl`). The model calls every MCP tool through one built-in tool,
`call_mcp_tool{ServerName,ToolName,Arguments}`.

**Trust.** In the TUI an untrusted workspace asks "Do you trust the contents of this project?"
(`screens/trust-folder.txt`); Yes adds the exact path to `trustedWorkspaces` in
`<dir>/antigravity-cli/settings.json` (`config/settings.json`). Print mode never asks. Pre-seed
`trustedWorkspaces` to skip the dialog. _Not verified:_ whether a trusted parent covers its
children.

### Q2. Login detection

| Check                                | Logged in             | Logged out                                                                                                                                 |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `agy models`                         | exit 0, TSV on stdout | exit 1, empty stdout, stderr `Error: Please sign in to view available models. Launch the CLI without arguments to sign in.`                |
| `agy -p "<anything>"`                | normal                | does not exit; stderr `Authentication required. Please visit the URL to log in: https://accounts.google.com/...` and it tries `open <url>` |
| `-p ... --output-format stream-json` | normal events         | after the timeout `{"event":"result","result":{"status":"ERROR","error":"authentication failed or timed out"}}`                            |

- **Machine check: the exit code of `agy models`.** Always wrap `-p` in a timeout.
- The login _mode_ shows only in the CLI log (`authMethod=consumer`) and in the TUI header
  (`screens/ready.txt`: account line, plan `Google AI Pro`). There is no machine-readable status
  command like `claude auth status`.
- Login screen: `Select login method:` with `1. Google OAuth` and `2. Use a Google Cloud
project` (`screens/login-method.txt`). It prints an OAuth URL; the redirect is
  `https://antigravity.google/oauth-callback`.
- The legacy gemini-cli files in `~/.gemini` (`oauth_creds.json`, ...) are not used by agy.
- _Not tested:_ a real sign-in, and handing the code back on a headless server. The expected
  step on the UI is: start `agy` on the server in a PTY and choose the Google account (as for
  the Claude and Codex logins, see Login and plan usage).

Samples: `quota-login/loggedout-*.{err,exit,out}`.

### Q3. Models

`agy models` prints `slug<TAB>display name` (`quota-login/agy-models.tsv`; the first line may
repeat the default):

- `gemini-3.8-flash-{high,medium,low}`, `gemini-3.7-flash-*`, `gemini-3.6-flash-*`,
  `gemini-3.1-pro-{high,low}`;
- `claude-opus-5-5-{low,medium,high}`, `claude-sonnet-5-5-{low,medium,high}`,
  `gpt-oss-120b-medium`.

Only the Gemini slugs start with `gemini`; the Claude and GPT-OSS models are in a separate quota
group. The output has no default flag and no `--effort` column: the **effort is the slug
suffix**, and `--model <family> --effort X` resolves to `<family>-X`. Without `--model` the run
used `gemini-3.8-flash-high`. `-p "/model" --output-format stream-json` returns
`{"id","label","effort","is_default"}` (`print-mode/slash-model.tsv`). Errors
(`print-mode/effort-resolution.txt`): a full slug plus a different `--effort` gives
`conflicts with --effort=high`; an effort the family lacks gives `gemini-3.1-pro has no
"medium" effort (available: low, high)`; `xhigh` and `max` are not accepted for flash; an
unknown model gives `model bogus-model is not recognized`.

### Q4. Hooks

Real stdin payloads are in `hooks/stdin/`, stdout answers in `hooks/stdout/`.

**Fields.** Common: `conversationId`, `workspacePaths`, `transcriptPath` (it points at
`transcript_full.jsonl`), `artifactDirectoryPath`, `modelName`. `PreInvocation` and
`PostInvocation` add `invocationNum`, `initialNumSteps`. `PreToolUse` adds `stepIdx` (equal to
the transcript `step_index` of the tool result step) and `toolCall{name,args}`; `PostToolUse`
the same plus `error` (`""` on success; the tool output is **not** included). `Stop` adds
`executionNum`, `terminationReason` (observed `NO_TOOL_CALL`), `error`, `fullyIdle`.

**Tools observed** (the args also carry the UI strings `toolAction` and `toolSummary`):
`view_file{AbsolutePath}`, `write_to_file{TargetFile,CodeContent,Overwrite,Description}`,
`run_command{CommandLine,Cwd,WaitMsBeforeAsync}`, `call_mcp_tool{ServerName,ToolName,Arguments}`,
`read_url_content{Url}`. Edit-in-place and browser tools (`browser_*`) were not exercised (no
browser session).

**Answers.** `PreToolUse` prints `{"decision":"allow|deny|ask|force_ask","reason":"..."}`
(`hooks/stdout/observed-PreToolUse.*.json`); the other events print `{}` or, for
`PreInvocation`, `{"injectSteps":[{"ephemeralMessage":"..."}]}`.

| Test                                                | Result                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `deny` (even with `--dangerously-skip-permissions`) | `tool call denied by pre-tool hook: <reason>`; no PostToolUse; the model repeats the reason       |
| `ask`, headless                                     | auto-denied: `permission check failed ... user denied permission`; `denied_actions` in the result |
| `ask`, TUI                                          | dialog with a `Reason:` line; key `4` declines, key `1` runs                                      |
| `allow`, TUI, `request-review`                      | the built-in dialog still appears                                                                 |
| `always-proceed` + `allow`                          | runs, no prompt                                                                                   |
| `always-proceed` + `ask` / `force_ask`              | ignored; the command ran                                                                          |
| `always-proceed` + `deny`                           | denied                                                                                            |
| timeout 2 s, handler sleeps 5 s                     | `JSON hook "..." failed: command failed: signal: killed`; the tool did **not** run (fail-closed)  |
| timeout 3600, handler sleeps 100 s                  | worked; the step took 100.73 s                                                                    |
| global `deny` + workspace `allow`                   | denied                                                                                            |
| workspace-only `deny`                               | denied                                                                                            |

- `PreToolUse` also fires for MCP calls (as `call_mcp_tool`), in the TUI and in print mode.
- The timeout is a field of the handler (`timeout`, default 30 s); 3600 was accepted. Waits
  beyond about 100 s were not tried.
- **Consequence:** with `toolPermission: always-proceed` the hook alone decides; `ask` cannot be
  used for an inbox question there. The inbox question is answered inside the blocking hook.
- _Not tested_ (documented examples only, `hooks/stdout/documented-*`): `overwrite` (argument
  rewrite), `PostInvocation.terminationBehavior`, `Stop` with `decision: "continue"`, the
  `userMessage` and `toolCall` inject steps.
- There is no `UserPromptSubmit` or `PermissionRequest` hook.

### Q5. Screens in the PTY

Captured with a Python pty driver and a VT emulator at 120x40, `TERM=xterm-256color`, an `open`
stub first in `PATH`. The TUI uses the alternate screen, bracketed paste and the kitty keyboard
protocol; it queries OSC 11 and needs no reply.

| State             | What is on screen (sample)                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ready             | prompt box `>` between `────` rules; footer `? for shortcuts` left, `Gemini 3.8 Flash · low` right (`screens/ready.txt`)                                                                                                       |
| Working           | braille spinner and `Generating...`; footer `esc to cancel` (`screens/working-generating.txt`)                                                                                                                                 |
| Permission dialog | `Run this command?` with `1. Yes, run command`, `2. Yes, and always allow in this conversation ...`, `3. ... (Persist to settings.json)`, `4. No, cancel`; a `Reason:` line when a hook asked (`screens/permission-ask-*.txt`) |
| Tool declined     | `screens/tool-declined.txt`                                                                                                                                                                                                    |
| Trust             | `Do you trust the contents of this project?` / `Yes, I trust this folder` / `No, exit`                                                                                                                                         |
| Login             | `Select login method:`                                                                                                                                                                                                         |
| First run         | `Choose your color scheme:`, then `Terms of Service & Data Use` with a checked consent box and `[Previous]  [Done]` (`screens/onboarding-*.txt`)                                                                               |

**Pitfalls.** A transient "Welcome ... You are currently not signed in." and "Signing in..."
appears in the first frame even when logged in; do not read it as logged out (the later frames
show the account). An announcement card ("... esc to dismiss",
`screens/ready-with-announcement-banner.txt`) can sit above the prompt; `Esc` on an empty
prompt dismisses it.

**Input.** `write("text\r")` submits. A bracketed paste of two lines does **not** submit
(`screens/prompt-multiline-paste.txt`), so a pasted brief needs a separate Enter. Ctrl-J,
Alt-Enter and Shift-Enter (`ESC[13;2u`) insert a newline. In the permission dialog a digit acts
at once, without Enter.

_Not seen:_ an update screen (updates run in the background), an out-of-quota screen,
cancelling a turn.

### Q6. Resume

`--conversation <id>` works in print mode and in the TUI: the id is echoed, step indices
continue, the TUI replays the history (`print-mode/resume-conversation.ndjson`,
`screens/resumed-conversation.txt`). The `conversationId` first appears

- in print mode: in the first stream event `{"event":"init","conversation_id":...}`;
- in the TUI: in the first `PreInvocation` hook payload, which also creates
  `antigravity-cli/brain/<id>/`.

`cache/last_conversations.json` maps a workspace to its last id. So, like Codex, the id is
learned from the first hook rather than set by us. _Not tested:_ `--continue`, and
`--input-format stream-json` (multi-turn over stdin, a possible alternative to scraping the PTY).

### Q7. Transcript

`<gemini_dir>/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`, one JSON
object per line (`transcript/`):

- **Fields:** `step_index`, `source` (`USER_EXPLICIT`, `MODEL`, `SYSTEM_SDK`), `type`
  (`USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC` for tool results, `EPHEMERAL_MESSAGE`), `status`,
  `created_at`, `content`; model lines add `tool_calls[{name,args}]`.
- **Tokens: yes.** `PLANNER_RESPONSE` lines carry `input_tokens`, `cache_read_tokens` and
  `output_tokens` (including thinking). A trivial prompt costs about 12k input tokens.
- **Two variants:** `transcript.jsonl` holds the tool args as JSON-encoded strings;
  `transcript_full.jsonl` (the hooks' `transcriptPath`) holds native JSON and adds `thinking`.
- `-p ... --output-format stream-json` reports `usage{input_tokens,output_tokens,thinking_tokens,
cache_read_tokens,total_tokens}` per step and in the result (`print-mode/ok.ndjson`).
- Tool names are the lower-case step types: `run_command`, `view_file`, `write_to_file`,
  `call_mcp_tool`, `read_url_content`, `browser_*`.
- `conversations/<id>.db` (SQLite) sits beside; the transcript is the simpler source.

### Q8. `--sandbox` and `--mode`

`--sandbox` alone does not auto-approve commands; that needs `toolPermission:
"proceed-in-sandbox"`. Presets: `request-review` (default), `proceed-in-sandbox`,
`always-proceed`, `strict`. Probe results (`sandbox/result-under-agy-sandbox.txt`,
`sandbox/sandbox-test.sh`):

| Probe                                | Without sandbox | With `--sandbox`                                                                                                                     |
| ------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| read outside the workspace/add-dir   | OK              | FAIL (`Operation not permitted`)                                                                                                     |
| read inside an `--add-dir`           | OK              | OK                                                                                                                                   |
| write to the workspace               | OK              | FAIL (the workspace was under `/private/tmp`; may be location-related, not retested)                                                 |
| write to an `--add-dir`              | OK              | FAIL                                                                                                                                 |
| write to `/tmp`                      | OK              | OK                                                                                                                                   |
| read `~/.gemini`                     | OK              | FAIL                                                                                                                                 |
| network (`curl https://example.com`) | OK              | FAIL                                                                                                                                 |
| `ps -A`                              | 532 processes   | 0 visible                                                                                                                            |
| environment                          | 59 variables    | the full parent env plus 10 `ANTIGRAVITY_*` (`ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CONVERSATION_ID`, ...) |

Under `--sandbox` commands still get the **full** parent environment plus ten `ANTIGRAVITY_*`
variables that agy adds itself, among them `ANTIGRAVITY_CSRF_TOKEN`. The runner strips billing
variables before the start (`BILLING_ENV_VARS`) but cannot remove what agy adds; whether the
unsandboxed run sees the same variables was not compared, and the adapter should treat the
CSRF token as visible to every command. `--mode` accepts `accept-edits` and `plan`; other values warn and the run
continues (the log shows `applying agent mode plan`). Its effect on prompts was not exercised.

### Q9. Writes under the gemini dir

Everything follows `--gemini_dir` (`config/gemini_dir.tree.txt`): conversations
(`antigravity-cli/brain/<id>/`, `conversations/<id>.db`), indexes and state
(`conversation_summaries.db`, `jetbox_summaries_proto.pb`, `jetski_state.pbtxt`,
`history.jsonl`), `cache/{onboarding.json,last_conversations.json,...}`, `installation_id`,
`updater/`, `builtin/skills/`, `presence/`, `implicit/`, `annotations/`, `crashes/`, `mcp/`, and
`config/{hooks.json,mcp_config.json,projects/default-cli-project.json}`. `--log-file <path>`
redirects the CLI log.

**Auto-update.** Each start spawns a background updater, at most once per 15 minutes per gemini
dir, which can replace `~/.local/bin/agy`. The env vars `DISABLE_AUTO_UPDATE`,
`AGY_DISABLE_AUTO_UPDATE` and `ANTIGRAVITY_DISABLE_AUTO_UPDATE` had no effect. The hidden
`--release_base_url http://127.0.0.1:9` makes the update fail harmlessly ("Update failed, please
install from website"), which would pin the version.

**The owner's real `~/.gemini` changed in two places during the probe;** no credential file was
read or touched: `config/projects/default-cli-project.json` was rewritten (130 to 87 bytes) by
the one `--app_data_dir` test, and `antigravity-cli/cache/CHANGELOG.md` (133 KB release notes)
was created by `agy changelog` and is safe to delete.

### Q10. Out of quota

`-p "/usage"` and `-p "/quota"` cost no model turn. Output is tab-separated: group, window
`... Remaining`, percent, reset time (`print-mode/slash-usage.tsv`, `quota-login/usage.tsv`):

```
Gemini Models	Five Hour Limit Remaining	98%	2026-10-05T12:40:52Z
Claude and GPT models	Weekly Limit Remaining	100%	2026-10-12T07:57:13Z
```

Groups: "Gemini Models" and "Claude and GPT models", each with a weekly and a five-hour window.
`json` or `stream-json` output gives `groups[].buckets[]{id,name,window,remaining_fraction,
reset_time,description}` (`print-mode/slash-usage.json-and-stream-json.txt`). Other model-free
commands: `/model`, `/hooks`, `/permissions`, `/help`, `/config`, `/changelog`.

**Out-of-quota text was not reproduced** (it would burn quota). From release notes and binary
strings only: the CLI says "Your AI credits balance is too low to continue."; headless runs that
end on a model or agent error exit with code 3 and print `AGY_ERROR: {...}` JSON on stderr.

### Q11. Context and instructions

Setup: `AGENTS.md` (marker word PINEAPPLE), `GEMINI.md` (MANGO) and `CLAUDE.md` (KIWI) in the
workspace, plus a `PreInvocation` ephemeral message (ZEBRA). The answers ended with "PINEAPPLE
MANGO" and ZEBRA appeared in the thinking; KIWI never appeared. So **`AGENTS.md` and `GEMINI.md`
are read, `CLAUDE.md` is not**. Rule files are capped at 24 KB each, with a 20,000-token rules
budget. There is no system or developer prompt flag (`--agent <name>` exists, untested). A
`PreInvocation` hook can add `{"injectSteps":[{"ephemeralMessage":"..."}]}` and the model
followed it; the transcript stores it as `{"type":"EPHEMERAL_MESSAGE","source":"SYSTEM_SDK"}`
(`transcript/transcript_full.ephemeral-and-thinking.sample.jsonl`,
`print-mode/rules-and-ephemeral-injection.ndjson`). Role instructions can therefore go in the
workspace `AGENTS.md` or in a `PreInvocation` hook of the `--gemini_dir`; a global rules file
under `<gemini_dir>/config/` (a tamper-proof place) was not tested.

### Not tested

Temp `HOME` with the real keychain (blocked by the permission classifier); browser-tool hooks;
`--continue`; `--input-format stream-json`; `--mode` effect on prompts; global `config/AGENTS.md`;
stdio MCP; hook waits beyond about 100 s; the out-of-quota and update screens; a real sign-in
(credentials were off limits).

## Session policy

### Outbound network (PM-355)

Every AI member has an `outboundNetwork` setting (default ON for everyone, including members
saved before it existed; only the owner changes it). It becomes `SessionPolicy.network.outbound`
(`open` or `allowlist`), and `sandboxNetwork` in `session-policy.ts` turns that into the
sandbox's network rules.

- **Claude Code, ON:** `allowedDomains` is `['*']` and `deniedDomains` is `HARD_DENIED_HOSTS`
  (`localhost`, `127.0.0.1`). `strictAllowlist` stays true; the publishing deny rules and the
  unreadable credential paths are unchanged.
- **Claude Code, OFF:** `allowedDomains` is the npm registry only. Any other host is refused by
  the sandbox without asking anyone (decision 41).
- **Codex:** the setting is carried in the policy but not mapped yet: Codex stays without
  network whatever the setting is (PM-358).
- **Gemini (agy) and NanoGPT:** the setting does not take effect for them either, as for Codex:
  their adapters do not follow `network.outbound`, so the setting is only shown. The hint under
  the checkbox tells the user that other addresses are refused; a Gemini mapping needs its own
  card.
- **Managed VM:** the profile ignores the setting; its network rules are unchanged.

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
- Codex: the local permission profile reads attachments through `:root=read` while denying
  sensitive paths (PM-356); the attachment directory is never a writable root.
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
| Protected start (PM-49) | `--setting-sources user` (project settings and `.mcp.json` are left out); `--strict-mcp-config` and `--no-chrome` are on every Claude session (PM-208)             | every hook event and the team server are `-c` overrides; the VM's own files are inspected (below) |
| Hooks                   | kept (HTTP hooks, SessionStart through the forwarder): the state of the session is followed as before                                                              | kept (command hooks through the forwarder)                                                        |

A `PermissionRequest` that reaches a managed VM session anyway is **not** shown to a human and not
judged by the command rules (`commandVerdict` is the legacy path's): the runner (and, one step
further, the inbox's broker) refuses it at once with the way forward (`MANAGED_VM_NO_LOCAL_APPROVAL`),
and the session carries on. A question for a person at the terminal (`AskUserQuestion`,
`request_user_input`) is not a permission and is handled as in every profile (below). The context pack leaves out the
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

Admission checks the login too (PM-324), after the AI limit and before the plan usage: an
automatic start of a member whose provider is not logged in waits with the reason
`provider_not_logged_in` (the card shows the provider) and starts on the next retry (every 30
seconds) once the login is there; a person's start gets the 409. A provider whose login cannot be
checked (`loggedIn: null`, or the check failing) holds nothing back. The status carries a `problem`
(`not_logged_in`, `no_key`, `cli_too_old`, `cli_missing`) with `loggedIn: false`, and optionally the CLI's
`cliVersion` and `minCliVersion`. Only the providers with a measurable plan (`PLAN_USAGE_PROVIDERS`: Claude and
Codex) have a plan-usage pause and a usage gauge.

Plan usage is per provider: Claude's from Claude Code's usage probe, ChatGPT's from the rate
limits Codex records in its transcripts (nothing is spent to read either). New AI work pauses
above `pauseAbovePlanUsagePercent` of the plan of the member's own provider.

### Token usage of sessions (PM-178)

The runner reads what each session used from its transcript as it grows and emits `usage`
events: increments per model and scope (`main`, or `subagent`), each with uncached input, output,
cache reads and cache writes. The domain adds them to `token_usage` (one row per session, hour,
model and scope); a session carries its sum (`Session.usage`, absent for sessions from before the
measurement: "no data"), the task drawer adds up the card's sessions, and a member's profile shows
the last 24 hours and 7 days (by the hour).

- Claude Code: an API response is written as several entries with the same `message.id`; it is
  counted once, and a later, larger `output_tokens` adds the difference (early entries may carry a
  placeholder). API error entries and the `<synthetic>` model are skipped. A subagent's
  conversation is in its own file, which the `SubagentStop` hook names (`agent_transcript_path`):
  it is read whole then, inside the worker home for a managed VM session. A subagent still running
  when the session ends is not counted. Sidechain entries in the main transcript (older versions)
  count as subagent usage.
- Codex: the difference of `total_token_usage` from the previous `token_count` counts (a repeated
  event adds nothing); without a previous one (the first event, or after a resume, which is
  followed from the end of the file) `last_token_usage` does. `cached_input_tokens` is part of
  Codex's `input_tokens`: it is moved to cache reads. The model comes from `turn_context`. Where
  Codex keeps its subagents' conversations is not known yet: the UI says their usage has no data.
- The counts compare sessions and models; the plan limits are not given in tokens.

### Measuring a card (PM-222)

`countCardRounds` (`packages/shared/src/domain/card-measure.ts`) counts from a card's timeline the
review rounds (entries into a code review stage: a `step` stage whose own duty, or its owners'
duty, is `code_review`), the reviews that asked for changes (`code-review-changes` added) and the
send-backs (a move into a `work` stage from a later stage; a manual move and a failed merge count
too). Stage kinds come from the configuration, not from names; old events count the same way. The
card's detail carries the counts (`TaskDetail.rounds`, not for clients) and the drawer shows them
with the weighted tokens per model (`limitTokens`: cache reads at a tenth).

`GET /api/projects/:key/measure/closed-cards?days=14` lists the cards done in the period (not the
cancelled ones) for every non-client member: the implementer (the assignee when it closed, else the
member that used the most), the models of the implementer's own conversations, the weighted tokens
in total and per model, the rounds, and how many sessions were not measured (from before PM-178).
The model comes from the sessions' usage rows, not from the member's setting today. The Team page
shows it, sortable by weighted tokens and review rounds.

The runner strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CODEX_API_KEY`, `OPENAI_API_KEY` and
common OpenAI/Azure endpoint overrides from every session's environment. For the Gemini
(Antigravity CLI) and NanoGPT providers (PM-319, PM-324) it also strips `GEMINI_API_KEY`,
`GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_GENAI_USE_VERTEXAI`,
`GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`,
`GOOGLE_CLOUD_LOCATION`, `AGY_ADC_AUTH`, `AGY_BUSINESS_PAYGO_TIER` and `NANOGPT_API_KEY`, and the
markers of a parent Gemini session (`GEMINI_CLI`, `ANTIGRAVITY_*`). The list is the same for every
provider. The NanoGPT key reaches only the sessions of NanoGPT members, handed back by the NanoGPT
adapter as a trusted `extra` of the child environment.

The file tools and the shell's sandbox also refuse `~/.gemini` and, in the app home, `secrets`
(the secret store) and `providers` (the providers' own CLI homes, such as the NanoGPT Codex home),
next to the other credentials (`sensitivePaths`).

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
and no real agent CLI. The PM-356 native run was recorded on 2026-10-06 by the integrator
with owner approval: Codex 0.159.1 on macOS 14.6 arm64. It verified denied shell reads,
database glob matches (including later siblings), symlink traversal, read-only/writing modes,
own TMPDIR writes and shared temp denials. `view_image` respected a denied image symlink.
No `:workspace` fallback or `features.shell_snapshot=false` was needed. The CLI's standalone
installation required a read exception beneath its otherwise denied Codex home; inline
`projects={...}` trust and `check_for_update_on_startup=false` prevented startup dialogs.
Five plugin flags and named user MCP disabling were exercised; the three additional
computer/browser flags still require the agreed supplementary startup acceptance.

| CLI / OS / policy                                                           | Shell file boundary                                         | Built-in file tools  | Own git / protected shared git                                                     | Network / test servers                                            | Strict minimum                         |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| Claude 2.1.223 / macOS                                                      | Unverified                                                  | Unverified           | Unverified                                                                         | Unverified                                                        | Not established                        |
| Claude 2.1.284 / macOS 14.6 arm64 / old probe settings                      | Reported sibling-folder denial; nested exception unverified | Unverified           | Reported commit allowed, hooks/config blocked; other protected metadata unverified | Reported npm allowed; local binding also opened other local ports | Not established; local-port conflict   |
| Codex 0.159.1 / macOS 14.6 arm64 / legacy settings plus writable shared git | Reported broad reads, limited writes                        | Unverified           | Reported index lock blocked but hooks/config writable                              | Reported network/binding blocked; npm used warm cache             | Fails the strict policy as configured  |
| Codex 0.159.1 / macOS 14.6 arm64 / restricted-read permission profile       | Denied secrets, credentials, database glob and symlinks     | Denied image symlink | Worktree edits allowed; shared index lock and protected directories denied         | Not verified by the PM-356 run                                    | Not established; PM-356 deny list only |
| Claude 2.1.223 and 2.1.284 / Linux                                          | Unverified                                                  | Unverified           | Unverified                                                                         | Unverified                                                        | Not established                        |
| Codex 0.159.1 / Linux                                                       | Unverified                                                  | Unverified           | Unverified                                                                         | Unverified                                                        | Not established                        |
| Any later proposed release / macOS or Linux                                 | Repeat full procedure                                       | Repeat               | Repeat                                                                             | Repeat                                                            | No inferred support                    |

The old settings used Claude `denyRead` for sibling live/secret folders, `allowWrite` for
`~/.npm`, strict npm-only networking and `allowLocalBinding: true`. The old report says boolean
`allowUnsandboxedCommands: false` worked where the string `"deny"` caused prompts; acceptance
and enforcement of either type remain version-specific observations to reproduce.

Current source differs from that probe: the developer sandbox allows npm/development-data writes
and local binding, and closes the home but its own work (PM-153). Codex's normal session spec
no longer grants the shared git root (PM-131). Its local permission profile now implements the
PM-356 sensitive-path deny list, while the wider home boundary remains PM-360.
Command-rule approval of Codex escalations is host execution,
not strict isolation. PM-134's transitional Claude setup is not the final PM-128/129 proof.

### The sandboxes the server hands out (PM-167)

`sessionSandbox(policy)` (`domain/session-policy.ts`) computes them per session from the actual
paths; `buildSandboxSettings` renders them, and `test/cli-sandbox.integration.test.ts` checks the
exact `--settings` the fake CLI receives:

| Session                                               | `filesystem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `network`                                   | `excludedCommands`                                             | `credentials.envVars` (`mode: "deny"`) and `env`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Extra deny rules                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Developer (`task_worktree`, PM-153, PM-193)           | `allowWrite`: the member's npm cache and development data (`<app home>/member-caches/<KEY>/<handle>/npm-cache`, `…/projectman-dev`) and the session folder (PM-268, a Claude session only); `denyRead`: the user's home, the app home (when not below it), `sensitivePaths`; `allowRead`: the worktree, the task's attachments, the member's two directories, the session folders' root (every member's folder of this instance is read, PM-333) and the browsers directory (PM-268), the shared git directory, `~/.gitconfig`, `~/.config/git`, `~/.claude/shell-snapshots`, the user's `core.excludesfile` (PM-216); `denyWrite`: see below | `registry.npmjs.org`, local binding allowed | none                                                           | `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `SSH_AUTH_SOCK` unset; `env`: `npm_config_cache`, `PROJECTMAN_HOME` to the member's directories, `PROJECTMAN_SESSION_DIR` and `PLAYWRIGHT_BROWSERS_PATH` (PM-268), `PROJECTMAN_SKIP_PTY_TESTS=1` (PM-194), `GIT_CONFIG_SYSTEM` to a read-only file in the member's directory with `gc.auto=0`, `maintenance.auto=false` and `core.packedRefsTimeout=0`; the "Unable to create packed-refs.lock" message after a commit stays (known, harmless, see SECURITY.md) (PM-216) | `Edit(//<path>)`, `Edit(//<path>/**)` per `denyWrite` |
| Reader (`read_only`, review copy without test opt-in) | `allowWrite`: the session folder (PM-268; else temp only); `denyWrite`: working directory, every `--add-dir` directory, the project's workspace, the app home, the server's own checkout; `denyRead`: `sensitivePaths`                                                                                                                                                                                                                                                                                                                                                                                                                        | `registry.npmjs.org`, local binding allowed | `gh pr view:*`, `gh pr diff:*`, only on a repository on GitHub | `env`: `PROJECTMAN_SKIP_PTY_TESTS=1` (PM-194), `PROJECTMAN_SESSION_DIR`, `PLAYWRIGHT_BROWSERS_PATH` (PM-268)                                                                                                                                                                                                                                                                                                                                                                                                                         | `Edit(//<path>)`, `Edit(//<path>/**)` per `denyWrite` |
| Managed VM profile, sessions behind the VM boundary   | none (the boundary is outside the CLI)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                             |                                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                       |
| Codex                                                 | local `projectman` permission profile: sensitive paths denied, portable writer roots granted (PM-356); managed VM unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |                                             |                                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                       |

All paths are absolute, from the actual user home and app home. A developer in a task worktree
gets `denyWrite` in the shared git directory (`sharedGitDenials`): `refs/heads/<default branch>`,
`HEAD`, `index`, `packed-refs` and each one's `.lock`, so git fails at the lock and leaves no
stale lock for the integrating session; and `refs/replace` (the directory) and `info/grafts`, with
which every local git command would see other content or history for the default branch without
the ref moving (`git replace <a blob of main> <another blob>` reaches the integrating checkout's
diff, merge and checkout). A member workspace (PM-138) is an independent clone with
its own `.git` in the working directory: no `gitDir`, no git `denyWrite`. An `allowRead` path
inside a `sensitivePaths` entry is left out; Claude Code 2.1.284's Seatbelt profile puts `allowRead`
after `denyRead` and denies the narrower `denyRead` paths again, so the credentials stay closed.

A developer writes nothing the host later runs or loads outside a sandbox (PM-193). Before
PM-193 its sandbox wrote the user's `~/.npm` (the host's `npx <package>` runs code from
`~/.npm/_npx`, unchecked) and `~/.projectman-dev` (the host's `npm run dev` loads its
configuration and database). Now the server makes `<app home>/member-caches/<KEY>/<handle>/`
with `npm-cache` and `projectman-dev`, the sandbox writes only those, and the session's `env`
(Claude Code's `env` setting, for the session and its commands) points `npm_config_cache` (npm and
`npx`) and `PROJECTMAN_HOME` (`npm run dev`, `npm start`) there. A member's cache is used only by
that member's sandboxed sessions; readers get none. Without an app home (only in tests) the
developer gets no writable directory outside its worktree and the temp directory.

**The session folder and the browsers (PM-268).** A Claude session in the legacy profile, a
writer or a reader, gets its own writable folder for what its commands produce (screenshots,
reports): `<tmp>/projectman-sessions/<hash of the app home>/<session id>.<random>`, outside every
checkout and the app home. The name is new at every start (a restart too), so a command of an
earlier run that outlived its process, with the old path in its sandbox, can neither use the new
folder nor put a link at its path. Only the server computes the path (`PROJECTMAN_SESSION_DIR` in
the session's `env`) and remembers which folder is the session's; it makes the folder (mode 0700,
exclusively: a path that exists is an error, then it checks a real directory of its own user)
before the process starts. It removes the folder when the process ends (an exit, a stop, a
restart, a failed start; the restart's new folder is made after the old one is removed): the
folder is renamed to a `.trash-<random>` name inside the root first, then removed, so the old
run's rule no longer reaches it while it is removed. The whole root is swept when the server
starts. A Codex session and the
managed VM profile get none. The sandbox writes only that folder; every session reads the other
members' folders of the same instance (PM-333, the owner's decision: a teammate names a
screenshot): the developer's `allowRead` holds the root, the reader reads everything anyway. Claude
Code's file tools, which are outside the sandbox, get `Read(//<root>/**)` and, for the own folder,
`Edit(//<dir>/**)`; the policy carries both paths (`filesystem.sessionFolder`,
`sessionFoldersRoot`) and the adapter renders the rules (`claudeToolRules`), since beside a policy
it drops the legacy allow list. No deny rule for the root: it would shut the own folder too. Another
instance's folders (another home hash) get no rule.
`attach_file` takes an absolute path inside the folder as well as one inside the working
directory (SECURITY.md has the checks). A folder inside a denied path, or inside a reader's
read-only checkout, is left out.

The browsers (`PROJECTMAN_BROWSERS_PATH`, default `<app home>/browsers`) are Playwright's
download directory, read-only for the sandbox: `PLAYWRIGHT_BROWSERS_PATH` points there, a
developer reads it, and a human installs the browsers on the host (`npm run browsers -- install`).
A directory that is the user's home, above it, or the app home or above it is not handed out.

Every one also has `enabled`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands: false`,
`failIfUnavailable` and `strictAllowlist`. A `denyWrite` path a rule cannot name as it is
refuses the start (a path rule takes letters of any script, an accented project path too, named
both composed and decomposed; PM-188). The temp directory is the sandbox's own `$TMPDIR`.

`excludedCommands` entries are rendered `<command>:*`: Claude Code 2.1.284 reads an entry
without `:*` or `*` as the exact command, so the bare `gh pr view` of PM-167 never matched
`gh pr view 1`. The same version leaves a command out of the sandbox only when every part of it
matches an entry and it holds no substitution and no redirection into a file (`2>&1` is fine),
so `gh pr view 1 && touch x`, `gh pr view 1 | cat` and `gh pr view 1 > x` run inside the sandbox
(read in the CLI's code, PM-188). The server gives the entries only for a repository on GitHub; on
a local-only one there is no pull request, and the reviewer reads the branch with git in the
developer's worktree (`--add-dir`).

**Manual run** (the PM-167 part of `SANDBOX-PROBE.md`), 2026-10-01 on the owner's Mac, live
instance at 06c519c: the reader ran in Auto inside the CLI's sandbox; writes and the reading of
credential files were refused, and no question reached the owner. `gh pr view 1`: **fail**, it ran
inside the sandbox and stopped on `open ~/.config/gh/config.yml: operation not permitted` (the
exact-command entry above; PM's repository is local-only besides, so it has no pull request to
read). `npx prettier --write`: **unverified** there, the file was already formatted; repeated in
PM-188 (Claude Code 2.1.284, macOS 14.6) on an unformatted file in a directory the sandbox denies
writing inside an allowed root: `EPERM: operation not permitted`, the file unchanged (same
checksum), as for `touch`. Still to run on a repository on GitHub: `gh pr view <n>` alone (outside
the sandbox, no question), `gh pr view <n> && touch probe.txt` and `gh pr view <n> > probe.txt`
(inside the sandbox: no file appears).

**Manual run of PM-153 and PM-193** (the PM-153 part of `SANDBOX-PROBE.md`): pending; the owner
runs it after the change is live. Record its result here.

### Commands Claude Code asks about in the sandbox (PM-153)

`autoAllowBashIfSandboxed` does not cover every command. The PM-142 developer asked at 12:44 on
2026-10-01 (inbox `inb_mupj09dy200e8fe2a4`) for
`cd apps/server/src/domain && cat > /dev/null <<'EOF'` + an empty body + `EOF` + `grep -n …`; it was
the only one of its 84 shell commands that asked (transcript: one `PermissionRequest` hook
decision). In Claude Code 2.1.284 (read from its bundled source): the bash parser gives up on a
here-document whose body it did not see (an empty one: "Heredoc body was not scanned by the
parser"), as on an unquoted delimiter; for such a "too complex" command the only sandbox
auto-allow path returns nothing when the command contains `<<` (not `<<<`), so the command goes
the usual way and asks. A command the parser handles takes the other auto-allow path, which has no
such exception, and the same session's `cd <worktree> && pwd` ran without asking. So `cd` is not
the cause; a here-document the parser cannot follow is. The members now run in Auto, where such a
question goes to Auto's classifier instead of a human, so the 12:44 case does not reach the inbox
the same way any more; the context pack's "Your sandbox" section still tells a member to write
files with the editing tools and pass text as quoted arguments, which needs neither.

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
