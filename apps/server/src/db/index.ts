import { createAttachmentRepository } from './attachments';
import { createMessageAttachmentRepository } from './message-attachments';
export type {
  MessageAttachmentRecord,
  MessageAttachmentState,
  StoredMessageAttachment,
} from './message-attachments';
import { createEngineRepository } from './engines';
export type { EngineRecord } from './engines';
import { createIntegratorKeyRepository } from './integrator-keys';
import { createSuperAuditRepository } from './super-audit';
import { createBoundaryRepository } from './boundary';
import { createFeedbackRepository } from './feedback';
export type {
  FeedbackEventRecord,
  FeedbackLaunchCodeRecord,
  FeedbackMarkPatch,
  FeedbackMarkRecord,
  FeedbackMarkStats,
  FeedbackSessionRecord,
  StoredFeedbackScreenshot,
} from './feedback';
import { createFullTestRunRepository } from './full-test-runs';
import { createEmailLoginRepository } from './email-login';
export { EMAIL_LOGIN_MAX_FAILED_ATTEMPTS } from './email-login';
export type { EmailLoginCodeRecord, EmailLoginEventKind } from './email-login';
import { createInvitationRepository } from './invitations';
export type { InvitationRecord } from './invitations';
import type { Db } from './database';
import { createDeferredStartRepository } from './deferred-starts';
import { createDecisionOfferRepository } from './decision-offers';
export type { DecisionCandidateState, DecisionOfferRecord, DecisionVerdict } from './decision-offers';
import { createDocWriteRepository } from './doc-writes';
export type { DocWriteEdit, DocWritePatch, DocWriteRecord, DocWriteState } from './doc-writes';
import { createMemberWorkspaceRepository } from './member-workspaces';
import { createInboxRepository } from './inbox';
import { createMemberStateRepository } from './member-state';
import { createMessageRepository } from './messages';
import { createCounterRepository, createProjectRepository } from './projects';
import { createOperatorRequestRepository } from './operator-requests';
import { createOperatorSignalRepository } from './operator-signals';
export type { OperatorSignalRecord } from './operator-signals';
import { createPauseRepository } from './pauses';
import { createProjectFocusRepository } from './project-focus';
import { createReleaseDeploymentRepository } from './release-deployments';
import { createReleaseRepository } from './releases';
import { createReviewPinRepository } from './review-pins';
import { createTaskMergeRepository, createTaskHandoverRepository } from './task-merges';
import { createMergeTrainRepository } from './merge-trains';
export type { MergeTrainMember, MergeTrainRecord } from './merge-trains';
export { mergeState, mergedState } from './task-merges';
export type { MergeRecord } from './task-merges';
import { createScheduleRepository } from './schedules';
import { createSeniorWaitRepository } from './senior-waits';
import { createSessionRepository } from './sessions';
import { createSessionCleanupRepository } from './session-cleanups';
export type { SessionCleanupFailure } from './session-cleanups';
import { createTaskCoverRepository } from './task-covers';
import { createTaskFixLimitRepository } from './fix-limits';
import { createTaskHandoffRepository } from './task-handoffs';
import { createTaskLoopRepository } from './task-loops';
import { createTaskRepository } from './tasks';
import { createTaskHandOnRepository } from './task-hand-ons';
import { createTimelineRepository } from './timeline';
import { createTokenUsageRepository } from './token-usage';
import { createAuthSessionRepository, createUserRepository } from './users';

export { openDatabase, migrate, schemaVersion } from './database';
export type { Db } from './database';
export { LATEST_SCHEMA_VERSION, migrations } from './migrations';
export type { AttachmentRecord, AttachmentState, StoredAttachment } from './attachments';
export type { DeferredStartRecord } from './deferred-starts';
export type { StoredSuperAudit } from './super-audit';
export type { MemberWorkspaceRecord, TaskWorkspaceBinding, WorkspaceHolder } from './member-workspaces';
export type { OperatorRequestRecord, OperatorStepRecord } from './operator-requests';
export type { PauseRecord, SessionPauseRecord, SessionPausePatch } from './pauses';
export type { ReviewPinRecord } from './review-pins';
export type { DeploymentRequestRecord } from './release-deployments';
export type { TaskCoverRecord } from './task-covers';
export type { TaskFixLimitRecord } from './fix-limits';
export type { FullTestRunRecord } from './full-test-runs';
export type { TaskLoopRecord } from './task-loops';
export type { TaskHandoffRow } from './task-handoffs';
export type { SeniorWaitDecision, SeniorWaitEndReason, SeniorWaitRecord } from './senior-waits';
export type { UserRecord, AuthSessionRecord } from './users';
export type { ProjectRecord } from './projects';
export type { MemberStateRecord } from './member-state';
export type { PullRequestLinkRef, TaskPatch } from './tasks';
export { encodeWorkItem, decodeWorkItem } from './sessions';

/** All repositories over one database connection. */
export function createRepositories(db: Db) {
  return {
    db,
    engines: createEngineRepository(db),
    users: createUserRepository(db),
    integratorKeys: createIntegratorKeyRepository(db),
    superAudit: createSuperAuditRepository(db),
    invitations: createInvitationRepository(db),
    emailLogin: createEmailLoginRepository(db),
    authSessions: createAuthSessionRepository(db),
    projects: createProjectRepository(db),
    counters: createCounterRepository(db),
    tasks: createTaskRepository(db),
    taskHandOns: createTaskHandOnRepository(db),
    timeline: createTimelineRepository(db),
    attachments: createAttachmentRepository(db),
    messageAttachments: createMessageAttachmentRepository(db),
    sessions: createSessionRepository(db),
    tokenUsage: createTokenUsageRepository(db),
    reviewPins: createReviewPinRepository(db),
    taskMerges: createTaskMergeRepository(db),
    mergeTrains: createMergeTrainRepository(db),
    releases: createReleaseRepository(db),
    releaseDeployments: createReleaseDeploymentRepository(db),
    taskHandovers: createTaskHandoverRepository(db),
    taskCovers: createTaskCoverRepository(db),
    taskLoops: createTaskLoopRepository(db),
    taskFixLimits: createTaskFixLimitRepository(db),
    taskHandoffs: createTaskHandoffRepository(db),
    projectFocus: createProjectFocusRepository(db),
    operatorRequests: createOperatorRequestRepository(db),
    operatorSignals: createOperatorSignalRepository(db),
    seniorWaits: createSeniorWaitRepository(db),
    pauses: createPauseRepository(db),
    fullTestRuns: createFullTestRunRepository(db),
    docWrites: createDocWriteRepository(db),
    decisionOffers: createDecisionOfferRepository(db),
    schedules: createScheduleRepository(db),
    deferredStarts: createDeferredStartRepository(db),
    memberWorkspaces: createMemberWorkspaceRepository(db),
    sessionCleanups: createSessionCleanupRepository(db),
    messages: createMessageRepository(db),
    inbox: createInboxRepository(db),
    boundary: createBoundaryRepository(db),
    memberState: createMemberStateRepository(db),
    feedback: createFeedbackRepository(db),
    /** Runs `fn` in a single SQLite transaction. */
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
