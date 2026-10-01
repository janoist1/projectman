import { afterEach, describe, expect, it } from 'vitest';
import type { AiMemberConfig } from '@projectman/shared';
import { createDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

describe('the cap on concurrent AI sessions is optional (decision 23)', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  /** Starts a general chat of each AI member through admission, in turn; the codes of the refusals. */
  async function startAll(): Promise<Array<string | null>> {
    const config = await h.domain.projects.config('AR');
    const refusals: Array<string | null> = [];
    for (const member of config.team.members.filter((m): m is AiMemberConfig => m.kind === 'ai')) {
      refusals.push(
        await h.domain.admission.start({ config, member, workItem: { type: 'general' } }).then(
          () => null,
          (err: { code: string }) => err.code,
        ),
      );
    }
    return refusals;
  }

  it('refuses at the cap the project names', async () => {
    h = await createDomainHarness({ adjust: (config) => void (config.team.limits.maxConcurrentAi = 1) });
    expect(await startAll()).toEqual([null, 'ai_limit_reached', 'ai_limit_reached']);
  });

  it('admits every member when the project names no cap', async () => {
    h = await createDomainHarness({ adjust: (config) => void delete config.team.limits.maxConcurrentAi });
    expect(await startAll()).toEqual([null, null, null]);
    expect(h.runner.started).toHaveLength(3);
  });

  it('keeps the plan usage pause without a cap', async () => {
    h = await createDomainHarness({
      adjust: (config) => void delete config.team.limits.maxConcurrentAi,
      planUsagePercent: 95,
    });
    expect(await startAll()).toEqual(['plan_usage_paused', 'plan_usage_paused', 'plan_usage_paused']);
  });
});
