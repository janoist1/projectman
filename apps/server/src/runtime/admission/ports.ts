/**
 * What the refinement line (`RefinementSteps`) needs from the outside, declared where it is used: the
 * services side (`services/operator`) fills it in `assembly.ts`, so the runtime imports no service.
 */

/** The turn of a refinement step that ended without its label (PM-702). */
export interface RefinementStallReport {
  projectKey: string;
  taskKey: string;
  label: string;
  member: string;
  /** The `createdAt` of the recorded `refinement_turn` event; part of the case key of the signal. */
  turnAt: string;
}

/**
 * Tells the project manager about a stalled refinement turn, as a report-only system signal.
 * - `delivered`: the PM has the signal (also when nothing was left to report);
 * - `queued`: a durable pending signal exists and is delivered when the PM can be woken (an offline engine,
 *   admission's waiting line, the wake-up interval); never a failure;
 * - `unavailable`: no PM can take it (none, AI off, leave, pause); no signal was stored;
 * - `failed`: storing or delivering it failed; a stored pending signal stays and is retried.
 * `unavailable` and `failed` make the caller fall back to the owners' alert.
 */
export interface RefinementStallNotices {
  report(input: RefinementStallReport): Promise<'delivered' | 'queued' | 'unavailable' | 'failed'>;
}
