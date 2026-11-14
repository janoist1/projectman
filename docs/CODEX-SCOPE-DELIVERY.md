# Scope changes during a Codex turn — PM-1505 investigation

Investigated on 2026-11-14 at `4d46ad4a3e27f626d246dc5c1d38317ced7471ef`.
This is a proposal, not an approved implementation plan. Runtime behavior is unchanged.

## Finding

There are two independent idle gates. Updating the card already creates a notice,
but neither that notice nor a teammate's message reaches a working developer through
the normal input path before the turn ends. Re-reading the card works because its
stored state is current; the running conversation does not refresh itself from it.

| Path                                                             | Current behavior                                                                                                                                                   | Source                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| AI teammate sends a message                                      | Stored and routed to the running session; reports `after_turn`. Calls `deliverWaiting`, not direct delivery.                                                       | `runtime/delivery/routing.ts`, `MessageRouter.deliverOrWake`                                                   |
| Waiting AI messages                                              | `flushWaiting` requires `idle`, checked again after asynchronous preparation. Messages are batched and claimed, then marked delivered after CLI acceptance.        | `runtime/delivery/delivery.ts:454–537`                                                                         |
| Card description changes                                         | Sends a “read it with get_task” notice to other running card sessions in work/review stages. A reviewer can be restarted; the assignee gets ordinary queued input. | `runtime/delivery/session-messages.ts:119–157`                                                                 |
| Ordinary input, including human messages and description notices | `typeInto` calls `sendUserMessage`; `Session.send` enqueues it. The input queue's `pump` refuses to type until `host.isIdle()`.                                    | `runtime/sessions/sessions.ts:1219–1228`, `runner/session.ts:247–254,445–451`, `runner/input-queue.ts:210–220` |
| Decision recorded only in a note/message                         | Does not itself change the description. A targeted message still follows the AI delivery path above.                                                               | `runtime/delivery/routing.ts`, `core/messages`                                                                 |

Removing only the runtime's `idle` check therefore does not fix delivery: the
engine's runner still waits. Changing `action` to `info` does not bypass either gate.
The former affects wake-up/staleness behavior, not mid-turn delivery capability.
Submission retries address failed input acceptance, not the delay before typing.

Existing executable evidence includes `test/message-validity.test.ts` (“batches
three AI messages only after a busy session reaches idle”),
`test/parallel-changes.test.ts` (description notices), and `runner/input-queue.test.ts`.
Domain harness delivery alone cannot prove that a real working Codex receives input:
the runner boundary needs separate coverage.

## Observed cases and historical constraint

The project memory log records PM-1428 (2026-11-13 16:37 UTC): a decision was already
on the card while direct delivery waited, costing about eight minutes of waiting.
PM-1482 (2026-11-14 14:07 UTC entry) records about five minutes of UI work and
screenshots after the 14:01 scope split and the 14:02 description update; that work
was then removed from the card's implementation. These are participants' recorded
observations, not measurements reproduced by this investigation.

PM-117 proposed urgent input by interrupting the turn with Esc. Its recorded owner
decision allowed urgent sends only from humans. PM-117 and PM-122/123/124 were
cancelled on 2026-11-04; its plan predates current delivery-id handling (PM-1205).
The current `Session.interrupt()` exists, but it is not an urgent-message contract.
PM-1505 does not authorize reviving that feature or granting AI senders interruption
rights. See the current PM-117 card and its cancellation entry, not only its old plan.

## Recommended follow-up: a notice at the next team tool response

Proposed card: **Targeted card-change notice in the running member's team tool
response**. Have analyst/architect refine it before implementation.

Use the next authenticated team MCP response as a second observation point within
the current turn. `mcp/server.ts:114–136` already returns text content for tool
results. A short additional text block could tell the member which card changed,
who changed it, and which source event/message to read with `get_task`. This avoids
depending on a new Codex TUI submission mode for this first increment.

Suggested scope and acceptance criteria for refinement:

- Automatically flag description changes made by another actor on the session's
  own open card. For decisions without a description edit, define an explicit
  source-linked signal to the current worker; do not infer decisions from prose
  or elevate every ordinary message. The allowed senders and exact contract need
  an architectural/product decision on the follow-up.
- Bind notices to the authenticated project, member, session and card. Preserve
  source attribution; a signal requests a fresh read and grants no authority.
  Revalidate superseded/closed sources before presenting them.
- Check after the tool finishes, so a change during a long team call is included.
  Preserve the original tool's result, images and error status. Include notices
  on error responses too, without making an unsuccessful operation look successful.
- Coalesce repeated changes to the same card. Define durable acknowledgement and
  retry behavior, including concurrent tool calls, failed responses and restarts.
  Do not mark the original queued message delivered merely because a change hint
  was returned; notification, reading and the original message receipt are different.
- Test a working session receiving the hint before idle, unrelated sessions/cards,
  changes during a call, errors, duplicate responses and superseding changes.
  Keep existing queued delivery and its receipt tests as regressions.

Limitation: this gives a next-team-call opportunity, not a seconds-based guarantee.
A long shell/test call or reasoning interval without team tools still delays the
hint. The member must read and act on it; a returned tool result is not evidence of
comprehension. It cannot undo work already performed.

If bounded delivery without team calls is required, propose a separate capability
probe for the supported interactive Codex version: whether native steering or
tool-hook context can carry a targeted notice during a turn, how acceptance is
confirmed, and what happens during a long command or permission prompt. This
investigation did not run a real CLI probe and claims neither capability. Only
after that evidence should architect select a runner/transport design. Esc-based
interruption remains a separate owner decision, with PM-117's history attached.

Until then, after a pending scope/architecture discussion and before dependent
work or hand-over, read the current card and the decision source. This reduces
avoidable rework but cannot guarantee immediate delivery of an unsolicited change.

## Remote engine and validation

Current delivery crosses hub → engine through `session.send`
(`engine-link/remote/runner.ts:255`, `engine-link/engine-handlers.ts:207`); the input
queue and PTY remain on the engine. The proposed MCP response notice would travel
back through the existing session-bound `mcp.relay` and Codex stdio bridge, not
through `session.send`. Relevant machine inventory entries are **Hooks and team
MCP over loopback**, **Conversation transcripts and resume**, and **Session process
liveness** in `MACHINE-DEPENDENT.md`. No path, process, socket, account or OS
behavior changes in this investigation, so no inventory update is needed.

The follow-up must exercise the cloud/engine MCP relay with session binding, engine
disconnect/reconnect and a response lost in transit. A hub-side MCP text addition
could use the existing relay; its final contract must be verified against the
bridge. Native steering would instead require engine-side work and a separately
designed capability/fallback across that boundary; it must not assume hub-local PTY
access. No new billing, provider API or app-server path is proposed.

This change is documentation only. Validation is the repository's local
`npm run handover-check` after committing; its outcome is recorded on PM-1505.
No automated test can validate a proposed, unimplemented notification path.
