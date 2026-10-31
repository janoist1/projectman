import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_BYTES } from '@projectman/shared';
import type { Actor } from '@projectman/shared';
import {
  createConfigStore,
  createCustomizationRepo,
  createDocumentStore,
  DocumentStoreError,
} from '../src/config';
import type { CustomizationRepo, GitConfigStore } from '../src/config';
import { runGit } from '../src/config/git';
import type { DocumentStore, DocumentWriter } from '../src/contracts';
import { testConfig } from './helpers/test-template';
import { rejection } from './helpers/errors';

const writerOf = (kind: Actor['kind'], handle: string, name = handle): DocumentWriter => ({
  name,
  email: `${handle}@members.projectman.invalid`,
  actor: { kind, handle },
});
const ann = writerOf('human', 'ann', 'Ann Owner');
const robot = writerOf('ai', 'dev', 'Fejlesztő 1');

describe('DocumentStore (documents repository in the customization repository)', () => {
  let dir: string;
  let repo: CustomizationRepo;
  let configs: GitConfigStore;
  let docs: DocumentStore;

  const git = async (args: string[], cwd = repo.rootDir) => (await runGit(cwd, args)).stdout.trim();
  const docsDir = (key = 'AR') => join(repo.rootDir, 'documents', key);
  const expectError = async (promise: Promise<unknown>, code: string) =>
    expect((await rejection(promise, DocumentStoreError)).code).toBe(code);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pm-documents-'));
    repo = createCustomizationRepo({ rootDir: join(dir, 'customization') });
    configs = createConfigStore({ rootDir: repo.rootDir, repo });
    docs = createDocumentStore({ repo });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists nothing before the first document and creates the submodule on the first write', async () => {
    expect(await docs.list('AR')).toEqual([]);
    expect(existsSync(docsDir())).toBe(false);

    const created = await docs.create('AR', { title: 'Projektterv', content: '# Terv\n' }, ann);

    expect(created.slug).toBe('projektterv');
    expect(existsSync(join(docsDir(), '.git'))).toBe(true);
    expect(readFileSync(join(repo.rootDir, '.gitmodules'), 'utf8')).toContain('path = documents/AR');
    expect(await git(['ls-files', '--stage', 'documents/AR'])).toMatch(/^160000 /);
    expect(await git(['submodule', 'status'])).toContain('documents/AR');
    expect(await docs.list('AR')).toEqual([
      expect.objectContaining({ slug: 'projektterv', title: 'Projektterv' }),
    ]);
  });

  it('points the parent at the documents HEAD after every write and makes up a missed gitlink commit', async () => {
    await docs.create('AR', { title: 'One', content: 'a' }, ann);
    const gitlink = async () => (await git(['ls-tree', 'HEAD', 'documents/AR'])).split(/\s+/)[2];
    expect(await gitlink()).toBe(await git(['rev-parse', 'HEAD'], docsDir()));

    await git(['reset', '-q', '--hard', 'HEAD~1']);
    await docs.create('AR', { title: 'Two', content: 'b' }, ann);

    expect(await gitlink()).toBe(await git(['rev-parse', 'HEAD'], docsDir()));
  });

  it('writes author and actor trailers, reads old versions and keeps the history across renames', async () => {
    const first = await docs.create('AR', { title: 'Plan', content: 'one', message: 'Start' }, ann);
    const second = await docs.update('AR', 'plan', { content: 'two' }, first.version, robot);
    const renamed = await docs.update('AR', 'plan', { title: 'Master plan' }, second.version, ann);

    expect(renamed.slug).toBe('plan');
    expect(renamed.title).toBe('Master plan');
    expect(renamed.content).toBe('two');
    expect((await docs.read('AR', 'plan', first.version)).content).toBe('one');
    const history = await docs.history('AR', 'plan');
    expect(history.map((entry) => entry.message)).toEqual(['Rename plan', 'Update plan', 'Start']);
    expect(history.map((entry) => entry.title)).toEqual(['Master plan', 'Plan', 'Plan']);
    expect(history[1]?.by).toEqual({ kind: 'ai', handle: 'dev', name: 'Fejlesztő 1' });
    expect(history[0]?.by).toEqual({ kind: 'human', handle: 'ann', name: 'Ann Owner' });
    expect(await git(['log', '-1', '--format=%an'], docsDir())).toBe('Ann Owner');
  });

  it('refuses a stale base version with the current one and commits nothing for an unchanged text', async () => {
    const first = await docs.create('AR', { title: 'Plan', content: 'one' }, ann);
    const second = await docs.update('AR', 'plan', { content: 'two' }, first.version, ann);

    const error = await rejection(
      docs.update('AR', 'plan', { content: 'mine' }, first.version, robot),
      DocumentStoreError,
    );
    expect(error.code).toBe('conflict');
    expect(error.details).toEqual({ currentVersion: second.version });
    expect((await docs.update('AR', 'plan', { content: 'two' }, second.version, ann)).version).toBe(
      second.version,
    );
    expect(await git(['rev-list', '--count', 'HEAD'], docsDir())).toBe('3');
  });

  it('restores an old version as a new one, then deletes with the history kept and the slug reserved', async () => {
    const first = await docs.create('AR', { title: 'Plan', content: 'one' }, ann);
    const second = await docs.update('AR', 'plan', { content: 'two' }, first.version, ann);

    const restored = await docs.restore('AR', 'plan', first.version, second.version, robot);
    expect(restored.content).toBe('one');
    expect(restored.version).not.toBe(first.version);
    expect((await docs.history('AR', 'plan')).map((entry) => entry.message)).toEqual([
      `Restore plan to ${first.version.slice(0, 12)}`,
      'Update plan',
      'Create plan',
    ]);

    const removed = await docs.remove('AR', 'plan', restored.version, ann);
    expect(await docs.list('AR')).toEqual([]);
    await expectError(docs.read('AR', 'plan'), 'not_found');
    const history = await docs.history('AR', 'plan');
    expect(history[0]).toMatchObject({ version: removed.version, deleted: true, title: 'Plan' });
    expect((await docs.read('AR', 'plan', second.version)).content).toBe('two');
    expect((await docs.create('AR', { title: 'Plan', content: 'new' }, ann)).slug).toBe('plan-2');
  });

  it.each([
    ['an empty title', () => docs.create('AR', { title: '  ', content: '' }, ann), 'invalid_title'],
    [
      'a too long title',
      () => docs.create('AR', { title: 'x'.repeat(201), content: '' }, ann),
      'invalid_title',
    ],
    [
      'a text over the limit',
      () => docs.create('AR', { title: 'Big', content: 'x'.repeat(MAX_DOCUMENT_BYTES + 1) }, ann),
      'too_large',
    ],
    ['an invalid slug', () => docs.read('AR', '../etc'), 'invalid_slug'],
    ['an unknown document', () => docs.history('AR', 'nothing'), 'not_found'],
  ])('refuses %s', async (_name, run, code) => {
    await expectError(run(), code);
  });

  it.each(['directory', 'file'])('refuses a symlink in place of the %s', async (kind) => {
    const first = await docs.create('AR', { title: 'Plan', content: 'one' }, ann);
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel'), 'unchanged');
    if (kind === 'directory') {
      rmSync(docsDir(), { recursive: true });
      symlinkSync(outside, docsDir());
    } else {
      rmSync(join(docsDir(), 'plan.md'));
      symlinkSync(join(outside, 'sentinel'), join(docsDir(), 'plan.md'));
    }

    await expectError(docs.update('AR', 'plan', { content: 'x' }, first.version, ann), 'unsafe_path');
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
  });

  describe('next to the configuration', () => {
    const save = (message: string) => configs.save('AR', testConfig(), { author: ann, message });

    it('leaves the configuration version and history alone and survives a save and a revert', async () => {
      const before = await save('Initial');
      const first = await docs.create('AR', { title: 'Plan', content: 'one' }, ann);
      await docs.update('AR', 'plan', { content: 'two' }, first.version, ann);

      expect((await configs.load('AR')).version).toBe(before.version);
      expect((await configs.history('AR')).map((entry) => entry.message)).toEqual(['Initial']);

      const config = testConfig();
      config.project.name = 'Renamed';
      const saved = await configs.save('AR', config, { author: ann, message: 'Rename project' });
      await configs.revertTo('AR', before.version, { author: ann });

      expect((await configs.load('AR')).version).not.toBe(saved.version);
      expect((await docs.read('AR', 'plan')).content).toBe('two');
      expect(await docs.history('AR', 'plan')).toHaveLength(2);
    });

    it('does not collide when configuration and document writes run together', async () => {
      await save('Initial');
      const writes = [
        ...Array.from({ length: 4 }, (_, i) => docs.create('AR', { title: `Doc ${i}`, content: 'x' }, ann)),
        ...Array.from({ length: 4 }, (_, i) => save(`Save ${i}`)),
      ];
      await Promise.all(writes);

      expect(await docs.list('AR')).toHaveLength(4);
      expect(await git(['status', '--porcelain', '--', 'documents', '.gitmodules'])).toBe('');
    });

    it('loads an old customization repository that has no documents', async () => {
      await save('Initial');
      expect(await configs.list()).toEqual(['AR']);
      expect(await docs.list('AR')).toEqual([]);
    });
  });
});
