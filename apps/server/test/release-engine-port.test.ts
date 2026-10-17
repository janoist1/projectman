import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Release } from '@projectman/shared';
import { realDeps } from '../../../scripts/cloud/deps';
import type { CloudDeps, RunOptions } from '../../../scripts/cloud/deps';
import type { CloudContext } from '../../../scripts/cloud/context';
import { PLIST_TEMPLATE, renderPlist, SERVICE_LABEL } from '../../../scripts/engine/service';
import { enginePort, publishPort } from '../../../scripts/release/adapters';
import type { HybridWorld } from '../../../scripts/release/adapters';
import { FakeLaunchd } from './helpers/fake-launchd';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const COMMIT = 'a'.repeat(40);

let launchd: FakeLaunchd;
let engineHome: string;
let alive: Set<number>;
let syncCalls: string[][];
let syncStatuses: number[];
beforeEach(() => {
  launchd = new FakeLaunchd();
  engineHome = path.join(launchd.dir, 'engine-home');
  fs.mkdirSync(engineHome, { mode: 0o700 });
  fs.mkdirSync(launchd.stateDir, { mode: 0o700, recursive: true });
  alive = new Set();
  syncCalls = [];
  syncStatuses = [];
});
afterEach(() => launchd.cleanup());

function world(overrides: Partial<HybridWorld> = {}): HybridWorld {
  return {
    context: { deps: realDeps() } as unknown as CloudContext,
    launchd: launchd.deps(),
    launchctlSync: (args) => {
      syncCalls.push(args);
      const status = args[0] === 'bootstrap' ? (syncStatuses.shift() ?? 0) : 0;
      if (args[0] === 'bootstrap' && status === 0) launchd.loaded.add(SERVICE_LABEL);
      if (args[0] === 'bootout') launchd.loaded.delete(SERVICE_LABEL);
      return { status, stdout: '', stderr: '' };
    },
    isPidAlive: (pid) => alive.has(pid),
    root: launchd.root,
    nodePath: process.execPath,
    platform: 'darwin',
    out: () => undefined,
    ...overrides,
  };
}

const template = () => fs.readFileSync(path.join(REPO_ROOT, PLIST_TEMPLATE), 'utf8');
function installEngine(root: string): string {
  const text = renderPlist(template(), {
    label: SERVICE_LABEL,
    node: '/opt/homebrew/bin/node',
    root,
    path: '/opt/homebrew/bin:/usr/bin',
    home: engineHome,
    logOut: '/logs/out',
    logErr: '/logs/err',
  });
  fs.writeFileSync(launchd.plist(SERVICE_LABEL), text);
  return text;
}
const port = () => enginePort(world(), { engineHome, stateDir: launchd.stateDir });

