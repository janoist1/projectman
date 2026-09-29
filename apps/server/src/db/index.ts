import type { Db } from './database';
import { createInboxRepository } from './inbox';
import { createMemberStateRepository } from './member-state';
import { createMessageRepository } from './messages';
import { createCounterRepository, createProjectRepository } from './projects';
import { createSessionRepository } from './sessions';
import { createTaskRepository } from './tasks';
import { createTimelineRepository } from './timeline';
import { createAuthSessionRepository, createUserRepository } from './users';

export { openDatabase, migrate, schemaVersion } from './database';
export type { Db } from './database';
export { LATEST_SCHEMA_VERSION, migrations } from './migrations';
export type { UserRecord, AuthSessionRecord } from './users';
export type { ProjectRecord } from './projects';
export type { MemberStateRecord } from './member-state';
export type { PullRequestLinkRef } from './tasks';
export { encodeWorkItem, decodeWorkItem } from './sessions';

/** All repositories over one database connection. */
export function createRepositories(db: Db) {
  return {
    db,
    users: createUserRepository(db),
    authSessions: createAuthSessionRepository(db),
    projects: createProjectRepository(db),
    counters: createCounterRepository(db),
    tasks: createTaskRepository(db),
    timeline: createTimelineRepository(db),
    sessions: createSessionRepository(db),
    messages: createMessageRepository(db),
    inbox: createInboxRepository(db),
    memberState: createMemberStateRepository(db),
    /** Runs `fn` in a single SQLite transaction. */
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
