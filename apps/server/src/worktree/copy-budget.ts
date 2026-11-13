/** One copying step; it must stop and settle soon after `signal` aborts. */
type CopyStep = (signal: AbortSignal) => Promise<void>;

/**
 * Runs steps sequentially within one budget, aborting and awaiting the running step on expiry.
 * Rejects with the step's own error or with `dependency copying timed out`.
 */
export async function copyWithinBudget(steps: readonly CopyStep[], budgetMs: number): Promise<void> {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, budgetMs);
  try {
    for (const step of steps) {
      if (expired) break;
      await step(controller.signal);
    }
  } catch (error) {
    // A step that failed because the budget aborted it is a timeout, not its own error.
    if (!expired) throw error;
  } finally {
    clearTimeout(timer);
  }
  if (expired) throw new Error('dependency copying timed out');
}
