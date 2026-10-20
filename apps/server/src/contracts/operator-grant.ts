export interface OperatorGrantRecord {
  id: string;
  userId: string;
  grantedAt: string;
  expiresAt: string | null;
}

/**
 * The host owner's grant for machine operations (PM-881): the one switch every machine operation of every
 * integrator scope passes. Auth implements it; a revoked or expired grant refuses at once, the key stays valid.
 */
export interface OperatorGrantGate {
  /** The host owner's active grant, or null. */
  active(): OperatorGrantRecord | null;
  /** Throws 403 `operator_grant_inactive` without an active grant; records `last_used_at`. */
  assertActive(): OperatorGrantRecord;
}
