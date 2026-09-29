import { AgentProvider, routes } from '@projectman/shared';
import type { ProvidersView } from '@projectman/shared';
import type { FastifyInstance } from 'fastify';
import type { Domain } from '../domain';

/** The auth guard grants every logged-in member access to provider login status. */
export function registerProviderRoutes(app: FastifyInstance, domain: Domain): void {
  app.get(routes.providers(), async (): Promise<ProvidersView> => ({
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
  }));
}
