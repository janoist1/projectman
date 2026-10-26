import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import {
  ADMINISTRATION_FOLDER,
  PrepareError,
  prepareFiles,
  render,
  writePrepared,
} from '../../../scripts/administration/prepare';
import { sensitivePaths } from '../src/contracts';
import type { PrepareInput } from '../../../scripts/administration/prepare';
import {
  SOCKET_PATH_MAX,
  loadSupervisorConfig,
  startSupervisor,
  createSocketClient,
} from '../src/administration';
import { unixSocketsWork } from '../src/administration/test-helpers';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
const socketsWork = await unixSocketsWork();

// `prepareFiles` only reads the templates, so the app home and its directories are fixed, short and need not
// exist: the socket path must fit a Unix socket address (103 characters) whatever the machine's temp path is.
const APP = '/srv/ph';
const stateOf = () => path.join(APP, ADMINISTRATION_FOLDER, 's');
const runOf = () => path.join(APP, ADMINISTRATION_FOLDER, 'r');

interface ShortInstall {
  root: string;
  state: string;
  run: string;
  out: string;
}

/**
 * A real app home for the tests that touch the disk. The socket path must fit a Unix socket address whatever
 * the machine's temp folder is, so it is made in /tmp first and in the temp folder when /tmp is not writable;
 * a temp folder that is still too long skips the test instead of failing it.
 */
async function shortInstall(ctx: TestContext): Promise<ShortInstall> {
  const root = await mkdtemp(path.join('/tmp', 'ap-')).catch(() => mkdtemp(path.join(os.tmpdir(), 'ap-')));
  ctx.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, ADMINISTRATION_FOLDER, 's');
  const run = path.join(root, ADMINISTRATION_FOLDER, 'r');
  if (path.join(run, 'supervisor.sock').length > SOCKET_PATH_MAX)
    ctx.skip('the temp folder is too long for a Unix socket');
  await mkdir(state, { recursive: true, mode: 0o700 });
  await mkdir(run, { recursive: true, mode: 0o700 });
  return { root, state, run, out: path.join(root, 'out') };
}

const input = (overrides: Partial<PrepareInput> = {}): PrepareInput => ({
  target: 'hub',
  service: 'projectman.service',
  appHome: APP,
  stateDir: stateOf(),
  socketDir: runOf(),
  outDir: path.join(APP, 'out'),
  root: repoRoot,
  nodePath: '/usr/local/bin/node',
  platform: 'linux',
  user: 'projectman',
  ...overrides,
});

describe('prepare', () => {
  it('writes the shell opt-in only when explicitly requested', () => {
    const config = (overrides: Partial<PrepareInput>) =>
      JSON.parse(prepareFiles(input(overrides))[0]!.content);
    expect(config({})).not.toHaveProperty('ownerCommand');
    expect(config({ ownerCommandShell: '/bin/zsh' })).toHaveProperty('ownerCommand.shell', '/bin/zsh');
    expect(() => config({ ownerCommandShell: 'zsh' })).toThrow(PrepareError);
  });
  it('builds the protected configuration and a systemd unit that names only the configuration file', () => {
    const files = prepareFiles(input());
    expect(files.map((file) => file.name)).toEqual(['supervisor.json', 'projectman-administration.service']);
    const config = JSON.parse(files[0]!.content);
    expect(config).toEqual({
      version: 1,
      target: { kind: 'hub' },
      appHome: APP,
      stateDir: stateOf(),
      socketPath: path.join(runOf(), 'supervisor.sock'),
      service: { kind: 'systemd', unit: 'projectman.service' },
    });
    const unit = files[1]!.content;
    expect(unit).toContain('User=projectman');
    expect(unit).toContain(`supervisor.ts ${path.join(APP, 'out', 'supervisor.json')}`);
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
      appHome: APP,
      service: { kind: 'launchd', label: 'com.projectman.engine' },
    });
    const plist = files[1]!.content;
    expect(plist).toContain('<string>com.projectman.administration</string>');
    expect(plist).toContain(path.join(APP, 'out', 'supervisor.json'));
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
    expect(() => prepareFiles(input({ stateDir: `${APP}/administration-other/state` }))).toThrow(
      PrepareError,
    );
    expect(() => prepareFiles(input({ socketDir: APP }))).toThrow(PrepareError);
    expect(() => prepareFiles(input({ socketDir: path.join(APP, ADMINISTRATION_FOLDER) }))).toThrow(
      PrepareError,
    );
    expect(() => prepareFiles(input({ appHome: '/Users/other/.projectman' }))).toThrow(PrepareError);
  });

  it('says so when the socket path would be too long for a Unix socket', () => {
    const long = path.join(APP, ADMINISTRATION_FOLDER, 'r'.repeat(90));
    expect(() => prepareFiles(input({ socketDir: long }))).toThrow(/socket path is longer than 103/);
    // The longest accepted path is exactly 103 characters.
    const fits = path.join(
      APP,
      ADMINISTRATION_FOLDER,
      'r'.repeat(103 - `${APP}/administration//supervisor.sock`.length),
    );
    expect(`${fits}/supervisor.sock`).toHaveLength(103);
    expect(() => prepareFiles(input({ socketDir: fits }))).not.toThrow();
  });

  it('puts the directories where the sandbox sensitive paths already deny them', () => {
    const denied = sensitivePaths({ userHome: '/home/someone', appHome: APP });
    const adminRoot = path.join(APP, ADMINISTRATION_FOLDER);
    expect(denied).toContain(adminRoot);
    for (const place of [stateOf(), runOf()]) expect(place.startsWith(`${adminRoot}/`)).toBe(true);
  });

  it('refuses a template with a placeholder it does not know', () => {
    expect(() => render('x {{UNKNOWN}}', {}, (value) => value)).toThrow(PrepareError);
  });

  it('writes private files into a private folder and the result loads as a supervisor configuration', async (ctx) => {
    const { root, state, run, out } = await shortInstall(ctx);
    await writePrepared(
      out,
      prepareFiles(input({ appHome: root, stateDir: state, socketDir: run, outDir: out })),
    );
    expect((await lstat(out)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(out))
      expect((await lstat(path.join(out, name))).mode & 0o777).toBe(0o600);
    const config = await loadSupervisorConfig(path.join(out, 'supervisor.json'));
    expect(config.target).toEqual({ kind: 'hub' });
    expect(config.appHome).toBe(root);
    // Only the two prepared files exist: no state or socket directory was created and nothing was started.
    expect((await readdir(out)).sort()).toEqual(['projectman-administration.service', 'supervisor.json']);
  });
});

describe.skipIf(!socketsWork)('the supervisor process', () => {
  it('starts from its configuration file alone, answers on its socket and refuses another target', async (ctx) => {
    const { root, state, run, out } = await shortInstall(ctx);
    await writePrepared(
      out,
      prepareFiles(input({ appHome: root, stateDir: state, socketDir: run, outDir: out })),
    );
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
        // The prepared configuration is a systemd service, which always has a journal to filter.
        capabilities: ['status', 'logs', 'machine', 'service_logs', 'restart'],
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
    expect(await readFile(path.join(state, 'journal.log'), 'utf8')).toContain('supervisor_started');
  });
});
