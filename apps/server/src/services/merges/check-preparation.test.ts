import { describe, expect, it, vi } from 'vitest';
import { EngineLinkLostError } from '../../contracts';
import type { EngineHost, FullTestExecutor } from '../../contracts';
import { chooseMergeCheckRunner } from './check-preparation';

function engine(available: FullTestExecutor['available']) {
  return { fullTestExecutor: { available, run: vi.fn() } } as unknown as EngineHost;
}

describe('merge check runner selection', () => {
  it('keeps GitHub when the connected remote engine has no ready sandbox', async () => {
    const available = vi.fn(async () => ({ ok: true as const }));
    const host = engine(available);
    host.fullTestExecutor!.sandboxReady = vi.fn(async () => false);
    expect(
      await chooseMergeCheckRunner(host, {
        configured: 'github_actions',
        requested: 'engine',
        githubOutage: true,
      }),
    ).toMatchObject({ ok: true, runner: 'github_actions', fallback: false });
    expect(available).not.toHaveBeenCalled();
    expect(host.fullTestExecutor!.sandboxReady).toHaveBeenCalledTimes(1);
  });

  it.each([{ requested: 'engine' as const, githubOutage: false }, { githubOutage: true }])(
    'uses the ready sandbox for %o',
    async (input) => {
      const host = engine(vi.fn(async () => ({ ok: true as const })));
      expect(await chooseMergeCheckRunner(host, { configured: 'github_actions', ...input })).toMatchObject({
        ok: true,
        runner: 'engine',
        fallback: true,
      });
    },
  );

  it('keeps healthy GitHub checks independent of sandbox availability', async () => {
    const available = vi.fn();
    expect(
      await chooseMergeCheckRunner(engine(available), { configured: 'github_actions', githubOutage: false }),
    ).toMatchObject({ ok: true, runner: 'github_actions', fallback: false });
    expect(available).not.toHaveBeenCalled();
  });

  it.each(['sandbox_unavailable', 'engine_offline'])(
    'keeps GitHub when fallback availability returns %s',
    async (reason) => {
      const host = engine(async () => ({ ok: false, reason }));
      expect(
        await chooseMergeCheckRunner(host, {
          configured: 'github_actions',
          requested: 'engine',
          githubOutage: true,
        }),
      ).toMatchObject({ ok: true, runner: 'github_actions', fallback: false });
    },
  );

  it('keeps GitHub when probing the fallback loses the engine link', async () => {
    const host = engine(async () => {
      throw new EngineLinkLostError('offline');
    });
    expect(
      await chooseMergeCheckRunner(host, { configured: 'github_actions', githubOutage: true }),
    ).toMatchObject({ ok: true, runner: 'github_actions' });
  });

  it('preserves engine link loss for an explicitly configured engine check', async () => {
    const host = engine(async () => ({ ok: false, reason: 'engine_offline' }));
    await expect(
      chooseMergeCheckRunner(host, { configured: 'engine', githubOutage: false }),
    ).rejects.toBeInstanceOf(EngineLinkLostError);
  });
});
