import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareSessionFoldersRoot, SessionFolders } from '../src/domain/session-folders';

describe('session folders (PM-268)', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pm-session-folders-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const mode = (path: string) => statSync(path).mode & 0o777;
  const prepared = () => {
    const root = join(base, 'projectman-sessions', 'abc');
    prepareSessionFoldersRoot(root);
    return new SessionFolders(root);
  };

  it('names a new folder below the root at every call, and refuses an id that could leave it', () => {
    const folders = new SessionFolders('/r');
    const first = folders.allocate('ses_a1-B2');
    const second = folders.allocate('ses_a1-B2');
    expect(first).toMatch(/^\/r\/ses_a1-B2\.[0-9a-f]{16}$/);
    expect(second).not.toBe(first);
    for (const id of ['../x', 'a/b', '', '..', '.', 'a b', 'x'.repeat(65)])
      expect(() => folders.allocate(id)).toThrow(/Not a session id/);
  });

  it('makes the root and one session’s folder with mode 0700, and removes the folder with its content', () => {
    const folders = prepared();
    expect(mode(folders.root)).toBe(0o700);
    const dir = folders.allocate('ses_one');
    expect(existsSync(dir)).toBe(false);
    folders.make('ses_one', dir);
    expect(mode(dir)).toBe(0o700);
    expect(folders.of('ses_one')).toBe(dir);
    mkdirSync(join(dir, 'shots', 'x'), { recursive: true });
    writeFileSync(join(dir, 'shots', 'x', '1.png'), 'png');
    folders.remove('ses_one');
    expect(existsSync(dir)).toBe(false);
    expect(folders.of('ses_one')).toBeUndefined();
    // Not even the name it was renamed to for the removal stays.
    expect(readdirSync(folders.root)).toEqual([]);
    // Removing what is not there is not an error.
    expect(() => folders.remove('ses_one')).not.toThrow();
  });

  it('makes a folder exclusively: a path that exists, as a folder or a link, is refused', () => {
    const folders = prepared();
    const target = join(base, 'target');
    mkdirSync(target);
    const dir = folders.allocate('ses_one');
    symlinkSync(target, dir);
    expect(() => folders.make('ses_one', dir)).toThrow(/EEXIST/);
    expect(folders.of('ses_one')).toBeUndefined();
    const other = folders.allocate('ses_one');
    mkdirSync(other);
    expect(() => folders.make('ses_one', other)).toThrow(/EEXIST/);
    expect(readdirSync(target)).toEqual([]);
  });

  it('refuses a path that is not one it gave out for that session', () => {
    const folders = prepared();
    expect(() => folders.make('ses_one', join(folders.root, 'ses_one'))).toThrow(/not a folder of session/);
    expect(() => folders.make('ses_one', folders.allocate('ses_two'))).toThrow(/not a folder of session/);
    expect(() => folders.make('ses_one', join(base, 'elsewhere', 'ses_one.00'))).toThrow(
      /not a folder of session/,
    );
  });

  it('removes the folder a session had before when it is given a new one', () => {
    const folders = prepared();
    const old = folders.allocate('ses_one');
    folders.make('ses_one', old);
    const next = folders.allocate('ses_one');
    folders.make('ses_one', next);
    expect(existsSync(old)).toBe(false);
    expect(folders.of('ses_one')).toBe(next);
    expect(readdirSync(folders.root)).toEqual([next.slice(folders.root.length + 1)]);
  });

  it('closes a root with group or other bits to 0700', () => {
    const root = join(base, 'root');
    mkdirSync(root, { mode: 0o755 });
    chmodSync(root, 0o755);
    prepareSessionFoldersRoot(root);
    expect(mode(root)).toBe(0o700);
  });

  it('refuses a root that is a symbolic link, and a parent that is one', () => {
    const target = join(base, 'target');
    mkdirSync(target);
    const link = join(base, 'link');
    symlinkSync(target, link);
    expect(() => prepareSessionFoldersRoot(link)).toThrow(/symbolic link/);
    expect(() => prepareSessionFoldersRoot(join(link, 'root'))).toThrow(/symbolic link/);
    // Nothing was made behind the link.
    expect(readdirSync(target)).toEqual([]);
  });

  it('refuses a root that is a file', () => {
    const file = join(base, 'file');
    writeFileSync(file, 'x');
    expect(() => prepareSessionFoldersRoot(file)).toThrow();
  });

  describe('the removal', () => {
    it('removes a link inside a folder as a link', () => {
      const folders = prepared();
      const dir = folders.allocate('ses_one');
      folders.make('ses_one', dir);
      const outside = join(base, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'precious.txt'), 'keep me');
      symlinkSync(outside, join(dir, 'escape'));
      folders.remove('ses_one');
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    });

    it('takes a folder that was replaced by a link away as a link', () => {
      const folders = prepared();
      const dir = folders.allocate('ses_one');
      folders.make('ses_one', dir);
      const outside = join(base, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'precious.txt'), 'keep me');
      rmSync(dir, { recursive: true });
      symlinkSync(outside, dir);
      folders.remove('ses_one');
      expect(() => lstatSync(dir)).toThrow();
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
      expect(readdirSync(folders.root)).toEqual([]);
    });

    it('renames the folder away before it removes it, so the old path is gone at once', () => {
      const folders = prepared();
      const dir = folders.allocate('ses_one');
      folders.make('ses_one', dir);
      writeFileSync(join(dir, 'a.png'), 'png');
      folders.remove('ses_one');
      // A command of the old run cannot put anything back: its rule covers the path, which is not
      // there, and the root is not writable for it.
      expect(existsSync(dir)).toBe(false);
    });
  });

  describe('the sweep', () => {
    it('removes everything but the folders of the sessions to keep', () => {
      const folders = prepared();
      const keep = folders.allocate('ses_keep');
      folders.make('ses_keep', keep);
      folders.make('ses_old', folders.allocate('ses_old'));
      writeFileSync(join(folders.root, 'stray-file'), 'x');
      mkdirSync(join(folders.root, '.trash-leftover'));
      mkdirSync(join(folders.root, 'ses_dead.0123456789abcdef'));
      const removed = folders.sweep((id) => id === 'ses_keep');
      expect(removed).toHaveLength(4);
      expect(readdirSync(folders.root)).toEqual([keep.slice(folders.root.length + 1)]);
      expect(folders.of('ses_keep')).toBe(keep);
      expect(folders.of('ses_old')).toBeUndefined();
    });

    it('removes a symbolic link as a link, and leaves its target alone', () => {
      const folders = prepared();
      const outside = join(base, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'precious.txt'), 'keep me');
      symlinkSync(outside, join(folders.root, 'ses_link.0123456789abcdef'));
      expect(folders.sweep(() => false)).toEqual(['ses_link.0123456789abcdef']);
      expect(readdirSync(folders.root)).toEqual([]);
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    });
  });
});
