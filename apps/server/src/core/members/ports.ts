import type { CapacityHolder, ProjectConfig, Session } from '@projectman/shared';
import type { UserRecord } from '../../db';

export type InvitationUser = Pick<UserRecord, 'id' | 'name' | 'email'>;

export interface InvitationAccounts {
  prepareUser(input: { name: string; email: string; password: string }): Promise<UserRecord>;
}

export interface MemberProfileSessions {
  list(projectKey: string, filter?: { member?: string; taskKey?: string }): Session[];
}

export interface MemberCapacity {
  holders(config: ProjectConfig, handle: string, excludeTaskKey?: string): CapacityHolder[];
}
