# Periodic work measurements (PM-733)

The shared fixture is `apps/server/test/periodic-work-performance.test.ts`. PM-769 adds it
before changing production code; PM-770 and PM-771 reuse its generator and measurements.
Original production source: `cc534b5589aa215dd1c6dcc1ad6363383c09ed61`. The initial harness
commit is `62fcf73fe9aceda20f1fb963659ea5f38c1cd621`. Instrumentation revision
`9810b8e0260cb97f4eeacc721c3c85f7694030d5` wraps the native statement prototype once,
retaining no statement instances or call history. Earlier incomplete attempts are not a baseline.

The attached original report (`9810b8e0260c`) and optimized report (`62ac57c09985`) retain their
measured source revisions from before the rebase onto PM-757 (`77644cb9`). Their migration
timings describe schema 75 to 76. On the rebased branch the pending migration is 77, after
PM-757's actor-origin migration 76; those historical timings do not measure schema 76 to 77.

The original run uses the original production tree with this harness. Before running, verify
`git diff --exit-code cc534b5589aa215dd1c6dcc1ad6363383c09ed61 -- ':(top)apps/server/src'`.
The report repeats that comparison as `productionMatchesOriginal`. `source` identifies the
repository/harness commit; when `productionMatchesOriginal` is true, the measured production
code is exactly `originalSource`, even when the harness itself is a later commit. Restore the
committed implementation before running the optimized comparison. Do not switch or reset a
shared checkout to reproduce a measurement.

Run from the repository root, in the foreground:

```sh
npm run heavy -- --label PM-733-measurement env PROJECTMAN_PERIODIC_BENCHMARK=1 npm run test -w @projectman/server -- test/periodic-work-performance.test.ts
```

The opt-in measurement requires the heavy queue. The normal test checks only the generator's
fixed active set at two small scales. No real provider, GitHub CLI, production data or engine
process participates: the domain harness supplies fake services. Record an unavailable queue
or sandbox refusal on the card; do not bypass it.

For a separately identified pending/migration-only report, add `PROJECTMAN_PERIODIC_PENDING_ONLY=1`
after `env` in the same command. This uses the same generator, instrumentation, warmup and 5×10
rounds; it does not stand in for the full periodic protocol. PM-769's full run repeatedly lost its
Vitest worker (`ERR_IPC_CHANNEL_CLOSED`); incomplete results and that exact failure are recorded
on the card. The shorter report isolates this slice's direct pending change and migration cost.

The seed is 733. There are two projects and 24 AI members in total. The active scenario has
20 pending messages and 20 open cards. Delivered-message history grows from 10,000 to
100,000; closed-card history grows from 2,000 to 20,000, including families with four children.
Active messages, cards and seven-day evidence stay identical at both scales. A separate quiet
scenario has the same historical sizes and no pending messages or open cards. Dates are fixed.

After two warmup rounds each path runs ten complete rounds, repeated five times:

- `pending`: read each recipient's pending messages, then count messages waiting for the local
  engine. This intentionally includes both the delivery read and the settings/outage count.
- `thirty`: deferred admission/urgent pull, review watch, full-test recovery and outage checks.
- `sixty`: loop watch and Operator signal reconciliation, including structural patterns.
- `combined`: the two periodic paths and the pending path in sequence.

These are direct calls to the same services the assembly timers invoke, without waiting for
wall-clock timer intervals. They measure the work, not timer jitter. Startup/configuration,
fixture insertion and the pending-recipient migration are measured separately. The one-off
startup AutoAdvance sweep is not described as a recurring thirty-second operation.

Each report records OS, architecture, CPU, Node, load, source commit, harness SHA-256, CPU
user+system milliseconds, wall median/p95, individual round timings, SQL calls, returned
message/card/link/timeline rows, decoded message/card counts and per-repeat memory usage. Counters wrap database
statements and the existing message-kind/card-recommendation decoding boundaries. Their
overhead is included in both versions. The report is synthetic process CPU, not an EC2 credit
measurement. Compare on the same machine; time outliers must be read alongside deterministic
row counts. CPU spikes and unrelated concurrent machine load can affect wall times.

The JSON report is written into the session folder (the system temp directory outside a member
session). Attach it to the card before ending a session. It contains individual-round time
series; console output includes repeat progress and compact path summaries. Original and
optimized reports have separate names. Partial reports are saved after each path with
`complete: false`; `complete: true` marks every case of the selected mode as finished. The full
periodic protocol additionally requires `mode: 'full'`. The migration measures logical
SQLite page bytes before and after a backfill of the same generated messages, separately from
the timed periodic paths.

