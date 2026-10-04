// A process that takes the machine's heavy-run lock, writes `start <label>` and `end <label>` to a log
// around holding it, and releases it: the real-process side of the heavy-lock tests (PM-336).
//
//   node --import tsx heavy-holder.ts <dir> <label> <log> <hold ms> [heartbeat ms] [stale ms]
import { appendFileSync } from 'node:fs';
import { acquireHeavyLock } from '../../src/full-test/heavy-lock';

const [dir, label, log, holdMs, heartbeatMs, staleMs] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string?,
  string?,
];

const lock = await acquireHeavyLock({
  dir,
  label,
  pollMs: 25,
  ...(heartbeatMs ? { heartbeatMs: Number(heartbeatMs) } : {}),
  ...(staleMs ? { staleMs: Number(staleMs) } : {}),
});
appendFileSync(log, `start ${label}\n`);
await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
appendFileSync(log, `end ${label}\n`);
await lock.release();
