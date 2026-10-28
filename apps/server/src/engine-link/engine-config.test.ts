import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cloudOrigin,
  EngineConfig,
  linkUrl,
  loadEngineConfig,
  readLinkHeaders,
  readSecretFile,
  resolveEngineConfig,
  saveEngineConfig,
  writeSecretFile,
} from './engine-config';

const base = (overrides: Record<string, unknown> = {}) =>
  EngineConfig.parse({
    schemaVersion: 1,
    cloudUrl: 'https://cloud.example.com',
    engineId: 'eng_aaaaaaaaaaaa',
    projects: [],
    repos: [],
    ...overrides,
  });

describe('engine configuration', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'engine-config-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('saves and loads a configuration, with the defaults filled in', () => {
    saveEngineConfig(dir, base());
    expect(loadEngineConfig(dir)).toMatchObject({
      maxPermissionMode: 'auto',
      allowRemoteTerminalInput: true,
    });
  });

  it('keeps the optional keepAwake mode, absent without it, and refuses an unknown one', () => {
    saveEngineConfig(dir, base());
    expect(loadEngineConfig(dir).keepAwake).toBeUndefined();
    saveEngineConfig(dir, base({ keepAwake: 'off' }));
    expect(loadEngineConfig(dir).keepAwake).toBe('off');
    expect(() => base({ keepAwake: 'always' })).toThrow();
  });

  it('refuses a file that is not JSON, or that has a field it does not know', () => {
    writeFileSync(path.join(dir, 'engine.json'), '{nope');
    expect(() => loadEngineConfig(dir)).toThrowError(expect.objectContaining({ code: 'config_invalid' }));
    writeFileSync(path.join(dir, 'engine.json'), JSON.stringify({ ...base(), extra: true }));
    expect(() => loadEngineConfig(dir)).toThrowError(expect.objectContaining({ code: 'config_invalid' }));
  });

  it('keeps the optional mergeBranch of a repo, and refuses an empty one', () => {
    const repo = { project: 'PM', repo: 'projectman', path: '/work/projectman' };
    saveEngineConfig(
      dir,
      base({
        repos: [
          { ...repo, mergeBranch: 'main' },
          { ...repo, repo: 'other' },
        ],
      }),
    );
    const loaded = loadEngineConfig(dir);
    expect(loaded.repos[0]).toMatchObject({ mergeBranch: 'main' });
    expect(loaded.repos[1]).not.toHaveProperty('mergeBranch');
    expect(() => base({ repos: [{ ...repo, mergeBranch: '' }] })).toThrow();
  });

  it.each([
    [undefined, null],
    [{ kind: 'none' }, null],
    [{ kind: 'npm_ci' }, { kind: 'npm_ci', timeoutMs: 600_000 }],
    [
      { kind: 'npm_ci', timeoutMs: 1_000 },
      { kind: 'npm_ci', timeoutMs: 1_000 },
    ],
  ])('resolves the optional workspace setup %j', (workspaceSetup, expected) => {
    const workspace = path.join(dir, 'workspace');
    const repo = path.join(workspace, 'app');
    mkdirSync(repo, { recursive: true });
    const config = base({
      projects: [{ project: 'PM', workspacePath: workspace }],
      repos: [{ project: 'PM', repo: 'app', path: repo, ...(workspaceSetup ? { workspaceSetup } : {}) }],
    });
    saveEngineConfig(dir, config);
    expect(loadEngineConfig(dir).schemaVersion).toBe(1);
    expect(
      resolveEngineConfig(config, path.join(dir, 'home'), { tmpdir: path.join(dir, 'tmp') }).repos[0]
        ?.workspaceSetup,
    ).toEqual(expected);
  });

  it.each([
    { kind: 'shell', command: 'npm install' },
    { kind: 'none', timeoutMs: 1_000 },
    { kind: 'npm_ci', command: 'npm install' },
    { kind: 'npm_ci', timeoutMs: 999 },
    { kind: 'npm_ci', timeoutMs: 1_800_001 },
    { kind: 'npm_ci', timeoutMs: 1_000.5 },
  ])('rejects invalid workspace setup %j', (workspaceSetup) => {
    expect(() =>
      base({ repos: [{ project: 'PM', repo: 'app', path: '/fixture', workspaceSetup }] }),
    ).toThrow();
  });

  describe('secret files', () => {
    const file = () => path.join(dir, 'secret');

    it('reads a private file of the user and trims it', () => {
      writeSecretFile(file(), ' value \n');
      expect(readSecretFile(file(), 'test')).toBe('value');
    });

    it.each([0o640, 0o604, 0o644, 0o666])('refuses mode %o', (mode) => {
      writeSecretFile(file(), 'value');
      chmodSync(file(), mode);
      expect(() => readSecretFile(file(), 'test')).toThrowError(
        expect.objectContaining({ code: 'secret_permissions' }),
      );
    });

    it('refuses a missing file, an empty file, a link and a directory', () => {
      expect(() => readSecretFile(file(), 'test')).toThrowError(
        expect.objectContaining({ code: 'secret_missing' }),
      );
      writeSecretFile(file(), '\n');
      expect(() => readSecretFile(file(), 'test')).toThrowError(
        expect.objectContaining({ code: 'secret_empty' }),
      );
      writeSecretFile(path.join(dir, 'real'), 'value');
      symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
      expect(() => readSecretFile(path.join(dir, 'link'), 'test')).toThrowError(
        expect.objectContaining({ code: 'secret_not_regular' }),
      );
      mkdirSync(path.join(dir, 'folder'));
      expect(() => readSecretFile(path.join(dir, 'folder'), 'test')).toThrowError(
        expect.objectContaining({ code: 'secret_not_regular' }),
      );
    });

    it('leaves no temporary file behind and replaces the content whole', () => {
      writeSecretFile(file(), 'one');
      writeSecretFile(file(), 'two');
      expect(readSecretFile(file(), 'test')).toBe('two');
    });
  });

  describe('link headers', () => {
    const headers = () => path.join(dir, 'headers.json');
    it('reads extra headers', () => {
      writeSecretFile(
        headers(),
        JSON.stringify({ 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'secret' }),
      );
      expect(readLinkHeaders(headers())).toEqual({
        'CF-Access-Client-Id': 'id',
        'CF-Access-Client-Secret': 'secret',
      });
    });

    it.each(['authorization', 'Authorization', 'Host', 'upgrade', 'Sec-WebSocket-Key'])(
      'refuses the header %s',
      (name) => {
        writeSecretFile(headers(), JSON.stringify({ [name]: 'x' }));
        expect(() => readLinkHeaders(headers())).toThrowError(
          expect.objectContaining({ code: 'link_headers_invalid' }),
        );
      },
    );

    it('refuses something that is not an object of strings, and a file others can read', () => {
      writeSecretFile(headers(), JSON.stringify(['x']));
      expect(() => readLinkHeaders(headers())).toThrowError(
        expect.objectContaining({ code: 'link_headers_invalid' }),
      );
      writeSecretFile(headers(), '{}');
      chmodSync(headers(), 0o644);
      expect(() => readLinkHeaders(headers())).toThrowError(
        expect.objectContaining({ code: 'secret_permissions' }),
      );
    });
  });

  describe('cloud address', () => {
    it('takes https, and http only for a loopback host', () => {
      expect(cloudOrigin('https://cloud.example.com/some/path').toString()).toBe(
        'https://cloud.example.com/',
      );
      expect(cloudOrigin('http://127.0.0.1:4700').toString()).toBe('http://127.0.0.1:4700/');
      expect(cloudOrigin('http://localhost:4700').hostname).toBe('localhost');
      expect(() => cloudOrigin('http://cloud.example.com')).toThrowError(
        expect.objectContaining({ code: 'cloud_url_insecure' }),
      );
      expect(() => cloudOrigin('ftp://cloud.example.com')).toThrowError(
        expect.objectContaining({ code: 'cloud_url_insecure' }),
      );
    });

    it('refuses credentials in the address', () => {
      expect(() => cloudOrigin('https://user:pass@cloud.example.com')).toThrowError(
        expect.objectContaining({ code: 'cloud_url_invalid' }),
      );
    });

    it('builds the link address with wss:// for https and ws:// for loopback http', () => {
      expect(linkUrl('https://cloud.example.com', '/engine/link')).toBe(
        'wss://cloud.example.com/engine/link',
      );
      expect(linkUrl('http://127.0.0.1:4700', '/engine/link')).toBe('ws://127.0.0.1:4700/engine/link');
    });
  });

  describe('resolving paths', () => {
    // The home lies in the system temp directory here; name another one so that only the case under test counts.
    const tmpdir = () => path.join(dir, 'system-tmp');
    const resolve = (config: EngineConfig, home = dir) =>
      resolveEngineConfig(config, home, { tmpdir: tmpdir() });

    it('refuses a key file, link headers or home inside a workspace', () => {
      const workspace = path.join(dir, 'work');
      mkdirSync(workspace);
      const projects = [{ project: 'PM', workspacePath: workspace }];
      expect(() => resolve(base({ projects, keyFile: path.join(workspace, 'engine.key') }))).toThrowError(
        expect.objectContaining({ code: 'secret_in_root' }),
      );
      expect(() =>
        resolve(base({ projects, linkHeadersFile: path.join(workspace, 'sub', 'headers.json') })),
      ).toThrowError(expect.objectContaining({ code: 'secret_in_root' }));
      expect(() => resolve(base({ projects }), workspace)).toThrowError(
        expect.objectContaining({ code: 'secret_in_root' }),
      );
    });

    it('refuses a key file or home inside the temporary directory, and inside the engine’s own worktrees', () => {
      const home = path.join(dir, 'home');
      mkdirSync(path.join(tmpdir(), 'x'), { recursive: true });
      mkdirSync(path.join(home, 'worktrees'), { recursive: true });
      expect(() => resolve(base({ keyFile: path.join(tmpdir(), 'engine.key') }), home)).toThrowError(
        expect.objectContaining({ code: 'secret_in_root' }),
      );
      expect(() => resolve(base(), path.join(tmpdir(), 'x'))).toThrowError(
        expect.objectContaining({ code: 'secret_in_root' }),
      );
      expect(() => resolve(base({ keyFile: path.join(home, 'worktrees', 'k') }), home)).toThrowError(
        expect.objectContaining({ code: 'secret_in_root' }),
      );
      // The real temporary directory is the default.
      expect(() => resolveEngineConfig(base(), dir)).toThrowError(
        expect.objectContaining({ code: 'secret_in_root' }),
      );
    });

    it('accepts an absolute workRoot (PM-846), refuses a relative one, and loads an old file without it', () => {
      saveEngineConfig(dir, base());
      expect(loadEngineConfig(dir).workRoot).toBeUndefined();
      expect(resolve(base()).workRoot).toBeUndefined();
      const home = path.join(dir, 'home');
      mkdirSync(home);
      saveEngineConfig(home, base({ workRoot: path.join(home, 'work') }));
      expect(loadEngineConfig(home).workRoot).toBe(path.join(home, 'work'));
      expect(resolve(base({ workRoot: path.join(home, 'work') }), home).workRoot).toBe(
        path.join(home, 'work'),
      );
      expect(() => resolve(base({ workRoot: 'work' }), home)).toThrowError(
        'invalid engine.json: workRoot must be an absolute path',
      );
    });

    it('refuses a key file inside the work root’s worktrees', () => {
      const home = path.join(dir, 'home');
      const root = path.join(home, 'work');
      mkdirSync(path.join(root, 'worktrees'), { recursive: true });
      expect(() =>
        resolve(base({ workRoot: root, keyFile: path.join(root, 'worktrees', 'k') }), home),
      ).toThrowError(expect.objectContaining({ code: 'secret_in_root' }));
    });

    it('refuses a key file that reaches a workspace through a symbolic link', () => {
      const workspace = path.join(dir, 'work');
      const keys = path.join(dir, 'keys');
      mkdirSync(workspace);
      mkdirSync(keys);
      symlinkSync(workspace, path.join(keys, 'link'));
      expect(() =>
        resolve(
          base({
            projects: [{ project: 'PM', workspacePath: workspace }],
            keyFile: path.join(keys, 'link', 'engine.key'),
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'secret_in_root' }));
    });

    it('accepts a key file and link headers outside every root, and returns them absolute', () => {
      const keys = path.join(dir, 'keys');
      mkdirSync(keys);
      const resolved = resolve(base({ linkHeadersFile: path.join(keys, 'headers.json') }));
      expect(resolved.keyFile).toBe(path.join(dir, 'engine.key'));
      expect(resolved.linkHeadersFile).toBe(path.join(keys, 'headers.json'));
      expect(() => resolve(base({ keyFile: 'engine.key' }))).toThrowError(
        expect.objectContaining({ code: 'path_not_absolute' }),
      );
    });

    it('resolves a symlinked workspace to its real path', () => {
      const real = path.join(dir, 'real');
      mkdirSync(path.join(real, 'repo'), { recursive: true });
      symlinkSync(real, path.join(dir, 'link'));
      const resolved = resolve(
        base({
          projects: [{ project: 'PM', workspacePath: path.join(dir, 'link') }],
          repos: [{ project: 'PM', repo: 'repo', path: path.join(dir, 'link', 'repo') }],
        }),
      );
      expect(resolved.projects[0]!.workspacePath).toBe(real);
      expect(resolved.repos[0]!.path).toBe(path.join(real, 'repo'));
      expect(resolved.keyFile).toBe(path.join(dir, 'engine.key'));
    });

    it('does not let a link inside the workspace lead the repo out of it', () => {
      const workspace = path.join(dir, 'work');
      const outside = path.join(dir, 'outside');
      mkdirSync(workspace);
      mkdirSync(outside);
      symlinkSync(outside, path.join(workspace, 'escape'));
      expect(() =>
        resolve(
          base({
            projects: [{ project: 'PM', workspacePath: workspace }],
            repos: [{ project: 'PM', repo: 'escape', path: path.join(workspace, 'escape') }],
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'repo_outside_workspace' }));
    });

    it('refuses a relative workspace path', () => {
      expect(() => resolve(base({ projects: [{ project: 'PM', workspacePath: 'relative' }] }))).toThrowError(
        expect.objectContaining({ code: 'path_not_absolute' }),
      );
    });
  });
});
