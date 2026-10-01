import { z } from 'zod';

/**
 * Whether the server runs behind the managed VM boundary and whether that boundary holds now
 * (PM-140). `managed_vm` is chosen by the root-owned boundary configuration the service unit
 * names; it only ever makes the server stricter: every session then starts through the protected
 * launcher, and none starts while `ready` is false. Free, question-free work (PM-141) may build on
 * `ready`, never on the mode alone.
 */
export const RuntimeBoundaryMode = z.enum(['off', 'managed_vm']);
export type RuntimeBoundaryMode = z.infer<typeof RuntimeBoundaryMode>;

export const RuntimeBoundaryPart = z.enum(['up', 'down', 'off']);
export type RuntimeBoundaryPart = z.infer<typeof RuntimeBoundaryPart>;

/** Stable problem codes; a readiness check that did not pass is `readiness:<check id>`. */
export const RUNTIME_BOUNDARY_PROBLEMS = [
  'not_configured',
  'readiness_report_missing',
  'readiness_report_invalid',
  'readiness_report_stale',
  'readiness_wrong_profile',
  'launcher_unreachable',
  'egress_proxy_down',
] as const;

export const RuntimeBoundaryStatus = z.object({
  mode: RuntimeBoundaryMode,
  /** Every part holds: a current readiness report passed and the launcher and proxy answer. */
  ready: z.boolean(),
  checkedAt: z.string().datetime(),
  /** Why it is not ready (codes above); empty when ready. */
  problems: z.array(z.string()),
  launcher: RuntimeBoundaryPart,
  egress: RuntimeBoundaryPart,
  /** The readiness report the verdict used, without its evidence. */
  readiness: z
    .object({
      generatedAt: z.string(),
      profileVersion: z.number().int(),
      missing: z.array(z.string()),
      failed: z.array(z.string()),
      unverified: z.array(z.string()),
      pending: z.array(z.string()),
    })
    .nullable(),
});
export type RuntimeBoundaryStatus = z.infer<typeof RuntimeBoundaryStatus>;
