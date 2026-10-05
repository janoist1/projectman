# Decisions

What the owner decided and why, numbered and append-only. Decisions 1–13 were agreed on
2026-09-29 while designing the first version; the later ones carry their own dates. When a
later decision refines or replaces an earlier one, the earlier text stays and gets a note.
Open questions waiting for the owner are listed in [ROADMAP.md](ROADMAP.md).

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
   capacity. Optional temp workers ("beugró") for one task each. _Refined by 16: capacity
   counts the holders of the stage's duty, and the temp workers' role is configurable._
5. **Fresh session per work item** for every AI member (developers and standing roles),
   with persistent identity and memory; follow-ups resume the same session. A context
   pack gives each new session the right context.
6. **Configurable pipeline.** For the first team (a client web project) the order is code review → integration →
   QA → client test → merge → release: bad code is not worth deploying.
7. **Gatekeeping can be delegated** (release and other approvals) to other humans; an AI
   never approves; changing the release approvers is owner-only. _Refined by 16 and 17:
   approvals are labels only humans may set; release approval is a duty. Decision 26 keeps
   this unchanged for gates and releases and adds a separate kind of request, to leave the
   machine._
8. **Customizations live in a separate git repository** (independent from the app
   source): every change is a commit; the main admin can revert.
9. **Our own database is the source of truth for tasks.** GitHub Projects would constrain
   the model (mixed team, gates, visibility, meetings, observations), clients would need
   GitHub accounts, and a local app gets no webhooks. GitHub is used for PRs, reviews,
   checks, merges and releases; issue creation and project mirroring come later.
10. **English source code; Hungarian UI** through locale files.
11. **Self-shaping within limits (later phase, "Rendszer" in `design/phase2.md`).** A system agent may change configuration
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
    watchdog's monitoring and the coach's retro come in a later phase. _Partly superseded by
    16: who may hold a role and what an AI holder is told now come from its duties._
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
16. **Roles are configurable bundles of fixed duties.** Approved by the owner on 2026-09-30.
    Duties, rather than role names, determine who owns stages, who may approve gates and
    which prompt fragments and session tools an AI receives. Teams may change built-in
    bundles and create custom roles, but cannot invent duties or configure away invariants.
    Holder eligibility is the intersection of duty eligibility; humans union their roles.
    Release approval and final decision are human-only. AI never approves; assignees and
    PR authors never submit their own code/security/QA results. Optional release four eyes
    requires an independent human. Release approval grants and removals are owner-only,
    whether made through a gate, bundle or membership change. Missing pipeline dependencies
    are errors; missing recommended duties are warnings. Existing explicit member lists and
    old custom-role YAML continue loading, with in-memory duty defaults. This supersedes
    decision 14's hard-coded holder restrictions and prompt responsibilities. Meetings and
    monitoring execution remain future work; their attachment metadata is already defined.
    _Decision 26 leaves the duties, gates and human-only approvals as they are; a duty for the
    leader's part in exit requests is an addition (PM-139)._
17. **Meaningful labels replace checks and gate condition types.** Approved by the owner on
    2026-09-30 (`docs/design/labels.md`). The fixed checks (code review, security review,
    QA, client test with five states) and the three gate condition types mirrored one kind
    of team. A project now defines its labels once, with a meaning that humans and AI
    members read and rules the server enforces (who may set, no self-review, comment
    required, auto-clear, blocking). Gates only say which labels must or must not be on the
    task; comments carry the reasons. Approvals are labels only humans may set, requested in
    the inbox; the GitHub integration keeps the `pr-merged` system label. A failing label
    notifies the assignee but does not move the task back. Plain labels without a meaning
    stay allowed and are offered for definition in settings. Simplifying stage kinds to
    queue / work / check / release / done was deferred to decision 18.
18. **Five stage kinds; the duty says what a step is.** Agreed with the owner as the second
    step of decision 17, built on 2026-09-30. Once checks were labels, the kinds `review`,
    `deploy`, `test`, `client_test` and `merge` differed only in name, and the pipeline editor
    offered nine kinds where four behave differently. Kinds are now `queue`, `work`, `step`,
    `release` and `done`: a `step` stage's owners do one thing and record the result with a
    label, and the stage's duty says what (code review, deployment, testing, client
    communication, final decision); AI instructions follow the duty. The kind is called
    `step` rather than the proposal's `check` so it is not mistaken for the removed checks.
    Configurations with the old kind names still load: they read as `step`.
