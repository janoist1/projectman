import { AgentProvider, canManageProviderKeys, routes, SetProviderKeyRequest } from '@projectman/shared';
import type { ProvidersView } from '@projectman/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Domain } from '../domain';
import { forbidden, invalid } from '../domain';
import { currentUser } from './context';

/** The auth guard grants every logged-in member access to provider login status. */
export function registerProviderRoutes(app: FastifyInstance, domain: Domain): void {
  const accesses = (request: FastifyRequest) =>
    Promise.all(
      domain.projects.summaries().map((project) => domain.accessFor(project.key, currentUser(request).email)),
    );
  const canManage = async (request: FastifyRequest) =>
    canManageProviderKeys((await accesses(request)).map((access) => access?.access ?? null));
  const view = async (request: FastifyRequest): Promise<ProvidersView> => ({
    keys: { nanogpt: domain.providerKeys?.status() ?? { set: false, setAt: null } },
    canManageKeys: await canManage(request),
    providers: await Promise.all(
      AgentProvider.options.map(
        async (provider) =>
          (await domain.runnerModule.runner.providerStatus?.(provider)) ?? {
            provider,
            loggedIn: null,
            method: null,
            checkedAt: new Date().toISOString(),
          },
      ),
    ),
  });
  app.get(routes.providers(), view);
  const manage = async (request: FastifyRequest) => {
    const memberships = await accesses(request);
    if (!canManageProviderKeys(memberships.map((access) => access?.access ?? null)))
      throw forbidden('insufficient_access', 'only an owner of every project may manage provider keys');
    return memberships.find((access) => access !== null)!.handle;
  };
  app.put(routes.nanogptKey(), async (request): Promise<ProvidersView> => {
    const by = await manage(request);
    const parsed = SetProviderKeyRequest.safeParse(request.body);
    // Zod's unknown-property details can echo attacker-controlled secret values as property names.
    if (!parsed.success) throw invalid('invalid_request', 'the request is invalid');
    if (!domain.providerKeys) throw new Error('Provider key store unavailable');
    await domain.providerKeys.setNanogpt(parsed.data.key, by);
    return view(request);
  });
  app.delete(routes.nanogptKey(), async (request): Promise<ProvidersView> => {
    const by = await manage(request);
    if (!domain.providerKeys) throw new Error('Provider key store unavailable');
    await domain.providerKeys.clearNanogpt(by);
    return view(request);
  });
}
