import type { FastifyBaseLogger } from 'fastify';
import type { ServerEvent } from '@projectman/shared';
import { getTemplate, templates } from '@projectman/templates';
import type { ProjectTemplate } from '@projectman/templates';
import type { EventBus } from '../contracts';
import type { Repositories } from '../db';

/** What every domain service gets. */
export interface DomainContext {
  repos: Repositories;
  /** Publishes to the websocket; inside a unit of work, events wait for its commit. */
  bus: EventBus;
  logger: FastifyBaseLogger;
  now: () => Date;
  /**
   * Runs `fn` as one unit of work: its writes are one SQLite transaction and the events it
   * publishes go out only once that commits (a failure rolls back both). `fn` is synchronous
   * (better-sqlite3 transactions are), so read what needs an await before; units of work nest.
   */
  unitOfWork<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T;
}

export function createDomainContext(deps: {
  repos: Repositories;
  bus: EventBus;
  logger: FastifyBaseLogger;
  now: () => Date;
}): DomainContext {
  // Events published inside the open units of work, innermost last.
  const pending: ServerEvent[][] = [];
  const bus: EventBus = {
    publish(event) {
      const buffer = pending.at(-1);
      if (buffer) buffer.push(event);
      else deps.bus.publish(event);
    },
    subscribe: (listener) => deps.bus.subscribe(listener),
  };
  return {
    repos: deps.repos,
    bus,
    logger: deps.logger,
    now: deps.now,
    unitOfWork<T>(fn: () => T): T {
      const buffer: ServerEvent[] = [];
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
      else for (const event of buffer) deps.bus.publish(event);
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
