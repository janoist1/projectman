import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTemplate } from '@projectman/templates';
import { createWorktreeManager } from '../src/worktree/index';
import { fixtureEnv, networkChecks, observe, plant, serve, setup } from '../../../scripts/sandbox-probe.mjs';

let base;
let p;
beforeEach(async () => {
  // macOS sockaddr_un has a short path limit; its normal per-user tmpdir is too long.
  base = await realpath(await mkdtemp(path.join(await realpath('/tmp'), 'pm126-')));
  p = await setup(path.join(base, 'fixture'));
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(fixtureEnv(p)))
    if (key.startsWith('GIT_')) vi.stubEnv(key, value);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (base) await rm(base, { recursive: true, force: true });
});

describe('PM-126 fictional probe fixtures (no agent CLI)', () => {
  it('requires live positive controls for IPv4, localhost, IPv6 and Unix sockets', async () => {
    const servers = await serve(p, { ipv4: 0, ipv6: 0 });
    const ports = { ipv4: servers[0].address().port, ipv6: servers[1].address().port };
    try {
      const baseline = await networkChecks(p, true, ports);
      expect(baseline).toHaveLength(4);
      expect(baseline.every((result) => result.meetsExpectation)).toBe(true);
      const exposure = await networkChecks(p, false, ports);
      expect(exposure.every((result) => result.observed === 'allowed' && !result.meetsExpectation)).toBe(
        true,
      );
    } finally {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    }
    const closed = await networkChecks(p, false, ports);
    expect(
      closed.every((result) => result.observed === 'failed-unclassified' && !result.meetsExpectation),
    ).toBe(true);
  });
  it('places own and foreign worktrees below the protected application home', async () => {
    expect(p.own.startsWith(`${p.data}${path.sep}`)).toBe(true);
    expect(p.other.startsWith(`${p.data}${path.sep}`)).toBe(true);
    const settings = JSON.parse(await readFile(path.join(p.own, 'claude-strict.json'), 'utf8'));
    expect(settings.sandbox.filesystem.denyRead).toContain(p.data);
    expect(settings.sandbox.filesystem.allowRead).toEqual([p.own, p.common]);
    expect(await readFile(path.join(p.own, 'secret-link'), 'utf8')).toBe('fictional cookie key');
    await expect(setup(p.root)).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('does not report a missing target or command failure as sandbox denial', async () => {
    expect(await observe('missing', 'deny', () => readFile(path.join(p.root, 'missing')))).toMatchObject({
      observed: 'failed-unclassified',
      meetsExpectation: false,
      code: 'ENOENT',
    });
    expect(
      await observe('command', 'deny', () => Promise.reject({ code: 1, stderr: 'invalid argument' })),
    ).toMatchObject({
      observed: 'failed-unclassified',
      meetsExpectation: false,
    });
    expect(
      await observe('permission', 'deny', () => Promise.reject({ code: 'EPERM', message: 'not permitted' })),
    ).toMatchObject({
      observed: 'denied',
      meetsExpectation: true,
    });
  });

  // This proves the host trigger, not whether a particular native sandbox allows planting.
  // If host git is hardened, replace these exposure assertions with marker-absence assertions.
  it.each(['hook', 'config-hooks', 'config-fsmonitor'])(
    'reproduces %s execution by the actual host worktree manager',
    async (variant) => {
      const { target } = await plant(p, variant);
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
      const project = getTemplate('small-team').build({
        key: 'T',
        name: 'Fictional probe',
        workspacePath: p.root,
        language: 'en',
        owner: { handle: 'owner', displayName: 'Probe', email: 'probe@example.invalid' },
      });
      project.project.repos = [{ name: 'repo', path: 'main-repo', defaultBranch: 'main' }];
      const noop = () => undefined;
      const manager = createWorktreeManager({
        rootDir: path.join(p.data, 'worktrees'),
        logger: { debug: noop, info: noop, warn: noop },
      });
      if (variant === 'config-fsmonitor') await manager.status(p.own);
      else
        await manager.ensureForTask({
          project,
          repoName: 'repo',
          taskKey: 'T-3',
          title: 'Fictional host trigger',
        });
      expect(await readFile(target, 'utf8')).toBe('fictional host execution\n');
    },
  );
});
