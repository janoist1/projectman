import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runEngineCli } from '../../../scripts/engine/commands';
import type { EngineCliIo } from '../../../scripts/engine/commands';
import { loadEngineConfig } from '../src/engine-link/engine-config';

const KEY = 'machine-key-0123456789abcdef';

describe('engine commands', () => {
  let base: string;
  let home: string;
  let workspace: string;
  let repo: string;
  let out: string[];
  let err: string[];
  let stdin: string | null;
  let running: Set<number>;
  let started: Array<{ home: string; env: NodeJS.ProcessEnv }>;

  const run = (...argv: string[]) => {
    const io: EngineCliIo = {
      env: {},
      cwd: base,
      tmpdir: path.join(base, 'system-tmp'),
      readStdin: async () => stdin,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      startEngine: async (startHome, env) => {
        started.push({ home: startHome, env });
        return 0;
      },
      isRunning: (pid) => running.has(pid),
      now: () => Date.parse('2026-10-09T10:00:00Z'),
    };
    return runEngineCli([...argv, '--home', home], io);
  };
  const init = (...extra: string[]) =>
    run('init', '--cloud', 'https://cloud.example.com', '--id', 'eng_aaaaaaaaaaaa', ...extra);
  const mode = (file: string) => statSync(file).mode & 0o777;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'engine-cli-')));
    home = path.join(base, 'home');
    workspace = path.join(base, 'work');
    repo = path.join(workspace, 'projectman');
    mkdirSync(repo, { recursive: true });
    out = [];
    err = [];
    stdin = `${KEY}\n`;
    running = new Set();
    started = [];
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  describe('init', () => {
    it('writes the configuration and the key (mode 0600) from standard input', async () => {
      expect(await init('--name', 'my-mac')).toBe(0);
      expect(loadEngineConfig(home)).toMatchObject({
        cloudUrl: 'https://cloud.example.com',
        engineId: 'eng_aaaaaaaaaaaa',
        name: 'my-mac',
        projects: [],
        repos: [],
      });
      expect(readFileSync(path.join(home, 'engine.key'), 'utf8').trim()).toBe(KEY);
      expect(mode(path.join(home, 'engine.key'))).toBe(0o600);
      expect(mode(path.join(home, 'engine.json'))).toBe(0o600);
      // The key is never printed.
      expect([...out, ...err].join('\n')).not.toContain(KEY);
    });

    it('refuses to overwrite a configuration without --force, and keeps the projects with it', async () => {
      await init();
      await run('project', 'set', 'PM', workspace);
      stdin = 'another-key-0123456789abcdef\n';
      expect(await init()).toBe(1);
      expect(err.join('\n')).toContain('config_exists');
      expect(readFileSync(path.join(home, 'engine.key'), 'utf8').trim()).toBe(KEY);
      expect(await init('--force')).toBe(0);
      expect(readFileSync(path.join(home, 'engine.key'), 'utf8').trim()).toBe('another-key-0123456789abcdef');
      expect(loadEngineConfig(home).projects).toEqual([{ project: 'PM', workspacePath: workspace }]);
    });

    it('needs the key on standard input, and refuses something that is not a key', async () => {
      stdin = null;
      expect(await init()).toBe(2);
      stdin = '  \n';
      expect(await init()).toBe(2);
      stdin = 'short';
      expect(await init()).toBe(1);
      expect(err.join('\n')).toContain('key_invalid');
      expect(existsSync(path.join(home, 'engine.key'))).toBe(false);
    });

    it('refuses an insecure cloud address, and allows http only for a loopback host', async () => {
      expect(await run('init', '--cloud', 'http://cloud.example.com', '--id', 'eng_aaaaaaaaaaaa')).toBe(1);
      expect(err.join('\n')).toContain('cloud_url_insecure');
      expect(await run('init', '--cloud', 'http://127.0.0.1:4700', '--id', 'eng_aaaaaaaaaaaa')).toBe(0);
    });

    it('refuses an engine id of the wrong shape', async () => {
      expect(await run('init', '--cloud', 'https://cloud.example.com', '--id', 'engine-1')).toBe(1);
      expect(err.join('\n')).toContain('config_invalid');
    });
  });

  describe('project and repo', () => {
    beforeEach(async () => {
      await init();
      out.length = 0;
    });

    it('sets a project workspace and registers a repo inside it, with the full test command', async () => {
      expect(await run('project', 'set', 'PM', workspace)).toBe(0);
      expect(await run('repo', 'add', 'PM', 'projectman', repo, '--full-test', 'npm test')).toBe(0);
      expect(loadEngineConfig(home)).toMatchObject({
        projects: [{ project: 'PM', workspacePath: workspace }],
        repos: [{ project: 'PM', repo: 'projectman', path: repo, fullTestCommand: 'npm test' }],
      });
    });

    it('replaces an entry instead of adding a second one', async () => {
      await run('project', 'set', 'PM', workspace);
      await run('repo', 'add', 'PM', 'projectman', repo);
      await run('repo', 'add', 'PM', 'projectman', repo, '--full-test', 'npm run all');
      const config = loadEngineConfig(home);
      expect(config.repos).toHaveLength(1);
      expect(config.repos[0]!.fullTestCommand).toBe('npm run all');
    });

    it('refuses a repo of a project without a workspace, or outside the workspace', async () => {
      expect(await run('repo', 'add', 'PM', 'projectman', repo)).toBe(1);
      expect(err.join('\n')).toContain('project_not_set');
      await run('project', 'set', 'PM', workspace);
      const elsewhere = path.join(base, 'elsewhere');
      mkdirSync(elsewhere);
      expect(await run('repo', 'add', 'PM', 'other', elsewhere)).toBe(1);
      expect(err.join('\n')).toContain('repo_outside_workspace');
      expect(loadEngineConfig(home).repos).toEqual([]);
    });

    it('refuses a missing path, a file, and a project key or repo name of the wrong shape', async () => {
      expect(await run('project', 'set', 'PM', path.join(base, 'nope'))).toBe(1);
      expect(err.join('\n')).toContain('path_missing');
      writeFileSync(path.join(base, 'file'), 'x');
      expect(await run('project', 'set', 'PM', path.join(base, 'file'))).toBe(1);
      expect(err.join('\n')).toContain('path_not_directory');
      expect(await run('project', 'set', 'pm', workspace)).toBe(1);
      await run('project', 'set', 'PM', workspace);
      expect(await run('repo', 'add', 'PM', 'Bad Name', repo)).toBe(1);
    });

    it('moves a relative path against the working directory', async () => {
      expect(await run('project', 'set', 'PM', 'work')).toBe(0);
      expect(loadEngineConfig(home).projects[0]!.workspacePath).toBe(workspace);
    });

    it('removes a repo, and says so when it is not registered', async () => {
      await run('project', 'set', 'PM', workspace);
      await run('repo', 'add', 'PM', 'projectman', repo);
      expect(await run('repo', 'remove', 'PM', 'projectman')).toBe(0);
      expect(loadEngineConfig(home).repos).toEqual([]);
      expect(await run('repo', 'remove', 'PM', 'projectman')).toBe(1);
      expect(err.join('\n')).toContain('not registered');
    });

    it('says to run init first when there is no configuration', async () => {
      rmSync(path.join(home, 'engine.json'));
      expect(await run('project', 'set', 'PM', workspace)).toBe(1);
      expect(err.join('\n')).toContain('init');
    });
  });

  describe('status', () => {
    const writeStatus = (overrides: Record<string, unknown> = {}) =>
      writeFileSync(
        path.join(home, 'engine-status.json'),
        JSON.stringify({
          pid: 4242,
          bootId: '0123456789abcdef',
          startedAt: '2026-10-09T09:50:00Z',
          connection: 'connected',
          connectedSince: '2026-10-09T09:55:00Z',
          updatedAt: '2026-10-09T09:59:50Z',
          attempts: 1,
          pendingEvents: 0,
          droppedEvents: 0,
          running: [{ sessionId: 's1', state: 'working' }],
          ...overrides,
        }),
      );
    beforeEach(async () => {
      await init();
      out.length = 0;
    });

    it('exits 1 when the engine has not run here', async () => {
      expect(await run('status')).toBe(1);
      expect(err.join('\n')).toContain('has not run');
    });

    it('exits 0 for a running, connected engine', async () => {
      writeStatus();
      running.add(4242);
      expect(await run('status')).toBe(0);
      expect(out.join('\n')).toContain('running (pid 4242)');
      expect(out.join('\n')).toContain('connected since 5m ago');
      expect(out.join('\n')).toContain('s1 working');
    });

    it('exits 1 when the process is gone, even if the file still says connected', async () => {
      writeStatus();
      expect(await run('status')).toBe(1);
      expect(out.join('\n')).toContain('not running');
      expect(out.join('\n')).toContain('link: down');
    });

    it('exits 1 when the link is down and shows the last error', async () => {
      writeStatus({
        connection: 'connecting',
        connectedSince: undefined,
        lastError: { code: 'link_refused', message: 'The cloud refused the key', at: '2026-10-09T09:58:00Z' },
      });
      running.add(4242);
      expect(await run('status')).toBe(1);
      expect(out.join('\n')).toContain('link_refused');
    });
  });

  describe('start', () => {
    beforeEach(async () => {
      await init();
      await run('project', 'set', 'PM', workspace);
      out.length = 0;
    });

    it('starts the engine mode with the home, after checking the configuration', async () => {
      expect(await run('start')).toBe(0);
      expect(started).toEqual([
        { home, env: expect.objectContaining({ PROJECTMAN_MODE: 'engine', PROJECTMAN_HOME: home }) },
      ]);
    });

    it('fails with the cause before it starts anything', async () => {
      chmodSync(path.join(home, 'engine.key'), 0o600);
      rmSync(path.join(home, 'engine.key'));
      expect(await run('start')).toBe(1);
      expect(err.join('\n')).toContain('key_missing');
      rmSync(workspace, { recursive: true });
      expect(await run('start')).toBe(1);
      expect(err.join('\n')).toContain('path_missing');
      expect(started).toEqual([]);
    });
  });

  describe('usage', () => {
    it.each([
      [['nothing-like-this']],
      [[]],
      [['init']],
      [['project', 'set', 'PM']],
      [['project', 'get', 'PM', '/x']],
      [['repo', 'add', 'PM', 'x']],
      [['repo', 'move']],
      [['status', 'extra']],
      [['start', 'extra']],
      [['init', '--bogus']],
      [['init', '--cloud']],
    ])('exits 2 with the usage for %j', async (argv) => {
      expect(await run(...argv)).toBe(2);
      expect(err.join('\n')).toContain('usage');
    });

    it('refuses an option given twice', async () => {
      expect(
        await run(
          'init',
          '--cloud',
          'https://a.example.com',
          '--cloud',
          'https://b.example.com',
          '--id',
          'eng_aaaaaaaaaaaa',
        ),
      ).toBe(2);
    });
  });
});