19. **The owner's answers to the review questions.** The 2026-09-30 code review left 15
    questions (`ROADMAP.md`); the owner accepted every recommendation the same day:
    - Clients: one visibility rule for REST and the websocket. Clients see progress (stage
      moves) and messages addressed to them, not internal labels, check events or member
      statuses.
    - Capacity counts only the work a member is doing now, not finished sessions on open
      tasks.
    - A human writing to a stopped AI session resumes it past the concurrency, plan-usage and
      capacity limits; only the master switch stops it.
    - Deferred starts are rebuilt from SQLite when the server starts.
    - Stage-owner notices typed into sessions are recorded where people can see them.
    - Release approval needs the release approval duty; a label any human may set does not
      pass a release gate.
    - Codex members cannot run in `bypassPermissions` mode; routine steps in their own
      worktree are allowed by the server's command rule (PM-77). _Differs only in the
      managed VM profile (decision 26), and only once its boundary is verified (PM-141); the
      legacy profile keeps this rule._
    - Watchdog alerts, prioritisation questions and release news follow duties
      (`monitoring`, `prioritization`, `client_communication`), not role names.
    - The invariants refuse duplicate repository names and column ids.
    - Clean-up: remove the unused fields, GitHub helpers and `PUT /config`; rename the
      misleading names with a migration; rewrite legacy configuration and check formats once
      and drop the converters. Reverting to a configuration from before labels need not work.
20. **The live instance runs apart from development (PM-72).** Decided by the owner on
    2026-09-30. The owner's instance runs a production build from its own checkout and is
    updated only with the owner's approval; development builds (`npm run dev`, agent
    worktrees) keep their data elsewhere (`~/.projectman-dev` by default). Merges no longer
    restart the owner's instance or stop its AI sessions, and a newer build never migrates
    the live database unasked. This is the precondition for projectman developing itself
    (PM-51).
21. **The integrating session pushes `main` after each verified merge.** Decided by the owner
    on 2026-09-30 (review question 12). Cloud sessions then start from the current state.
    Agents and workstreams still commit on their own branch and do not push. The repository
    is public, so whatever reaches `main` is published. _Differs only in the managed VM
    profile (decision 26): members there may publish their own task branches through a
    restricted gate and a separate GitHub identity, never `main` (PM-142); everywhere else
    agents do not push._
22. **One word per thing in the Hungarian UI.** Decided by the owner on 2026-10-01, answering
    the reviewer's question on PM-96. A session is a "munkamenet" (not "session") and a
    pipeline stage is a "lépés" (not "szakasz"). Developer words stay out of plain UI text:
    error codes sit behind "Részletek", settings versions in a tooltip, and a schedule has a
    plain label with an example instead of raw cron. The strings live only in
    `apps/web/src/i18n/hu.ts`, so changing a word is one edit.
23. **As many AIs work as the team has, except those on leave.** Decided by the owner on
    2026-10-01: "ne legyen korlátozás, annyi AI fut amennyi a csapat - kivéve, akit
    »szabadságra küldünk«". There is no project-wide cap on concurrent AI sessions, and a
    member sent on leave does not work. PM-106 builds it; until then the PM project's
    `maxConcurrentAi` is set to its maximum.
24. **Sandboxed tests may listen on local ports.** Decided by the owner on 2026-10-01, answering
    the PM-126 probe: the agents' sandbox allows local binding, so the test suite runs inside it,
    although sandboxed commands then also reach the live instance's port on the same machine.
    The live instance stays protected by its login and the per-session tokens of the MCP and
    hook endpoints; the question goes away once the server runs on its own machine (PM-45).
    _Decision 25 replaces the strict native sandbox direction this exception belonged to; in
    the managed VM the workers' loopback access is the one documented in `docs/VM.md`._
25. **The work moves to the virtual-machine direction.** Decided by the owner on 2026-10-01
    (PM-135, "Átállás a VM-es irányra"). The remaining parts of the old strict native sandbox
    direction stop: further work on PM-128, PM-129, PM-130, PM-132 and PM-136 ends, and what
    they already produced stays. The PM-126 procedure and the PM-127 provider-neutral policy
    model stay. PM-134: the owner's earlier answer was that its activation waits ("Élesítés
    várjon"); its content has nevertheless been live in the owner's instance since 2026-10-01
    10:59, through an error of the integrating session, which the owner knows about. It is not
    withdrawn. The VM is built first as a reproducible guest on
    the owner's Mac, later from the same files on a Linux server (PM-137, `docs/VM.md`); it is
    not a migration of the live instance, which needs its own approval (PM-143).
