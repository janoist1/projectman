import type { ErrorCode } from '../api/error-codes';
import { operatorApprovalOf, operatorKnowledgeApprovalOf } from '../api/dto';
import type { ResolveInboxRequest } from '../api/dto';
import { approvalRefusal } from '../config/labels';
import { memberOf } from '../config/lookup';
import { RETIRED_OPERATOR_HANDLE } from '../config/operator-member';
import type { ProjectConfig } from '../config/schema';
import { hasBoundOrigin, hasConnectedOrigin } from './actor-origin';
import type { Actor } from './event';
import {
  canResolveInboxItem,
  externalQuestionAnswerRefusal,
  gateRequestOf,
  hasProtectedQuestionPayload,
  isIntegratorInboxItem,
  isIntegratorTodo,
  questionPayloadOf,
  superDecisionRefusal,
  TODO_CANNOT_OPTION,
  TODO_DONE_OPTION,
} from './inbox';
import type { InboxItem } from './inbox';
import type { HumanAccess } from './member';
import type { Task } from './task';

/** Who resolves an inbox item: the person, and the integrator's origin when it acts for them. */
export interface InboxResolver {
  handle: string;
  access: HumanAccess;
  via?: 'integrator';
  /** The bound origin (an Operator or a connected Claude) of a step made on the owner's authority (PM-757). */
  superActor?: Actor;
}

export interface InboxResolveFacts {
  config: ProjectConfig;
  /**
   * The integrator credential the request runs under, null for a person's own login. `boundOrigin`: its live
   * actor is an Operator or a connected Claude, which may decide on the owner's authority (PM-875).
   */
  credential: { mode: 'read' | 'super'; boundOrigin: boolean } | null;
  /** The super endpoint closing the integrator's own todo (PM-806), not an answer. */
  integratorTodo?: boolean;
  /** The other pending questions of the item's group. */
  groupMembers: readonly InboxItem[];
  /** The member whose session asked an item. */
  sessionMemberOf: (item: InboxItem) => string | null | undefined;
  /** The item's card, for the label rules of a gate approval. */
  task: Pick<Task, 'assignee' | 'links'> | null;
}