describe('the engine port (PM-751)', () => {
  it('reports nothing for an engine that is not installed', async () => {
    expect(await port().state()).toMatchObject({ loaded: false, root: null, plistSha256: null, pid: null });
  });

  it('reads the checkout, the plist hash and the pid from launchd and the plist', async () => {
    installEngine('/engine/previous');
    launchd.loaded.add(SERVICE_LABEL);
    launchd.pids.set(SERVICE_LABEL, 4001);
    alive.add(4001);
    expect(await port().state()).toMatchObject({
      loaded: true,
      root: '/engine/previous',
      pid: 4001,
      pidAlive: true,
      plistSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      status: null,
    });
  });

  it('ignores a plist that belongs to another engine home', async () => {
    fs.writeFileSync(
      launchd.plist(SERVICE_LABEL),
      renderPlist(template(), {
        label: SERVICE_LABEL,
        node: '/n',
        root: '/r',
        path: '/p',
        home: '/another/home',
        logOut: '/o',
        logErr: '/e',
      }),
    );
    expect(await port().state()).toMatchObject({ root: null, plistSha256: null });
  });

  describe('the plist snapshot', () => {
    it('copies the plist into the state directory (0600) and returns its hash', async () => {
      const text = installEngine('/engine/previous');
      const id = randomUUID();
      const snapshot = await port().snapshotPlist(id);
      expect(snapshot.path).toBe(path.join(launchd.stateDir, `engine-plist-${id}.plist`));
      expect(fs.readFileSync(snapshot.path, 'utf8')).toBe(text);
      expect(fs.statSync(snapshot.path).mode & 0o777).toBe(0o600);
      expect(snapshot.sha256).toBe((await port().state()).plistSha256);
    });

    it('is repeatable for the same attempt and refuses when the plist changed since', async () => {
      installEngine('/engine/previous');
      const id = randomUUID();
      const first = await port().snapshotPlist(id);
      expect(await port().snapshotPlist(id)).toEqual(first);
      installEngine('/engine/other');
      await expect(port().snapshotPlist(id)).rejects.toMatchObject({ exitCode: 2 });
    });

    it('refuses an attempt id that is not a UUID, so no path can be built from it', async () => {
      installEngine('/engine/previous');
      await expect(port().snapshotPlist('../../x')).rejects.toMatchObject({ exitCode: 2 });
    });

    it('refuses when no engine service is installed', async () => {
      await expect(port().snapshotPlist(randomUUID())).rejects.toMatchObject({ exitCode: 2 });
    });
  });

  describe('stop', () => {
    it('boots the job out and proves the process is gone', async () => {
      installEngine('/engine/previous');
      launchd.loaded.add(SERVICE_LABEL);
      alive.add(4001);
      const stopping = port().stop(4001);
      alive.delete(4001);
      expect(await stopping).toBe(true);
      expect(launchd.loaded.has(SERVICE_LABEL)).toBe(false);
    });

    it('says false, and never kills, when the process stays alive', async () => {
      installEngine('/engine/previous');
      launchd.loaded.add(SERVICE_LABEL);
      alive.add(4001);
      expect(await port().stop(4001)).toBe(false);
      expect(alive.has(4001)).toBe(true);
      expect(launchd.time - Date.parse('2026-10-17T10:00:00.000Z')).toBeGreaterThanOrEqual(60_000);
    });

    it('says false when launchd cannot unload the job', async () => {
      installEngine('/engine/previous');
      launchd.loaded.add(SERVICE_LABEL);
      launchd.bootoutStatus = 5;
      expect(await port().stop(4001)).toBe(false);
    });
  });

  describe('start and the way back', () => {
    it('installs the candidate checkout with the node and the PATH of the installed service', async () => {
      installEngine('/engine/previous');
      await port().start(REPO_ROOT);
      const text = fs.readFileSync(launchd.plist(SERVICE_LABEL), 'utf8');
      expect(text).toContain(`<string>${REPO_ROOT}/apps/server/src/index.ts</string>`);
      expect(text).toContain('<string>/opt/homebrew/bin/node</string>');
      expect(text).toContain('<string>/opt/homebrew/bin:/usr/bin</string>');
      expect(text).toContain(`<string>${engineHome}</string>`);
      expect(syncCalls.map((call) => call[0])).toEqual(['bootout', 'bootstrap']);
    });

    it('waits through the busy bootstrap of a job that is still torn down', async () => {
      installEngine('/engine/previous');
      syncStatuses = [5, 5];
      await port().start(REPO_ROOT);
      expect(syncCalls.filter((call) => call[0] === 'bootstrap')).toHaveLength(3);
    });

    it('wraps a launchctl failure in a message without raw output', async () => {
      installEngine('/engine/previous');
      syncStatuses = [1];
      await expect(port().start(REPO_ROOT)).rejects.toMatchObject({
        message: expect.stringContaining('could not be started'),
      });
    });

    it('refuses to start without an installed service to copy the node and PATH from', async () => {
      await expect(port().start(REPO_ROOT)).rejects.toMatchObject({ exitCode: 2 });
    });

    it('restores the saved plist byte for byte and loads it', async () => {
      const before = installEngine('/engine/previous');
      const snapshot = await port().snapshotPlist(randomUUID());
      await port().start(REPO_ROOT);
      launchd.calls.length = 0;
      await port().restorePrevious({ plistPath: snapshot.path, plistSha256: snapshot.sha256 });
      expect(fs.readFileSync(launchd.plist(SERVICE_LABEL), 'utf8')).toBe(before);
      expect(fs.statSync(launchd.plist(SERVICE_LABEL)).mode & 0o777).toBe(0o644);
      expect(launchd.calls.filter((call) => !call.startsWith('print'))).toEqual([
        `bootout ${SERVICE_LABEL}`,
        `bootstrap ${SERVICE_LABEL}`,
      ]);
      expect(launchd.loaded.has(SERVICE_LABEL)).toBe(true);
    });

    it('refuses a snapshot whose hash differs or that lies outside the state directory', async () => {
      installEngine('/engine/previous');
      const snapshot = await port().snapshotPlist(randomUUID());
      await expect(
        port().restorePrevious({ plistPath: snapshot.path, plistSha256: 'f'.repeat(64) }),
      ).rejects.toMatchObject({ exitCode: 2 });
      const outside = path.join(launchd.dir, 'outside.plist');
      fs.copyFileSync(snapshot.path, outside);
      await expect(
        port().restorePrevious({ plistPath: outside, plistSha256: snapshot.sha256 }),
      ).rejects.toMatchObject({ exitCode: 2 });
    });
  });

  describe('the commit of a checkout', () => {
    const git = (cwd: string, ...args: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd,
        encoding: 'utf8',
      });

    it('is HEAD for a clean checkout, and null for a dirty, an untracked or a missing one', async () => {
      const repo = path.join(launchd.dir, 'checkout');
      fs.mkdirSync(repo);
      git(repo, 'init', '-q');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'one');
      const head = git(repo, 'rev-parse', 'HEAD').stdout.trim();
      expect(await port().rootCommit(repo)).toBe(head);
      fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x');
      expect(await port().rootCommit(repo)).toBeNull();
      fs.rmSync(path.join(repo, 'untracked.txt'));
      fs.writeFileSync(path.join(repo, 'a.txt'), 'changed');
      expect(await port().rootCommit(repo)).toBeNull();
      expect(await port().rootCommit(path.join(launchd.dir, 'missing'))).toBeNull();
    });
  });
});

