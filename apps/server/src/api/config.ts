import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ProjectConfig, RevertConfigRequest, routes, PatchConfigRequest } from '@projectman/shared';
import type { ConfigView } from '@projectman/shared';
import type { Domain } from '../domain';
import { configInvalid } from '../domain/projects';
import { actorOf, authorOf, requireAccess } from './context';
import { parseBody } from './validation';

type ProjectParams = { Params: { key: string } };

/**
 * PUT body: either the whole ProjectConfig, or
 * { config, message? (commit message), baseVersion? (rejects stale edits with 409 config_conflict) }.
 * Only scripts use PUT; the settings UI patches (PATCH) and could replace it.
 */
const UpdateConfigBody = z.object({
  config: ProjectConfig,
  message: z.string().trim().min(1).max(500).optional(),
  baseVersion: z.string().optional(),
});

function isWrapped(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'config' in body && !('schemaVersion' in body);
}

/** Parses a configuration edit; schema violations are 400 config_invalid, like every invalid edit. */
function parseEdit<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw configInvalid('configuration does not match the schema', { schemaIssues: parsed.error.issues });
  }
  return parsed.data;
}

/**
 * Configuration edits (PUT, PATCH, revert) share one commit path in ProjectService: owner-only
 * rules, removed stages still in use (409 stage_in_use), invariants (400 config_invalid) and
 * stale versions (409 config_conflict).
 */
export function registerConfigRoutes(app: FastifyInstance, domain: Domain): void {
  const view = async (key: string): Promise<ConfigView> => {
    const { config, version } = await domain.projects.load(key);
    return { config, version, history: await domain.projects.history(key, 50) };
  };

  app.get<ProjectParams>(routes.config(':key'), async (request): Promise<ConfigView> => {
    await requireAccess(domain, request, request.params.key, { internal: true });
    return view(request.params.key);
  });

  app.patch<ProjectParams>(routes.patchConfig(':key'), async (request): Promise<ConfigView> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const patch = parseEdit(PatchConfigRequest, request.body);
    await domain.projects.patch(key, patch, { actor: actorOf(access), author: authorOf(request) });
    return view(key);
  });

  /** Admins edit the configuration (a commit); release approvers and owners change only by an owner. */
  app.put<ProjectParams>(routes.config(':key'), async (request): Promise<ConfigView> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = isWrapped(request.body)
      ? parseEdit(UpdateConfigBody, request.body)
      : { config: parseEdit(ProjectConfig, request.body), message: undefined, baseVersion: undefined };
    await domain.projects.save(key, body.config, {
      actor: actorOf(access),
      author: authorOf(request),
      message: body.message,
      expectedVersion: body.baseVersion,
    });
    return view(key);
  });

  /** Restores an earlier version in a new commit (owner only). */
  app.post<ProjectParams>(routes.revertConfig(':key'), async (request): Promise<ConfigView> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'owner' });
    const body = parseBody(RevertConfigRequest, request.body);
    await domain.projects.revert(key, body.version, { actor: actorOf(access), author: authorOf(request) });
    return view(key);
  });
}
