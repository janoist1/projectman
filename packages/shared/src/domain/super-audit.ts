import { z } from 'zod';
import { TaskKey } from './task';

/**
 * The audit of the Operator's super mode (PM-757): one entry per step of an operation made with a
 * super credential. It holds the operation's name and its target, never the request, a configuration
 * or a raw error: the vocabulary below is closed so nothing free-form can get in.
 */

/** `started`: begun, no result yet; `unknown`: the result was lost (an external answer), never a made-up success. */
export const SuperAuditOutcome = z.enum(['started', 'succeeded', 'refused', 'failed', 'unknown']);
export type SuperAuditOutcome = z.infer<typeof SuperAuditOutcome>;

/** Operation names, error codes and request ids are short identifiers, not text. */
export const SUPER_AUDIT_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
export const SUPER_AUDIT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

export const SuperOperationName = z.string().regex(SUPER_AUDIT_NAME);

/** What the audit shows of an entry: the token only by its prefix, and the origin. */
export const SuperOperationAudit = z.object({
  id: z.string(),
  projectKey: z.string(),
  /** The card the operation was aimed at, when it was aimed at one. */
  taskKey: TaskKey.nullable(),
  prefix: z.string(),
  operatorMode: z.literal('super'),
  requestId: z.string().regex(SUPER_AUDIT_REQUEST_ID),
  /** The Operator's hand-over this operation carries out, when it does. */
  handoffId: z.string().nullable(),
  operation: SuperOperationName,
  outcome: SuperAuditOutcome,
  errorCode: z.string().regex(SUPER_AUDIT_NAME).nullable(),
  createdAt: z.string(),
});
export type SuperOperationAudit = z.infer<typeof SuperOperationAudit>;

export const SUPER_AUDIT_DEFAULT_LIMIT = 50;
export const SUPER_AUDIT_MAX_LIMIT = 100;

/** `GET /api/projects/:key/operator-super/audit`: newest first; `before` is an entry id of the project. */
export const SuperAuditQuery = z.strictObject({
  prefix: z.string().min(1).max(40).optional(),
  before: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(SUPER_AUDIT_MAX_LIMIT).default(SUPER_AUDIT_DEFAULT_LIMIT),
});
export type SuperAuditQuery = z.infer<typeof SuperAuditQuery>;

export const SuperAuditPage = z.object({
  entries: z.array(SuperOperationAudit),
  /** Pass as `before` for the next (older) page; null on the last one. */
  nextBefore: z.string().nullable(),
});
export type SuperAuditPage = z.infer<typeof SuperAuditPage>;
