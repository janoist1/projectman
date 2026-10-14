import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { createDomainContext, createEventBus } from '../core/base';
import { capturingLogger } from '../../test/helpers/fakes';
import { createRepositories, mergedState, mergeState, openDatabase } from './index';
import type { MergeRecord, MergeTrainMember, MergeTrainRecord, Repositories } from './index';

const at = '2026-10-14T10:00:00.000Z';
function member(seq: number): MergeTrainMember {
  return {
    mergeId: `merge_member0${seq}`,
    taskKey: `PM-${seq}`,
    commit: 'a'.repeat(40),
    branch: `PM-${seq}-change`,
    startedBy: 'claude',
    startedAt: at,
  };
}
function train(patch: Partial<MergeTrainRecord> = {}): MergeTrainRecord {
  return {
    id: 'mrg_train0001',
    projectKey: 'PM',
    repo: 'projectman',
    base: 'main',
    engineId: 'local',
    reviewTest: { command: 'npm run merge-test', maxWorkers: 2, timeoutMinutes: 15 },
    members: [member(2), member(1)],
    state: 'running',
    step: 'merging',
    landed: 'nowhere',
    createdAt: at,
    updatedAt: at,
    ...patch,
  };
}
function queued(item: MergeTrainMember): MergeRecord {
  return {
    id: item.mergeId,
    projectKey: 'PM',
    taskKey: item.taskKey,
    repo: 'projectman',
    base: 'main',
    commit: item.commit,
    branch: item.branch,
    fromStageId: 'review',
    toStageId: 'done',
    merger: item.startedBy,
    startedBy: item.startedBy,
    startedAt: item.startedAt,
    requestedAt: at,
    state: 'queued',
    step: 'queued',
    landed: 'nowhere',
    createdAt: at,
    updatedAt: at,
    prioritizedAt: at,
  };
}

