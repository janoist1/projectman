import type { FastifyBaseLogger } from 'fastify';
import type {
  Actor,
  EgressAllowance,
  InboxItem,
  Session,
  Task,
  TimelineEvent,
  WorkItemRef,
} from '@projectman/shared';
import type { ConfigChange } from './projects';
import type { StageChange } from './tasks';

/**
 * What happens inside the domain, for the services that react to it. Internal only: what
 * clients see goes out through the event bus (the websocket) instead.
 */
export interface DomainEventMap {
  /** A configuration change was committed (also a project's creation or import). */
  config_changed: ConfigChange;
  /** A human resolved an inbox item. */
  inbox_resolved: InboxItem;
  /** A task entered another stage (after the change committed). */
  task_stage_changed: StageChange;
  /** A task was cancelled. */
  task_cancelled: Task;
  /** Someone other than the assignee put labels on a task that notify its assignee. */
  task_labels_notice: { task: Task; labels: string[]; actor: Actor; comment?: string };
  /** A task comment mentions members (never its author). */
  task_note_added: { event: TimelineEvent; mentions: string[] };
  /** A session's process started (a new or a resumed conversation). */
  session_started: Session;
  /** A session ended: it exited, was stopped, or failed (also to start). */
  session_ended: Session;
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
