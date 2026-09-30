# Roadmap

Where projectman stands, what comes next and what waits for the owner. Backlog cards
(`PM-nn`) live on the "PM" board of the owner's local projectman instance; this file names
them so that the plan and the board stay in step. Decisions already taken are in
[DECISIONS.md](DECISIONS.md).

Last reviewed: 2026-09-30 (a full review and clean-up of code and plan; see
[Technical debt](#technical-debt)).

## Built (v1)

- **Projects and configuration.** Four templates (web client project, small team, internal
  tool, daily routine); configuration as YAML in the customization repository with
  history and revert; a settings editor for the project, team, roles and duty matrix,
  pipeline, gates, labels and limits; access levels; colleagues as unclaimed seats with
  single-use invitations.
- **Work.** Board with columns, drag and drop stage moves, task drawer (editing, markdown,
  one level of subtasks, comments with @mentions, labels, links), cancel, reopen, reassign,
  import with original dates.
- **AI members.** Claude Code and Codex providers on subscriptions; a fresh session per work
  item with a context pack and durable memory; the team tools (MCP); a git worktree per task;
  per-duty session policies; stage hand-overs; message wake-ups; admission (master switch,
  concurrency, plan usage, capacity) with retries; temp workers; member schedules.
- **Humans in the loop.** Inbox for permissions, approvals and questions; team messages;
  member profiles; session chat and live terminal; phone layouts.
- **GitHub.** Read-only PR polling, the `pr-merged` label, label clearing on new commits,
  PR author attribution.
- **Operations.** `npm run demo` with fake CLIs, production build and smoke test, a deploy
  kit (systemd, Tailscale Serve), a security review ([SECURITY.md](SECURITY.md)).

## Now: projectman develops itself (PM-51)

Today Claude (in a Claude Code conversation) and Codex (in separate worktrees) develop
projectman, while the PM project in projectman only shows the cards with AI work switched off.
Moving the work into projectman is the best test of the product. The path:

1. **PM-72 — the live instance runs from its own directory. Done on 2026-09-30.** The
   owner's instance is a production build in a checkout of its own, updated only on the
   owner's approval, and `npm run dev` keeps its data elsewhere (decision 20; README, "Live
   instance next to development"). Merges no longer stop running AI sessions.
2. **Less permission friction. Done on 2026-09-30.** PM-75 lets developers work freely inside
   their worktree. **PM-77** finished it: the server allows a developer's routine git steps
   (`git add`, `git commit` with a message, `git merge --ff-only` onto the default branch) in
   the task's own worktree, and read-only commands inside the directories a session may read,
   which also covers PM-71 and the rest of PM-69. **PM-84**: Codex members never run in
   `bypassPermissions` mode. The limits of the text-based rules are in
   [SECURITY.md](SECURITY.md).
3. **Repositories without GitHub. Done on 2026-10-01.** **PM-67**: the developer commits on
   the task branch and tells the reviewer; the reviewer reviews the branch against its base;
   the owner merges. This replaces the temporary trial wording in members' instructions.
   **PM-68**: a task without a repo never runs in the workspace root. In a one-repo project it
   uses that repo's worktree (one rule, `effectiveRepo`); in a project with several repos a
   developer start is refused (`repo_required`) until a person chooses the repo. A task's repo
   can be set later: in the task drawer, through the REST `PATCH` or the `update_task` tool,
   and not while a session of the task runs.
4. **Session continuity. Done on 2026-10-01.** **PM-76**: a restarted task session gets a
   short "continue" message (or the message that woke it) as its first input, on the command
   line of `codex resume`, and the first SessionStart hook also makes a Codex session ready.
   **PM-81**: deferred starts are kept in SQLite and rebuilt when the server starts (nothing
   is inferred from task state). **PM-90**: while a project's AI switch is off, the retry
   timer leaves the starts that wait for it alone.
5. **Clear questions.** **PM-74**: `ask_human` questions start with one plain sentence, say
   what the member recommends and why, and describe each option by its consequence; the inbox
   marks the recommended option and folds away the details.
6. **Codex hook trust.** **PM-49**: document or limit `--dangerously-bypass-hook-trust`
   before Codex members work unattended.

Then the trial: check the Claude and Codex members' settings, switch AI work on for the PM
project and run a first task end to end.

## Next: the owner's UI requests

- **PM-73** — settings: per-item edit and delete buttons and a "+" button for labels,
  columns and stages, one change per save through the existing pipeline PATCH. The settings
  sections are now separate components, so the change stays local.
- **PM-78** — messages page grouped by member like a chat app, plus an "all messages" view
  for owners and admins with member and task filters.

## Operations

- **PM-45** — a long-running server: a Hetzner 8 GB VPS behind Tailscale (about 2 GB base
  plus 1–1.5 GB per concurrent AI developer). [DEPLOY.md](DEPLOY.md) is ready.
- **PM-46** — verify `X-Forwarded-Proto` behind Tailscale Serve from a phone (Secure cookies,
  origin checks); DEPLOY.md lists the curl checks.
- **PM-50** — remove the merged `codex*` and `agent-*` worktrees and branches (local chore).

## Phase 2: team rituals and bounded adaptation (PM-44)

The plan is [design/phase2.md](design/phase2.md), delivered in this order: meeting records
and a manual standup (PM-52); refinement, planning, retro and demo screens (PM-53); meeting
tools for AI members (PM-54); scheduled meetings (PM-55); the PM setup conversation (PM-56);
observations and retro follow-through (PM-57); "Rendszer", configuration changes within
limits (PM-58); browser notifications, then a PWA (PM-59); a shared queue for heavy commands
(PM-60). Eight owner decisions gate these steps (listed in the plan).

## Product and data

- **PM-47** — product name, then the rename in code. The owner's favourite is "Onboard"
  (AI members are taken on like colleagues); the name collides with existing products and
  packages, so the decision is still open.
- **PM-43** — bring over the remaining comments and closed tickets of a client project from
  ClickUp; waits for the ClickUp rate limit and runs locally.
- **PM-48** — decided: the whole history went to the public GitHub repository as it was.

## Technical debt

The 2026-09-30 review looked at every module; the clean-up that followed was merged into
`main` the same day (PM-89). What it changed, in short:

- **One place per rule.** Gate evaluation, label change planning, owner-only changes, member
  and stage lookups and the task key sequence moved into `packages/shared`; the server and the
  web's test fake both use them. One commit path for configuration writes (PUT, PATCH,
  revert) and one place for configuration migrations.
- **Domain.** Tasks split into CRUD, labels, stage moves and pull request records; one
  all-or-nothing task update for REST and `update_task`; one admission path for every
  automatic session start with one deferred-start store; one send path for team messages;
  typed domain events instead of late-bound callbacks; units of work (SQLite transactions
  with events published after commit); the provider stored on each session; error codes typed
  against one shared list.
- **Runner and prompts.** Claude code under `providers/claude` like Codex; the session split
  into an input queue and a permission gate with fast unit tests; shared transcript and fake
  CLI code; each rule for AI members stated once, in the wording of labels and duties.
- **Web.** The removed `VITE_MOCK` mode; large components split (settings sections, pipeline
  editor, session page, team page, task drawer); design tokens; translations checked against
  the shared issue and error codes.
- **Bugs fixed on the way.** A retire with hand-over wrote a false "unassigned" event;
  `update_task` could half-apply; REST and MCP updates applied labels and moves in different
  orders; configuration revert skipped the "stage in use" check; `HOST=::1` broke hooks and
  MCP; successful logins used up the shared login limit; label changes were missing from the
  kick-off brief; `get_task` listed labels twice; role overrides were ignored when finding
  prioritisers and release contacts; the label picker offered release approvals the server
  refuses; reloaded chats showed absolute paths.

Still open, roughly by value:

- **Storage.** Message receipts are a JSON blob scanned in JavaScript on every session start;
  a `team_message_recipients` table would fix that (PM-88). The legacy `tasks.checks` column
  is converted to labels on every read (PM-86).
- **Providers.** The context pack still branches on provider, and the session policy is
  written in Claude Code's rule syntax that Codex parses back; a provider-neutral policy
  (team tools, read-only commands, denied operations, readable and writable directories)
  rendered by each adapter would remove that (PM-87). Codex does not enforce denied tools;
  PM-84 takes away the one mode where nothing else stops it.
- **Tests.** Every domain test builds a full domain with a git-backed configuration store;
  the pure parts (admission checks, label planning) now have fast unit tests, the rest could
  follow. The PTY integration tests of the runner are the slowest part of the suite.

## Open questions for the owner

From the backlog: the eight phase 2 questions ([design/phase2.md](design/phase2.md)) and the
product name (PM-47).

The fifteen questions of the 2026-09-30 review were answered by the owner the same day: every
recommendation was accepted (decision 19). The work they call for is on the board:

| Question                                                  | Outcome                           |
| --------------------------------------------------------- | --------------------------------- |
| 1. What clients see                                       | PM-79                             |
| 2. Capacity counts only current work                      | PM-80                             |
| 3. A human's chat resumes a session past the limits       | kept as is: a deliberate override |
| 4. Deferred starts survive a restart                      | PM-81                             |
| 5. Stage-owner notices are recorded                       | PM-82                             |
| 6, 7, 9, 11, 15. Unused fields and code, names, old forms | PM-86                             |
| 8. Release approval needs the release approval duty       | PM-83                             |
| 10. No `bypassPermissions` mode for Codex                 | PM-84                             |
| 12. Pushing `main`                                        | decision 21                       |
| 13. Duties decide who hears what                          | kept as is                        |
| 14. Duplicate repository names and column ids             | PM-85                             |
