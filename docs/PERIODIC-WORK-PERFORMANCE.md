# Periodic work measurements (PM-733)

The shared fixture is `apps/server/test/periodic-work-performance.test.ts`. PM-769 adds it
before changing production code; PM-770 and PM-771 reuse its generator and measurements.
Original production source: `cc534b5589aa215dd1c6dcc1ad6363383c09ed61`. The initial harness
commit is `62fcf73fe9aceda20f1fb963659ea5f38c1cd621`. The corrected, memory-bounded harness
baseline is `b6ed1f014ce4a6f1583cff6d9dd28f7a2aeabfa3`; production code is still identical
to the original source in that commit.

Run from the repository root, in the foreground:

```sh
npm run heavy -- --label PM-733-measurement env PROJECTMAN_PERIODIC_BENCHMARK=1 npm run test -w @projectman/server -- test/periodic-work-performance.test.ts
```

The opt-in measurement requires the heavy queue. The normal test checks only the generator's
fixed active set at two small scales. No real provider, GitHub CLI, production data or engine
process participates: the domain harness supplies fake services. Record an unavailable queue
or sandbox refusal on the card; do not bypass it.

The seed is 733. There are two projects and 24 AI members in total. The active scenario has
20 pending messages and 20 open cards. Delivered-message history grows from 10,000 to
100,000; closed-card history grows from 2,000 to 20,000, including families with four children.
Active messages, cards and seven-day evidence stay identical at both scales. A separate quiet
scenario has the same historical sizes and no pending messages or open cards. Dates are fixed.

After two warmup rounds each path runs ten complete rounds, repeated five times:

- `pending`: read each recipient's pending messages, then count messages waiting for the local
  engine. This intentionally includes both the delivery read and the settings/outage count.
- `thirty`: deferred admission/focus pull, review watch, full-test recovery and outage checks.
- `sixty`: loop watch and Operator signal reconciliation, including structural patterns.
- `combined`: the two periodic paths and the pending path in sequence.

These are direct calls to the same services the assembly timers invoke, without waiting for
wall-clock timer intervals. They measure the work, not timer jitter. Startup/configuration,
fixture insertion and the pending-recipient migration are measured separately. The one-off
startup AutoAdvance sweep is not described as a recurring thirty-second operation.

Each report records OS, architecture, CPU, Node, load, source commit, harness SHA-256, CPU
user+system milliseconds, wall median/p95, individual round timings, SQL calls, returned
message/card/link/timeline rows, and decoded message/card counts. Counters wrap database
statements and the existing message-kind/card-recommendation decoding boundaries. Their
overhead is included in both versions. The report is synthetic process CPU, not an EC2 credit
measurement. Compare on the same machine; time outliers must be read alongside deterministic
row counts. CPU spikes and unrelated concurrent machine load can affect wall times.

The JSON report is written into the session folder (the system temp directory outside a member
session). Attach it to the card before ending a session. It contains individual-round time
series; console output includes compact repeat summaries. The migration measures logical
SQLite page bytes before and after a backfill of the same generated messages, separately from
the timed periodic paths.

PM-769's deterministic requirement is that pending hydration equals only the pending result,
and the engine count hydrates none, independently of delivered history. The remaining
historical card/link/timeline work is measured for PM-770 and PM-771. Their final report must
compare against the original baseline as well as each intermediate slice.
