import { describe, expect, it } from 'vitest';
import { smallCardsWarnings } from './small-cards-warnings';
import { ProjectConfig } from './schema';

function setup(options: { onLeave?: boolean; smallCards?: boolean; nextGate?: object[] } = {}) {
  const config = ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AR', name: 'Acme', workspacePath: '/work/acme', repos: [{ name: 'web', path: '.' }] },
    team: {
      limits: {},
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' },
        {
          kind: 'ai',
          handle: 'small',
          displayName: 'Small',
          role: 'code_review',
          sponsor: 'owner',
          ...(options.onLeave ? { onLeave: true } : {}),
        },
        { kind: 'ai', handle: 'lead', displayName: 'Lead', role: 'code_review', sponsor: 'owner' },
      ],
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      labels: [
        { id: 'review-ok', name: 'Review ok', setBy: { members: ['lead'] } },
        { id: 'any-ok', name: 'Any ok', setBy: 'anyone' },
      ],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
        {
          id: 'review',
          name: 'Review',
          kind: 'step',
          owners: ['lead'],
          columnId: 'all',
          ...(options.smallCards === false ? {} : { smallCards: { maxPoints: 3, owners: ['small'] } }),
        },
        {
          id: 'done',
          name: 'Done',
          kind: 'done',
          columnId: 'all',
          gate: {
            conditions: options.nextGate ?? [
              { type: 'has_label', label: 'review-ok' },
              { type: 'has_label', label: 'any-ok' },
            ],
          },
        },
      ],
    },
  });
  return { config, stage: config.pipeline.stages[1]! };
}

describe('smallCardsWarnings', () => {
  it('warns about a label of the next gate the small owner may not set', () => {
    const { config, stage } = setup();
    expect(smallCardsWarnings(config, stage)).toEqual([
      { code: 'cannot_set_label', member: 'small', label: 'review-ok' },
    ]);
  });

  it('warns that a small owner is on leave, before its labels', () => {
    const { config, stage } = setup({ onLeave: true });
    expect(smallCardsWarnings(config, stage).map((warning) => warning.code)).toEqual([
      'on_leave',
      'cannot_set_label',
    ]);
  });

  it('skips the labels only some cards need', () => {
    const { config, stage } = setup({ nextGate: [{ type: 'has_label', label: 'review-ok', when: 'ui' }] });
    expect(smallCardsWarnings(config, stage)).toEqual([]);
  });

  it('is empty without a rule', () => {
    const { config, stage } = setup({ smallCards: false });
    expect(smallCardsWarnings(config, stage)).toEqual([]);
  });
});
