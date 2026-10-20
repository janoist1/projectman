import type { FullTestResult } from '../../contracts';
import type { MergeCheckRunStart } from '../../db';
import type { DomainContext } from '../../core/base';
import { isoNow } from '../../core/base';

/**
 * Records one merge check (PM-876) around its full test run: the row exists from the request, `started`
 * marks the machine's heavy-run queue turn, and the end carries the executor's time and step report.
 * A run that throws is recorded as an error and the error goes on. Whatever the database says never
 * changes what the merge does: a failed write is logged and the run goes on.
 */
export async function recordMergeCheck(
  ctx: DomainContext,
  start: Omit<MergeCheckRunStart, 'requestedAt'>,
  run: (started: () => void) => Promise<FullTestResult>,
): Promise<FullTestResult> {
  const guard = (what: string, write: () => void) => {
    try {
      write();
    } catch (err) {
      ctx.logger.warn({ err, runId: start.id }, `could not ${what} the merge check record`);
    }
  };
  const runs = ctx.repos.mergeCheckRuns;
  guard('start', () => runs.start({ ...start, requestedAt: isoNow(ctx) }));
  let result: FullTestResult;
  try {
    result = await run(() => guard('mark', () => runs.markStarted(start.id, isoNow(ctx))));
  } catch (err) {
    guard('finish', () =>
      runs.finish(start.id, {
        status: 'error',
        reason: null,
        durationMs: null,
        report: null,
        finishedAt: isoNow(ctx),
      }),
    );
    throw err;
  }
  guard('finish', () =>
    runs.finish(start.id, {
      status: result.outcome,
      reason: result.reason ?? null,
      durationMs: result.durationMs,
      report: result.report ?? null,
      finishedAt: isoNow(ctx),
    }),
  );
  return result;
}