PM-769's deterministic requirement is that pending hydration equals only the pending result,
and the engine count hydrates none, independently of delivered history. The remaining
historical card/link/timeline work is measured for PM-770 and PM-771. Their final report must
compare against the original baseline as well as each intermediate slice.

## Startup recovery sample (PM-770)

A restarted server reads cards and messages once, before the periodic timers matter. The
harness measures this separately from the 30/60 second paths and never merges the two: add
`PROJECTMAN_PERIODIC_STARTUP=1` after `env`. It builds the same two scales and the same
active/quiet scenarios on a file database, then stops the domain, closes the database and
times a full `createDomainHarness` start over the same file (the startup recovery of the
assembly: AutoAdvance sweep, merge reconciliation, deferred starts, worktree sweep), one
warmup and ten rounds, with CPU, wall and the SQL/row/decode counters of the periodic paths.
The report stores the process memory at the end of the sample, not a peak. The report is
`periodic-work-{original|optimized}-startup-<sha12>.json`; the name says `optimized` for every
tree that differs from the original source, so the `source` field tells the slices apart.
The normal test runs the same sample at a small scale and asserts only that the sample runs.

`PROJECTMAN_PERIODIC_PATHS=thirty,sixty` runs only the named periodic paths; the report mode and
name record the subset (`paths-thirty`). It exists because the original and PM-769 trees lose
the Vitest worker (`ERR_IPC_CHANNEL_CLOSED`, RSS above 1.6 GB, also with a 6 GB heap) at the
100,000/20,000 scale: they read the whole history, which is what PM-770 removes.

Results on the same machine, median of ten, same harness, active scenario
(10,000 / 100,000 delivered messages, 2,000 / 20,000 closed cards):

| Startup sample                 | original (`cc534b5589aa`) | PM-769 (`9cf0428d0877`) | PM-770 (HEAD) |
| ------------------------------ | ------------------------- | ----------------------- | ------------- |
| CPU ms, 10k/2k                 | 343                       | 344                     | 75            |
| CPU ms, 100k/20k               | 3,277                     | 3,405                   | 459           |
| SQL calls, 100k/20k            | 241,086                   | 241,089                 | 40,677        |
| Message rows, 100k/20k         | 8,500                     | 3                       | 3             |
| Card (and link) rows, 100k/20k | 60,100                    | 60,100                  | 20,080        |

The 20,000 card rows that remain are the closed-card inventory the worktree sweep pages
through (100 per page, released after each page) to find expired worktrees; it is the only
read that grows with the closed history, a one-off at startup. The quiet scenario reads exactly
those 20,000 rows; the active scenario adds 80 rows for its open cards.

The 30 second path (`thirty`, 10,000/100,000 messages): the original and PM-769 trees read
4,040 cards and 4,040 links with 20,421 SQL calls per round (about 205 ms CPU at 10k/2k; the
100k/20k run was lost, see above). PM-770 reads 33 SQL calls, 0 cards, 0 links and 0 messages
at both scales and both scenarios (about 0.3–1 ms CPU), because the harness has no free
developer: free developers are checked before any card is read. Starts with a free developer
are covered by the read-counting tests in `urgent-pull.test.ts` and `task-scheduling-reads.test.ts`.

## Operator history reads (PM-771)

