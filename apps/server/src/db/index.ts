import { createAttachmentRepository } from './attachments';
import { createChecklistRepository } from './checklist';
import { createEmailChannelRepository } from './email-channel';
export type { EmailMessageRecord } from './email-channel';
import { createWebPushRepository } from './web-push';
export { pushDeviceView } from './web-push';
export type { PushDeviceRecord } from './web-push';
import { createMessageAttachmentRepository } from './message-attachments';
export type { MessageAttachmentRecord, MessageAttachmentState } from './message-attachments';
import { createEngineRepository } from './engines';
export type { EngineRecord } from './engines';
import { createProjectEngineRepository } from './project-engines';
import { createIntegratorKeyRepository } from './integrator-keys';
import { createIntegratorKeyAuditRepository } from './integrator-key-audit';
import { createSuperAuditRepository } from './super-audit';
import { createSuperHandoffRepository } from './super-handoffs';
export type { StoredSuperOperation } from './super-handoffs';
import { createFeedbackRepository } from './feedback';
import { createSystemFeedbackRepository } from './system-feedback';
export type { SystemFeedbackItemRecord } from './system-feedback';
export type {
  FeedbackEventRecord,
  FeedbackMarkRecord,
  FeedbackMarkStats,
  StoredFeedbackScreenshot,
} from './feedback';
import { createHistoryRepository } from './history';
export { HISTORY_INDEX_VERSION, historyDocumentEntityId, historySourceId } from './history';
export type { HistoryDirtyRow, HistoryDocStateRow, HistoryDocumentRow } from './history';
export { createHistorySemanticRepository, historyContentHash, historyFullText } from './history-semantic';
import { createHistorySearchRepository } from './history-searches';
import { createFullTestRunRepository } from './full-test-runs';
import { createMergeCheckRunRepository } from './merge-check-runs';
import { createEmailLoginRepository } from './email-login';
export { EMAIL_LOGIN_MAX_FAILED_ATTEMPTS } from './email-login';
export type { EmailLoginCodeRecord, EmailLoginEventKind } from './email-login';
import { createInvitationRepository } from './invitations';
import { createHostRequestRepository } from './host-requests';
export type { HostRequestRecord } from './host-requests';
import { createOwnerAccountRepository } from './owner-accounts';
import { createOwnerInvitationRepository } from './owner-invitations';
export type { OwnerInvitationRecord } from './owner-invitations';
import type { Db } from './database';
import { createDeferredStartRepository } from './deferred-starts';
import { createDecisionOfferRepository } from './decision-offers';
import { createDocWriteRepository } from './doc-writes';
export type { DocWriteEdit, DocWritePatch, DocWriteRecord } from './doc-writes';
import { createMemberWorkspaceRepository } from './member-workspaces';
import { createInboxRepository } from './inbox';
import { createMemberHandleRepository } from './member-handles';
import { createMemberStateRepository } from './member-state';
import { createMessageRepository } from './messages';
import { createMemberQueueRepository } from './member-queue';
export type {
  MemberQueueSourceKey,
  MemberQueueWaitDetails,
  NewMemberQueueItem,
  StoredMemberQueueItem,
} from './member-queue';
import { createCounterRepository, createProjectRepository } from './projects';
import { createOperatorRequestRepository } from './operator-requests';
import { createOperatorSignalRepository } from './operator-signals';
export type { OperatorSignalRecord } from './operator-signals';
import { createPauseRepository } from './pauses';
import { createProjectChangeEventRepository } from './project-change-events';
import { createReleasePublicationRepository } from './release-publications';
import { createReleaseRepository } from './releases';
import { createReviewPinRepository } from './review-pins';
import { createTaskMergeRepository, createTaskHandoverRepository } from './task-merges';
import { createMergeTrainRepository } from './merge-trains';
export type { MergeTrainMember, MergeTrainRecord } from './merge-trains';
export { mergeState, mergedState } from './task-merges';
export type { MergeRecord } from './task-merges';
import { createScheduleRepository } from './schedules';
import { createObligationRepository } from './obligations';
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

