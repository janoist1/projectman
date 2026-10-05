import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createFixtureProbe, parseMachineFixture } from './fixture';

const sample = (name: string): string =>
  readFileSync(new URL(`../../../../scripts/fixtures/machine/${name}.json`, import.meta.url), 'utf8');

describe('the machine fixture', () => {
  it('parses the two samples of the screenshot scenarios', () => {
    const busy = parseMachineFixture(sample('busy'));
    expect(busy.machine.memoryPressure).toBe('critical');
    expect(busy.orphans).toHaveLength(2);
    const calm = parseMachineFixture(sample('calm'));
    expect(calm.orphans).toEqual([]);
  });

  it('refuses what is not JSON or has the wrong shape', () => {
    expect(() => parseMachineFixture('{')).toThrow(/not valid JSON/);
    expect(() => parseMachineFixture('{"machine": 3}')).toThrow(/invalid/);
  });

  it('marks its orphans with the instance, and removes them on a signal without sending a real one', async () => {
    const kill = vi.spyOn(process, 'kill');
    try {
      const probe = createFixtureProbe(parseMachineFixture(sample('busy')), {
        runningPids: () => [],
        instanceTag: 'abcdef0123456789',
      });
      const list = (await probe.processes())!;
      const roots = list.filter((record) => record.ppid === 1 && record.args.includes('vite'));
      expect(roots).toHaveLength(1);
      const environment = await probe.envValues(
        [roots[0]!.pid],
        ['PROJECTMAN_INSTANCE', 'PROJECTMAN_SESSION_ID'],
      );
      expect(environment.get(roots[0]!.pid)).toEqual({
        PROJECTMAN_INSTANCE: 'abcdef0123456789',
        PROJECTMAN_SESSION_ID: 'ses_fixture_a',
      });
      expect(probe.signal(roots[0]!.pid, 'SIGTERM')).toBe('sent');
      const after = (await probe.processes())!;
      expect(after.some((record) => record.pid === roots[0]!.pid)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});
