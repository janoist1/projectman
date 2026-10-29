import type { FastifyBaseLogger } from 'fastify';
import type { ServerEvent } from '@projectman/shared';
import { getTemplate, templates } from '@projectman/templates';
import type { ProjectTemplate } from '@projectman/templates';
import type { EventBus } from '../../contracts';
import type { Repositories } from '../../db';
import { ChangeJournal } from './change-journal';
import { createDomainEvents } from './events';
import type { DomainEvents } from './events';

/** What every domain service gets. */
export interface DomainContext {
  repos: Repositories;
  /** Publishes to the websocket; inside a unit of work, events wait for its commit. */
  bus: EventBus;
  /** What happens inside the domain, for the services that react to it (never sent to clients). */
  events: DomainEvents;
  logger: FastifyBaseLogger;
  now: () => Date;
  /** The durable change journal (PM-761); `journal.record` belongs inside the unit of work of the change. */
  journal: ChangeJournal;
  /**
   * Runs `fn` as one unit of work: its writes are one SQLite transaction and the events it
   * publishes go out only once that commits (a failure rolls back both). `fn` is synchronous
   * (better-sqlite3 transactions are), so read what needs an await before; units of work nest.
   */
  unitOfWork<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T;
  /**
   * Runs `fn` once the enclosing unit of work has committed (dropped on a rollback), at once outside
   * one. For what must not be told before the change is durable: the domain events.
   */
  afterCommit(fn: () => void): void;
}

export function createDomainContext(deps: {
  repos: Repositories;
  bus: EventBus;
  logger: FastifyBaseLogger;
  now: () => Date;
}): DomainContext {
  // Events and callbacks held inside the open units of work, innermost last.
  const pending: (ServerEvent | (() => void))[][] = [];
  const bus: EventBus = {
    publish(event) {
      const buffer = pending.at(-1);
      // A queue change only says "read the queue again": one per unit of work and member is enough (PM-894).
      if (
        buffer &&
        event.type === 'member_queue_changed' &&
        buffer.some(
          (e) =>
            typeof e !== 'function' &&
            e.type === event.type &&
            e.projectKey === event.projectKey &&
            e.member === event.member,
        )
      )
        return;
      if (buffer) buffer.push(event);
      else deps.bus.publish(event);
    },
    subscribe: (listener) => deps.bus.subscribe(listener),
  };
  return {
    repos: deps.repos,
    bus,
    events: createDomainEvents(deps.logger),
    logger: deps.logger,
    now: deps.now,
    journal: new ChangeJournal(deps.repos, deps.now),
    afterCommit(fn) {
      const buffer = pending.at(-1);
      if (buffer) buffer.push(fn);
      else fn();
    },
    unitOfWork<T>(fn: () => T): T {
      const buffer: (ServerEvent | (() => void))[] = [];
      pending.push(buffer);
      let result: T;
      try {
        result = deps.repos.transaction(fn);
      } finally {
        pending.pop();
      }
      // Committed, or released into the enclosing unit of work, which publishes on its commit.
      const outer = pending.at(-1);
      if (outer) outer.push(...buffer);
      else for (const item of buffer) typeof item === 'function' ? item() : deps.bus.publish(item);
      return result;
    },
  };
}

export function isoNow(ctx: Pick<DomainContext, 'now'>): string {
  return ctx.now().toISOString();
}

/** Source of project templates; the default reads @projectman/templates, tests inject their own. */
export interface TemplateRegistry {
  list(): ProjectTemplate[];
  get(id: string): ProjectTemplate | undefined;
}

export const defaultTemplateRegistry: TemplateRegistry = {
  list: () => templates,
  get: (id) => getTemplate(id),
};

export function createTemplateRegistry(list: ProjectTemplate[]): TemplateRegistry {
  return { list: () => list, get: (id) => list.find((t) => t.id === id) };
}
