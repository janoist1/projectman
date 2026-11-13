/** One running probe process, as the facade sees it. */
export interface ProbeProcess {
  /** Claude Code's answer; null when the process failed or closed without one. Never rejects. */
  readonly answer: Promise<unknown>;
  /** Resolves when the process closed, or when it never started. Never rejects. */
  readonly closed: Promise<void>;
  /** Ends stdin: no prompt was sent, so this ends the process. */
  end(): void;
  /** True while the process started and has neither exited nor been killed by a signal. */
  running(): boolean;
  /** Kills it with SIGKILL. */
  kill(): void;
}

/** Waits for the answer, then ends the process and reaps it within a bounded grace period. */
export async function probeWithin(
  child: ProbeProcess,
  timeoutMs: number,
  killAfterMs: number,
): Promise<unknown> {
  let answerTimer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    answerTimer = setTimeout(() => resolve(null), timeoutMs);
  });
  const answer = await Promise.race([child.answer, timedOut]);
  clearTimeout(answerTimer);
  // No prompt was sent: closing stdin ends the process; a stuck one is killed.
  child.end();
  const reapTimer = setTimeout(() => {
    if (child.running()) child.kill();
  }, killAfterMs);
  void child.closed.then(() => clearTimeout(reapTimer));
  return answer;
}
