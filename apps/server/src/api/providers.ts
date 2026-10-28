import { AgentProvider, canManageProviderKeys, routes, SetProviderKeyRequest } from '@projectman/shared';
import type { ProvidersView } from '@projectman/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiServices } from './index';
import { forbidden, invalid } from '../kernel';
import { currentUser } from './context';

/** The auth guard grants every logged-in member access to provider login status. */
export function registerProviderRoutes(app: FastifyInstance, services: ApiServices): void {
  const { domain, auth } = services;
  // The hub's provider keys are the host owner's alone (PM-1068); a person's own projects do not change that.
  const canManage = (request: FastifyRequest) =>
    canManageProviderKeys({ hostOwner: auth.isHostOwner(currentUser(request).id) });
  const view = async (request: FastifyRequest): Promise<ProvidersView> => ({
    keys: { nanogpt: domain.providerKeys?.status() ?? { set: false, setAt: null } },
    canManageKeys: canManage(request),
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
  const manage = (request: FastifyRequest) => {
    if (!canManage(request))
      throw forbidden('insufficient_access', 'only the host owner may manage provider keys');
    return currentUser(request).id;
  };
  app.put(routes.nanogptKey(), async (request): Promise<ProvidersView> => {
    const by = manage(request);
    const parsed = SetProviderKeyRequest.safeParse(request.body);
    // Zod's unknown-property details can echo attacker-controlled secret values as property names.
    if (!parsed.success) throw invalid('invalid_request', 'the request is invalid');
    if (!domain.providerKeys) throw new Error('Provider key store unavailable');
    await domain.providerKeys.setNanogpt(parsed.data.key, by);
    return view(request);
  });
  app.delete(routes.nanogptKey(), async (request): Promise<ProvidersView> => {
    const by = manage(request);
    if (!domain.providerKeys) throw new Error('Provider key store unavailable');
    await domain.providerKeys.clearNanogpt(by);
    return view(request);
  });
}
