# Decisions

Agreed with the owner on 2026-09-29, while designing the first version.

1. **Run on the owner's Claude subscription, never on API billing.** Interactive Claude
   Code in a PTY instead of the Agent SDK / `claude -p`: Anthropic announced (then paused)
   moving SDK and `-p` usage to a separate monthly credit; interactive use was unaffected.
2. **Colleagues use their own Claude accounts.** Plan credentials are for individual use,
   and apps may not collect Claude credentials. For now everything runs on the owner's
   subscription; others join with their own login later.
3. **One team of humans and AI members.** Same roster, statuses and messages. Every
   pipeline stage has owners: a human, an AI or both. Every AI member shows whose
   subscription it runs on.
4. **Members have unique handles.** Developer sessions are capped by the hired developers'
   capacity. Optional temp workers ("beugró") for one task each.
5. **Fresh session per work item** for every AI member (developers and standing roles),
   with persistent identity and memory; follow-ups resume the same session. A context
   pack gives each new session the right context.
6. **Configurable pipeline.** For the first team (a client web project) the order is code review → integration →
   QA → client test → merge → release: bad code is not worth deploying.
7. **Gatekeeping can be delegated** (release and other approvals) to other humans; an AI
   never approves; changing the release approvers is owner-only.
8. **Customizations live in a separate git repository** (independent from the app
   source): every change is a commit; the main admin can revert.
9. **Our own database is the source of truth for tasks.** GitHub Projects would constrain
   the model (mixed team, gates, visibility, meetings, observations), clients would need
   GitHub accounts, and a local app gets no webhooks. GitHub is used for PRs, reviews,
   checks, merges and releases; issue creation and project mirroring come later.
10. **English source code; Hungarian UI** through locale files.
11. **Self-shaping within limits (later phase).** A system agent may change configuration
    only through a fixed list of typed operations; invariants always hold; only the owner
    widens the limits.
12. **Project manager (later phase)**: an optional member (human or AI). An intake
    conversation sets up the working mode and rituals. It proposes; humans prioritise.
13. **Feedback loop (later phase)**: anyone (optionally AI members, evidence-based) can file
    observations; the retro turns them into configuration changes, tasks or nothing.
14. **Role catalogue.** Roles are responsibilities, separate from a human's access level. An
    AI member holds exactly one role; a human may hold several. 20 built-in roles (operator
    and product owner are human-only, the watchdog is AI-only) plus custom roles the team
    defines in its configuration. "Daily worker" is a schedule any AI member can have, not a
    role. The project manager (scheduling: standups, planning, deadlines, reminders, weekly
    report) and the coach (retros, role and process improvement) are separate roles; the
    watchdog's monitoring and the coach's retro come in a later phase.
15. **OpenAI Codex CLI as a second provider, through its interactive TUI and hooks, on the
    subscription only.** Each AI member runs in Claude Code or Codex (default Claude Code),
    on its sponsor's plan: Codex members use the owner's ChatGPT login. Codex runs like
    Claude Code: the interactive TUI in a PTY, not `codex exec` or the app server (whose
    docs rule out app-server authentication for commercial or hosted services), so the
    terminal view, the chat and the inbox approvals work the same. Command hooks forward
    every event to the runner, and the PermissionRequest hook answers approvals from the
    inbox. Every setting is a per-process `-c` override; nothing is written to `~/.codex`.
    The runner strips `CODEX_API_KEY` and `OPENAI_API_KEY` from every session, and refuses
    to start a session whose provider is not logged in with a subscription (an API-key
    login counts as not logged in). **Plan usage is per provider**: Claude's from Claude
    Code's usage probe, ChatGPT's from the rate limits Codex records in its transcripts
    (nothing is spent to read either), and new work pauses on the plan of the member's own
    provider.
