# runtime/sessions

## Responsibility

Session orchestration on the hub. This file describes the team's pause and resume (`PauseService`).

## Pause and resume (PM-219, part of PM-198)

The team's work can be paused so that every session stops at a safe point and goes on from there (a quicker
deploy; decision 32). The runner's part is `SessionRunner.pause` / `forcePause` / `release` (PM-218,
[PROVIDERS.md](../PROVIDERS.md)); `PauseService` (`runtime/sessions`) is the team's.

- **Scope and storage.** A pause covers the instance or one project, never one member (decision 32). It is a row of
  `pauses` (migration 31; at most one open per scope), and `session_pauses` holds one open row for every session
  it stops (point, tool, what it still waits for, `needs_restart`), so it survives a restart. `Session.pause`
  carries that row, `BoardView.pause` the open pauses of the project (`ProjectPauseView`; a client reads them like any member),
  `pause_changed` and `session_upserted` keep the app current. The rules are pure and in
  `packages/shared/src/domain/pause.ts` (`isWorkPaused`, `pauseStateOf`). The old `canManageInstancePause`
  rule is gone (PM-1068): `canManageProviderKeys` is the host owner's alone.
- **Pausing.** Under the admission lock only the rows and the timeline event (`team_paused`; project-level,
  internal) are written; then every running session gets `runner.pause(id, { forceAfterMs })`. The pause is
  `pausing` until every session has a point, then `paused`. `force` writes the deadline as now and cuts the
  rest with one Esc. A session that starts during a pause (a race) is stopped too.
- **What waits.** `assertNotPaused` in admission (right after `assertAiEnabled`) makes `team_paused` a deferrable
  refusal: hand-overs, work starts, refinement rounds, message wake-ups and the loop notice go to
  `deferred_starts` and are retried on resume. A person's Start, a write into a stopped session and the PM-170
  restart are refused with 409 (nothing is recorded). A message to a running paused session is stored and
  held in `MessageDelivery.pauseHeld` (in memory); the restart for new permissions, the PM-170 restart and the
  compaction do not stop a paused session. A fix limit's `reassign` decision is left until resume
  (`FixLimitWatch.afterResume`), a refinement turn that the pause cut is not "stalled", and a scheduled run
  is skipped with `team_paused` and made up once on resume (`ScheduleService.catchUp`, from the pause's own times).
- **Resuming.** Closing the row and the timeline event (`team_resumed`) are under the lock, the rest after it.
  A session goes on only when its project is no longer paused by anything (the instance's and the project's
  pauses are independent). A live session is released (`runner.release`), with a nudge when it was cut in the middle
  of a turn (`NUDGE_POINTS`: the tool ran, the call did not run, or the tool was interrupted; text from
  `ContextPackBuilder.pauseNudge`), then gets its held messages and its idle work back (`sessions.afterPause`). A
  session whose process is gone, stopped at a `RESTART_POINTS` point, is started again with `--resume`
  (`ensureSession` with `nudge`, which stands before the waiting messages); one that stopped idle is not, and
  the member is woken for a message that came meanwhile (`Messaging.wakeWaiting`). A row with no point (the
  process was cut before it answered) is started again like a mid-turn one, with the `interrupted` nudge. When
  the card holds the messages (the fix limit, a refinement turn) or the start fails, the nudge is stored as a
  `system` message instead (`Messaging.holdsMessagesOf`) and the usual path carries on. Last come `fixLimit.afterResume`, `schedules.catchUp` and `admission.retryDeferred`. A deliberate stop
  closes the session's row: it is not restarted.
- **Stopping the server.** Every stop pauses first (`ShutdownOptions.pause`, before `close`, because the hooks
  and the MCP reach the server over its HTTP and Fastify's `close` answers 503): `pauseForShutdown` opens an
  instance pause of kind `shutdown` (source `system`; it writes no timeline event) and waits for the sessions up
  to `PROJECTMAN_SHUTDOWN_PAUSE_MS` (default 60 s, 0 turns it off) plus 10 s, then the server closes as before.
  The runner cuts a session at the shutdown pause's own deadline; at the same time the sessions of a longer
  pause that was open before are cut with one Esc (`forcePause`), so the stop waits for none of them longer.
  After the start `resumeAfterStartup` (in the background, after `restoreDeferred`) ends the `shutdown`
  pauses, so the sessions start again with a nudge that says their process is new; a pause a person made stays.
  A crash and a second Ctrl-C after 3 s do not pause. The service manager must allow the shutdown
  pause to finish before terminating child sessions.
- **Access.** `GET` of a project's pause: an internal member; changing it: admin or owner. The instance's pause
  may be seen by anyone who is internal in some project (and by the host owner with no project of their own),
  with only the sessions of the viewer's projects, and changed by the host owner alone (`domain.instanceOwner`,
  PM-1058). The pause itself acts on the whole instance, projects of other owners included; an integrator key of
  the host owner is bound only in the projects its holder owns (`assertCredential`).
- **Control socket.** `PROJECTMAN_HOME/control.sock` (mode 0600; `apps/server/src/control`, not opened for a standby
  copy) takes one JSON line per request (`ControlRequest`: `pause`, `resume`, `force`, `status`) and answers one
  (`ControlResponse`); the requests are the instance's, source `control`, with no person behind them, and there is
  no login: whoever may open the file may pause the team, like whoever may stop the service. A file nobody
  answers on is replaced; one somebody answers on is left alone and logged. The members' sessions may not touch it
  (`sensitivePaths`). `npm run control -- pause --wait | resume | force | status`
  (`scripts/control`) is its client ([DEPLOY.md](../DEPLOY.md)). Since PM-491 it also takes `release_next`,
  `release_claim` and `release_report`, the release watcher's operations (see [services/releases](services-releases.md)), and
  since PM-749 `release_get` (one release in any state) and `engine_status` (the engine registry's id, online,
  version and last seen; `[]` in single mode). `sendControlRequest(socketPath, request, options)`
  (`control/client.ts`) is the shared one-request client (30 s, 64 KiB answers, never retried), and the packaged
  `control/cli.js` is the cloud container's relay of the admin channel. Since PM-752 it takes
  `release_deploy_get`, `release_deploy_begin` and `release_deploy_change` too (hybrid release, see below); a
  request or an answer stays within the relay's 16 KiB / 64 KiB limits. An ordinary `resume` (control socket or
  admin) refuses to end the pause a deployment owns (`release_pause_conflict`).
