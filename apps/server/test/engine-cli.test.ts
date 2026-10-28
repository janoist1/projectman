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
import { LOG_TAIL_BYTES, tailLines } from '../../../scripts/engine/logs';
import { EngineLocalSnapshot, overallState } from '../../../scripts/engine/snapshot';
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

    it('writes the link headers file resolved against the working directory, and keeps it without the switch (PM-1077)', async () => {
      writeFileSync(path.join(base, 'access.json'), '{}', { mode: 0o600 });
      expect(await init('--link-headers-file', 'access.json')).toBe(0);
      expect(loadEngineConfig(home).linkHeadersFile).toBe(path.join(base, 'access.json'));
      expect(await init('--force')).toBe(0);
      expect(loadEngineConfig(home).linkHeadersFile).toBe(path.join(base, 'access.json'));
    });

    it('refuses a link headers file that is missing or not a regular file, and writes nothing', async () => {
      expect(await init('--link-headers-file', 'nope.json')).toBe(1);
      expect(err.join('\n')).toContain('path_missing');
      expect(await init('--link-headers-file', workspace)).toBe(1);
      expect(err.join('\n')).toContain('path_not_file');
      expect(existsSync(path.join(home, 'engine.json'))).toBe(false);
      expect(existsSync(path.join(home, 'engine.key'))).toBe(false);
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

    it('refuses a home that holds a projectman server database, and writes nothing there', async () => {
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, 'db.sqlite'), '');
      expect(await init()).toBe(1);
      expect(err.join('\n')).toContain('home_in_use');
      expect(err.join('\n')).toContain('PROJECTMAN_HOME=~/.projectman-engine');
      expect(existsSync(path.join(home, 'engine.key'))).toBe(false);
      expect(existsSync(path.join(home, 'engine.json'))).toBe(false);
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

    it('does not claim a hold or a need when the engine process is gone', async () => {
      writeStatus({ keepAwake: { mode: 'while_working', holding: true, since: '2026-10-09T09:55:00Z' } });
      await run('status');
      expect(out.join('\n')).toContain('keep awake: not held');
    });

    it('reads a status file of an older engine without the keep-awake fields', async () => {
      writeStatus();
      running.add(4242);
      expect(await run('status')).toBe(0);
      expect(out.join('\n')).toContain('keep awake');
    });

    it('shows whether the engine holds the machine awake, and the work that runs', async () => {
      writeStatus({
        work: { sessions: 2, fullTests: 1, screenshots: 0 },
        keepAwake: { mode: 'while_working', holding: true, since: '2026-10-09T09:55:00Z' },
      });
      running.add(4242);
      await run('status');
      expect(out.join('\n')).toMatch(
        /keep awake: holding for 5m; work: 2 sessions, 1 merge checks, 0 screenshot/,
      );
    });

    it.each([
      ['off', { mode: 'off', holding: false }],
      ['not supported', { mode: 'while_working', holding: false, unsupported: true }],
      ['not needed', { mode: 'while_working', holding: false }],
    ])('shows the keep-awake state: %s', async (expected, keepAwake) => {
      writeStatus({ keepAwake });
      running.add(4242);
      await run('status');
      expect(out.join('\n')).toContain(`keep awake: ${expected}`);
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

    it('shows the version and the release of the engine, or that an older one reports none', async () => {
      writeStatus({ version: 'abc123', releaseTag: 'v2026.10.9' });
      await run('status');
      expect(out.join('\n')).toContain('version: abc123; release: v2026.10.9');
      out.length = 0;
      writeStatus();
      await run('status');
      expect(out.join('\n')).toContain('not reported by this engine version');
    });
  });

  describe('status --json', () => {
    const statusFile = () => path.join(home, 'engine-status.json');
    const writeStatus = (overrides: Record<string, unknown> = {}) =>
      writeFileSync(
        statusFile(),
        JSON.stringify({
          pid: 4242,
          bootId: '0123456789abcdef',
          startedAt: '2026-10-09T09:50:00Z',
          connection: 'connected',
          connectedSince: '2026-10-09T09:55:00Z',
          updatedAt: '2026-10-09T09:59:50Z',
          attempts: 1,
          pendingEvents: 3,
          droppedEvents: 0,
          running: [
            {
              sessionId: 's1',
              state: 'working',
              member: 'dev',
              provider: 'claude',
              label: 'Dev · PM-1',
              startedAt: '2026-10-09T09:56:00Z',
            },
          ],
          version: 'abc123',
          releaseTag: 'v2026.10.9',
          work: { sessions: 1, fullTests: 1, screenshots: 0 },
          keepAwake: { mode: 'while_working', holding: true, since: '2026-10-09T09:56:00Z' },
          ...overrides,
        }),
      );
    const snapshot = async () => {
      out.length = 0;
      expect(await run('status', '--json')).toBe(0);
      expect(out).toHaveLength(1);
      return EngineLocalSnapshot.parse(JSON.parse(out[0]!));
    };

    it.each([
      [{ initialised: false, processAlive: false, connection: null }, 'not_initialised'],
      [{ initialised: true, processAlive: false, connection: 'connected' }, 'stopped'],
      [{ initialised: true, processAlive: true, connection: 'connected' }, 'running'],
      [{ initialised: true, processAlive: true, connection: 'connecting' }, 'no_cloud'],
    ] as const)('judges the overall state of %j as %s', (input, expected) => {
      expect(overallState(input)).toBe(expected);
    });

    it('is not initialised without engine.json, and still exits 0', async () => {
      const result = await snapshot();
      expect(result).toMatchObject({ overall: 'not_initialised', engine: null, link: { state: 'down' } });
    });

    it('describes a running, connected engine', async () => {
      await init('--name', 'my-mac');
      writeStatus();
      running.add(4242);
      const result = await snapshot();
      expect(result).toMatchObject({
        overall: 'running',
        engine: { id: 'eng_aaaaaaaaaaaa', name: 'my-mac', cloudOrigin: 'https://cloud.example.com' },
        process: { running: true, pid: 4242, version: 'abc123', releaseTag: 'v2026.10.9' },
        link: { state: 'connected', since: '2026-10-09T09:55:00Z', pendingEvents: 3 },
        sessions: [{ sessionId: 's1', member: 'dev', provider: 'claude', label: 'Dev · PM-1' }],
        work: { sessions: 1, fullTests: 1, screenshots: 0 },
        keepAwake: { mode: 'while_working', holding: true },
        service: { supported: false, installed: false },
      });
      expect(result.logs.out).toBe(path.join(home, 'logs', 'engine-service.out.log'));
    });

    it('says stopped, with the link down and nothing running, when the process is gone', async () => {
      await init();
      writeStatus();
      const result = await snapshot();
      expect(result).toMatchObject({
        overall: 'stopped',
        process: { running: false, pid: null },
        link: { state: 'down', since: null },
        sessions: [],
        work: { sessions: 0 },
        keepAwake: { holding: false, since: null },
      });
    });

    it('says no_cloud for a live engine whose link is not connected', async () => {
      await init();
      writeStatus({ connection: 'disconnected', connectedSince: undefined });
      running.add(4242);
      expect((await snapshot()).overall).toBe('no_cloud');
    });

    it('fills what the status file of an older engine does not have', async () => {
      await init();
      writeStatus({
        version: undefined,
        releaseTag: undefined,
        work: undefined,
        keepAwake: undefined,
        running: [{ sessionId: 's1', state: 'working' }],
      });
      running.add(4242);
      const result = await snapshot();
      expect(result.process).toMatchObject({ version: null, releaseTag: null });
      expect(result.sessions).toEqual([
        { sessionId: 's1', state: 'working', member: null, provider: null, label: null, startedAt: null },
      ]);
      expect(result.work).toEqual({ sessions: 1, fullTests: 0, screenshots: 0 });
      expect(result.keepAwake).toMatchObject({ mode: 'while_working', holding: false, since: null });
    });

    it('exits 1, and says why, when the configuration cannot be read', async () => {
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, 'engine.json'), '{not json');
      expect(await run('status', '--json')).toBe(1);
      expect(err.join('\n')).toContain('config_invalid');
    });
  });

  describe('logs', () => {
    const logDir = () => path.join(home, 'logs');
    const write = (name: string, text: string) => {
      mkdirSync(logDir(), { recursive: true });
      writeFileSync(path.join(logDir(), name), text);
    };

    it('gives the last lines of both logs, 50 by default and no more than were asked for', async () => {
      write('engine-service.out.log', `${Array.from({ length: 80 }, (_, i) => `out ${i}`).join('\n')}\n`);
      write('engine-service.err.log', 'err 1\nerr 2\nerr 3\n');
      expect(await run('logs', '--json')).toBe(0);
      const all = JSON.parse(out[0]!) as { out: string[]; err: string[] };
      expect(all.out).toHaveLength(50);
      expect(all.out.at(-1)).toBe('out 79');
      out.length = 0;
      await run('logs', '--json', '--lines', '2');
      expect(JSON.parse(out[0]!)).toEqual({ out: ['out 78', 'out 79'], err: ['err 2', 'err 3'] });
    });

    it('reads only the end of a big file, without its cut-off first line', () => {
      const file = path.join(base, 'big.log');
      writeFileSync(file, `${'x'.repeat(LOG_TAIL_BYTES)}\nlast\n`);
      expect(tailLines(file, 200)).toEqual(['last']);
    });

    it('gives empty lists for a missing file, and refuses a wrong line count', async () => {
      expect(await run('logs', '--json')).toBe(0);
      expect(JSON.parse(out[0]!)).toEqual({ out: [], err: [] });
      for (const lines of ['0', '201', 'many']) expect(await run('logs', '--lines', lines)).toBe(2);
    });
  });

  describe('keep-awake', () => {
    beforeEach(async () => {
      await init();
      out.length = 0;
    });

    it('writes the mode to the configuration and says it takes effect after a restart', async () => {
      expect(await run('keep-awake', 'off')).toBe(0);
      expect(loadEngineConfig(home).keepAwake).toBe('off');
      expect(out.join('\n')).toContain('restart');
      expect(await run('keep-awake', 'on')).toBe(0);
      expect(loadEngineConfig(home).keepAwake).toBe('while_working');
    });

    it.each([[['keep-awake']], [['keep-awake', 'maybe']], [['keep-awake', 'on', 'extra']]])(
      'refuses %j',
      async (argv) => {
        expect(await run(...argv)).toBe(2);
      },
    );
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
