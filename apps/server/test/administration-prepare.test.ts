import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMINISTRATION_FOLDER,
  PrepareError,
  prepareFiles,
  render,
  writePrepared,
} from '../../../scripts/administration/prepare';
import { sensitivePaths } from '../src/contracts';
import type { PrepareInput } from '../../../scripts/administration/prepare';
import { loadSupervisorConfig, startSupervisor, createSocketClient } from '../src/administration';
import { unixSocketsWork } from '../src/administration/test-helpers';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
const socketsWork = await unixSocketsWork();

// `dir` plays the app home: the state and socket directories belong below `<dir>/administration`.
let dir: string;
// Short names: the socket path must fit a Unix socket address (103 characters).
const stateOf = () => path.join(dir, 'administration', 's');
const runOf = () => path.join(dir, 'administration', 'r');
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ap-'));
  await mkdir(stateOf(), { recursive: true, mode: 0o700 });
  await mkdir(runOf(), { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const input = (overrides: Partial<PrepareInput> = {}): PrepareInput => ({
  target: 'hub',
  service: 'projectman.service',
  appHome: dir,
  stateDir: stateOf(),
  socketDir: runOf(),
  outDir: path.join(dir, 'out'),
  root: repoRoot,
  nodePath: '/usr/local/bin/node',
  platform: 'linux',
  user: 'projectman',
  ...overrides,
});

describe('prepare', () => {
  it('builds the protected configuration and a systemd unit that names only the configuration file', () => {
    const files = prepareFiles(input());
    expect(files.map((file) => file.name)).toEqual(['supervisor.json', 'projectman-administration.service']);
    const config = JSON.parse(files[0]!.content);
    expect(config).toEqual({
      version: 1,
      target: { kind: 'hub' },
      stateDir: stateOf(),
      socketPath: path.join(runOf(), 'supervisor.sock'),
      service: { kind: 'systemd', unit: 'projectman.service' },
    });
    const unit = files[1]!.content;
    expect(unit).toContain('User=projectman');
    expect(unit).toContain(`supervisor.ts ${path.join(dir, 'out', 'supervisor.json')}`);
    expect(unit).toContain(`ReadWritePaths=${stateOf()} ${runOf()}`);
    expect(unit).not.toContain('{{');
    // The comments explain what the unit never uses; the directives themselves name no docker, sudo or secret.
    const directives = unit
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n');
    for (const forbidden of ['docker', 'sudo', 'ANTHROPIC', 'TOKEN'])
      expect(directives).not.toContain(forbidden);
  });

  it('builds a launchd file for an engine machine', () => {
    const files = prepareFiles(
      input({
        platform: 'darwin',
        target: 'engine:eng_abcdefghij12',
        service: 'com.projectman.engine',
        user: undefined,
      }),
    );
    expect(files.map((file) => file.name)).toEqual([
      'supervisor.json',
      'com.projectman.administration.plist',
    ]);
    expect(JSON.parse(files[0]!.content)).toMatchObject({
      target: { kind: 'engine', id: 'eng_abcdefghij12' },
      service: { kind: 'launchd', label: 'com.projectman.engine' },
    });
    const plist = files[1]!.content;
    expect(plist).toContain('<string>com.projectman.administration</string>');
    expect(plist).toContain(path.join(dir, 'out', 'supervisor.json'));
    expect(plist).not.toContain('{{');
    // launchd gives the job one variable only.
    expect(plist.match(/<key>[A-Z_]+<\/key>/g)).toEqual(['<key>PATH</key>']);
  });

  it('refuses a value that could not be a plain name or path, instead of escaping it', () => {
    expect(() => prepareFiles(input({ target: 'engine:eng_x; reboot' }))).toThrow(PrepareError);
    expect(() => prepareFiles(input({ service: 'projectman.service; reboot' }))).toThrow(PrepareError);
    expect(() => prepareFiles(input({ stateDir: '/var/lib/a b' }))).toThrow(PrepareError);
    expect(() => prepareFiles(input({ stateDir: '/var/lib/../etc' }))).toThrow(PrepareError);
    expect(() => prepareFiles(input({ stateDir: 'relative' }))).toThrow(PrepareError);
    expect(() => prepareFiles(input({ socketDir: stateOf() }))).toThrow(PrepareError);
    expect(() => prepareFiles(input({ user: 'root; id' }))).toThrow(PrepareError);
    expect(() => prepareFiles(input({ user: undefined }))).toThrow(PrepareError);
    expect(() => prepareFiles(input({ platform: 'win32' }))).toThrow(PrepareError);
  });

  it('refuses a state or socket directory outside the folder the session sandbox denies', () => {
    const outside = '/var/lib/projectman-admin';
    expect(() => prepareFiles(input({ stateDir: outside }))).toThrow(/session sandbox denies/);
    expect(() => prepareFiles(input({ socketDir: outside }))).toThrow(/session sandbox denies/);
    // A sibling that merely starts with the same letters, the app home itself and the folder itself are outside too.
    expect(() => prepareFiles(input({ stateDir: `${dir}/administration-other/state` }))).toThrow(
      PrepareError,
    );
    expect(() => prepareFiles(input({ socketDir: dir }))).toThrow(PrepareError);
    expect(() => prepareFiles(input({ socketDir: path.join(dir, 'administration') }))).toThrow(PrepareError);
    expect(() => prepareFiles(input({ appHome: '/Users/other/.projectman' }))).toThrow(PrepareError);
  });

  it('puts the directories where the sandbox sensitive paths already deny them', () => {
    const denied = sensitivePaths({ userHome: '/home/someone', appHome: dir });
    const adminRoot = path.join(dir, ADMINISTRATION_FOLDER);
    expect(denied).toContain(adminRoot);
    for (const place of [stateOf(), runOf()]) expect(place.startsWith(`${adminRoot}/`)).toBe(true);
  });

  it('refuses a template with a placeholder it does not know', () => {
    expect(() => render('x {{UNKNOWN}}', {}, (value) => value)).toThrow(PrepareError);
  });

  it('writes private files into a private folder and the result loads as a supervisor configuration', async () => {
    const out = path.join(dir, 'out');
    await writePrepared(out, prepareFiles(input({ outDir: out })));
    expect((await lstat(out)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(out))
      expect((await lstat(path.join(out, name))).mode & 0o777).toBe(0o600);
    const config = await loadSupervisorConfig(path.join(out, 'supervisor.json'));
    expect(config.target).toEqual({ kind: 'hub' });
    // Nothing else was created or started: the state and socket directories are still empty.
    expect(await readdir(stateOf())).toEqual([]);
    expect(await readdir(runOf())).toEqual([]);
  });
});

describe.skipIf(!socketsWork)('the supervisor process', () => {
  it('starts from its configuration file alone, answers on its socket and refuses another target', async () => {
    const out = path.join(dir, 'out');
    await writePrepared(out, prepareFiles(input({ outDir: out })));
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const running = await startSupervisor({
      configFile: path.join(out, 'supervisor.json'),
      platform: 'linux',
      version: '9.9.9',
      run: async (file, args) => {
        calls.push({ file, args });
        return {
          exitCode: 0,
          stdout: 'ActiveState=active\nInvocationID=0123456789abcdef0123456789abcdef\n',
        };
      },
    });
    try {
      const client = createSocketClient({ socketPath: running.config.socketPath });
      expect(await client.status({ kind: 'hub' })).toMatchObject({
        online: true,
        version: '9.9.9',
        capabilities: ['status', 'logs', 'restart'],
      });
      await expect(client.status({ kind: 'engine', id: 'eng_abcdefghij12' as never })).rejects.toMatchObject({
        code: 'administration_target_mismatch',
      });
      expect(
        (await client.logs({ kind: 'hub' }, { limit: 10 })).entries.map((entry) => entry.code),
      ).toContain('supervisor_started');
      expect(calls.every((call) => call.args.at(-1) === 'projectman.service')).toBe(true);
    } finally {
      await running.close();
    }
    expect(await readFile(path.join(stateOf(), 'journal.log'), 'utf8')).toContain('supervisor_started');
  });
});