describe('merge train repository', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });
  afterEach(() => repos.db.close());

  it('round-trips ordered members and every optional field', () => {
    expect(repos.mergeTrains.get('mrg_unknown0')).toBeNull();
    const record = train({
      engineId: 'eng_abcdefgh1234',
      members: [{ ...member(2), prioritizedAt: at }, member(1)],
      localFrom: 'a'.repeat(40),
      onto: 'b'.repeat(64),
      candidate: 'C'.repeat(40),
      check: { command: 'npm run merge-test', status: 'passed', runId: 'full_run', reused: false },
      parentTrainId: 'mrg_parent00',
    });
    repos.mergeTrains.save(record);
    expect(repos.mergeTrains.get(record.id)).toEqual(record);
    expect(repos.mergeTrains.listRunning()).toEqual([record]);
    const finished = {
      ...record,
      state: 'merged' as const,
      step: 'finishing' as const,
      landed: 'local' as const,
      updatedAt: '2026-10-14T11:00:00.000Z',
      finishedAt: '2026-10-14T11:00:00.000Z',
    };
    repos.mergeTrains.save(finished);
    expect(repos.mergeTrains.get(record.id)).toEqual(finished);
    expect(repos.mergeTrains.listRunning()).toEqual([]);
    const stored = repos.db.prepare('SELECT * FROM merge_trains').get() as { record_json: string };
    expect(stored).toMatchObject({
      id: record.id,
      project_key: record.projectKey,
      repo: record.repo,
      state: 'merged',
    });
    expect(JSON.parse(stored.record_json)).toEqual(finished);
  });

  it.each(['merged', 'failed', 'blocked', 'cancelled'] as const)('releases a repository on %s', (state) => {
    const first = train();
    repos.mergeTrains.save(first);
    const second = train({ id: 'mrg_train0002' });
    expect(() => repos.mergeTrains.save(second)).toThrow(/UNIQUE/);
    expect(repos.mergeTrains.get(second.id)).toBeNull();
    repos.mergeTrains.save({ ...first, state, finishedAt: at });
    repos.mergeTrains.save(second);
    expect(repos.mergeTrains.listRunning()).toEqual([second]);
  });

  it('allows independent repositories and projects to hold running trains', () => {
    const records = [
      train(),
      train({ id: 'mrg_train0002', repo: 'other' }),
      train({ id: 'mrg_train0003', projectKey: 'OTHER' }),
    ];
    for (const record of records) repos.mergeTrains.save(record);
    expect(repos.mergeTrains.listRunning()).toEqual(records);
  });

  it('keeps SQL identity, repository and state fields consistent on updates', () => {
    const record = train();
    repos.mergeTrains.save(record);
    const changed = { ...record, projectKey: 'OTHER', repo: 'other', state: 'blocked' as const };
    repos.mergeTrains.save(changed);
    expect(repos.mergeTrains.get(record.id)).toEqual(changed);
    expect(repos.db.prepare('SELECT id, project_key, repo, state FROM merge_trains').get()).toEqual({
      id: record.id,
      project_key: 'OTHER',
      repo: 'other',
      state: 'blocked',
    });
  });

  it.each([{ state: 'merged' as const }, { step: 'queued' as const }, { landed: 'remote' as const }])(
    'refuses an invalid initial manifest: %j',
    (patch) => {
      expect(() => repos.mergeTrains.save(train(patch))).toThrow(/new merge train/);
      expect(repos.mergeTrains.listRunning()).toEqual([]);
    },
  );

  it('keeps member identities and their order fixed after creation', () => {
    const record = train();
    repos.mergeTrains.save(record);
    for (const members of [
      [...record.members].reverse(),
      [member(2), member(3)],
      [...record.members, member(3)],
    ]) {
      expect(() => repos.mergeTrains.save({ ...record, members })).toThrow(/member order/);
      expect(repos.mergeTrains.get(record.id)).toEqual(record);
    }
  });

  it.each<[string, Record<string, unknown>]>([
    ['train id', { id: 'mrg_short' }],
    ['legacy train id', { id: 'merge_train001' }],
    ['project key', { projectKey: 'pm' }],
    ['repo name', { repo: '../projectman' }],
    ['base branch', { base: 'HEAD' }],
    ['engine id', { engineId: 'remote' }],
    ['created timestamp', { createdAt: 'yesterday' }],
    ['updated timestamp', { updatedAt: '2026-02-30T10:00:00.000Z' }],
    ['finished timestamp', { finishedAt: '2026-10-14' }],
    ['parent train id', { parentTrainId: '../parent' }],
    ['local commit', { localFrom: 'main' }],
    ['onto commit', { onto: 'a'.repeat(39) }],
    ['candidate commit', { candidate: 'invalid' }],
    ['state', { state: 'queued' }],
    ['step', { step: 'invalid' }],
    ['landed', { landed: 'invalid' }],
    ['review test', { reviewTest: { command: '', maxWorkers: 9, timeoutMinutes: 0 } }],
    ['merge check', { check: { command: 'npm test', status: 'running' } }],
    ['missing members', { members: [] }],
    ['singleton', { members: [member(1)] }],
    ['too many members', { members: Array.from({ length: 9 }, (_, i) => member(i + 1)) }],
    ['duplicate merge ids', { members: [member(1), { ...member(2), mergeId: member(1).mergeId }] }],
    ['duplicate task keys', { members: [member(1), { ...member(2), taskKey: member(1).taskKey }] }],
    ['member id', { members: [member(1), { ...member(2), mergeId: 'other_member02' }] }],
    ['member key', { members: [member(1), { ...member(2), taskKey: 'pm-2' }] }],
    ['member commit', { members: [member(1), { ...member(2), commit: 'main' }] }],
    ['member branch', { members: [member(1), { ...member(2), branch: 'topic..change' }] }],
    ['member handle', { members: [member(1), { ...member(2), startedBy: 'Claude' }] }],
    ['member timestamp', { members: [member(1), { ...member(2), startedAt: 'invalid' }] }],
    ['priority timestamp', { members: [member(1), { ...member(2), prioritizedAt: null }] }],
    ['unexpected root field', { extra: true }],
  ])('rejects an invalid %s at the write boundary', (_name, patch) => {
    expect(() => repos.mergeTrains.save({ ...train(), ...patch } as MergeTrainRecord)).toThrow(ZodError);
    expect(repos.mergeTrains.listRunning()).toEqual([]);
  });

  it('validates manifests on both read paths', () => {
    const record = train();
    repos.mergeTrains.save(record);
    repos.db
      .prepare('UPDATE merge_trains SET record_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...record, members: [member(1)] }), record.id);
    expect(() => repos.mergeTrains.get(record.id)).toThrow(ZodError);
    expect(() => repos.mergeTrains.listRunning()).toThrow(ZodError);
  });

  it.each(['id', 'projectKey', 'repo', 'state'] as const)('rejects a mismatched JSON %s', (field) => {
    const record = train();
    repos.mergeTrains.save(record);
    const value = { id: 'mrg_other000', projectKey: 'OTHER', repo: 'other', state: 'blocked' }[field];
    repos.db
      .prepare('UPDATE merge_trains SET record_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...record, [field]: value }), record.id);
    expect(() => repos.mergeTrains.get(record.id)).toThrow(/SQL fields/);
    expect(() => repos.mergeTrains.listRunning()).toThrow(/SQL fields/);
  });

  it('commits or rolls back the train and every member in the existing unit of work', () => {
    const ctx = createDomainContext({
      repos,
      bus: createEventBus(),
      logger: capturingLogger().logger,
      now: () => new Date(at),
    });
    const record = train({ members: [member(3), member(2), member(1)] });
    const rows = record.members.map(queued);
    for (const row of rows) repos.taskMerges.save(row);
    const reserve = () => {
      repos.mergeTrains.save(record);
      for (const row of rows)
        repos.taskMerges.save({
          ...row,
          state: 'running',
          step: 'merging',
          trainId: record.id,
          prioritizedAt: undefined,
        });
    };
    expect(() =>
      ctx.unitOfWork(() => {
        reserve();
        throw new Error('reservation failed');
      }),
    ).toThrow('reservation failed');
    expect(repos.mergeTrains.get(record.id)).toBeNull();
    for (const row of rows) expect(repos.taskMerges.get(row.id)).toEqual(row);
    ctx.unitOfWork(reserve);
    expect(repos.mergeTrains.get(record.id)).toEqual(record);
    for (const row of rows) {
      expect(repos.taskMerges.get(row.id)).toMatchObject({
        trainId: record.id,
        state: 'running',
        createdAt: row.createdAt,
      });
      expect(repos.taskMerges.get(row.id)).not.toHaveProperty('prioritizedAt');
    }
  });

  it('keeps train membership internal and clears it to SQL null when omitted', () => {
    const row = { ...queued(member(1)), trainId: 'mrg_train0001' };
    repos.taskMerges.save(row);
    expect(repos.taskMerges.get(row.id)).toEqual(row);
    expect(mergeState(repos.taskMerges.get(row.id)!)).not.toHaveProperty('trainId');
    repos.taskMerges.save({ ...row, state: 'merged', finishedAt: at });
    expect(mergedState(repos.taskMerges.get(row.id)!)).not.toHaveProperty('trainId');
    repos.taskMerges.save({ ...row, trainId: undefined });
    expect(repos.taskMerges.get(row.id)).not.toHaveProperty('trainId');
    expect(repos.db.prepare('SELECT train_id FROM task_merges WHERE id = ?').get(row.id)).toEqual({
      train_id: null,
    });
  });

  it.each(['merge_train001', 'mrg_short', '../train'])(
    'validates internal train membership: %s',
    (trainId) => {
      const row = queued(member(1));
      repos.taskMerges.save(row);
      expect(() => repos.taskMerges.save({ ...row, trainId })).toThrow(ZodError);
      expect(repos.taskMerges.get(row.id)).toEqual(row);
      repos.db.prepare('UPDATE task_merges SET train_id = ? WHERE id = ?').run(trainId, row.id);
      expect(() => repos.taskMerges.get(row.id)).toThrow(ZodError);
    },
  );
});

it('persists manifests across restart and rejects a competing connection reservation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-trains-'));
  const path = join(dir, 'db.sqlite');
  const first = openDatabase(path);
  const second = openDatabase(path);
  const record = train();
  try {
    createRepositories(first).mergeTrains.save(record);
    const repos = createRepositories(second);
    expect(repos.mergeTrains.get(record.id)).toEqual(record);
    expect(() => repos.mergeTrains.save(train({ id: 'mrg_compete0' }))).toThrow(/UNIQUE/);
  } finally {
    first.close();
    second.close();
  }
  const reopened = openDatabase(path);
  try {
    expect(createRepositories(reopened).mergeTrains.listRunning()).toEqual([record]);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