export { openAuxiliaryDatabase, openDatabase, migrate, schemaVersion, statementCount } from './database';
export type { Db } from './database';
export { LATEST_SCHEMA_VERSION, migrations } from './migrations';
export type { AttachmentRecord } from './attachments';
export type { DeferredStartRecord } from './deferred-starts';
export type { StoredSuperAudit } from './super-audit';
export type { MemberWorkspaceRecord, TaskWorkspaceBinding, WorkspaceHolder } from './member-workspaces';
export type { OperatorRequestRecord, OperatorStepRecord } from './operator-requests';
export type { PauseRecord, SessionPauseRecord } from './pauses';
export type { ReviewPinRecord } from './review-pins';
export type { TaskFixLimitRecord } from './fix-limits';
export type { FullTestRunRecord } from './full-test-runs';
export type { MergeCheckRunQuery, MergeCheckRunStart } from './merge-check-runs';
export type { TaskLoopRecord } from './task-loops';
export type { TaskHandoffRow } from './task-handoffs';
export type { SeniorWaitEndReason, SeniorWaitRecord } from './senior-waits';
export type { UserRecord } from './users';
export type { ProjectRecord } from './projects';
export type { TaskPatch } from './tasks';
export { encodeWorkItem, decodeWorkItem } from './sessions';
export type { TaskSessionActivity } from './sessions';

/** All repositories over one database connection. */
export function createRepositories(db: Db) {
  return {
    checklists: createChecklistRepository(db),
    db,
    webPush: createWebPushRepository(db),
    engines: createEngineRepository(db),
    projectEngines: createProjectEngineRepository(db),
    users: createUserRepository(db),
    integratorKeys: createIntegratorKeyRepository(db),
    integratorKeyAudit: createIntegratorKeyAuditRepository(db),
    superAudit: createSuperAuditRepository(db),
    superHandoffs: createSuperHandoffRepository(db),
    invitations: createInvitationRepository(db),
    hostRequests: createHostRequestRepository(db),
    ownerAccounts: createOwnerAccountRepository(db),
    ownerInvitations: createOwnerInvitationRepository(db),
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
    releasePublications: createReleasePublicationRepository(db),
    taskHandovers: createTaskHandoverRepository(db),
    taskCovers: createTaskCoverRepository(db),
    taskLoops: createTaskLoopRepository(db),
    taskFixLimits: createTaskFixLimitRepository(db),
    taskHandoffs: createTaskHandoffRepository(db),
    projectChanges: createProjectChangeEventRepository(db),
    operatorRequests: createOperatorRequestRepository(db),
    operatorSignals: createOperatorSignalRepository(db),
    seniorWaits: createSeniorWaitRepository(db),
    obligations: createObligationRepository(db),
    pauses: createPauseRepository(db),
    fullTestRuns: createFullTestRunRepository(db),
    mergeCheckRuns: createMergeCheckRunRepository(db),
    docWrites: createDocWriteRepository(db),
    decisionOffers: createDecisionOfferRepository(db),
    schedules: createScheduleRepository(db),
    deferredStarts: createDeferredStartRepository(db),
    memberWorkspaces: createMemberWorkspaceRepository(db),
    sessionCleanups: createSessionCleanupRepository(db),
    messages: createMessageRepository(db),
    memberQueue: createMemberQueueRepository(db),
    inbox: createInboxRepository(db),
    memberState: createMemberStateRepository(db),
    memberHandles: createMemberHandleRepository(db),
    feedback: createFeedbackRepository(db),
    systemFeedback: createSystemFeedbackRepository(db),
    emailChannel: createEmailChannelRepository(db),
    history: createHistoryRepository(db),
    historySearches: createHistorySearchRepository(db),
    /** Runs `fn` in a single SQLite transaction. */
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