26. **Protected control, free workspace.** Decided by the owner on 2026-10-01 (PM-135, "Védett
    vezérlés, szabad munkatér"). Inside the VM the daily work of the AI members is free; the live
    projectman, its data (database, cookie secret, audit, logs, other members' tokens) and the
    rules for what may leave the machine are protected separately, by the system and not by the
    workers' cooperation. The technical plan (PM-135) works this out as: a protected service and
    system-managed egress rules; unprivileged, per-member workers with no general sudo and no
    shared home; the protected launcher and network gate (PM-140). The plan's consequences for
    earlier decisions, recorded here so the differences are exact and not silent:
    - Decisions 7 and 16 stand: gates and release approval stay human-only, and an AI never
      approves. What is added is a typed request for an exit permission (leaving the machine),
      with an audit trail (PM-139). The owner has decided who answers it: the leader developer
      first (by duty, not by handle), and four categories always go to the owner and never to an
      AI: cost, production systems and releases (publishing to `main` included), a new account,
      token or secret, and a lasting widening of the host boundary. Not decided by the owner,
      only proposed by the architect and built as configurable defaults on PM-139: the
      two-minute leader deadline before the request escalates to the owner, and that no request
      is ever allowed automatically.
    - Decision 19 (no `bypassPermissions` for Codex, command-by-command rule) and decision 21
      (agents do not push) are different only in the **new managed VM profile**, only behind a
      verified boundary (readiness report of `docs/VM.md`) and only once the cards that build
      them are done (PM-141, PM-142). In every other profile they apply as before.
    - Old `permissionMode` values are never migrated to a freer mode automatically; the VM
      profile and the delegation rights are owner-only settings.
27. **Each worker has its own subscription login.** Decided by the owner on 2026-10-01 (PM-140,
    "Tagonként saját bejelentkezés"). In the managed VM the members' sessions run as their own
    worker accounts, so each worker gets its own Claude and Codex login on the same subscription,
    made once by a person per worker and provider; the login file stays in that worker's home,
    readable by nobody else. No login is copied between accounts or handed to a session by the
    launcher, and no API key is used (decisions 1 and 15 stand).
28. **Permissions follow Claude Code and Codex; two settings per AI member.** Decided by the
    owner on 2026-10-01 (PM-162, PM-164). The principle, in the owner's words: „úgy kéne nálunk
    megtervezni a rendszert, h azt a filozófiát kövessük, amit a claude és a codex is tesz. ezen
    felül igény esetén finomíthatunk, de az alap ez legyen.” Answering the question on one
    setting or two (16:03): „Két beállítás, mint a Desktopban”. So each AI member has the CLI's
    own mode (the existing `permissionMode`: Kérdez, Szerkesztést elfogad, Auto, Tervezés; no
    derived mode) and, separately, who answers when it asks (`approver`: a person, the AI decider,
    or nobody); only an owner sets either. Answering who gets the rare question of an Auto member:
    „Senkihez, a rendszer elutasítja”, so a new member is hired in Auto with approver `none`.
    Answering the sandbox question of the same design: „Homokozó, a CLI-k saját kerítése”, that
    is, the sandbox is the CLIs' own.
    The earlier answer „Mind Auto-ra, egyszerre” stands for the members' mode (the PM members
    already run in Auto). No code migration changes existing members (decision 26): an unset
    approver reads as a person until the owner sets it, per member or in one configuration
    commit.
29. **Who may mark a card as a duplicate.** Decided by the owner on 2026-10-01 (PM-192, the
    architect's question; answer: „El nem kezdett kártyát bárki”). Marking a duplicate closes
    (cancels) the card. A card that has not started (waiting in a queue stage, no live session) can
    be marked by anyone who can edit it, an AI member included; a card that has started only by
    whoever may cancel a card today (an admin or the owner). On a card that is closed already only
    the relation is made. The rule is `duplicateMarkRefusal` in `packages/shared` (PM-202).
30. **Subtasks merge into the Relations section; the prerequisite sign sits in the status line
    when the card stands on it.** Decided by the owner on 2026-10-02 (PM-203, the designer's two
    questions; answers: „Beolvad” and „Állapotsor, ha emiatt áll”). The drawer has one section,
    „Kapcsolatok”, where the subtasks row was: the parts, their progress and the new-subtask form
    live in it (`TaskSubtasks` is gone). On the board a card shows „Előfeltételre vár: PM-xxx” in
    its status line when it stands because of the prerequisite (waiting in a queue stage, or its
    start waits); when something else is happening to it (working, waiting for you, blocked, waiting
    on someone) the status line says that, and a small chip names the prerequisite. The text never
    stands twice on a card.
31. **Every step can be done by a person, and any part of the process can be left to AI; a card
    is worked out before development, one step at a time.** Decided by the owner on 2026-10-02.
    The principle, in the owner's words, meant for the whole system and not only this part: „a
    lényeg, h minden emberileg is mozgatható legyen, címkézhető, stb, de mindig lehetőség van
    AI-ra bízni a folyamat egy vagy teljes részét”. So no step requires an AI member: a person can
    move every card, set every label and do every step by hand, and a team may leave one step,
    several, or the whole process to AI members. Steps follow duties (decision 16), which a person
    or an AI holds; a step whose duty no AI member holds falls to a person.
    On working a card out („addig ne kezdődjön el a fejlesztés, amíg a kártya nem áll készen, nincs
    kidolgozva. ennek kell egy felelős”), answering how: „Egymás után, egy felelőssel”. A
    responsible duty decides, with a reason, what a card needs (requirements, a UI plan, a
    technical plan); the steps run in that order, one member at a time, and the system starts the
    next; development starts only on a card that is worked out. Whether a card needs the designer
    is decided by the architect when they plan it, otherwise by whoever opens it, with a reason
    (answer: „Architekt vagy a nyitó, indokkal”). PM-252 designs the flow.
32. **The team pauses as the instance or as a project, and every stop of the server pauses it.**
    Decided by the owner on 2026-10-01 (PM-198, the pause and resume of the team). A pause covers the
    whole instance or one project, not a single member; and every stop of the server pauses the team
    first and the next start resumes it, so that an update loses no session's place. PM-219 builds it
    on the server (`PauseService`, the control socket), PM-220 the app.
33. **When the machine's heavy-run queue cannot be used, a member's heavy command does not run.**
    Decided by the owner on 2026-10-05 (PM-346; the architect's question, answer: „Álljon le”). The
    full test, the type check and the screenshot runs of a member stop with exit status 78 and a
    four-line message instead of running at full speed beside the others, which overloaded the
    machine. The server's own full test before review still runs without the queue and logs a
    warning, because the review must not stall on it.
34. **NanoGPT is a narrow API-key exception.** Decided by the owner on 2026-10-04
    (PM-319). Open models run through the interactive Codex CLI with NanoGPT as its custom
    model provider, not through Ollama or `--oss`. The key is a projectman secret and reaches
    only NanoGPT members' session environments. The `ANTHROPIC_*`, `OPENAI_*` and `CODEX_*` billing-key
    prohibitions remain; there is no fallback to ChatGPT login or OpenAI billing. This
    modifies decision 15 only for the projectman-managed NanoGPT key (PM-328, PM-329).
    On 2026-10-05, the owner accepted the temporary residual risk on PM-329:
    „Elfogadom átmenetileg, külön kártyán javítjuk” and „Indulhat, a lezárás később”.
    The legacy Codex sandbox can read the NanoGPT secret file and the `providers` directory
    from both Codex and NanoGPT sessions. The environment key is still delivered only to
    NanoGPT sessions. The accepted exposure routes are chat and team tools, or commands
    outside the sandbox approved by a human or an AI approver; NanoGPT has no automatic
    command approval. Such approved commands may inspect the parent CLI's environment.
    PM-356 will close the broad filesystem reads for all Codex CLI members. This acceptance
    does not waive PM-329's ambient configuration checks or its manual verification.
35. **Every live release gets a git tag and a GitHub release.** Decided by the owner on
    2026-10-05 („minden release-t git taggel kéne csinálni meg valami egyszerűbb release-t
    githubon ilyen összefoglalóval - persze ezt angolul”). The tag is the UTC date the build
    went live, `vYYYY.M.D`, and `vYYYY.M.D.N` for the N-th release of that day; it points at the
    merge commit the live instance runs. The GitHub release has the same name and a short English
    summary of what changed, with the card keys. The integrator creates both after the switch,
    once the new build runs. The releases before v2026.10.5.5 were tagged afterwards from the live
    switch backups, without GitHub releases.
