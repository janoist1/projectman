import { describe, expect, it } from 'vitest';
import {
  allStageOwners,
  cardStageOwners,
  needsChangedFiles,
  pickStageOwners,
  possibleStageOwners,
} from './stage-owner-pick';
import { ProjectConfig } from './schema';
import type { Stage } from '../domain/pipeline';
import type { StageOwnerPick } from '../domain/stage-owner-pick';

const smallCards = {
  maxPoints: 3,
  owners: ['small', 'small-2'],
  centralPaths: ['apps/server/src/db/**', '*.lock'],
};

function setup(options: { onLeave?: readonly string[]; smallCards?: object } = {}) {
  const ai = (handle: string, role: string) => ({
    kind: 'ai',
    handle,
    displayName: handle,
    role,
    sponsor: 'owner',
    ...(options.onLeave?.includes(handle) ? { onLeave: true } : {}),
  });
  const config = ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AR', name: 'Acme', workspacePath: '/work/acme', repos: [{ name: 'web', path: '.' }] },
    team: {
      limits: {},
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' },
        ai('dev', 'developer'),
        ai('lead', 'code_review'),
        ai('small', 'code_review'),
        ai('small-2', 'code_review'),
      ],
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      labels: [],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
        { id: 'dev', name: 'Dev', kind: 'work', owners: ['dev'], columnId: 'all' },
        {
          id: 'review',
          name: 'Review',
          kind: 'step',
          owners: ['lead'],
          columnId: 'all',
          smallCards: options.smallCards ?? smallCards,
        },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
    },
  });
  const stage = config.pipeline.stages.find((s) => s.id === 'review') as Stage;
  return { config, stage };
}

const points = (value: 1 | 2 | 3 | 5 | 8 | 13) => ({
  points: value,
  reason: null,
  setBy: 'owner',
  setAt: '',
});
const card = (overrides: object = {}) => ({
  assignee: 'dev',
  links: [],
  complexity: points(2),
  ...overrides,
});
const clean = { paths: ['apps/web/src/a.ts'], truncated: false };

describe('pickStageOwners', () => {
  it('is null for a stage without the rule', () => {
    const { config } = setup();
    const dev = config.pipeline.stages.find((s) => s.id === 'dev')!;
    expect(pickStageOwners(config, dev, card(), clean)).toBeNull();
  });

  it.each([
    ['no points', {}, { complexity: undefined }, clean, { small: false, code: 'no_points' }],
    ['over the limit', {}, { complexity: points(5) }, clean, { small: false, code: 'over_limit' }],
    [
      'the small owners wrote it',
      { smallCards: { ...smallCards, owners: ['dev'] } },
      {},
      clean,
      { small: false, code: 'small_owner_is_author' },
    ],
    [
      'the small owners are on leave',
      { onLeave: ['small', 'small-2'] },
      {},
      clean,
      { small: false, code: 'small_owners_on_leave' },
    ],
    ['no branch was read', {}, {}, undefined, { small: false, code: 'no_branch' }],
    ['the files could not be read', {}, {}, null, { small: false, code: 'unreadable' }],
    [
      'a central file changed',
      {},
      {},
      { paths: ['apps/server/src/db/tasks.ts', 'a.ts'], truncated: false },
      { small: false, code: 'central_files' },
    ],
    ['the list was cut', {}, {}, { paths: ['a.ts'], truncated: true }, { small: false, code: 'unreadable' }],
    ['all is within the limit', {}, {}, clean, { small: true, code: 'small' }],
    [
      'no central paths need no files',
      { smallCards: { ...smallCards, centralPaths: [] } },
      {},
      undefined,
      { small: true, code: 'small' },
    ],
  ] as const)('%s', (_name, options, overrides, changed, expected) => {
    const { config, stage } = setup(options);
    const pick = pickStageOwners(config, stage, card(overrides), changed);
    expect(pick).toMatchObject({ stageId: 'review', small: expected.small, reason: { code: expected.code } });
  });

  it('names at most three central files and counts them all', () => {
    const { config, stage } = setup();
    const paths = ['a.lock', 'b.lock', 'c.lock', 'd.lock'];
    const pick = pickStageOwners(config, stage, card(), { paths, truncated: false });
    expect(pick?.reason).toEqual({ code: 'central_files', files: paths.slice(0, 3), count: 4 });
  });
});

describe('needsChangedFiles', () => {
  it.each([
    ['a small card', {}, {}, true],
    ['no points', {}, { complexity: undefined }, false],
    ['over the limit', {}, { complexity: points(8) }, false],
    ['no central paths', { smallCards: { ...smallCards, centralPaths: [] } }, {}, false],
    ['the small owners are away', { onLeave: ['small', 'small-2'] }, {}, false],
  ] as const)('%s', (_name, options, overrides, expected) => {
    const { config, stage } = setup(options);
    expect(needsChangedFiles(config, stage, card(overrides))).toBe(expected);
  });
});

describe('the owners a card has in the stage', () => {
  const pick = (small: boolean): StageOwnerPick => ({
    stageId: 'review',
    small,
    reason: small ? { code: 'small', points: 2 } : { code: 'no_points' },
  });

  it('are the small owners when the stage gave the card to them', () => {
    const { config, stage } = setup();
    expect(cardStageOwners(config, stage, card({ stageOwnerPick: pick(true) }))).toEqual([
      'small',
      'small-2',
    ]);
  });

  it.each([
    ['no pick', undefined],
    ['a main pick', pick(false)],
    ['a pick of another stage', { ...pick(true), stageId: 'dev' }],
  ])('are the main owners with %s', (_name, stageOwnerPick) => {
    const { config, stage } = setup();
    expect(cardStageOwners(config, stage, card({ stageOwnerPick }))).toEqual(['lead']);
  });

  it('leave out the authors of the card and fall back to the main owners when none is left', () => {
    const { config, stage } = setup();
    const authored = card({ assignee: 'small', stageOwnerPick: pick(true) });
    expect(cardStageOwners(config, stage, authored)).toEqual(['small-2']);
    const all = card({
      assignee: 'small',
      stageOwnerPick: pick(true),
      links: [{ kind: 'pull_request', ref: '1', author: 'small-2' }],
    });
    expect(cardStageOwners(config, stage, all)).toEqual(['lead']);
  });

  it('are everyone who could own the stage, without a card', () => {
    const { config, stage } = setup();
    expect(allStageOwners(config, stage)).toEqual(['lead', 'small', 'small-2']);
  });

  it.each([
    ['a small card', {}, ['lead', 'small', 'small-2']],
    ['a card over the limit', { complexity: points(8) }, ['lead']],
    ['a card without points', { complexity: undefined }, ['lead']],
    ['a card the small owner wrote', { assignee: 'small' }, ['lead', 'small-2']],
  ] as const)('are possible for %s before it enters', (_name, overrides, expected) => {
    const { config, stage } = setup();
    expect(possibleStageOwners(config, stage, card(overrides))).toEqual(expected);
  });
});
