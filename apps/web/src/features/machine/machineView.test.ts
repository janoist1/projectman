import { describe, expect, it } from 'vitest';
import { MachineView } from '@projectman/shared';
import { MockBackend } from '../../mocks/backend';
import { holdOrder, isDelayed, sortSessions } from './machineView';

const sample = () => MachineView.parse(new MockBackend().handle('GET', '/api/machine', undefined).body);

describe('machine list rules', () => {
  it('keeps missing measurements last in both directions and sorts age by process start', () => {
    const [a, b, c] = sample().sessions;
    a!.memoryBytes = null;
    b!.memoryBytes = 100;
    c!.memoryBytes = 200;
    const rows = [a!, b!, c!];
    expect(sortSessions(rows, 'memory', true)).toEqual([b, c, a]);
    expect(sortSessions(rows, 'memory', false)).toEqual([c, b, a]);
    a!.processStartedAt = null;
    b!.processStartedAt = '2026-10-01T10:00:00Z';
    c!.processStartedAt = '2026-10-01T11:00:00Z';
    expect(sortSessions(rows, 'age', false)).toEqual([b, c, a]);
  });

  it('keeps existing identities in place, removes departed rows and appends arrivals', () => {
    const [a, b, c] = sample().sessions;
    expect(holdOrder([b!.sessionId, 'departed', a!.sessionId], [c!, a!, b!])).toEqual([
      b!.sessionId,
      a!.sessionId,
      c!.sessionId,
    ]);
  });

  it('marks the sample delayed only after three intervals or when absent', () => {
    const data = sample();
    const now = Date.parse(data.sampledAt!);
    expect(isDelayed(data, now + 3 * data.intervalMs)).toBe(false);
    expect(isDelayed(data, now + 3 * data.intervalMs + 1)).toBe(true);
    expect(isDelayed({ ...data, sampledAt: null }, now)).toBe(true);
  });
});
