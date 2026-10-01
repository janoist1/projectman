import { z } from 'zod';
import { Actor } from './event';
import { memberDuties } from '../config/duties';
import { memberOf } from '../config/lookup';
import { isOnLeave } from '../config/leave';
import type { ProjectConfig } from '../config/schema';

export const BoundaryId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const BoundaryCategory = z.enum(['delegable', 'cost', 'production', 'credentials', 'host_expansion']);
export type BoundaryCategory = z.infer<typeof BoundaryCategory>;
export const BoundaryState = z.enum([
  'pending_lead',
  'pending_owner',
  'allowed',
  'denied',
  'expired',
  'revoked',
]);
export type BoundaryState = z.infer<typeof BoundaryState>;
export const BoundaryReason = z.enum([
  'scope_verified',
  'unsafe_target',
  'insufficient_context',
  'not_needed',
]);
export type BoundaryReason = z.infer<typeof BoundaryReason>;
export const BoundaryAuditReason = z.enum([
  ...BoundaryReason.options,
  'owner_revoked',
  'deadline_expired',
  'policy_changed',
  'lead_unavailable',
]);
export type BoundaryAuditReason = z.infer<typeof BoundaryAuditReason>;

/** Supplied only by a protected operation adapter, never by the requesting agent. No credentials,
 * request bodies or command strings: resource is a canonical, public resource identifier. */
export const BoundaryTarget = z.strictObject({
  operation: z.enum([
    'read_external',
    'publish_branch',
    'publish_main',
    'spend',
    'production_change',
    'release',
    'create_account',
    'create_secret',
    'expand_host',
  ]),
  resource: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:#-]*$/),
  environment: z.enum(['development', 'production']),
  branch: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._/-]+$/)
    .nullable(),
  /** The adapter knows repository protection and the configured default branch. */
  protectedBranch: z.boolean(),
  scope: z.literal('single_operation'),
  expiresAt: z.string().datetime(),
  policyVersion: BoundaryId,
});
export type BoundaryTarget = z.infer<typeof BoundaryTarget>;

/** These four owner exceptions cannot be relabelled by a caller's explanation. */
export function boundaryCategory(target: BoundaryTarget): BoundaryCategory {
  if (target.operation === 'spend') return 'cost';
  if (target.operation === 'create_account' || target.operation === 'create_secret') return 'credentials';
  if (target.operation === 'expand_host') return 'host_expansion';
  if (
    target.environment === 'production' ||
    target.operation === 'production_change' ||
    target.operation === 'release' ||
    target.operation === 'publish_main' ||
    (target.operation === 'publish_branch' &&
      (target.protectedBranch ||
        !target.branch ||
        ['main', 'master'].includes(target.branch.replace(/^refs\/heads\//, ''))))
  )
    return 'production';
  return 'delegable';
}

export const BoundaryRequest = z.object({
  id: BoundaryId,
  projectKey: z.string(),
  member: z.string(),
  sessionId: z.string(),
  taskKey: z.string().nullable(),
  operationId: BoundaryId,
  /** Digest of the submitted retry key; raw caller text is never persisted. */
  deduplicationKey: BoundaryId,
  target: BoundaryTarget,
  category: BoundaryCategory,
  policyVersion: z.string(),
  state: BoundaryState,
  assignees: z.array(z.string()),
  leadDeadline: z.string().datetime(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  decidedBy: Actor.nullable(),
  reason: BoundaryAuditReason.nullable(),
});
export type BoundaryRequest = z.infer<typeof BoundaryRequest>;
export const BoundaryGrant = z.object({
  state: z.enum(['active', 'consumed', 'revoked', 'expired']),
  id: BoundaryId,
  requestId: BoundaryId,
  projectKey: z.string(),
  member: z.string(),
  sessionId: z.string(),
  taskKey: z.string().nullable(),
  operationId: BoundaryId,
  target: BoundaryTarget,
  policyVersion: z.string(),
  decidedBy: Actor,
  reason: BoundaryReason,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  consumedAt: z.string().datetime().nullable(),
});
export type BoundaryGrant = z.infer<typeof BoundaryGrant>;
export const BoundaryRequestView = z.object({ request: BoundaryRequest, grant: BoundaryGrant.nullable() });
export type BoundaryRequestView = z.infer<typeof BoundaryRequestView>;
export const SubmitBoundaryRequest = z.strictObject({
  operationId: BoundaryId,
  deduplicationKey: BoundaryId,
});
export type SubmitBoundaryRequest = z.infer<typeof SubmitBoundaryRequest>;
export const DecideBoundaryRequest = z.strictObject({
  decision: z.enum(['allow', 'deny']),
  reason: BoundaryReason,
});
export type DecideBoundaryRequest = z.infer<typeof DecideBoundaryRequest>;

export function boundaryOwners(config: ProjectConfig): string[] {
  return config.team.members.filter((m) => m.kind === 'human' && m.access === 'owner').map((m) => m.handle);
}
export function boundaryLeads(config: ProjectConfig, requester: string): string[] {
  return config.team.members
    .filter(
      (m) =>
        m.handle !== requester &&
        !isOnLeave(m) &&
        (m.kind === 'ai' ? config.team.limits.aiEnabled : m.access !== 'viewer' && m.access !== 'client') &&
        memberDuties(config, m).includes('boundary_authorization'),
    )
    .map((m) => m.handle);
}
/** The same live membership and independence rule for REST, MCP and test backends. */
export function canDecideBoundary(config: ProjectConfig, request: BoundaryRequest, handle: string): boolean {
  const member = memberOf(config, handle);
  const requester = memberOf(config, request.member);
  if (requester?.kind !== 'ai' || isOnLeave(requester)) return false;
  if (!member || (request.state !== 'pending_lead' && request.state !== 'pending_owner')) return false;
  if (member.kind === 'human' && member.access === 'owner') return true;
  return (
    config.team.boundary?.enabled === true &&
    request.state === 'pending_lead' &&
    boundaryCategory(request.target) === 'delegable' &&
    request.category === 'delegable' &&
    request.assignees.includes(handle) &&
    boundaryLeads(config, request.member).includes(handle)
  );
}

export function canReadBoundary(config: ProjectConfig, request: BoundaryRequest, handle: string): boolean {
  const member = memberOf(config, handle);
  return (
    !!member &&
    (request.member === handle ||
      request.assignees.includes(handle) ||
      (member.kind === 'human' && member.access === 'owner'))
  );
}

/** Pure deadline/availability rule, shared with the web's in-memory backend. */
export function boundaryWaitingState(
  config: ProjectConfig,
  request: BoundaryRequest,
  now: number,
): BoundaryState {
  if (!['pending_lead', 'pending_owner', 'allowed'].includes(request.state)) return request.state;
  if (now >= Date.parse(request.expiresAt)) return 'expired';
  if (
    request.state === 'pending_lead' &&
    (now >= Date.parse(request.leadDeadline) ||
      !config.team.boundary?.enabled ||
      !request.assignees.some((h) => boundaryLeads(config, request.member).includes(h)))
  )
    return 'pending_owner';
  return request.state;
}
