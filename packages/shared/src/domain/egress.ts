import { z } from 'zod';
import { BoundaryId } from './boundary';
import type { BoundaryTarget } from './boundary';

/**
 * The network side of the VM boundary (PM-140). A worker reaches the internet only through the
 * protected egress proxy, and only a fixed base list or an exact destination a lead or owner
 * allowed: one host and one TCP port, for one member in one project, until a fixed time.
 * There are no wildcards and no IPv6 destinations (the confined accounts have no IPv6).
 */

/** A lower-case DNS name or dotted IPv4 address; no trailing dot, no IPv6 literal. */
export const EgressHost = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const EgressPort = z.number().int().min(1).max(65_535);
export const EgressDestination = z.strictObject({ host: EgressHost, port: EgressPort });
export type EgressDestination = z.infer<typeof EgressDestination>;

/** The canonical form of a host a client asked for, or null when it cannot be a destination. */
export function normalizeEgressHost(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/\.$/, '');
  return EgressHost.safeParse(host).success ? host : null;
}

/** `host:port` of a CONNECT request, normalized; null for IPv6 literals and anything malformed. */
export function parseEgressAuthority(authority: string): EgressDestination | null {
  const match = /^([^:[\]\s]+):(\d{1,5})$/.exec(authority.trim());
  if (!match) return null;
  const host = normalizeEgressHost(match[1]!);
  const port = Number(match[2]);
  if (!host || !EgressPort.safeParse(port).success) return null;
  return { host, port };
}

export function sameDestination(a: EgressDestination, b: EgressDestination): boolean {
  return a.host === b.host && a.port === b.port;
}

/** The public resource name of a destination in boundary requests and their audit. */
export function egressResource(destination: EgressDestination): string {
  return `egress:${destination.host}:${destination.port}`;
}

/** Version of the egress target shape; part of every egress BoundaryTarget. */
export const EGRESS_POLICY_VERSION = 'egress-1';
/** How long an egress request may wait and its allowance lasts, at most (BoundaryService limit). */
export const EGRESS_MAX_GRANT_HOURS = 24;

/**
 * A destination a session was refused, registered so the session can ask for it with
 * `submit_boundary_request` (its id is the operation id). Registering never asks anyone.
 */
export const EgressOperation = z.object({
  id: BoundaryId,
  projectKey: z.string(),
  member: z.string(),
  sessionId: z.string(),
  taskKey: z.string().nullable(),
  host: EgressHost,
  port: EgressPort,
  createdAt: z.string().datetime(),
  /** The request may wait and the allowance it opens lasts until this time. */
  expiresAt: z.string().datetime(),
});
export type EgressOperation = z.infer<typeof EgressOperation>;

/** An allowed request, consumed by the proxy: the member may reach the destination in the project. */
export const EgressAllowance = z.object({
  id: BoundaryId,
  projectKey: z.string(),
  member: z.string(),
  host: EgressHost,
  port: EgressPort,
  requestId: BoundaryId,
  operationId: BoundaryId,
  grantedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  revokedBy: z.string().nullable(),
});
export type EgressAllowance = z.infer<typeof EgressAllowance>;

/** The target the protected adapter reports for an egress operation: development, delegable. */
export function egressTarget(operation: EgressOperation): BoundaryTarget {
  return {
    operation: 'read_external',
    resource: egressResource(operation),
    environment: 'development',
    branch: null,
    protectedBranch: false,
    scope: 'single_operation',
    expiresAt: operation.expiresAt,
    policyVersion: EGRESS_POLICY_VERSION,
  };
}

/** Whether an allowance opens the destination for the member in the project now. */
export function allowanceCovers(
  allowance: EgressAllowance,
  scope: { projectKey: string; member: string },
  destination: EgressDestination,
  now: number,
): boolean {
  return (
    allowance.revokedAt === null &&
    allowance.projectKey === scope.projectKey &&
    allowance.member === scope.member &&
    sameDestination(allowance, destination) &&
    now < Date.parse(allowance.expiresAt)
  );
}

/** Why the proxy refused a connection (also shown to the session, so no secrets). */
export const EgressDenial = z.enum([
  /** The destination is neither in the base list nor allowed for this member and project. */
  'not_allowed',
  /** The connection carried no valid session credentials, so nothing can be requested for it. */
  'no_session',
  /** The connecting account is not a worker, or not the worker of the session it claims. */
  'identity_mismatch',
  /** The member may not work now (removed, on leave, AI work switched off). */
  'member_inactive',
  /** A private, loopback, link-local, shared or reserved address: never through the proxy. */
  'private_address',
  /** The name did not resolve to an IPv4 address. */
  'unresolved',
  /** Not a TLS connection, or its server name is not the host that was allowed. */
  'tls_mismatch',
  /** The session asked for too many different destinations. */
  'too_many_requests',
]);
export type EgressDenial = z.infer<typeof EgressDenial>;
