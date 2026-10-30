import type {
  ExternalQuestionRead,
  ExternalToolOrigin,
  QuestionAttachment,
  QuestionOptionInput,
  QuestionRecipient,
  QuestionResponsePurpose,
} from '@projectman/shared';

/** Who asks a person a question (PM-784): a member in a session, or the integrator in super mode. */
export type HumanQuestionCaller =
  | { kind: 'member'; member: string; sessionId: string | null }
  | { kind: 'external'; origin: ExternalToolOrigin };

/** The question as the caller wrote it; the caller's own tool boundary has already parsed it. */
export interface HumanQuestionInput {
  question: string;
  options?: QuestionOptionInput[];
  /** The card the question is about; a member's session card is resolved by its tool, never here. */
  taskKey?: string | null;
  to?: string[];
  recommended?: string;
  recommendationReason?: string;
  details?: string;
  attachmentIds?: string[];
  responsePurpose?: QuestionResponsePurpose;
  /** Member questions only. */
  recipient?: QuestionRecipient;
  reaskOf?: string;
  reaskReason?: string;
  /** Member questions only: the owner topic of the coordinator's own decision question or of a re-ask (PM-1190). */
  ownerTopic?: string;
  /** The system signal the question is about (PM-455); the caller's tool has checked it. */
  signalId?: string;
}

export interface AskedHuman {
  inboxItemId: string;
  approvalLabel?: string;
  attachments?: QuestionAttachment[];
  /** A member's question waits for the Operator's screening before the people see it (PM-558). */
  screening?: true;
}

/** The questions people are asked, for a member and for the integrator in super mode (PM-784). */
export interface HumanQuestionsPort {
  ask(projectKey: string, caller: HumanQuestionCaller, input: HumanQuestionInput): Promise<AskedHuman>;
  /** The question this key owner's integrator asked and its answer; any other question is `not_found`. */
  readExternal(projectKey: string, ownerUserId: string, itemId: string): ExternalQuestionRead;
  /** Withdraws the integrator's own open question. */
  withdrawExternal(
    projectKey: string,
    origin: ExternalToolOrigin,
    itemId: string,
    reason: string,
  ): Promise<{ itemId: string; state: 'cancelled' }>;
}