export interface InboxResolveRefusal {
  status: 400 | 403 | 409;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

const ANSWERED_BY_OWNERS = ['question', 'alert', 'mention'];

const APPROVAL_REFUSALS = {
  not_an_assignee: 'the current gate does not authorize this approver',
  release_four_eyes: 'release approval requires an independent human',
  self_review_forbidden: 'the assignee and PR authors cannot set this label',
} as const;

const refused = (
  status: InboxResolveRefusal['status'],
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): InboxResolveRefusal => ({ status, code, message, ...(details ? { details } : {}) });

/**
 * Whether a decision stays reserved to the owner's own login on a super step (PM-883). What the connected Claude
 * asked itself (the holder's name is its source) stays reserved, and so does what the retired Operator asked
 * (decision 66): its member is gone, its items remain.
 */
export function reservedSuperDecisionRefusal(
  item: Pick<InboxItem, 'kind' | 'payload' | 'source'>,
  actorHandle: string | null,
  sessionMember: string | null | undefined,
): 'owner_approval_required' | null {
  if (item.source === RETIRED_OPERATOR_HANDLE || sessionMember === RETIRED_OPERATOR_HANDLE)
    return 'owner_approval_required';
  return superDecisionRefusal(item, { operatorHandle: actorHandle, sessionMember });
}

/**
 * Why `resolver` may not resolve `item` with `request`, or null when they may (S-03). The one authority rule of
 * the server's inbox and the web's fake; the callers keep only the identity binding before it and the effects
 * (deciders, delivery, closing) after it.
 */
export function inboxResolveRefusal(
  item: InboxItem,
  request: ResolveInboxRequest,
  resolver: InboxResolver,
  facts: InboxResolveFacts,
): InboxResolveRefusal | null {
  const { credential } = facts;
  if (credential?.mode === 'read')
    return refused(403, 'integrator_read_only', 'a read credential cannot decide');
  const superScope = credential?.mode === 'super';
  const ownLogin = !credential && !resolver.via && !hasBoundOrigin(resolver.superActor);
  const superDecision = superScope && credential.boundOrigin && hasBoundOrigin(resolver.superActor);
  if (superScope && !superDecision)
    return refused(403, 'owner_approval_required', 'a decision requires a person using their own login');
  const delegated = !!resolver.via || !!resolver.superActor || !!credential;
  if (facts.integratorTodo) {
    if (!superScope || !resolver.superActor)
      return refused(
        403,
        'integrator_not_allowed',
        'only an explicit super credential resolves an integrator todo',
      );
    if (resolver.access !== 'owner')
      return refused(403, 'insufficient_access', 'a current project owner is required');
    if (item.state !== 'open') return refused(409, 'inbox_item_closed', 'the inbox item is closed');
    if (hasProtectedQuestionPayload(item))
      return refused(403, 'owner_approval_required', 'only a person may approve');
    if (!isIntegratorTodo(item))
      return refused(403, 'super_relay_refused', 'only a current integrator todo may be resolved');
    if (request.optionId !== TODO_DONE_OPTION.id && request.optionId !== TODO_CANNOT_OPTION.id)
      return refused(400, 'invalid_request', 'only todo result options are accepted');
  } else if (isIntegratorInboxItem(item) && (delegated || resolver.access !== 'owner')) {
    return refused(
      403,
      'super_relay_refused',
      'an integrator item needs the dedicated super endpoint or the owner login',
    );
  }
  // A permission is the owner's own decision; other decisions also take the Operator's on the owner's authority.
  if (
    item.kind === 'permission'
      ? !ownLogin
      : !ANSWERED_BY_OWNERS.includes(item.kind) && !ownLogin && !superDecision
  )
    return refused(403, 'owner_approval_required', 'a decision requires a person using their own login');
  if (request.attachmentIds !== undefined && item.kind !== 'question')
    return refused(400, 'invalid_request', 'only questions accept attachments', { field: 'attachmentIds' });
  if (item.state !== 'open')
    return refused(409, 'inbox_item_closed', `inbox item ${item.id} is ${item.state}`, {
      id: item.id,
      state: item.state,
    });
  const question = item.kind === 'question' ? questionPayloadOf(item) : null;
  // The owner's question about a super operation (PM-762) is answered by their own login only.
  if (question?.superOperation && (delegated || resolver.access !== 'owner'))
    return refused(403, 'owner_approval_required', 'Only the owner may decide this, using their own login', {
      kind: item.kind,
    });
  // A question the integrator asked itself (PM-784) is answered by an owner's own login.
  const via = resolver.via ?? (credential ? 'integrator' : undefined);
  const askedRefusal =
    item.kind === 'question'
      ? externalQuestionAnswerRefusal(item.payload, { via, superActor: resolver.superActor })
      : null;
  if (askedRefusal)
    return refused(
      403,
      superScope ? 'owner_approval_required' : askedRefusal,
      askedRefusal === 'super_relay_refused'
        ? 'The integrator cannot answer its own question'
        : 'Only the owner may decide this, using their own login',
    );
  if (superScope) {
    const actor = resolver.superActor!;
    // A connected step on a member's queue item is named for the issuer, so it relays nothing for the holder.
    if (hasConnectedOrigin(actor) && actor.kind !== 'human')
      return refused(403, 'owner_approval_required', 'this item requires a person using their own login');
    // Every pending group member must be decidable.
    for (const member of [item, ...facts.groupMembers]) {
      const reserved = reservedSuperDecisionRefusal(member, actor.handle, facts.sessionMemberOf(member));
      const asked =
        member.kind === 'question' &&
        externalQuestionAnswerRefusal(member.payload, { via, superActor: actor });
      if (reserved || asked)
        return refused(403, 'owner_approval_required', 'this item requires a person using their own login');
    }
  }
  if (operatorApprovalOf(item))
    return refused(409, 'inbox_item_closed', 'Operator approvals have been retired');
  if (operatorKnowledgeApprovalOf(item)?.stale && request.optionId !== 'dismiss')
    return refused(409, 'operator_knowledge_stale', 'the knowledge proposal is stale; dismiss it');
  if (!item.options.some((option) => option.id === request.optionId))
    return refused(400, 'unknown_option', `unknown option: ${request.optionId}`);
  if (memberOf(facts.config, resolver.handle)?.kind !== 'human')
    return refused(403, 'ai_approval_forbidden', 'only human members may resolve inbox items');
  const gate = item.kind === 'decision' && request.optionId === 'approve' ? gateRequestOf(item) : null;
  if (gate?.label) {
    // Approving puts the label on in the approver's name: the label rules apply up front.
    const refusal = approvalRefusal(facts.config, gate.label, resolver.handle, facts.task);
    if (refusal) return refused(403, refusal, APPROVAL_REFUSALS[refusal]);
  }
  if (!canResolveInboxItem(resolver, item))
    return refused(403, 'not_an_assignee', 'only the assignees may resolve this item');
  const note = request.note?.trim();
  if (item.kind === 'question' && request.optionId === 'answer' && !note && !request.attachmentIds?.length)
    return refused(400, 'answer_required', 'a free-text answer needs a note');
  if (item.kind === 'question' && request.optionId === TODO_CANNOT_OPTION.id && !note)
    return refused(400, 'todo_reason_required', 'say why the task cannot be done');
  if (item.kind === 'release')
    return refused(409, 'inbox_item_closed', 'release approvals have been retired');
  // Files go back to an AI member's session or an integrator's question; a group's answer carries them to all.
  if (
    request.attachmentIds?.length &&
    !question?.group &&
    (question?.superOperation ||
      (!question?.externalQuestion && memberOf(facts.config, item.source)?.kind !== 'ai'))
  )
    return refused(400, 'invalid_request', 'only AI questions accept attachments', {
      field: 'attachmentIds',
    });
  return null;
}
