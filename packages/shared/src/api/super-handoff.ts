import { z } from 'zod';
import { AdministrationCommandSchema } from './administration';
import { Actor } from '../domain/event';
import { MemberHandle } from '../domain/member';
import { TaskKey } from '../domain/task';
import {
  CreateInviteRequest,
  OperatorOperation,
  OrderMergeQueueRequest,
  StartMergeRequest,
  UpdateMemberRequest,
} from './dto';

/**
 * The durable hand-over of an owner-reserved or too-large piece of work from the base Operator to the
 * super-mode integrator (PM-762). Handing over grants no right to execute and no approval: it only records
 * what was asked, by whom and why, so that the integrator can pick it up later, even after a restart.
 */

/** The closed, versioned set of commands a handoff and its operation can carry. */
export const SuperCommand = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('operate'), operation: OperatorOperation }),
  z.strictObject({ kind: z.literal('member_update'), handle: MemberHandle, request: UpdateMemberRequest }),
  z.strictObject({ kind: z.literal('invite_create'), request: CreateInviteRequest }),
  z.strictObject({ kind: z.literal('merge'), taskKey: TaskKey, request: StartMergeRequest }),
  z.strictObject({ kind: z.literal('merge_order'), ...OrderMergeQueueRequest.shape }),
  z.strictObject({ kind: z.literal('administration'), request: AdministrationCommandSchema }),
]);
export type SuperCommand = z.infer<typeof SuperCommand>;

export const SUPER_STATES = [
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
export const SUPER_OPEN_STATES: readonly SuperState[] = ['pending', 'waiting_owner', 'running'];

export const SUPER_REASON_MAX = 2000;

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

/** The hand-over from the base Operator (MCP `request_super_operation`). */
export const RequestSuperOperationRequest = z.strictObject({
  taskKey: TaskKey.optional(),
  reason: z.string().trim().min(1).max(SUPER_REASON_MAX),
  command: SuperCommand,
  expectedConfigVersion: z.string().min(1).optional(),
  requestId: z.uuid(),
});
export type RequestSuperOperationRequest = z.infer<typeof RequestSuperOperationRequest>;

export const SUPER_HANDOFF_LIST_LIMIT_MAX = 100;
export const ListSuperHandoffsQuery = z.strictObject({
  state: SuperState.optional(),
  limit: z.coerce.number().int().min(1).max(SUPER_HANDOFF_LIST_LIMIT_MAX).default(50),
});
export type ListSuperHandoffsQuery = z.infer<typeof ListSuperHandoffsQuery>;

export const ListSuperHandoffsResponse = z.strictObject({ handoffs: z.array(SuperHandoff) });
export type ListSuperHandoffsResponse = z.infer<typeof ListSuperHandoffsResponse>;

export const ExecuteSuperHandoffRequest = z.strictObject({ requestId: z.uuid() });
export type ExecuteSuperHandoffRequest = z.infer<typeof ExecuteSuperHandoffRequest>;

export const ExecuteSuperHandoffResponse = z.strictObject({ operation: SuperOperation });
export type ExecuteSuperHandoffResponse = z.infer<typeof ExecuteSuperHandoffResponse>;

/** Answers an open, simple information question for the owner (PM-762); it is not an owner decision. */
export const RELAY_ANSWER_MAX = 20_000;
export const RelayOwnerAnswerRequest = z.strictObject({
  answer: z.string().trim().min(1).max(RELAY_ANSWER_MAX),
});
export type RelayOwnerAnswerRequest = z.infer<typeof RelayOwnerAnswerRequest>;