describe('the publish port (PM-751)', () => {
  const REMOTE = 'https://github.com/owner/projectman.git';
  const release = {
    id: 'rel_1',
    summary: '- PM-1: a change',
    tasks: ['PM-1'],
    liveAt: '2026-10-17T10:00:00.000Z',
  } as unknown as Release;

  interface Call {
    command: string;
    args: string[];
    options: RunOptions | undefined;
  }
  let calls: Call[];
  let remoteTags: string;
  let existingRelease: boolean;
  let failing: string | null;
  let notes: string | null;

  function publisher() {
    const deps = {
      ...realDeps(),
      now: () => new Date('2026-10-17T10:00:00.000Z'),
      run: async (command: string, args: string[], options?: RunOptions) => {
        calls.push({ command, args, options });
        const key = `${command} ${args.filter((arg) => !arg.startsWith('-C')).join(' ')}`;
        if (failing && key.includes(failing)) return { code: 1, stdout: '', stderr: 'denied' };
        if (args.includes('ls-remote')) return { code: 0, stdout: remoteTags, stderr: '' };
        if (command === 'gh' && args[1] === 'view')
          return existingRelease
            ? { code: 0, stdout: '{"url":"https://github.com/owner/projectman/releases/tag/x"}', stderr: '' }
            : { code: 1, stdout: '', stderr: 'release not found' };
        if (command === 'gh' && args[1] === 'create') {
          notes = fs.readFileSync(args[args.indexOf('--notes-file') + 1]!, 'utf8');
          return { code: 0, stdout: 'https://github.com/owner/projectman/releases/tag/new\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    } as unknown as CloudDeps;
    const releasesDir = path.join(launchd.dir, 'engine-releases');
    return publishPort(
      world({
        context: { deps, config: { repository: { url: REMOTE } } } as unknown as CloudContext,
      }),
      { stateDir: launchd.stateDir, engineReleasesDir: releasesDir },
    );
  }
  const gitVerbs = () => calls.filter((call) => call.command === 'git').map((call) => call.args.slice(2));

  beforeEach(() => {
    calls = [];
    remoteTags = '';
    existingRelease = false;
    failing = null;
    notes = null;
  });

  it('tags the commit, pushes only that tag, and creates the release with a notes file that is removed', async () => {
    const published = await publisher().publish({ release, commit: COMMIT });
    expect(published.tag).toMatch(/^v2026\.10\.17/);
    expect(gitVerbs()).toEqual([
      ['ls-remote', '--tags', REMOTE],
      ['tag', '-d', published.tag],
      ['tag', '-a', published.tag, COMMIT, '-m', published.tag],
      ['push', REMOTE, `refs/tags/${published.tag}`],
    ]);
    expect(published.url).toBe('https://github.com/owner/projectman/releases/tag/new');
    expect(notes).toContain('- PM-1: a change');
    expect(notes).toContain(`Commit: ${COMMIT}`);
    expect(fs.readdirSync(launchd.stateDir).filter((name) => name.startsWith('notes-'))).toEqual([]);
    const create = calls.find((call) => call.command === 'gh' && call.args[1] === 'create')!;
    expect(create.args).toContain('--verify-tag');
    expect(create.options?.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });
  });

  it('reuses an identical tag and an existing release and changes nothing', async () => {
    remoteTags = `${'1'.repeat(40)}\trefs/tags/v2026.10.17\n${COMMIT}\trefs/tags/v2026.10.17.1\n`;
    existingRelease = true;
    const published = await publisher().publish({ release, commit: COMMIT });
    expect(published.tag).toBe('v2026.10.17.1');
    expect(gitVerbs()).toEqual([['ls-remote', '--tags', REMOTE]]);
    expect(calls.some((call) => call.args[1] === 'create')).toBe(false);
  });

  it('reads the commit of an annotated tag from its peeled line', async () => {
    remoteTags = `${'2'.repeat(40)}\trefs/tags/v2026.10.17\n${COMMIT}\trefs/tags/v2026.10.17^{}\n`;
    existingRelease = true;
    expect((await publisher().publish({ release, commit: COMMIT })).tag).toBe('v2026.10.17');
  });

  it('never moves a tag that points elsewhere: it takes the next free name', async () => {
    remoteTags = `${'3'.repeat(40)}\trefs/tags/v2026.10.17\n`;
    const published = await publisher().publish({ release, commit: COMMIT });
    expect(published.tag).not.toBe('v2026.10.17');
    expect(published.tag).toMatch(/^v2026\.10\.17\./);
    expect(gitVerbs()).toContainEqual(['tag', '-a', published.tag, COMMIT, '-m', published.tag]);
  });

  it('says what failed without raw output, and still removes the notes file', async () => {
    failing = 'release create';
    await expect(publisher().publish({ release, commit: COMMIT })).rejects.toThrow(
      /gh release create exited with 1/,
    );
    failing = 'push';
    await expect(publisher().publish({ release, commit: COMMIT })).rejects.toThrow(
      /git push of .* exited with 1/,
    );
    expect(fs.readdirSync(launchd.stateDir).filter((name) => name.startsWith('notes-'))).toEqual([]);
  });

  it('refuses a remote that is not a GitHub one', async () => {
    const deps = realDeps();
    const bad = publishPort(
      world({
        context: {
          deps,
          config: { repository: { url: 'https://example.com/x/y.git' } },
        } as unknown as CloudContext,
      }),
      { stateDir: launchd.stateDir, engineReleasesDir: launchd.dir },
    );
    await expect(bad.publish({ release, commit: COMMIT })).rejects.toThrow(/not a GitHub remote/);
  });
});
