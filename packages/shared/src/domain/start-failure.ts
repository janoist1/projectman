/** How many starts of a place may fail in a row (PM-1335): the next automatic start is not tried. */
export const START_FAILURE_LIMIT = 5;

/** The first wait after a failed automatic start; every further failure doubles it. */
const START_RETRY_BASE_MS = 30_000;

/** The wait before the next automatic start after `failures` failed ones (1 to the limit minus one): 30 s, 1, 2, 4 min. */
export function startRetryDelayMs(failures: number): number {
  return START_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(failures, START_FAILURE_LIMIT - 1) - 1);
}
