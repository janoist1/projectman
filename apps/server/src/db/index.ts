import { createAttachmentRepository } from './attachments';
import { createBoundaryRepository } from './boundary';
import { createEgressRepository } from './egress';
import { createFullTestRunRepository } from './full-test-runs';
import { createInvitationRepository } from './invitations';
import type { Db } from './database';
import { createDeferredStartRepository } from './deferred-starts';
import { createMemberWorkspaceRepository } from './member-workspaces';
import { createInboxRepository } from './inbox';
import { createMemberStateRepository } from './member-state';
import { createMessageRepository } from './messages';
import { createCounterRepository, createProjectRepository } from './projects';
import { createReviewPinRepository } from './review-pins';
import { createScheduleRepository } from './schedules';
import { createSessionRepository } from './sessions';
import { createTaskCoverRepository } from './task-covers';
import { createTaskFixLimitRepository } from './fix-limits';
import { createTaskLoopRepository } from './task-loops';
import { createTaskRepository } from './tasks';
import { createTimelineRepository } from './timeline';
import { createTokenUsageRepository } from './token-usage';
import { createAuthSessionRepository, createUserRepository } from './users';

export { openDatabase, migrate, schemaVersion } from './database';
export type { Db } from './database';
export { LATEST_SCHEMA_VERSION, migrations } from './migrations';
export type { AttachmentRecord, AttachmentState, StoredAttachment } from './attachments';
export type { DeferredStartRecord } from './deferred-starts';
export type { MemberWorkspaceRecord, TaskWorkspaceBinding, WorkspaceHolder } from './member-workspaces';
export type { ReviewPinRecord } from './review-pins';
export type { TaskCoverRecord } from './task-covers';
export type { TaskFixLimitRecord } from './fix-limits';
export type { FullTestRunRecord } from './full-test-runs';
export type { TaskLoopRecord } from './task-loops';
export type { UserRecord, AuthSessionRecord } from './users';
export type { ProjectRecord } from './projects';
export type { MemberStateRecord } from './member-state';
export type { PullRequestLinkRef, TaskPatch } from './tasks';
export { encodeWorkItem, decodeWorkItem } from './sessions';

/** All repositories over one database connection. */
export function createRepositories(db: Db) {
  return {
    db,
    users: createUserRepository(db),
    invitations: createInvitationRepository(db),
    authSessions: createAuthSessionRepository(db),
    projects: createProjectRepository(db),
    counters: createCounterRepository(db),
    tasks: createTaskRepository(db),
    timeline: createTimelineRepository(db),
    attachments: createAttachmentRepository(db),
    sessions: createSessionRepository(db),
    tokenUsage: createTokenUsageRepository(db),
    reviewPins: createReviewPinRepository(db),
    taskCovers: createTaskCoverRepository(db),
    taskLoops: createTaskLoopRepository(db),
    taskFixLimits: createTaskFixLimitRepository(db),
    fullTestRuns: createFullTestRunRepository(db),
    schedules: createScheduleRepository(db),
    deferredStarts: createDeferredStartRepository(db),
    memberWorkspaces: createMemberWorkspaceRepository(db),
    messages: createMessageRepository(db),
    inbox: createInboxRepository(db),
    boundary: createBoundaryRepository(db),
    egress: createEgressRepository(db),
    memberState: createMemberStateRepository(db),
    /** Runs `fn` in a single SQLite transaction. */
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
