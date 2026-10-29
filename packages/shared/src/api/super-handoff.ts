import { z } from 'zod';
import { OwnerCommandText } from './administration';
import { Actor } from '../domain/event';
import { MemberHandle } from '../domain/member';
import { TaskKey } from '../domain/task';
import {
  CreateInviteRequest,
  CreateTaskRequest,
  UpdateTaskRequest,
  ChangeTaskLabelsRequest,
  CancelTaskRequest,
  StartTaskRequest,
  ResolveInboxRequest,
  OperatorOperation,
  OrderMergeQueueRequest,
  StartMergeRequest,
  UpdateMemberRequest,
} from './dto';

/**
 * The super mode's commands and operations (PM-762, PM-764). The handoffs the retired base Operator recorded
 * (`SuperHandoff`) are no longer made; their rows and timeline events stay readable.
 */

const SUPER_REASON_MAX = 2000;

/** The closed, versioned set of commands a new operation can carry. */
export const NewSuperCommand = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('operate'), operation: OperatorOperation }),
  z.strictObject({ kind: z.literal('member_update'), handle: MemberHandle, request: UpdateMemberRequest }),
  z.strictObject({ kind: z.literal('invite_create'), request: CreateInviteRequest }),
  z.strictObject({ kind: z.literal('merge'), taskKey: TaskKey, request: StartMergeRequest }),
  z.strictObject({ kind: z.literal('merge_order'), ...OrderMergeQueueRequest.shape }),
  z.strictObject({ kind: z.literal('task_create'), request: CreateTaskRequest }),
  z.strictObject({ kind: z.literal('task_update'), taskKey: TaskKey, request: UpdateTaskRequest }),
  z.strictObject({ kind: z.literal('task_labels'), taskKey: TaskKey, request: ChangeTaskLabelsRequest }),
  z.strictObject({ kind: z.literal('task_start'), taskKey: TaskKey, request: StartTaskRequest }),
  z.strictObject({ kind: z.literal('task_cancel'), taskKey: TaskKey, request: CancelTaskRequest }),
  z.strictObject({
    kind: z.literal('inbox_resolve'),
    itemId: z.string().min(1),
    request: ResolveInboxRequest,
  }),
  z.strictObject({ kind: z.literal('credential_revoke'), keyId: z.string().min(1) }),
  /** Frees the workspace a failed process-scope cleanup keeps reserved, without proof that it stopped (PM-935). */
  z.strictObject({
    kind: z.literal('workspace_release'),
    scopeId: z.string().min(1).max(200),
    reason: OwnerCommandText.trim().min(1).max(SUPER_REASON_MAX),
  }),
]);
/** Stored operations from the retired supervisor remain readable, never executable. */
export type NewSuperCommand = z.infer<typeof NewSuperCommand>;
export const SuperCommand = z.discriminatedUnion('kind', [
  ...NewSuperCommand.options,
  z.strictObject({ kind: z.literal('administration'), request: z.unknown() }),
]);
export type SuperCommand = z.infer<typeof SuperCommand>;

const SUPER_STATES = [
  'pending',
  'waiting_owner',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
] as const;
export const SuperState = z.enum(SUPER_STATES);
export type SuperState = z.infer<typeof SuperState>;

/** A state nothing moves on from by itself: the record is finished (`unknown` waits for a human to look). */
export const SUPER_TERMINAL_STATES: readonly SuperState[] = ['succeeded', 'failed', 'cancelled', 'unknown'];

export const SuperHandoff = z.strictObject({
  id: z.string(),
  projectKey: z.string(),
  taskKey: TaskKey.nullable(),
  requestedBy: Actor,
  reason: z.string().min(1).max(SUPER_REASON_MAX),
  command: SuperCommand,
  expectedConfigVersion: z.string().nullable(),
  state: SuperState,
  operationId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SuperHandoff = z.infer<typeof SuperHandoff>;

export const SuperOperation = z.strictObject({
  id: z.string(),
  projectKey: z.string(),
  taskKey: TaskKey.nullable(),
  handoffId: z.string().nullable(),
  state: SuperState,
  requestId: z.uuid(),
  command: SuperCommand,
  ownerQuestionId: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SuperOperation = z.infer<typeof SuperOperation>;

/** Answers an open, simple information question for the owner (PM-762); it is not an owner decision. */
const RELAY_ANSWER_MAX = 20_000;
export const RelayOwnerAnswerRequest = z.strictObject({
  answer: z.string().trim().min(1).max(RELAY_ANSWER_MAX),
});
export type RelayOwnerAnswerRequest = z.infer<typeof RelayOwnerAnswerRequest>;
