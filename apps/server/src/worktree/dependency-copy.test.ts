import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyDependencyTrees } from './dependency-copy';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

let root: string;
let source: string;
let target: string;
const write = (base: string, relative: string, content = 'package') => {
  const file = path.join(base, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const copy = (overrides: Partial<Parameters<typeof copyDependencyTrees>[0]> = {}) =>
  copyDependencyTrees({ source, target, platform: 'linux', ...overrides });

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-dep-copy-')));
  source = path.join(root, 'source');
  target = path.join(root, 'target');
  mkdirSync(source);
  mkdirSync(target);
  vi.mocked(execFile).mockClear();
});
afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(execFile).mockImplementation(actual.execFile);
  rmSync(root, { recursive: true, force: true });
});

describe('shared dependency tree copying', () => {
  it('copies root and two workspace levels, keeps relative links and clears local caches', async () => {
    for (const relative of ['', 'app', 'apps/server', 'apps/server/deep']) {
      write(source, path.join(relative, 'node_modules/pkg/index.js'));
      mkdirSync(path.join(target, relative), { recursive: true });
    }
    for (const cache of ['.vite', '.vite-temp', '.cache']) write(source, `node_modules/${cache}/old`);
    symlinkSync('../app', path.join(source, 'node_modules/workspace'));
    expect((await copy()).sort()).toEqual(['app/node_modules', 'apps/server/node_modules', 'node_modules']);
    expect(readFileSync(path.join(target, 'apps/server/node_modules/pkg/index.js'), 'utf8')).toBe('package');
    expect(readlinkSync(path.join(target, 'node_modules/workspace'))).toBe('../app');
    expect(existsSync(path.join(target, 'apps/server/deep/node_modules'))).toBe(false);
    for (const cache of ['.vite', '.vite-temp', '.cache'])
      expect(existsSync(path.join(target, 'node_modules', cache))).toBe(false);
  });

  it('preserves existing targets and skips removed or linked workspace parents', async () => {
    write(source, 'node_modules/pkg/index.js');
    write(target, 'node_modules/existing', 'keep');
    write(source, 'apps/server/node_modules/pkg/index.js');
    write(source, 'removed/node_modules/pkg/index.js');
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(target, 'apps'));
    expect(await copy()).toEqual([]);
    expect(readFileSync(path.join(target, 'node_modules/existing'), 'utf8')).toBe('keep');
    expect(existsSync(path.join(outside, 'server'))).toBe(false);
  });

  it('never follows a linked source package directory', async () => {
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(source, 'node_modules'));
    expect(await copy()).toEqual([]);
  });

  it('falls back from a failed Darwin clone to a plain copy', async () => {
    write(source, 'node_modules/pkg/index.js');
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(execFile).mockImplementation(((
      file: string,
      args: string[],
      options: object,
      callback: (err: Error | null) => void,
    ) => {
      if (args.includes('-c')) {
        mkdirSync(path.join(target, 'node_modules'));
        write(target, 'node_modules/partial');
        setTimeout(() => callback(new Error('clone unsupported')), 0);
        return { kill: () => true };
      }
      expect(existsSync(path.join(target, 'node_modules'))).toBe(false);
      return actual.execFile(file, args, options, callback);
    }) as typeof execFile);
    expect(await copy({ platform: 'darwin' })).toEqual(['node_modules']);
    expect(readFileSync(path.join(target, 'node_modules/pkg/index.js'), 'utf8')).toBe('package');
    expect(vi.mocked(execFile).mock.calls.map((args) => args[1])).toEqual([
      ['-c', '-R', '-P', path.join(source, 'node_modules'), path.join(target, 'node_modules')],
      ['-R', '-P', path.join(source, 'node_modules'), path.join(target, 'node_modules')],
    ]);
  });

  it.each(['abort', 'timeout'])('waits for the copying child after %s and never falls back', async (kind) => {
    write(source, 'node_modules/pkg/index.js');
    const controller = new AbortController();
    let stopped = false;
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _options: object,
      callback: (err: Error) => void,
    ) => {
      if (kind === 'abort') setTimeout(() => controller.abort(), 1);
      return {
        kill: () => {
          setTimeout(() => {
            stopped = true;
            callback(new Error('stopped'));
          }, 20);
          return true;
        },
      };
    }) as typeof execFile);
    await expect(
      copy({ signal: controller.signal, timeoutMs: kind === 'timeout' ? 10 : 1000, platform: 'darwin' }),
    ).rejects.toThrow();
    expect(stopped).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
