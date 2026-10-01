import { describe, expect, it } from 'vitest';
import { applyConfigPatch, PatchConfigRequest } from './edit';
import { aiLimitReached, isHandleOnLeave, isOnLeave } from './leave';
import { memberOf } from './lookup';
import { ProjectConfig } from './schema';

function configWith(limits: Record<string, unknown> = {}, onLeave?: boolean): ProjectConfig {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        {
          kind: 'ai',
          handle: 'dev-1',
          displayName: 'Developer',
          role: 'developer',
          sponsor: 'owner',
          ...(onLeave === undefined ? {} : { onLeave }),
        },
      ],
      limits,
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [],
    },
  });
}

describe('leave', () => {
  it('is a flag an AI member may carry; absent means at work', () => {
    expect(isOnLeave(memberOf(configWith(), 'dev-1'))).toBe(false);
    expect(isOnLeave(memberOf(configWith({}, false), 'dev-1'))).toBe(false);
    expect(isOnLeave(memberOf(configWith({}, true), 'dev-1'))).toBe(true);
  });

  it('never applies to humans, unknown members or nobody', () => {
    const config = configWith({}, true);
    expect(isOnLeave(memberOf(config, 'owner'))).toBe(false);
    expect(isOnLeave(undefined)).toBe(false);
    expect(isOnLeave(null)).toBe(false);
    expect(isHandleOnLeave(config, 'dev-1')).toBe(true);
    expect(isHandleOnLeave(config, 'owner')).toBe(false);
    expect(isHandleOnLeave(config, 'nobody')).toBe(false);
    expect(isHandleOnLeave(config, null)).toBe(false);
  });

  it('is not written for members that never went on leave, so older configurations stay as they are', () => {
    expect(memberOf(configWith(), 'dev-1')).not.toHaveProperty('onLeave');
  });
});

describe('the cap on concurrent AI sessions', () => {
  it('does not exist unless the limits name one', () => {
    const config = configWith();
    expect(config.team.limits.maxConcurrentAi).toBeUndefined();
    expect(aiLimitReached(config, 0)).toBe(false);
    expect(aiLimitReached(config, 500)).toBe(false);
  });

  it('keeps the value a configuration names', () => {
    const config = configWith({ maxConcurrentAi: 3 });
    expect(config.team.limits.maxConcurrentAi).toBe(3);
    expect(aiLimitReached(config, 2)).toBe(false);
    expect(aiLimitReached(config, 3)).toBe(true);
  });

  it('still bounds a named value to 1..20', () => {
    expect(() => configWith({ maxConcurrentAi: 0 })).toThrow();
    expect(() => configWith({ maxConcurrentAi: 21 })).toThrow();
  });

  it('is removed by a patch with null, set by a number and kept when the patch does not name it', () => {
    const capped = configWith({ maxConcurrentAi: 3 });
    const patch = (limits: Record<string, unknown>) =>
      PatchConfigRequest.parse({ baseVersion: 'v1', limits });
    expect(applyConfigPatch(capped, patch({ maxConcurrentAi: null })).team.limits).not.toHaveProperty(
      'maxConcurrentAi',
    );
    expect(applyConfigPatch(capped, patch({ maxConcurrentAi: 5 })).team.limits.maxConcurrentAi).toBe(5);
    expect(applyConfigPatch(capped, patch({ aiEnabled: false })).team.limits.maxConcurrentAi).toBe(3);
    expect(applyConfigPatch(configWith(), patch({ aiEnabled: false })).team.limits).not.toHaveProperty(
      'maxConcurrentAi',
    );
    expect(() => patch({ maxConcurrentAi: 0 })).toThrow();
  });
});
