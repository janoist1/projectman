import { describe, expect, it } from 'vitest';
import { cardAnalyst } from './duties';
import { ProjectConfig } from './schema';

/** A team with a human product owner, a developer and AI analysts (one on leave when asked). */
function configWith(analysts: { handle: string; onLeave?: boolean }[]) {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'EX', name: 'Example', workspacePath: '/tmp/example', repos: [] },
    team: {
      members: [
        {
          kind: 'human',
          handle: 'owner',
          displayName: 'Owner',
          access: 'owner',
          roles: ['operator', 'product_owner'],
        },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        ...analysts.map(({ handle, onLeave }) => ({
          kind: 'ai',
          handle,
          displayName: handle,
          role: 'business_analyst',
          sponsor: 'owner',
          ...(onLeave === undefined ? {} : { onLeave }),
        })),
      ],
      limits: {},
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

describe('cardAnalyst', () => {
  it('is the AI member who set the analysis label', () => {
    const config = configWith([{ handle: 'analyst-1' }, { handle: 'analyst-2' }]);
    expect(cardAnalyst(config, 'analyst-2')).toBe('analyst-2');
  });

  it('falls back to the first analyst of the team when nobody set the label', () => {
    const config = configWith([{ handle: 'analyst-1' }, { handle: 'analyst-2' }]);
    expect(cardAnalyst(config, null)).toBe('analyst-1');
  });

  it('does not take a person or an unknown handle for the setter', () => {
    const config = configWith([{ handle: 'analyst-1' }]);
    expect(cardAnalyst(config, 'owner')).toBe('analyst-1');
    expect(cardAnalyst(config, 'gone')).toBe('analyst-1');
  });

  it('skips a member on leave, whoever asks', () => {
    const config = configWith([{ handle: 'analyst-1', onLeave: true }, { handle: 'analyst-2' }]);
    expect(cardAnalyst(config, 'analyst-1')).toBe('analyst-2');
    expect(cardAnalyst(config, null)).toBe('analyst-2');
  });

  it('is nobody without an AI analyst at work', () => {
    expect(cardAnalyst(configWith([]), null)).toBeNull();
    expect(cardAnalyst(configWith([{ handle: 'analyst-1', onLeave: true }]), 'analyst-1')).toBeNull();
  });
});
