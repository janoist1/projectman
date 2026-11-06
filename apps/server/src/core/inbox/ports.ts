import type {
  AlertPayload,
  InboxItem,
  IntegratorChannel,
  MemberHandle,
  ProjectConfig,
  SystemNotice,
} from '@projectman/shared';

/**
 * Where an alert of the `owner_messages` class goes (PM-1250): a `system_notice` message to the recipients'
 * general conversation, with no push and no inbox item. `core/messages` implements it (it depends on this module,
 * not the other way round); the failure to send is the sink's to log, the alert's caller goes on.
 */
export interface AlertNoticeSink {
  send(input: { projectKey: string; recipients: readonly string[]; notice: SystemNotice }): Promise<void>;
}

/**
 * Where an alert of the `pm` class goes (PM-1250): the project manager's signal of the same case. The signal is
 * idempotent per case, so raising it again for a case that is open changes nothing. `services/coordination`
 * implements it.
 */
export interface AlertPmSignals {
  raise(projectKey: string, alert: Extract<AlertPayload, { alert: 'relation_check' | 'work_outage' }>): void;
}

/** A connected Claude as the work queues show it (PM-1294): a live super key of an owner, never its token. */
interface IntegratorConnection {
  ownerHandle: MemberHandle;
  keyId: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedChannel: IntegratorChannel | null;
}

/**
 * Whether integrator work stays on its side: an owner has a live super key, so a connected client can work it
 * (PM-1045). `connections` lists those keys and `onChange` hears of a key created or revoked (PM-1294); a port
 * without them has no connection state to show.
 */
export interface IntegratorTodoAccess {
  available(config: ProjectConfig): boolean;
  connections?(config: ProjectConfig): IntegratorConnection[];
  onChange?(listener: () => void): () => void;
}

/** Records all original answers and their durable messages in one unit of work, before delivery. */
export type QuestionGroupAnswerer = (
  items: InboxItem[],
  attachmentIds: readonly string[],
  close: () => void,
) => Promise<void>;

/**
 * Whether the machine a member's sessions run on is reachable (PM-708). `online`: its link is up; `offline`:
 * known but not connected; `unknown`: no machine is chosen. `lastConfirmedOnlineAt` is the last moment the
 * server recorded the machine online (null: never recorded). The state is data of the link, not a member setting.
 */
export interface ScreeningEngineState {
  read(
    projectKey: string,
    member: MemberHandle,
  ): { state: 'online' | 'offline' | 'unknown'; lastConfirmedOnlineAt: string | null };
}
