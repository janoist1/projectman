import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperatorKnowledgeStore } from './operator-knowledge-store';
import type { OperatorKnowledgeDocument } from '@projectman/shared';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});

let directory: string;
let rootDir: string;
let store: ReturnType<typeof createOperatorKnowledgeStore>;
const approvedAt = '2026-10-14T12:00:00.000Z';
const nextKnowledge = (): OperatorKnowledgeDocument => ({
  schemaVersion: 1,
  revision: 1,
  agreement: {
    version: 1,
    data: { summary: 'Ask before critical steps', involvement: 'important', extraCritical: ['Deployment'] },
    approvedBy: 'owner',
    approvedAt,
  },
  principles: [
    {
      id: 'principle-1',
      example: 'Check source',
      principle: 'Verify first',
      effect: 'Fewer guesses',
      approvedBy: 'owner',
      approvedAt,
    },
  ],
  appliedProposalIds: ['proposal-1'],
});
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'operator-knowledge-'));
  rootDir = join(directory, 'operator-data');
  store = createOperatorKnowledgeStore({ rootDir });
});
afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('private operator storage', () => {
  it('returns fresh defaults for missing files without creating storage', async () => {
    expect(await store.readKnowledge('PM')).toEqual({
      schemaVersion: 1,
      revision: 0,
      agreement: null,
      principles: [],
      appliedProposalIds: [],
    });
    const preference = await store.readPreference('PM', 'owner');
    expect(preference).toEqual({
      schemaVersion: 1,
      revision: 0,
      data: {
        length: 'brief',
        technicalLevel: 'plain',
        detail: 'offer',
        clarity: 'plain',
        background: 'minimal',
      },
      updatedAt: null,
    });
    preference.data.length = 'detailed';
    expect((await store.readPreference('PM', 'owner')).data.length).toBe('brief');
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('persists all three records across store restart with private modes and isolated keys', async () => {
    const knowledge = nextKnowledge();
    await store.compareAndSwapKnowledge('PM', 0, knowledge);
    const preference = { ...(await store.readPreference('PM', 'owner')), revision: 1, updatedAt: approvedAt };
    preference.data.length = 'detailed';
    await store.compareAndSwapPreference('PM', 'owner', 0, preference);
    const restarted = createOperatorKnowledgeStore({ rootDir });
    expect(await restarted.readKnowledge('PM')).toEqual(knowledge);
    expect(await restarted.readPreference('PM', 'owner')).toEqual(preference);
    expect((await restarted.readPreference('PM', 'qa')).revision).toBe(0);
    expect((await restarted.readKnowledge('AR')).revision).toBe(0);
    for (const path of [rootDir, join(rootDir, 'PM'), join(rootDir, 'PM/preferences')])
      expect((await fs.stat(path)).mode & 0o777).toBe(0o700);
    for (const path of [join(rootDir, 'PM/knowledge.json'), join(rootDir, 'PM/preferences/owner.json')])
      expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(join(rootDir, 'PM'))).toEqual(['knowledge.json', 'preferences']);
  });

  it('allows exactly one concurrent CAS at the same revision across store instances', async () => {
    const other = createOperatorKnowledgeStore({ rootDir });
    const results = await Promise.allSettled([
      store.compareAndSwapKnowledge('PM', 0, nextKnowledge()),
      other.compareAndSwapKnowledge('PM', 0, { ...nextKnowledge(), appliedProposalIds: ['proposal-2'] }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'operator_knowledge_stale', status: 409 },
    });
    expect((await store.readKnowledge('PM')).revision).toBe(1);
    const preference = { ...(await store.readPreference('PM', 'owner')), revision: 1 };
    const preferences = await Promise.allSettled([
      store.compareAndSwapPreference('PM', 'owner', 0, preference),
      other.compareAndSwapPreference('PM', 'owner', 0, preference),
    ]);
    expect(preferences.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(preferences.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'operator_knowledge_stale' },
    });
  });

  it.each([-1, 0.5, NaN, Infinity])('rejects invalid expected revision %s', async (revision) => {
    await expect(store.compareAndSwapKnowledge('PM', revision, nextKnowledge())).rejects.toMatchObject({
      code: 'operator_knowledge_invalid',
    });
  });
  it('requires an increment of exactly one and leaves the existing file unchanged', async () => {
    await store.compareAndSwapKnowledge('PM', 0, nextKnowledge());
    for (const revision of [1, 3])
      await expect(
        store.compareAndSwapKnowledge('PM', 1, { ...nextKnowledge(), revision }),
      ).rejects.toMatchObject({ code: 'operator_knowledge_invalid' });
    expect(await store.readKnowledge('PM')).toEqual(nextKnowledge());
  });

  it.each(['../PM', '/PM', 'pm', 'PM/AR', 'PM\\AR', 'PM\0'])('rejects unsafe project key %s', async (key) => {
    await expect(store.readKnowledge(key)).rejects.toMatchObject({ code: 'operator_knowledge_invalid' });
    await expect(store.compareAndSwapKnowledge(key, 0, nextKnowledge())).rejects.toMatchObject({
      code: 'operator_knowledge_invalid',
    });
  });
  it.each(['../owner', '/owner', 'Owner', 'owner/qa', 'owner\\qa', 'owner\0'])(
    'rejects unsafe member handle %s',
    async (handle) => {
      await expect(store.readPreference('PM', handle)).rejects.toMatchObject({
        code: 'operator_knowledge_invalid',
      });
      await expect(
        store.compareAndSwapPreference('PM', handle, 0, {
          ...(await store.readPreference('PM', 'owner')),
          revision: 1,
        }),
      ).rejects.toMatchObject({ code: 'operator_knowledge_invalid' });
    },
  );

  it.each([undefined, null, 42])('rejects a non-string preference handle %s', async (handle) => {
    const next = { ...(await store.readPreference('PM', 'owner')), revision: 1 };
    await expect(store.readPreference('PM', handle as unknown as string)).rejects.toMatchObject({
      code: 'operator_knowledge_invalid',
    });
    await expect(
      store.compareAndSwapPreference('PM', handle as unknown as string, 0, next),
    ).rejects.toMatchObject({
      code: 'operator_knowledge_invalid',
    });
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it.each(['root', 'project', 'preferences', 'knowledge', 'preference'])(
    'refuses a symlink at %s on reads and writes',
    async (location) => {
      const outside = join(directory, 'outside');
      await fs.mkdir(outside);
      await fs.mkdir(join(rootDir, 'PM/preferences'), { recursive: true });
      const paths = {
        root: rootDir,
        project: join(rootDir, 'PM'),
        preferences: join(rootDir, 'PM/preferences'),
        knowledge: join(rootDir, 'PM/knowledge.json'),
        preference: join(rootDir, 'PM/preferences/owner.json'),
      };
      const path = paths[location as keyof typeof paths];
      await fs.rm(path, { recursive: true, force: true });
      await fs.symlink(outside, path);
      if (['preferences', 'preference'].includes(location)) {
        await expect(store.readPreference('PM', 'owner')).rejects.toMatchObject({
          code: 'operator_knowledge_invalid',
        });
        await expect(
          store.compareAndSwapPreference('PM', 'owner', 0, {
            schemaVersion: 1,
            revision: 1,
            data: {
              length: 'brief',
              technicalLevel: 'plain',
              detail: 'offer',
              clarity: 'plain',
              background: 'minimal',
            },
            updatedAt: null,
          }),
        ).rejects.toMatchObject({ code: 'operator_knowledge_invalid' });
      } else {
        await expect(store.readKnowledge('PM')).rejects.toMatchObject({ code: 'operator_knowledge_invalid' });
        await expect(store.compareAndSwapKnowledge('PM', 0, nextKnowledge())).rejects.toMatchObject({
          code: 'operator_knowledge_invalid',
        });
      }
      expect(await fs.readdir(outside)).toEqual([]);
    },
  );

  it('refuses a directory as a document', async () => {
    await fs.mkdir(join(rootDir, 'PM/knowledge.json'), { recursive: true });
    await expect(store.readKnowledge('PM')).rejects.toMatchObject({ code: 'operator_knowledge_invalid' });
    await expect(store.compareAndSwapKnowledge('PM', 0, nextKnowledge())).rejects.toMatchObject({
      code: 'operator_knowledge_invalid',
    });
  });
  it('refuses a hard-linked document without changing its other name', async () => {
    await store.compareAndSwapKnowledge('PM', 0, nextKnowledge());
    const copy = join(directory, 'linked.json');
    await fs.link(join(rootDir, 'PM/knowledge.json'), copy);
    await expect(store.readKnowledge('PM')).rejects.toMatchObject({ code: 'operator_knowledge_invalid' });
    await expect(
      store.compareAndSwapKnowledge('PM', 1, { ...nextKnowledge(), revision: 2 }),
    ).rejects.toMatchObject({ code: 'operator_knowledge_invalid' });
    expect(JSON.parse(await fs.readFile(copy, 'utf8'))).toEqual(nextKnowledge());
  });
  it('preserves malformed preference files on reads and writes', async () => {
    const next = { ...(await store.readPreference('PM', 'owner')), revision: 1 };
    await fs.mkdir(join(rootDir, 'PM/preferences'), { recursive: true });
    const file = join(rootDir, 'PM/preferences/owner.json');
    await fs.writeFile(file, '{partial');
    await expect(store.readPreference('PM', 'owner')).rejects.toMatchObject({
      code: 'operator_knowledge_invalid',
      status: 409,
    });
    await expect(store.compareAndSwapPreference('PM', 'owner', 0, next)).rejects.toMatchObject({
      code: 'operator_knowledge_invalid',
    });
    expect(await fs.readFile(file, 'utf8')).toBe('{partial');
  });
  it('reports read I/O failures as unavailable without treating them as missing', async () => {
    await store.compareAndSwapKnowledge('PM', 0, nextKnowledge());
    vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error('Read failure'), { code: 'EIO' }));
    await expect(store.readKnowledge('PM')).rejects.toMatchObject({
      code: 'operator_knowledge_unavailable',
      status: 503,
    });
    expect(await store.readKnowledge('PM')).toEqual(nextKnowledge());
  });
  it.each([
    '{unfinished',
    JSON.stringify({ ...nextKnowledge(), schemaVersion: 2 }),
    JSON.stringify({ ...nextKnowledge(), operatorWatch: true }),
  ])('preserves corrupt or unknown data', async (raw) => {
    await fs.mkdir(join(rootDir, 'PM'), { recursive: true });
    const file = join(rootDir, 'PM/knowledge.json');
    await fs.writeFile(file, raw);
    await expect(store.readKnowledge('PM')).rejects.toMatchObject({
      code: 'operator_knowledge_invalid',
      status: 409,
    });
    await expect(store.compareAndSwapKnowledge('PM', 0, nextKnowledge())).rejects.toMatchObject({
      code: 'operator_knowledge_invalid',
    });
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
  });

  it('rejects duplicate markers and principle ids and never drops an approval marker', async () => {
    const next = nextKnowledge();
    await expect(
      store.compareAndSwapKnowledge('PM', 0, { ...next, appliedProposalIds: ['same', 'same'] }),
    ).rejects.toMatchObject({ code: 'operator_knowledge_invalid' });
    await expect(
      store.compareAndSwapKnowledge('PM', 0, {
        ...next,
        principles: [next.principles[0]!, next.principles[0]!],
      }),
    ).rejects.toMatchObject({ code: 'operator_knowledge_invalid' });
    await store.compareAndSwapKnowledge('PM', 0, next);
    await expect(
      store.compareAndSwapKnowledge('PM', 1, { ...next, revision: 2, appliedProposalIds: [] }),
    ).rejects.toMatchObject({ code: 'operator_knowledge_invalid' });
  });
  it('accepts 512 markers, refuses overflow with the limit code, and retains every approval', async () => {
    const next = {
      ...nextKnowledge(),
      appliedProposalIds: Array.from({ length: 512 }, (_, i) => `proposal-${i}`),
    };
    await store.compareAndSwapKnowledge('PM', 0, next);
    await expect(
      store.compareAndSwapKnowledge('PM', 1, {
        ...next,
        revision: 2,
        appliedProposalIds: [...next.appliedProposalIds, 'new'],
      }),
    ).rejects.toMatchObject({ code: 'operator_knowledge_limit', status: 409 });
    expect(await store.readKnowledge('PM')).toEqual(next);
  });
  it('keeps the instance knowledge apart from the projects and refuses a stale write', async () => {
    expect((await store.readInstanceKnowledge()).revision).toBe(0);
    await store.compareAndSwapInstanceKnowledge(0, nextKnowledge());
    expect(await store.readInstanceKnowledge()).toEqual(nextKnowledge());
    expect((await store.readKnowledge('PM')).revision).toBe(0);
    expect(await fs.readdir(join(rootDir, '_instance'))).toEqual(['knowledge.json']);
    await expect(store.compareAndSwapInstanceKnowledge(0, nextKnowledge())).rejects.toMatchObject({
      code: 'operator_knowledge_stale',
      status: 409,
    });
  });
  it('preserves complete JSON and cleans the temporary file after a failed atomic rename', async () => {
    await store.compareAndSwapKnowledge('PM', 0, nextKnowledge());
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('I/O failure'), { code: 'EIO' }));
    await expect(
      store.compareAndSwapKnowledge('PM', 1, { ...nextKnowledge(), revision: 2 }),
    ).rejects.toMatchObject({ code: 'operator_knowledge_unavailable', status: 503 });
    expect(await store.readKnowledge('PM')).toEqual(nextKnowledge());
    expect(await fs.readdir(join(rootDir, 'PM'))).toEqual(['knowledge.json']);
    await store.compareAndSwapKnowledge('PM', 1, { ...nextKnowledge(), revision: 2 });
    const [temporary, destination] = vi.mocked(fs.rename).mock.calls.at(-1)!;
    expect(destination).toBe(join(rootDir, 'PM/knowledge.json'));
    expect(String(temporary)).toMatch(/PM\/\.operator-.*\.tmp$/);
  });
});
