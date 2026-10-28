# projectman — development lessons

What building projectman with its own AI team taught us: the challenge, what we learned, and
where it went. Newest first. The owner's decisions stay in [DECISIONS.md](DECISIONS.md); this
file keeps the experience behind them, so that members and the Operator do not learn it twice.
Anyone may propose a lesson; the Operator adds it.

## 2026-10-25 – 2026-10-26: checks that only the merge ran

**A new column broke an old-database test.** PM-1006 added a column to an existing table. The merge test failed in `history-index.test.ts`, whose fixture rolls the database back to version 83 by dropping the newer columns: the new one was missing from that list ("duplicate column name"). _Lesson:_ a migration that adds a column to an existing table also updates that rollback fixture, and the developer runs the test before hand-over. (PM-1006)

**Changing the web fake without its own tests.** PM-1008 changed `apps/web/src/mocks/backend.ts` and ran the UI tests that use it, but not the fake's own tests; the merge failed in `backend.test.ts`. _Lesson:_ after changing the fake backend, run the whole `src/mocks` group. (PM-1008)

## 2026-10-25: a new merge check without its local command

**A new merge check failed the next card.** PM-965 added the dead-code check (knip) to the merge test, but the developers' hand-over list did not get the fast local command. The next card, PM-1000, passed its local checks and failed at merge. _Lesson:_ a card that adds a merge check which runs fast locally updates the developers' hand-over list in the same change. When the merger sends a card back, they name the local command that was skipped, and propose adding it if the list lacks it. (PM-1002)

## 2026-10-12 – 2026-10-13: handing the integrator's work to the team

**Merging moved to the team, and broke at once.** The first member merge (`merge_task`) failed
on every card: the domain made `merge_…` ids, the engine accepted only `mrg_…`. A contract
between two modules was checked in neither. _Lesson:_ a value that crosses a module boundary is
defined once in the contracts and tested from both sides. (PM-551)

**A pipeline fix helps only after a release.** PM-564 made a failed merge check name the failed
tests, but merges kept failing without names for hours: the live server still ran the old build.
_Lesson:_ a fix to the team's own tooling (merge, release, signals, delivery) is worth a release
soon after it lands. (PM-564; v2026.10.13 was the first release proposed by the lead developer,
approved by the owner and deployed by the watcher, with nobody else touching it)

**Flaky tests block the whole merge queue.** One flaky test fails roughly one merge in four, and
every card in the queue pays for it. Unchanged retries are a gamble and cost a queue slot each.
_Lesson:_ fix a known flaky test before anything else, before more merges queue up. Do not retry a
card that failed on it; wait for the fix. (PM-553, PM-555, PM-564)

**The merge queue's order is a decision, not a rule.** Merges run one at a time per repository:
that is the system's rule (the check runs on main plus the card). The order was first-come
first-served only because nobody chose otherwise, and a retried card kept its old place.
_Lesson:_ the service keeps its rule and gives the member a tool for the decision. (PM-576)

**Machine load decides how fast everything is.** With the owner's transcriptions, `brew` and the
reviewers' test runs together, the load reached 60–90. Merge checks timed out at 30 minutes and
UI tests at 20 seconds. Raising the timeout was rejected. _Lesson:_ look at the load before
starting heavy work; when it is high, ask the responsible person whether to start, and let them
wait for calm. (PM-572)

**The same suite ran twice.** Reviewers ran the full server suite in the background although the
merge check runs it anyway. That doubled the load and the runs were lost when the session was
stopped as idle. _Lesson:_ reviewers run the related tests and the type check in the foreground;
the full suite runs once, at merge. (PM-569)

**Idle sessions hold places.** A reviewer waiting for a merge or for a developer's fix kept one of
its two places, and other reviews could not start. _Lesson:_ a session that waits on someone else
gives its place back; the conversation resumes when the work returns. (PM-552 for merges,
PM-570 for fix rounds)

**A message counted as delivered was lost.** Under heavy load the text was typed into the CLI but
the Enter did not register; the message was marked delivered and nobody saw it. _Lesson:_
"delivered" means submitted and seen, and a lost message must never stay silent. (PM-571)

**Questions reached the owner that were not theirs.** Members asked the owner which test failed,
or whether to retry. _Lesson:_ only a real decision reaches the owner. What a tool or the team can
find out, the Operator finds out or starts a member on, and whoever takes a question over tells
the asker at once. (PM-556, PM-558)

**Ready cards waited for a click.** Nobody was assigned to start cards in Ready, so they waited
for the owner. _Lesson:_ such working arrangements come from getting to know the owner and the
team, not from settings they must learn. The Operator proposes them. (PM-563)

**Disk cleanup freed little.** Deleting 66 worktrees showed 20 GB by `du` but freed about 2 GB:
the `node_modules` folders are APFS clones. _Lesson:_ measure freed space with `df`, and look for
the real consumer before cleaning. (PM-566)

**The watcher must never stop.** The integrator's board watcher was not re-armed once and the
board stalled for eleven hours. _Lesson:_ routine watching belongs to the system, which wakes the
Operator; it should not depend on someone remembering. (PM-545)

**What made the difference: looking at the real cause.** Every stall today was found in the server
log, the database or a session's transcript, not on the board. _Lesson:_ diagnose before acting,
take the smallest step that works, check that it worked, and open a root-cause card when a
problem comes back. The Operator needs the same reading tools. (PM-563)

**Architecture: core and services.** These problems sit on the boundaries between responsibilities:
delivery and the runner, the reviewer and the merge, the queue and its order. _Lesson:_ think in
modules with one clear responsibility and an explicit interface; the core knows no service, and
services give members tools for decisions. The language stays TypeScript; a full refactor, possibly
with Effect, is the main priority once the current work is closed. (PM-577)
