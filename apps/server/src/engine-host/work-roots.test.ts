import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkRoots, WORK_ROOT_MARKER, WorkRootError } from './work-roots';

let base: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-work-roots-')));
  home = path.join(base, 'home');
  mkdirSync(home);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function mount(dir: string, marker = true): string {
  mkdirSync(dir, { recursive: true });
  if (marker) writeFileSync(path.join(dir, WORK_ROOT_MARKER), '');
  return dir;
}

function reasonOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(WorkRootError);
    expect((err as WorkRootError).code).toBe('work_root_invalid');
    return (err as WorkRootError).reason;
  }
  return undefined;
}

describe('resolveWorkRoots', () => {
  it('gives today’s paths and creates nothing without a work root', () => {
    expect(resolveWorkRoots(home)).toEqual({
      workRoot: null,
      worktrees: path.join(home, 'worktrees'),
      workspaces: path.join(home, 'workspaces'),
    });
    expect(statSyncOrNull(path.join(home, 'worktrees'))).toBeNull();
  });

  it('refuses a relative path', () => {
    expect(reasonOf(() => resolveWorkRoots(home, 'work'))).toBe('not_absolute');
  });

  it('refuses a path that does not exist', () => {
    expect(reasonOf(() => resolveWorkRoots(home, path.join(home, 'work')))).toBe('missing');
  });

  it('refuses a root that is a file', () => {
    const file = path.join(home, 'work');
    writeFileSync(file, '');
    expect(reasonOf(() => resolveWorkRoots(home, file))).toBe('missing');
  });

  it('refuses a root without the marker (an unmounted volume)', () => {
    const root = mount(path.join(home, 'work'), false);
    expect(reasonOf(() => resolveWorkRoots(home, root))).toBe('marker_missing');
    expect(statSyncOrNull(path.join(root, 'worktrees'))).toBeNull();
  });

  it('refuses a marker that is a symbolic link', () => {
    const root = mount(path.join(home, 'work'), false);
    writeFileSync(path.join(base, 'elsewhere'), '');
    symlinkSync(path.join(base, 'elsewhere'), path.join(root, WORK_ROOT_MARKER));
    expect(reasonOf(() => resolveWorkRoots(home, root))).toBe('marker_missing');
  });

  it('refuses a root outside the home', () => {
    const root = mount(path.join(base, 'volume'));
    expect(reasonOf(() => resolveWorkRoots(home, root))).toBe('outside_home');
  });

  it('refuses the home itself', () => {
    writeFileSync(path.join(home, WORK_ROOT_MARKER), '');
    expect(reasonOf(() => resolveWorkRoots(home, home))).toBe('outside_home');
  });

  it('refuses a link inside the home that points out of it', () => {
    const root = mount(path.join(base, 'volume'));
    symlinkSync(root, path.join(home, 'work'));
    expect(reasonOf(() => resolveWorkRoots(home, path.join(home, 'work')))).toBe('outside_home');
  });

  it('follows a link inside the home that points further in, and returns the real paths', () => {
    const real = mount(path.join(home, 'volumes', 'work'));
    symlinkSync(real, path.join(home, 'work'));

    const roots = resolveWorkRoots(home, path.join(home, 'work'));

    expect(roots).toEqual({
      workRoot: real,
      worktrees: path.join(real, 'worktrees'),
      workspaces: path.join(real, 'workspaces'),
    });
    for (const dir of [roots.worktrees, roots.workspaces]) expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('keeps what is already in the subdirectories', () => {
    const root = mount(path.join(home, 'work'));
    mkdirSync(path.join(root, 'worktrees', 'PM'), { recursive: true });

    resolveWorkRoots(home, root);

    expect(statSync(path.join(root, 'worktrees', 'PM')).isDirectory()).toBe(true);
  });
});

function statSyncOrNull(target: string) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}
