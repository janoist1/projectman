import { describe, expect, it } from 'vitest';
import type { Task } from '../domain/task';
import {
  canSkipCollectingMerge,
  collectingAutoClose,
  collectingSourceStateOf,
  partsClosedWaiver,
} from './collecting-close';
import type { CollectingSourceEvidence } from './collecting-close';
import { ProjectConfig } from './schema';

function config({ withDev = true } = {}) {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'incoming', name: 'Incoming', kind: 'queue', columnId: 'all' },
        {
          id: 'ready',
          name: 'Ready',
          kind: 'queue',
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'scope-ok' }] },
        },
        ...(withDev
          ? [{ id: 'dev', name: 'Development', kind: 'work', owners: ['dev-1'], columnId: 'all' }]
          : []),
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [
        { id: 'scope-ok', name: 'Scope ok', setBy: { members: ['owner'] } },
        { id: 'waiting-answer', name: 'Waiting', blocks: true },
        { id: 'plain', name: 'Plain' },
      ],
    },
  });
}

const card = (over: Partial<Pick<Task, 'kind' | 'status' | 'stageId' | 'labels'>> = {}) => ({
  key: 'AC-1',
  kind: 'task' as const,
  status: 'waiting' as const,
  stageId: 'incoming',
  labels: [] as string[],
  ...over,
});
const part = (key: string, status: Task['status']) => ({ key, status });

describe('partsClosedWaiver', () => {
  const cfg = config();

  it('waives the gates when every part is closed and one is done, sorted by key number', () => {
    const parts = [part('AC-10', 'done'), part('AC-3', 'cancelled'), part('AC-2', 'done')];
    expect(partsClosedWaiver(cfg, card(), parts, 'done')).toEqual({
      done: ['AC-2', 'AC-10'],
      cancelled: ['AC-3'],
    });
  });

  it('does not waive without parts, with an open part or when every part was cancelled', () => {
    expect(partsClosedWaiver(cfg, card(), [], 'done')).toBeNull();
    expect(partsClosedWaiver(cfg, card(), [part('AC-2', 'done'), part('AC-3', 'active')], 'done')).toBeNull();
    expect(partsClosedWaiver(cfg, card(), [part('AC-2', 'blocked')], 'done')).toBeNull();
    expect(partsClosedWaiver(cfg, card(), [part('AC-2', 'cancelled')], 'done')).toBeNull();
  });

  it('does not waive a theme, a closed card or a move that does not enter the done stage', () => {
    const parts = [part('AC-2', 'done')];
    expect(partsClosedWaiver(cfg, card({ kind: 'theme' }), parts, 'done')).toBeNull();
    expect(partsClosedWaiver(cfg, card({ status: 'done' }), parts, 'done')).toBeNull();
    expect(partsClosedWaiver(cfg, card({ status: 'cancelled' }), parts, 'done')).toBeNull();
    expect(partsClosedWaiver(cfg, card(), parts, 'ready')).toBeNull();
    expect(partsClosedWaiver(cfg, card(), parts, 'nowhere')).toBeNull();
  });

  it('keeps a blocking label in force but not a plain one', () => {
    const parts = [part('AC-2', 'done')];
    expect(partsClosedWaiver(cfg, card({ labels: ['waiting-answer'] }), parts, 'done')).toBeNull();
    expect(partsClosedWaiver(cfg, card({ labels: ['plain'] }), parts, 'done')).not.toBeNull();
  });
});

describe('collectingAutoClose', () => {
  const parts = [part('AC-2', 'done'), part('AC-3', 'cancelled')];

  it('closes a card that stands before the development stage', () => {
    const result = collectingAutoClose(config(), card(), parts);
    expect(result?.to.id).toBe('done');
    expect(result?.parts).toEqual({ done: ['AC-2'], cancelled: ['AC-3'] });
    expect(collectingAutoClose(config(), card({ stageId: 'ready', status: 'active' }), parts)).not.toBeNull();
  });

  it('leaves a card in or after the development stage to a person', () => {
    expect(collectingAutoClose(config(), card({ stageId: 'dev', status: 'active' }), parts)).toBeNull();
  });

  it('without a development stage closes a card standing anywhere before the done stage', () => {
    expect(collectingAutoClose(config({ withDev: false }), card({ stageId: 'ready' }), parts)).not.toBeNull();
  });

  it('leaves a blocked card, a card with a blocking label and a card without a waiver', () => {
    expect(collectingAutoClose(config(), card({ status: 'blocked' }), parts)).toBeNull();
    expect(collectingAutoClose(config(), card({ labels: ['waiting-answer'] }), parts)).toBeNull();
    expect(collectingAutoClose(config(), card(), [part('AC-2', 'active')])).toBeNull();
  });
});

describe('collectingSourceStateOf and canSkipCollectingMerge (PM-797)', () => {
  const evidence = (over: Partial<CollectingSourceEvidence> = {}): CollectingSourceEvidence => ({
    sourceRecorded: false,
    workRecorded: false,
    origin: 'native',
    ...over,
  });
  const unassigned = { assignee: null };

  it('is none only for a native card nobody worked on that never had a source', () => {
    expect(collectingSourceStateOf(unassigned, evidence())).toBe('none');
  });

  it('is present whenever a source was recorded, whatever else is known', () => {
    expect(collectingSourceStateOf(unassigned, evidence({ sourceRecorded: true }))).toBe('present');
    expect(
      collectingSourceStateOf(
        { assignee: 'dev-1' },
        evidence({ sourceRecorded: true, workRecorded: true, origin: 'unknown' }),
      ),
    ).toBe('present');
  });

  it('is unknown without evidence, for a card not created here, after work or with an assignee', () => {
    expect(collectingSourceStateOf(unassigned, null)).toBe('unknown');
    expect(collectingSourceStateOf(unassigned, evidence({ origin: 'imported' }))).toBe('unknown');
    expect(collectingSourceStateOf(unassigned, evidence({ origin: 'unknown' }))).toBe('unknown');
    expect(collectingSourceStateOf(unassigned, evidence({ workRecorded: true }))).toBe('unknown');
    expect(collectingSourceStateOf({ assignee: 'dev-1' }, evidence())).toBe('unknown');
  });

  it('skips the merge only for a move with the waiver and a proven absence of source', () => {
    const closed = { done: ['AC-2'], cancelled: [] };
    expect(canSkipCollectingMerge(closed, 'none')).toBe(true);
    expect(canSkipCollectingMerge(closed, 'present')).toBe(false);
    expect(canSkipCollectingMerge(closed, 'unknown')).toBe(false);
    expect(canSkipCollectingMerge(null, 'none')).toBe(false);
    expect(canSkipCollectingMerge(null, 'present')).toBe(false);
  });
});
