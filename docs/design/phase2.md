# Phase 2: team rituals and bounded adaptation

Status: proposal (backlog PM-44, delivery cards PM-52 to PM-60), waiting for the owner's
answers to the questions at the end. Nothing here is built yet, except what it reuses:
duties with their meeting metadata, member schedules, sessions per work item and the team
tools.

Proposal for discussion. Preserve subscription sessions, the fixed duty catalogue and human
approvals. Configuration belongs in the customization git repository; meeting activity in SQLite.
UI labels stay in Hungarian locale files; participant content follows the project language.

## Meetings

Meeting series define type, participants, mode, cron, response window and enabled state.
Each occurrence records its configuration version, leader, agenda, rounds, contributions,
notes, decisions and action links. States: scheduled, open, closed or cancelled. A deadline
marks missing answers; silence never means agreement.

Leadership follows effective duties, not role names: `standup_facilitation` and
`refinement_facilitation` normally resolve to the PM; `retro_facilitation` to the Coach.
With several holders, the series nominates one or the starter chooses. With no holder,
whoever starts leads. An automatic occurrence without
a holder waits for someone to start it; the timer is not a facilitator.

Planning and demo have no matching attachment today. Proposed catalogue metadata:
attach both to `scheduling`, normally held by the PM, with explicit facilitation wording.
Facilitation never grants prioritization or approval rights.

| Type                  | Screen shows                                                                | Screen records                                                                              |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Standup               | Participant progress, next steps, blockers and linked tasks                 | Each answer, blocker owner, follow-up actions                                               |
| Refinement            | Candidate tasks, descriptions, acceptance criteria, dependencies, questions | Agreed edits, splits, unresolved questions and readiness recommendation                     |
| Planning              | Ready backlog, human priorities, capacity and proposed assignments          | Goal, selected tasks, human-confirmed priorities and commitments                            |
| Retro                 | Previous improvements, observations, evidence and proposed clusters         | Chosen themes, human decisions, up to three improvements, success measures and review dates |
| Review/demo, optional | Completed tasks, PR/demo links and acceptance evidence                      | Feedback and follow-ups; release approval remains a separate explicit human decision        |

Screens share attendance/response status, agenda, notes, decision authors, action-task
links and a filtered project timeline link. Finalized actions become ordinary tasks through
the existing creation service, initially unassigned in the first stage for human prioritization.
Store the proposed responsible person and due date on the action. Use idempotent conversion
so retries cannot create duplicate tasks. Task edits retain normal permissions and gates.

Live participation means shared web text, synchronized through websocket events. Async
participation uses bounded rounds: collect answers, discuss a synthesis, confirm outcomes.
Both modes write the same records; audio/video is outside this phase. Humans answer in the
web; AI members answer from Claude Code or Codex sessions using team tools. Reuse one
session per member × meeting, resuming it for later rounds. Capacity or plan limits may
delay AI answers without blocking human participation.

Existing `send_message` is task-scoped and session text reaches nobody. Add
meeting routing and typed `get_meeting`, `submit_meeting_contribution` and
`finalize_meeting` operations, shared by REST and MCP. Contributions name meeting, round
and reply target; identity comes from authentication. Only the leader finalizes the record;
human decisions remain attributed to the humans who made them. Corrections append history.

Extend `ScheduleService`, rather than introduce another timer: retain cron evaluation in the
project timezone, next-run display, occurrence deduplication, run-now and run history. Today
it starts member schedule sessions, skips unavailable members and never replays missed
minutes. Add a meeting target keyed by series + scheduled instant; opening an occurrence
must not require an AI slot. Admit each AI participant through existing capacity, concurrency,
provider-login and plan-usage checks. Record deferred invitations and retry within the response
window. Keep no automatic backfill after downtime; show a missed occurrence and offer run-now.
Prevent overlapping occurrences of the same series by default. Restart preserves meeting
records and resumes conversations on demand, without pretending processes survived.

## Setup conversation with the PM

The owner and optional PM discuss availability, rituals, frequency, participants, mode and
response windows. Without a PM, the owner uses the same screen. The draft shows a weekly
calendar, timezone, participation and configuration diff. Discussion revises it without applying it.

Typed operations needed:

- `read_working_mode()` returns current configuration, duties and version.
- `propose_config(baseVersion, operations, reason, evidenceRefs)` stores a draft.
- `preview_config(proposalId)` validates it and shows the diff, warnings and effective holders.
- `approve_config(proposalId, expectedVersion)` authenticates the owner and applies exactly
  that reviewed draft; `reject_config(proposalId, reason)` closes it without applying.

Approval creates one atomic customization commit with author, approver, reason and proposal
reference, then activates schedules and appends a timeline event. Concurrent configuration
edits invalidate the preview and require renewed approval. A conversational “yes” must resolve
to a specific versioned proposal, never an AI-authored approval. New schemas belong in
`packages/shared`, with server contracts; `ask_human` can request a decision but does not
itself authorize configuration changes.

## Retro feedback loop

Anyone can file an internal observation: what happened, impact and optional suggestion.
AI observation collection is team-configurable, off by default, and requires at least one
resolvable task, timeline-event or session reference. Turning it off stops new AI submissions,
not human observations or the historical record. Evidence links respect visibility rules.

The holder of retro facilitation clusters observations, preserving originals and dissent;
process improvement supplies measurable proposals. These are Coach defaults, not privileges
attached to a role name. Without a holder, the retro starter facilitates. Humans select at most
three actions, defer a theme or explicitly choose no change. Each action has a responsible
person, success measure and review date; the next retro checks the result.

An action may propose a pipeline, duty-bundle or limit change. Link observation → retro
decision → task/proposal → commit → measured result. The Coach proposes; it receives no
configuration-write authority through `process_improvement`.

