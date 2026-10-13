import { z } from 'zod';
import { EngineId } from './engine';
import { AgentProvider } from './member';

/** Login problems, plus setup failures that a login check cannot see. */
export const ProviderOutageProblem = z.enum([
  'not_logged_in',
  'no_key',
  'cli_too_old',
  'cli_missing',
  'chatgpt_login',
  'setup_incomplete',
]);
export type ProviderOutageProblem = z.infer<typeof ProviderOutageProblem>;
export const OutageEngine = z.object({ id: EngineId, name: z.string() });
export const WorkOutage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('provider'),
    id: z.string(),
    provider: AgentProvider,
    problem: ProviderOutageProblem,
    engine: OutageEngine.nullable(),
    cliVersion: z.string().optional(),
    minCliVersion: z.string().optional(),
    since: z.string(),
  }),
  z.object({ kind: z.literal('engine'), id: z.string(), engine: OutageEngine.nullable(), since: z.string() }),
]);
export type WorkOutage = z.infer<typeof WorkOutage>;
export const OUTAGE_REFUSALS = [
  'provider_not_logged_in',
  'nanogpt_key_missing',
  'nanogpt_setup_incomplete',
  'codex_setup_incomplete',
  'engine_offline',
] as const;

export function outageIdOf(
  target:
    | { kind: 'provider'; provider: AgentProvider; engineId: EngineId | null }
    | { kind: 'engine'; engineId: EngineId | null },
): string {
  return target.kind === 'provider'
    ? `provider:${target.provider}:${target.engineId ?? 'local'}`
    : `engine:${target.engineId ?? 'none'}`;
}

export function providerOutageProblemOf(
  code: string,
  details?: Record<string, unknown>,
): ProviderOutageProblem | null {
  if (code === 'nanogpt_key_missing') return 'no_key';
  if (
    code !== 'provider_not_logged_in' &&
    code !== 'nanogpt_setup_incomplete' &&
    code !== 'codex_setup_incomplete'
  )
    return null;
  const problem = ProviderOutageProblem.safeParse(details?.problem);
  return problem.success
    ? problem.data
    : code === 'provider_not_logged_in'
      ? 'not_logged_in'
      : 'setup_incomplete';
}
