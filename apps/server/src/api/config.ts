import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ProjectConfig,
  RevertConfigRequest,
  routes,
  PatchConfigRequest,
  applyConfigPatch,
  configSchemaIssues,
  validateProjectConfig,
} from '@projectman/shared';
import type { ConfigView } from '@projectman/shared';
import type { Domain } from '../domain';
import { ProjectService } from '../domain';
import { actorOf, authorOf, requireAccess } from './context';
import { parseBody } from './validation';
import { DomainError, invalid } from '../domain/errors';

type ProjectParams = { Params: { key: string } };

/**
 * PUT body: either the whole ProjectConfig, or
 * { config, message? (commit message), baseVersion? (rejects stale edits with 409 version_conflict) }.
 */
const UpdateConfigBody = z.object({
  config: ProjectConfig,
  message: z.string().trim().min(1).max(500).optional(),
  baseVersion: z.string().optional(),
});

function isWrapped(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'config' in body && !('schemaVersion' in body);
}

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
    const parsed = PatchConfigRequest.safeParse(request.body);
    if (!parsed.success) {
      throw invalid('config_invalid', 'configuration does not match the schema', {
        issues: configSchemaIssues(parsed.error.issues),
      });
    }
    const body = parsed.data;
    const current = await domain.projects.load(key);
    const next = applyConfigPatch(current.config, body);
    try {
      await domain.projects.save(key, next, {
        actor: actorOf(access),
        author: authorOf(request),
        expectedVersion: body.baseVersion,
        message:
          body.message ??
          (body.pipeline ? 'Update pipeline' : body.limits ? 'Update limits' : 'Update project'),
        check: (previous, draft) => {
          ProjectService.assertChangeAllowed(previous, draft, access.access);
          const issues = validateProjectConfig(draft);
          if (issues.some((issue) => issue.severity !== 'warning'))
            throw invalid('config_invalid', 'configuration violates invariants', { issues });
        },
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'version_conflict') {
        throw new DomainError('config_conflict', error.message, { status: 409, details: error.details });
      }
      throw error;
    }
    return view(key);
  });

  /** Admins edit the configuration (a commit); release approvers and owners change only by an owner. */
  app.put<ProjectParams>(routes.config(':key'), async (request): Promise<ConfigView> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = isWrapped(request.body)
      ? parseBody(UpdateConfigBody, request.body)
      : { config: parseBody(ProjectConfig, request.body), message: undefined, baseVersion: undefined };
    await domain.projects.save(key, body.config, {
      actor: actorOf(access),
      author: authorOf(request),
      message: body.message ?? 'Update configuration',
      expectedVersion: body.baseVersion,
      check: (previous, next) => ProjectService.assertChangeAllowed(previous, next, access.access),
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
