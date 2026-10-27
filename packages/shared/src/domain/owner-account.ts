/**
 * Owner accounts (PM-1062): an invited owner besides the chopper's host owner. They create projects on
 * their own engine and manage their own engines; the host owner keeps everything else of the instance.
 */

/** The stored account: there is a row for the user, and it is not revoked. */
export function isOwnerAccount(row: { revokedAt: string | null } | null): boolean {
  return row !== null && row.revokedAt === null;
}

interface CreatorRights {
  isHostOwner: boolean;
  isOwnerAccount: boolean;
}

/** Creating a project (and choosing the folder on an engine for it) is the host owner's and an owner account's. */
export function canCreateProject(a: CreatorRights): boolean {
  return a.isHostOwner || a.isOwnerAccount;
}

/** Creating an engine key is the host owner's and an owner account's. */
export function canCreateEngine(a: CreatorRights): boolean {
  return a.isHostOwner || a.isOwnerAccount;
}

/** Managing (revoking) an engine: the host owner any, an owner account only their own (`engines.created_by`). */
export function canManageEngine(a: {
  isHostOwner: boolean;
  actorUserId: string;
  engineOwnerUserId: string;
}): boolean {
  return a.isHostOwner || a.actorUserId === a.engineOwnerUserId;
}
