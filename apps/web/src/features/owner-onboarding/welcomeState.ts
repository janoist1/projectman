import { starterProvider } from '@projectman/shared';
import type { AgentProvider, EngineView, ProviderLoginStatus } from '@projectman/shared';

export type WelcomeStep = 1 | 2 | 3 | 4;

/** What the wizard hands to the page after creating the project (router state; gone after a reload). */
export interface ProjectSetupState {
  folder?: string;
  repos?: { name: string; path: string }[];
}

/** The machines the owner has set up and not revoked; a revoked one is gone for the first steps. */
export function ownEngines(engines: readonly EngineView[]): EngineView[] {
  return engines.filter((engine) => engine.ownedByMe === true && !engine.revokedAt);
}

/** The machine the first steps follow: the latest connected one, else the latest created. */
export function currentEngine(engines: readonly EngineView[]): EngineView | null {
  const own = ownEngines(engines);
  const latest = (list: EngineView[]) =>
    list.reduce<EngineView | null>(
      (best, engine) => (best === null || engine.createdAt >= best.createdAt ? engine : best),
      null,
    );
  return latest(own.filter((engine) => engine.online)) ?? latest(own);
}

/**
 * The step the server state puts the owner at: 1 no machine, 2 a machine that has not connected,
 * 3 a connected one without a provider login, 4 everything ready. `providers` is null until the machine answered.
 */
export function welcomeStep(
  engine: Pick<EngineView, 'online'> | null,
  providers: readonly Pick<ProviderLoginStatus, 'provider' | 'loggedIn'>[] | null,
): WelcomeStep {
  if (!engine) return 1;
  if (!engine.online) return 2;
  if (providers === null || starterProvider(providers) === null) return 3;
  return 4;
}

/** The provider the starter team uses on the machine: the first one logged in, else Claude. */
export function pmProvider(
  providers: readonly Pick<ProviderLoginStatus, 'provider' | 'loggedIn'>[],
): AgentProvider {
  return starterProvider(providers) ?? 'claude';
}
