import type { CapacityHolder, ProjectConfig, Session } from '@projectman/shared';
import type { UserRecord } from '../../db';

export type InvitationUser = Pick<UserRecord, 'id' | 'name' | 'email'>;

export interface InvitationAccounts {
  prepareUser(input: { name: string; email: string; password: string }): Promise<UserRecord>;
  /** A new account without a password, for an invited client who logs in with an e-mail code (PM-670). */
  preparePasswordlessUser(input: { name: string; email: string }): UserRecord;
  /** The initial host owner, whom no e-mail login may touch. */
  isHostOwner(userId: string): boolean;
}

export interface MemberProfileSessions {
  list(projectKey: string, filter?: { member?: string; taskKey?: string }): Session[];
}

/** What the runtime tells a handle rename (PM-1025): the starts it holds back and the deferred starts naming the member. */
export interface MemberRenameRuntime {
  /** Refuses the member's session starts (`member_renaming`) until the returned function is called. */
  holdStarts(projectKey: string, handle: string): () => void;
  /** Whether a kept deferred start names the member. */
  deferredStartNames(projectKey: string, handle: string): boolean;
}

export interface MemberCapacity {
  holders(config: ProjectConfig, handle: string, excludeTaskKey?: string): CapacityHolder[];
}
