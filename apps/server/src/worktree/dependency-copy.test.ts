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
import { execCommand, type ExecCommandOptions } from '../exec';
import { copyDependencyTrees } from './dependency-copy';

vi.mock('../exec', async (original) => {
  const actual = await original<typeof import('../exec')>();
  return { ...actual, execCommand: vi.fn(actual.execCommand) };
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
  vi.mocked(execCommand).mockClear();
});
afterEach(async () => {
  const actual = await vi.importActual<typeof import('../exec')>('../exec');
  vi.mocked(execCommand).mockImplementation(actual.execCommand);
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
    const actual = await vi.importActual<typeof import('../exec')>('../exec');
    vi.mocked(execCommand).mockImplementation(((
      file: string,
      args: string[],
      options: ExecCommandOptions & { encoding?: 'utf8' },
    ) => {
      if (args.includes('-c')) {
        mkdirSync(path.join(target, 'node_modules'));
        write(target, 'node_modules/partial');
        return Promise.reject(new Error('clone unsupported'));
      }
      expect(existsSync(path.join(target, 'node_modules'))).toBe(false);
      return actual.execCommand(file, args, options);
    }) as unknown as typeof execCommand);
    expect(await copy({ platform: 'darwin' })).toEqual(['node_modules']);
    expect(readFileSync(path.join(target, 'node_modules/pkg/index.js'), 'utf8')).toBe('package');
    expect(vi.mocked(execCommand).mock.calls.map((args) => args[1])).toEqual([
      ['-c', '-R', '-P', path.join(source, 'node_modules'), path.join(target, 'node_modules')],
      ['-R', '-P', path.join(source, 'node_modules'), path.join(target, 'node_modules')],
    ]);
  });

  it.each(['abort', 'timeout'])('waits for the copying child after %s and never falls back', async (kind) => {
    write(source, 'node_modules/pkg/index.js');
    const controller = new AbortController();
    let stopped = false;
    vi.mocked(execCommand).mockImplementation((async (
      _file: string,
      _args: string[],
      options: ExecCommandOptions,
    ) => {
      if (kind === 'abort') setTimeout(() => controller.abort(), 1);
      await new Promise<void>((resolve) => {
        if (kind === 'abort')
          options.cancelSignal?.addEventListener('abort', () => resolve(), { once: true });
        else setTimeout(resolve, options.timeoutMs);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      stopped = true;
      throw new Error('stopped');
    }) as unknown as typeof execCommand);
    await expect(
      copy({ signal: controller.signal, timeoutMs: kind === 'timeout' ? 10 : 1000, platform: 'darwin' }),
    ).rejects.toThrow();
    expect(stopped).toBe(true);
    expect(execCommand).toHaveBeenCalledTimes(1);
  });
});