The 60 second path (`sixty`: `loopWatch.sweep` and `operatorSignals.sweep`) walked the closed history of
every project: all cards and links through the board cases and the task waits, and the project's whole
timeline for the 7-day structural evidence. PM-771 reads the open cards, the cards a prerequisite link
or a window event names, and the window events through an index (`docs/ARCHITECTURE.md`, "Operator history
reads"). The generator (seed 733) gained **current 7-day evidence at both scales**: per project one
family of three subtasks that close inside the window, their parent, and a few more structural events
(`currentEvidence` in the harness; 8 cards and 24 events, the same at every scale). The old closed
subtask families (a parent and four children, with a stage-change event each) were already in the
generator. Because the harness changed (SHA-256 `4f9a494a7d44…`), the original and PM-770 trees were
measured again with this harness; earlier tables in this file used the previous one and are not
comparable with the numbers below.

Environment: Apple M1 Pro, macOS (Darwin 23.6.0), arm64, Node v23.11.0, process CPU
(`process.cpuUsage`, user+system) in the Vitest worker, 2 warmups and 5 repeats of 10 rounds each,
queued with `npm run heavy` on a loaded machine (load average 8–10 at the start). Source: `000e87494446`
(harness commit; the production tree under test is named in each row; the original and PM-770 trees were
checked out over `apps/server/src` with `git restore --source`, and `productionMatchesOriginal` is true
for the first). Command: `npm run heavy -- env PROJECTMAN_PERIODIC_BENCHMARK=1
PROJECTMAN_PERIODIC_PATHS=thirty,sixty npm run test -w @projectman/server --
test/periodic-work-performance.test.ts`. The medians below are of the five repeats' medians; SQL and row
counts are exact and identical in every round.

`sixty`, active scenario, 10,000 / 100,000 delivered messages and 2,000 / 20,000 closed cards:

| `sixty`                   | original (`cc534b5589aa`) 10k/2k | PM-770 (`65e50b64`) 10k/2k | PM-770 100k/20k | PM-771 10k/2k | PM-771 100k/20k |
| ------------------------- | -------------------------------- | -------------------------- | --------------- | ------------- | --------------- |
| CPU ms (median)           | 129                              | 143                        | 1,676           | 2.4           | 2.0             |
| Wall ms (median / p95)    | 116 / 131                        | 130 / 136                  | 1,376 / 1,424   | 2.3 / 3.2     | 1.9 / 3.3       |
| SQL calls per round       | 4,912                            | 4,912                      | 48,112          | 116           | 116             |
| Card rows (links) decoded | 16,224 (16,160)                  | 16,224 (16,160)            | 160,224         | 168 (120)     | 168 (120)       |
| Timeline rows             | 4,968                            | 4,968                      | 48,168          | 132           | 132             |
| Message rows              | 0                                | 0                          | 0               | 0             | 0               |

The quiet scenario (no open cards) reads 94 SQL calls, 48 cards, no links and 72 timeline rows at both
PM-771 scales (about 1.1 ms CPU); PM-770 reads 160,064 cards and 48,108 timeline rows there at 100k/20k
(1,738 ms CPU, 1,370 ms wall). The 168 and 48 cards are the open cards and the eight current-window cards,
read a few times by the board cases, the task waits, the roster and the structural report; none of them is
historical. `thirty` is unchanged by PM-771 (33 SQL calls, no card, link or message row, 0.2–1 ms CPU at
both scales); the original tree reads 20,501 SQL calls and 4,056 cards per round there (about 205 ms CPU,
256 ms wall at 10k/2k).

What the original tree did at 100,000 / 20,000: the Vitest worker was lost in the active `thirty` case
(`Unhandled Rejection: Error: Channel closed`, `ERR_IPC_CHANNEL_CLOSED`, process RSS 1.2–1.5 GB at the
fourth repeat, wall median about 4.1 s per round before it) and the run ended without the other 100k/20k
cases and without the quiet scenario. The partial JSON (`complete: false`) holds the two 10k/2k active cases
only, so there is no original number at 100k/20k and no claim about it. The PM-770 tree completed every
case. Startup is a separate sample (`PROJECTMAN_PERIODIC_STARTUP=1`) and is not part of the figures above;
PM-771 does not touch it: the final tree reads the same 40,677 SQL calls and 20,080 cards at 100k/20k
(about 0.5 s CPU, once per start) as PM-770, and the same 4,317 SQL calls and 2,080 cards at 10k/2k
(about 79 ms CPU), the closed-card inventory the worktree sweep pages through.

The deterministic condition (no machine load involved) is a test, not a timing:
`test/structural-history-reads.test.ts` runs a report and a sweep over 10 and 100 closed families and
asserts that the cards read, the project lists, the children reads and the card histories are equal and
that no project list is read; `test/timeline-state-history.test.ts` asserts the query plans of the two
new timeline reads (the partial indexes, no scan of the project's timeline).

What this is not: the figures are process CPU of a synthetic in-process fixture on one development
machine, not an EC2 CPU-credit measurement, and nothing here is a claim about a t4g.micro instance. A
comparable real report (PM-772, PM-773, PM-775) must say separately what it sampled (container CPU, the
process observed, the state-sampling interval), the container and healthcheck settings and which
interval fell outside the periodic paths; no real data, snapshot or secret belongs in this repository.
