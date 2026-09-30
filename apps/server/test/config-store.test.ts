import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAILY_WORKER_SCHEDULE } from '@projectman/templates';
import type { ProjectConfig } from '@projectman/shared';
import { parseYamlFile } from '../src/config/layout';
import { ConfigStoreError, createConfigStore } from '../src/config';
import { runGit } from '../src/config/git';
import type { GitConfigStore } from '../src/config';
import { testConfig } from './helpers/test-template';
import { rejection } from './helpers/errors';

const author = { name: 'Owner Person', email: 'owner@example.com' };

async function expectConfigError(promise: Promise<unknown>, code: string): Promise<ConfigStoreError> {
  const err = await rejection(promise, ConfigStoreError);
  expect(err.code).toBe(code);
  return err;
}

describe('ConfigStore (customization repository)', () => {
  let dir: string;
  let store: GitConfigStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pm-config-'));
    store = createConfigStore({ rootDir: join(dir, 'customization') });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads legacy explicit owners and approvers without rewriting YAML and round-trips duty overrides', async () => {
    const old = testConfig();
    await store.save('AR', old, { author, message: 'Legacy configuration' });
    const file = join(store.rootDir, 'projects/AR/team.yaml');
    const before = readFileSync(file, 'utf8');
    const loaded = await store.load('AR');
    expect(loaded.config.pipeline).toEqual(old.pipeline);
    expect(readFileSync(file, 'utf8')).toBe(before);
    loaded.config.team.roleOverrides = {
      developer: { duties: ['implementation', 'docs'], instructions: 'Explain examples.' },
    };
    loaded.config.team.releaseFourEyes = true;
    await store.save('AR', loaded.config, { author, message: 'Configure duties' });
    const saved = await store.load('AR');
    expect(saved.config.team.roleOverrides).toEqual(loaded.config.team.roleOverrides);
    expect(saved.config.team.releaseFourEyes).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('roleOverrides:');
  });

  it('rejects excessive YAML and does not echo source secrets', () => {
    for (const yaml of [
      'a: &a [1]\nb: *a',
      '['.repeat(60) + '1' + ']'.repeat(60),
      'x'.repeat(1024 * 1024 + 1),
      'secret-value: [',
    ]) {
      expect(() => parseYamlFile('team.yaml', yaml)).toThrow(ConfigStoreError);
      expect(() => parseYamlFile('team.yaml', yaml)).not.toThrow('secret-value');
    }
  });

  it('refuses symlinked project parents without touching the destination', async () => {
    await store.init();
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel'), 'unchanged');
    rmSync(join(store.rootDir, 'projects'), { recursive: true });
    symlinkSync(outside, join(store.rootDir, 'projects'));
    await expect(store.save('AR', testConfig(), { author, message: 'No escape' })).rejects.toThrow(
      'symlinks',
    );
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
    expect(existsSync(join(outside, 'AR'))).toBe(false);
  });

  it('initializes a separate git repository with an initial commit', async () => {
    await store.init();
    await store.init();
    expect(existsSync(join(store.rootDir, '.git'))).toBe(true);
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: store.rootDir, encoding: 'utf8' });
    expect(log.trim()).toBe('Initialize customization repository');
    expect(await store.list()).toEqual([]);
  });

  it('saves YAML files per project, loads them back and commits with the author', async () => {
    const config = testConfig();
    const { version } = await store.save('AR', config, { author, message: 'Create project AR' });
    expect(version).toMatch(/^[0-9a-f]{40}$/);

    const projectYaml = readFileSync(join(store.rootDir, 'projects/AR/project.yaml'), 'utf8');
    expect(projectYaml).toContain('schemaVersion: 1');
    expect(projectYaml).toContain('maxConcurrentAi: 3');
    expect(readFileSync(join(store.rootDir, 'projects/AR/team.yaml'), 'utf8')).toContain('handle: dev-1');
    expect(readFileSync(join(store.rootDir, 'projects/AR/pipeline.yaml'), 'utf8')).toContain('id: release');

    expect(await store.list()).toEqual(['AR']);
    const loaded = await store.load('AR');
    expect(loaded.version).toBe(version);
    expect(loaded.config).toEqual(config);

    const head = execFileSync('git', ['log', '-1', '--format=%an <%ae>|%s'], {
      cwd: store.rootDir,
      encoding: 'utf8',
    });
    expect(head.trim()).toBe('Owner Person <owner@example.com>|Create project AR');
  });

  it('keeps custom roles and human roles in team.yaml and loads files written before them', async () => {
    const config = testConfig();
    config.team.roles.push({
      id: 'data_steward',
      name: 'Data steward',
      summary: 'Keeps the reference data clean.',
      notTheirJob: '',
      holders: 'human',
      instructions: '',
    });
    const owner = config.team.members[0]!;
    if (owner.kind === 'human') owner.roles = ['operator', 'data_steward'];
    config.project.timezone = 'Europe/Budapest';
    await store.save('AR', config, { author, message: 'Create project AR' });
    expect(readFileSync(join(store.rootDir, 'projects/AR/project.yaml'), 'utf8')).toContain(
      'timezone: Europe/Budapest',
    );

    const teamYaml = readFileSync(join(store.rootDir, 'projects/AR/team.yaml'), 'utf8');
    expect(teamYaml).toContain('id: data_steward');
    expect(teamYaml).toMatch(/roles:\n\s+- operator\n\s+- data_steward/);
    expect((await store.load('AR')).config).toEqual(config);

    // A team.yaml from before custom roles, human roles and the time zone existed.
    writeFileSync(
      join(store.rootDir, 'projects/AR/team.yaml'),
      teamYaml.replace(/\nroles:[\s\S]*$/, '\n').replace(/\n\s+roles:\n(\s+- \w+\n)+/, '\n'),
    );
    const projectYaml = join(store.rootDir, 'projects/AR/project.yaml');
    writeFileSync(projectYaml, readFileSync(projectYaml, 'utf8').replace(/\n\s+timezone: .*/, ''));
    const legacy = (await store.load('AR')).config;
    expect(legacy.team.roles).toEqual([]);
    expect(legacy.team.members[0]).toMatchObject({ kind: 'human', roles: [] });
    expect(legacy.project.timezone).toBe('UTC');
  });

  it('migrates legacy scheduled members in memory and persists them on the next save', async () => {
    const warn = vi.fn();
    store = createConfigStore({ rootDir: store.rootDir, logger: { warn } });
    const { version } = await store.save('AR', testConfig(), { author, message: 'Create' });
    const path = join(store.rootDir, 'projects/AR/team.yaml');
    const fixture = readFileSync(new URL('./fixtures/legacy-scheduled-team.yaml', import.meta.url), 'utf8');
    writeFileSync(path, fixture);

    const loaded = await store.load('AR');
    expect(loaded.version).toBe(version);
    expect(loaded.config.team.members[1]).toMatchObject({
      role: 'maintainer',
      schedule: DAILY_WORKER_SCHEDULE,
    });
    expect(loaded.config.team.members[2]).toMatchObject({
      role: 'maintainer',
      schedule: { cron: '0 18 * * *', prompt: 'Review the fictional project backlog.' },
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      { projectKey: 'AR', member: 'dev-1' },
      'Migrated legacy scheduled role to maintainer',
    );
    expect(readFileSync(path, 'utf8')).toBe(fixture);
    await store.save('AR', loaded.config, { author, message: 'Save migrated configuration' });
    expect(readFileSync(path, 'utf8')).not.toContain('role: scheduled');
    expect((await store.load('AR')).config).toEqual(loaded.config);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reads a Codex member in bypassPermissions as acceptEdits, in memory until the next save', async () => {
    const warn = vi.fn();
    store = createConfigStore({ rootDir: store.rootDir, logger: { warn } });
    await store.save('AR', testConfig(), { author, message: 'Create' });
    const path = join(store.rootDir, 'projects/AR/team.yaml');
    const member = (handle: string, settings: string[]) =>
      [
        '  - kind: ai',
        `    handle: ${handle}`,
        `    displayName: ${handle}`,
        '    role: developer',
        '    sponsor: owner',
        ...settings.map((line) => `    ${line}`),
      ].join('\n');
    const legacy = `members:
  - kind: human
    handle: owner
    displayName: Owner Person
    access: owner
${member('dev-1', ['provider: codex', 'permissionMode: bypassPermissions'])}
${member('dev-2', ['permissionMode: bypassPermissions'])}
  - kind: ai
    handle: cr
    displayName: Reviewer
    role: code_review
    sponsor: owner
`;
    writeFileSync(path, legacy);

    const loaded = await store.load('AR');
    expect(loaded.config.team.members[1]).toMatchObject({ provider: 'codex', permissionMode: 'acceptEdits' });
    expect(loaded.config.team.members[2]).toMatchObject({ permissionMode: 'bypassPermissions' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { projectKey: 'AR', member: 'dev-1' },
      'Migrated codex member from bypassPermissions to acceptEdits',
    );
    expect(readFileSync(path, 'utf8')).toBe(legacy);

    await store.save('AR', loaded.config, { author, message: 'Save migrated configuration' });
    const saved = parseYamlFile('team.yaml', readFileSync(path, 'utf8')) as {
      members: Array<Record<string, unknown>>;
    };
    expect(saved.members[1]).toMatchObject({ provider: 'codex', permissionMode: 'acceptEdits' });
    expect(saved.members[2]).toMatchObject({ permissionMode: 'bypassPermissions' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses to save a Codex member in bypassPermissions', async () => {
    const config = testConfig();
    const developer = config.team.members[1]!;
    if (developer.kind !== 'ai') throw new Error('expected an AI member');
    developer.provider = 'codex';
    developer.permissionMode = 'bypassPermissions';
    const err = await expectConfigError(
      store.save('AR', config, { author, message: 'Create' }),
      'invalid_config',
    );
    expect((err.details as { issues: unknown[] }).issues).toContainEqual({
      code: 'codex_bypass_not_allowed',
      path: 'team.members[1].permissionMode',
    });
  });

  it('does not commit when nothing changed', async () => {
    const first = await store.save('AR', testConfig(), { author, message: 'Create' });
    const second = await store.save('AR', testConfig(), { author, message: 'No-op' });
    expect(second.version).toBe(first.version);
    expect(await store.history('AR')).toHaveLength(1);
  });

  it('lists history newest first and reverts to an earlier version in a new commit', async () => {
    const v1 = await store.save('AR', testConfig(), { author, message: 'Create project AR' });
    const changed: ProjectConfig = testConfig();
    changed.team.limits.maxConcurrentAi = 5;
    const v2 = await store.save('AR', changed, {
      author: { name: 'Admin', email: 'a@x' },
      message: 'Raise AI limit',
    });
    expect(v2.version).not.toBe(v1.version);

    const history = await store.history('AR');
    expect(history.map((h) => h.message)).toEqual(['Raise AI limit', 'Create project AR']);
    expect(history[0]).toMatchObject({ version: v2.version, author: 'Admin' });
    expect(history[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const reverted = await store.revertTo('AR', v1.version, { author });
    expect(reverted.version).not.toBe(v2.version);
    expect((await store.load('AR')).config.team.limits.maxConcurrentAi).toBe(3);
    const after = await store.history('AR');
    expect(after).toHaveLength(3);
    expect(after[0]!.message).toBe(`Revert AR configuration to ${v1.version.slice(0, 12)}`);

    // Reverting to the current content is a no-op.
    expect((await store.revertTo('AR', v1.version, { author })).version).toBe(reverted.version);
    await expectConfigError(store.revertTo('AR', 'deadbeef', { author }), 'unknown_version');
    await expectConfigError(store.revertTo('AR', '--help', { author }), 'unknown_version');
  });

  it('rejects configurations that violate the invariants and keeps the repository unchanged', async () => {
    await store.save('AR', testConfig(), { author, message: 'Create' });
    const bad: ProjectConfig = testConfig();
    const merge = bad.pipeline.stages.find((s) => s.id === 'merge')!;
    merge.gate = { conditions: [{ type: 'has_label', label: 'nobody-knows' }] };
    const err = await expectConfigError(
      store.save('AR', bad, { author, message: 'Unknown gate label' }),
      'invalid_config',
    );
    expect((err.details as { issues: Array<{ code: string }> }).issues.map((i) => i.code)).toContain(
      'unknown_label',
    );

    const noOwner: ProjectConfig = testConfig();
    noOwner.team.members = noOwner.team.members.map((m) =>
      m.kind === 'human' ? { ...m, access: 'admin' } : m,
    );
    await expectConfigError(store.save('AR', noOwner, { author, message: 'No owner' }), 'invalid_config');

    const schema = { ...testConfig(), schemaVersion: 2 } as unknown as ProjectConfig;
    await expectConfigError(store.save('AR', schema, { author, message: 'Schema' }), 'invalid_config');
    await expectConfigError(
      store.save('XY', testConfig(), { author, message: 'Key mismatch' }),
      'invalid_config',
    );
    await expectConfigError(
      store.save('../x', testConfig(), { author, message: 'Traversal' }),
      'invalid_key',
    );

    expect(await store.history('AR')).toHaveLength(1);
    expect((await store.load('AR')).config).toEqual(testConfig());
  });

  it('reports broken YAML and missing projects on load', async () => {
    await expectConfigError(store.load('ZZ'), 'not_found');
    await store.save('AR', testConfig(), { author, message: 'Create' });
    writeFileSync(join(store.rootDir, 'projects/AR/team.yaml'), 'members: [unclosed');
    await expectConfigError(store.load('AR'), 'invalid_yaml');
  });

  it('ignores GIT_* variables of the parent process', async () => {
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(dir, 'somewhere-else');
    try {
      await store.save('AR', testConfig(), { author, message: 'Create' });
      expect(await store.history('AR')).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it('serializes concurrent saves', async () => {
    const configs = [3, 4, 5, 6].map((n) => {
      const c = testConfig();
      c.team.limits.maxConcurrentAi = n;
      return c;
    });
    await Promise.all(configs.map((c, i) => store.save('AR', c, { author, message: `Change ${i}` })));
    expect(await store.history('AR')).toHaveLength(4);
    expect((await store.load('AR')).config.team.limits.maxConcurrentAi).toBe(6);
  });

  it('never reads a project while a save rewrites its files', async () => {
    await store.save('AR', testConfig(), { author, message: 'Create' });
    const operations = Array.from({ length: 24 }, (_, i) => {
      if (i % 2) return store.load('AR').then(({ config }) => config.team.limits.maxConcurrentAi);
      const config = testConfig();
      config.team.limits.maxConcurrentAi = 1 + (i % 5);
      return store.save('AR', config, { author, message: `Change ${i}` }).then(() => null);
    });
    const results = await Promise.allSettled(operations);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(await store.list()).toEqual(['AR']);
  });

  it('migrates earlier versions like the working tree (revert)', async () => {
    const created = await store.save('AR', testConfig(), { author, message: 'Create' });
    const teamYaml = join(store.rootDir, 'projects/AR/team.yaml');
    writeFileSync(teamYaml, readFileSync(teamYaml, 'utf8').replace('role: developer', 'role: scheduled'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], {
        cwd: store.rootDir,
        encoding: 'utf8',
      });
    git('commit', '-q', '--no-verify', '-am', 'Hand-edited legacy role');
    const legacy = git('rev-parse', 'HEAD').trim();
    await store.save('AR', testConfig(), { author, message: 'Back to current' });

    const expected = { role: 'maintainer', schedule: DAILY_WORKER_SCHEDULE };
    expect((await store.loadVersion('AR', legacy)).team.members[1]).toMatchObject(expected);
    expect((await store.loadVersion('AR', created.version)).team.members[1]).toMatchObject({
      role: 'developer',
    });
    await store.revertTo('AR', legacy, { author });
    expect((await store.load('AR')).config.team.members[1]).toMatchObject(expected);
    await expectConfigError(store.loadVersion('AR', 'deadbeef'), 'unknown_version');
  });
});

describe('git on the customization repository', () => {
  it('kills a call that runs longer than its timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-config-git-'));
    try {
      // hash-object waits for stdin, which is never closed.
      await expect(runGit(dir, ['hash-object', '--stdin'], { timeoutMs: 200 })).rejects.toThrow(/timed out/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
