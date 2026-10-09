import type { FastifyBaseLogger } from 'fastify';
import type {
  Actor,
  EgressAllowance,
  InboxItem,
  Session,
  Task,
  TaskRelationKind,
  TimelineEvent,
  WorkItemRef,
} from '@projectman/shared';
import type { ConfigChange } from './projects';
import type { SessionStartCause } from './sessions';
import type { StageChange } from './tasks';

/** A relation a card got, as that card sees it (`kind`), pointing at the card `ref`. */
export interface AddedRelation {
  taskKey: string;
  kind: TaskRelationKind;
  ref: string;
}

/**
 * What happens inside the domain, for the services that react to it. Internal only: what
 * clients see goes out through the event bus (the websocket) instead.
 */
export interface DomainEventMap {
  /** A configuration change was committed (also a project's creation or import). */
  config_changed: ConfigChange;
  /** A human resolved an inbox item. */
  inbox_resolved: InboxItem;
  /** Open items of a retired member were cancelled without a decision (questions among them). */
  inbox_cancelled: InboxItem;
  /** A member's tool question went to its AI decider (PM-169): the decider is woken to answer it. */
  permission_delegated: InboxItem;
  /** A task entered another stage (after the change committed). */
  task_stage_changed: StageChange;
  /** An operation put relations on cards (PM-421), after it committed; both cards of each, from their own side. */
  task_relations_added: { projectKey: string; actor: Actor; added: AddedRelation[] };
  /** A task's assignee changed (PM-262), after the change committed. `previous` is the one it had. */
  task_assigned: { task: Task; previous: string | null; actor: Actor };
  /** A card's recommended developer was set or changed (PM-347), after the change committed. */
  task_level_changed: { task: Task; actor: Actor };
  /** A task was cancelled. */
  task_cancelled: Task & { cancelledBy?: Actor };
  /** A prerequisite relation of this task was removed (PM-204): its start may no longer have to wait. */
  task_prerequisite_removed: Task;
  /** A task's labels changed (after the change committed): a start that waits for a label may go ahead (PM-236). */
  task_labels_changed: { task: Task; actor: Actor; previousLabels: string[] };
  /** Someone other than the assignee put labels on a task that notify its assignee. */
  task_labels_notice: { task: Task; labels: string[]; actor: Actor; comment?: string };
  /** A task's description was changed (PM-184): the sessions working the card are told. */
  task_description_changed: { task: Task; actor: Actor };
  /** A task comment mentions members (never its author). */
  task_note_added: { event: TimelineEvent; mentions: string[] };
  /** A team message or a note was recorded on a card (PM-186), imported comments included. */
  task_talk_recorded: { event: TimelineEvent };
  /** Work was recorded on a card (PM-431): a note, an attachment or a change of the description. */
  task_work_recorded: { event: TimelineEvent };
  /** A session's process started (a new or a resumed conversation). */
  session_started: Session;
  /** A task session started or resumed with `announce` (PM-249, not a restart): the card's other workers are told. */
  task_session_joined: { session: Session; resumed: boolean; cause: SessionStartCause | null };
  /** A session ended: it exited, was stopped, or failed (also to start). */
  session_ended: Session;
  /** A running session's turn ended: it idles, and its member may have capacity again (PM-119). */
  session_idle: Session;
  /**
   * A running session no longer waits for its restart into a new permission mode (PM-170) without
   * having restarted: the mode went back, or it cannot restart now (AI work off, the member on
   * leave). The messages held for it are typed in now.
   */
  session_input_released: Session;
  /** A stored message waits for an AI recipient that has no running session for its work item. */
  message_waiting: { projectKey: string; handle: string; workItem: WorkItemRef; messageId: string };
  /** An owner closed a network allowance (PM-140): the egress proxy ends its open tunnels. */
  egress_allowance_revoked: EgressAllowance;
  /** A member may no longer work in a project (removed, on leave, AI off): its tunnels end. */
  egress_member_inactive: { projectKey: string; member: string };
}

export type DomainEventType = keyof DomainEventMap;
export type DomainEventListener<K extends DomainEventType> = (
  event: DomainEventMap[K],
) => void | Promise<void>;

export interface DomainEvents {
  /** Adds a listener; returns its removal. Listeners run in the order they were added. */
  on<K extends DomainEventType>(type: K, listener: DomainEventListener<K>): () => void;
  /**
   * Runs the listeners one after the other, waiting for each that returns a promise; the
   * listeners before the first asynchronous one run before `emit` returns. A failing listener
   * is logged and never stops the others or the emitter.
   */
  emit<K extends DomainEventType>(type: K, event: DomainEventMap[K]): Promise<void>;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === 'function';
}

export function createDomainEvents(logger: FastifyBaseLogger): DomainEvents {
  const listeners = new Map<DomainEventType, Array<DomainEventListener<never>>>();
  const failed = (type: DomainEventType, err: unknown) =>
    logger.error({ err, event: type }, 'domain event listener failed');

  return {
    on(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener as DomainEventListener<never>);
      listeners.set(type, list);
      return () => {
        const current = listeners.get(type) ?? [];
        listeners.set(
          type,
          current.filter((l) => l !== listener),
        );
      };
    },
    emit(type, event) {
      const pending = [...(listeners.get(type) ?? [])] as Array<(event: unknown) => unknown>;
      const runFrom = (index: number): Promise<void> => {
        for (let i = index; i < pending.length; i++) {
          let result: unknown;
          try {
            result = pending[i]!(event);
          } catch (err) {
            failed(type, err);
            continue;
          }
          if (isPromiseLike(result))
            return Promise.resolve(result).then(
              () => runFrom(i + 1),
              (err: unknown) => {
                failed(type, err);
                return runFrom(i + 1);
              },
            );
        }
        return Promise.resolve();
      };
      return runFrom(0);
    },
  };
}
