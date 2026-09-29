import type { FastifyBaseLogger } from 'fastify';
import { getTemplate, templates } from '@projectman/templates';
import type { ProjectTemplate } from '@projectman/templates';
import type { EventBus } from '../contracts';
import type { Repositories } from '../db';

/** What every domain service gets. */
export interface DomainContext {
  repos: Repositories;
  bus: EventBus;
  logger: FastifyBaseLogger;
  now: () => Date;
}

export function isoNow(ctx: DomainContext): string {
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
