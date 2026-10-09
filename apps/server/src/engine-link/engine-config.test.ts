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

  it('refuses a file that is not JSON, or that has a field it does not know', () => {
    writeFileSync(path.join(dir, 'engine.json'), '{nope');
    expect(() => loadEngineConfig(dir)).toThrowError(expect.objectContaining({ code: 'config_invalid' }));
    writeFileSync(path.join(dir, 'engine.json'), JSON.stringify({ ...base(), extra: true }));
    expect(() => loadEngineConfig(dir)).toThrowError(expect.objectContaining({ code: 'config_invalid' }));
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
    it('resolves a symlinked workspace to its real path', () => {
      const real = path.join(dir, 'real');
      mkdirSync(path.join(real, 'repo'), { recursive: true });
      symlinkSync(real, path.join(dir, 'link'));
      const resolved = resolveEngineConfig(
        base({
          projects: [{ project: 'PM', workspacePath: path.join(dir, 'link') }],
          repos: [{ project: 'PM', repo: 'repo', path: path.join(dir, 'link', 'repo') }],
        }),
        dir,
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
        resolveEngineConfig(
          base({
            projects: [{ project: 'PM', workspacePath: workspace }],
            repos: [{ project: 'PM', repo: 'escape', path: path.join(workspace, 'escape') }],
          }),
          dir,
        ),
      ).toThrowError(expect.objectContaining({ code: 'repo_outside_workspace' }));
    });

    it('refuses a relative workspace path', () => {
      expect(() =>
        resolveEngineConfig(base({ projects: [{ project: 'PM', workspacePath: 'relative' }] }), dir),
      ).toThrowError(expect.objectContaining({ code: 'path_not_absolute' }));
    });
  });
});