## “Rendszer”: configuration changes within limits

Rendszer is a system-agent identity using a separate bounded capability, not a new duty or
an administrator account. It can submit only a fixed, code-backed operation catalogue:

- `move_stage(stageId, beforeStageId)` reorders existing stages.
- `set_role_duties(roleId, dutyIds)` rebundles existing catalogue duties.
- `set_limit(limitKey, value)` changes an enumerated operational limit.
- `upsert_meeting(seriesId, definition)` and `disable_meeting(seriesId)` manage rituals.
- `set_ai_observations(enabled)` controls collection.

No raw YAML patches, shell edits, invented duties or arbitrary permission changes. Operations
carry reason, evidence, base version and idempotency key. Validate the resulting configuration,
including missing duty holders and affected tasks.

Owner-set policy classifies operations as forbidden, approval-required or automatic within
named targets and numeric bounds. Default: all require approval. Only the owner edits this
policy; the agent cannot widen it. Automatic changes still receive a preview, audit event and
commit, and notify the owner. Stale versions fail without partial application.

Rendszer may never alter effective release approvers, protected release-duty bundles or
membership, release gates or four-eyes rules, even through an owner-approved agent proposal.
Those changes use the separate owner-only settings flow. It may never give AI members
approval rights. Validate indirect effects across bundles, membership and gates; all existing
human-only, self-review and release invariants remain enforced.

Every applied configuration change is a customization-repository commit. An authorized human
can revert through a new validated commit; incompatible reversions explain what must be
resolved. Reverting configuration does not erase meetings, undo completed work or revoke an
already executed release. The timeline links the original and reverting commits.

## Notifications

Keep the inbox authoritative. Trigger notifications for questions/permissions, human gate
decisions, meeting invitations, approaching unanswered-round deadlines, assigned actions,
configuration approvals/results and failed scheduled participation. Deduplicate by event and
recipient; routine summaries use digests. Respect task visibility and avoid sensitive lock-screen text.

Start with opt-in browser notifications while connected to the local app through Tailscale
HTTPS. Add an installable PWA and service worker next; closed-app push is a separate delivery
capability requiring browser support and an external push service, so installation alone must
not promise delivery. Show delivery limitations when the host sleeps or is unreachable.
Email is later and optional.

Each person chooses channels, timezone and quiet hours. Inbox entries appear immediately;
defer alerts until quiet hours end and collapse stale reminders into a digest.
Default: no quiet-hours bypass, including for approvals. Never auto-approve on timeout.

## Heavy commands: owner decision

AI-session limits do not control simultaneous installs, builds or test suites on one machine.
Queue scope should cover all projects and members on that host.

| Option                                 | Trade-off                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Voluntary reservation tool             | Small change; cooperative members queue, direct shell commands can bypass it               |
| Managed command runner, one heavy slot | Predictable serialization and cancellation; requires routing supported commands through it |
| Weighted CPU/memory slots              | Better throughput for unequal jobs; needs estimates, tuning and starvation protection      |
| Isolated workers/containers            | Stronger enforcement and isolation; highest setup and maintenance cost                     |

Recommend a managed runner with one FIFO heavy slot, plus worktree locks for mutating installs.
Requests identify member, work item, directory, command class and timeout. Show queue position,
support cancellation and reconcile child processes after restart before freeing slots. Keep
command permission checks. Direct shell commands bypass the queue unless intercepted.

## Incremental delivery

1. Meeting records and manual standup: shared history, web contributions and action conversion.
2. Refinement, planning, retro and demo screens: type-specific records and duty leadership.
   **Owner first: planning/demo duty mapping.**
3. Meeting team tools: routed contributions and resumable member × meeting sessions.
4. Scheduled meetings: extend schedule targets, deduplication and deferred invitations.
   **Owner first: cadence and downtime policy.**
5. PM setup: typed proposals, preview, owner approval and atomic config commits.
6. Observations and retro follow-through: evidence, clusters and measured actions.
   **Owner first: AI collection setting.**
7. Rendszer: restricted catalogue, policy enforcement and validated revert.
   **Owner first: autonomous-operation bounds.**
8. Browser notifications, then PWA: preferences, quiet hours and delivery status.
   **Owner first: closed-app push dependency.**
9. Heavy-command queue: shared host admission and recovery.
   **Owner first: enforcement versus complexity.**

## Questions for the owner

1. How much meeting time is useful? **Default:** weekday async standup, weekly refinement
   and planning, fortnightly retro; demo on demand to limit interruptions.
2. Who leads planning/demo? **Default:** scheduling-duty holder (usually PM); reuse the
   catalogue rather than add duties. Human prioritization remains separate.
3. Should downtime create catch-up meetings? **Default:** no backfill; notify and offer
   run-now, avoiding a burst when the machine wakes.
4. Should AI file observations? **Default:** off initially; enable evidence-linked submissions
   when the team accepts the review load.
5. May Rendszer act without asking? **Default:** require approval initially;
   widen bounds after reviewing useful proposals.
6. Are closed-app alerts worth an external push dependency? **Default:** connected-browser
   alerts first; accept missed immediate alerts while offline.
7. May alerts interrupt quiet hours? **Default:** no; decisions may wait until morning.
8. How strictly should heavy commands queue? **Default:** one managed FIFO slot; accept
   that direct shell commands bypass it until stronger enforcement is funded.

## Summary

Build meetings on existing duties, sessions, schedules and tasks. The PM proposes rituals;
the owner approves configuration. Retros turn evidence into measurable improvements.
Rendszer uses bounded operations, commits and validated reversions, without release authority.
Notifications respect quiet hours and delivery limits. Decide command-queue enforcement
separately from session capacity, then ship incrementally.
