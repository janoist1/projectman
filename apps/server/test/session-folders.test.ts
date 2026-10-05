import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultHeavyLockDir } from '../src/full-test/heavy-lock';
import {
  defaultSessionTmpRoot,
  prepareSessionFoldersRoot,
  prepareSessionTmpRoot,
  realpathOfNearest,
  SessionFolders,
} from '../src/domain/session-folders';

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

  it('resolves a path that is not there through the nearest existing ancestor, links followed', () => {
    const real = realpathSync(base);
    mkdirSync(join(base, 'dir'));
    symlinkSync(join(real, 'dir'), join(base, 'link'));
    expect(realpathOfNearest(join(base, 'link', 'a', 'b'))).toBe(join(real, 'dir', 'a', 'b'));
    expect(realpathOfNearest(join(base, 'dir'))).toBe(join(real, 'dir'));
    // Not a directory: the file's own path is kept, what is "below" it is appended.
    writeFileSync(join(base, 'file'), 'x');
    expect(realpathOfNearest(join(base, 'file', 'x'))).toBe(join(real, 'file', 'x'));
  });

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

  describe('the temporary directories of the sessions (PM-339)', () => {
    const tmpFolders = (warn?: (err: unknown, dir: string) => void) => {
      const root = join(base, 'projectman-sessions', 'abc');
      const tmpRoot = join(base, 'projectman-501-tmp', '0123abcd');
      prepareSessionFoldersRoot(root);
      prepareSessionTmpRoot(tmpRoot);
      return { folders: new SessionFolders(root, tmpRoot, warn), tmpRoot };
    };
    /** A session with its folder and its made temporary directory. */
    const startedSession = (folders: SessionFolders, id: string) => {
      const tmp = folders.allocateTmp(id)!;
      folders.make(id, folders.allocate(id), tmp);
      return tmp;
    };

    it('names `<tmpRoot>/<sessionId>.<6 hex>`, new at every call, and refuses an id that could leave it', () => {
      const { folders, tmpRoot } = tmpFolders();
      const first = folders.allocateTmp('ses_a1-B2')!;
      expect(first).toMatch(new RegExp(`^${tmpRoot}/ses_a1-B2\\.[0-9a-f]{6}$`));
      expect(folders.allocateTmp('ses_a1-B2')).not.toBe(first);
      for (const id of ['../x', 'a/b', '', '..', 'a b'])
        expect(() => folders.allocateTmp(id)).toThrow(/Not a session id/);
      expect(new SessionFolders('/r').allocateTmp('ses_a')).toBeUndefined();
    });

    it('makes 0700 only a path `allocateTmp` gave out', () => {
      const { folders, tmpRoot } = tmpFolders();
      const tmp = startedSession(folders, 'ses_one');
      expect(mode(tmp)).toBe(0o700);
      const dir = folders.allocate('ses_two');
      expect(() => folders.make('ses_two', dir, join(tmpRoot, 'x', 'ses_two.abcdef'))).toThrow(
        /not a temporary/,
      );
      expect(() => folders.make('ses_two', dir, join(tmpRoot, 'ses_one.abcdef'))).toThrow(/not a temporary/);
      expect(() => folders.make('ses_two', dir, join(base, 'elsewhere'))).toThrow(/not a temporary/);
      expect(() => new SessionFolders('/r').make('ses_two', undefined, '/r/abc')).toThrow(/not a temporary/);
      // Refused before anything is made or removed.
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(tmp)).toBe(true);
    });

    it('does not use a link or a directory that is already at the path, and makes nothing behind it', () => {
      const { folders, tmpRoot } = tmpFolders();
      const target = join(base, 'target');
      mkdirSync(target);
      const planted = join(tmpRoot, 'ses_one.012345');
      symlinkSync(target, planted);
      expect(() => folders.make('ses_one', folders.allocate('ses_one'), planted)).toThrow(/EEXIST/);
      expect(readdirSync(target)).toEqual([]);
      // The link is left to the sweep, which removes it as a link, never its target.
      folders.remove('ses_one');
      expect(existsSync(planted)).toBe(true);
      folders.sweep(() => false);
      expect(existsSync(planted)).toBe(false);
      expect(existsSync(target)).toBe(true);
      const real = join(tmpRoot, 'ses_two.ba9876');
      mkdirSync(real);
      expect(() => folders.make('ses_two', undefined, real)).toThrow(/EEXIST/);
    });

    it('makes a temporary directory alone, without a folder', () => {
      const { folders } = tmpFolders();
      const tmp = folders.allocateTmp('ses_one')!;
      folders.make('ses_one', undefined, tmp);
      expect(existsSync(tmp)).toBe(true);
      expect(folders.of('ses_one')).toBeUndefined();
      folders.remove('ses_one');
      expect(existsSync(tmp)).toBe(false);
    });

    it('makes the root and the folder above it 0700 and refuses a link or a folder of another kind there', () => {
      const { tmpRoot } = tmpFolders();
      expect(mode(tmpRoot)).toBe(0o700);
      expect(mode(dirname(tmpRoot))).toBe(0o700);
      // A folder that somebody made with more rights is tightened.
      chmodSync(dirname(tmpRoot), 0o755);
      prepareSessionTmpRoot(tmpRoot);
      expect(mode(dirname(tmpRoot))).toBe(0o700);
      const target = join(base, 'target');
      mkdirSync(target);
      symlinkSync(target, join(base, 'linked'));
      expect(() => prepareSessionTmpRoot(join(base, 'linked', 'x'))).toThrow(/symbolic link/);
      expect(existsSync(join(target, 'x'))).toBe(false);
      writeFileSync(join(base, 'plain'), '');
      expect(() => prepareSessionTmpRoot(join(base, 'plain', 'x'))).toThrow(/not a directory/);
    });

    it('removes the session’s temporary directory with its content when the session’s folder is removed', () => {
      const { folders } = tmpFolders();
      const tmp = startedSession(folders, 'ses_one');
      mkdirSync(join(tmp, 'a', 'b'), { recursive: true });
      writeFileSync(join(tmp, 'a', 'b', 'x'), 'x');
      folders.remove('ses_one');
      expect(existsSync(tmp)).toBe(false);
      expect(readdirSync(dirname(tmp))).toEqual([]);
      expect(() => folders.remove('ses_one')).not.toThrow();
    });

    it('removes the previous run’s temporary directory when a restart makes the new one', () => {
      const { folders } = tmpFolders();
      const first = startedSession(folders, 'ses_one');
      const second = startedSession(folders, 'ses_one');
      expect(second).not.toBe(first);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(true);
    });

    it('logs a temporary directory it cannot remove and goes on with the folder', () => {
      const warned: string[] = [];
      const { folders, tmpRoot } = tmpFolders((_err, dir) => warned.push(dir));
      const dir = folders.allocate('ses_one');
      const tmp = folders.allocateTmp('ses_one')!;
      folders.make('ses_one', dir, tmp);
      // The rename into the root fails when the root cannot be written.
      chmodSync(tmpRoot, 0o500);
      try {
        expect(() => folders.remove('ses_one')).not.toThrow();
      } finally {
        chmodSync(tmpRoot, 0o700);
      }
      expect(existsSync(dir)).toBe(false);
      // Running as root the removal succeeds, so the failure is not seen.
      if (process.getuid?.() !== 0) expect(warned).toEqual([tmp]);
    });

    it('sweeps the temporary directories of sessions that are gone, and keeps a kept session’s', () => {
      const { folders, tmpRoot } = tmpFolders();
      const kept = startedSession(folders, 'ses_keep');
      startedSession(folders, 'ses_gone');
      mkdirSync(join(tmpRoot, 'ses_stray.abcdef'));
      writeFileSync(join(tmpRoot, 'stray'), 'x');
      folders.sweep((id) => id === 'ses_keep');
      expect(readdirSync(tmpRoot)).toEqual([basename(kept)]);
    });

    it('removes an empty root at the stop and leaves one that holds a session’s directory', () => {
      const { folders, tmpRoot } = tmpFolders();
      startedSession(folders, 'ses_one');
      folders.releaseTmpRoot();
      expect(existsSync(tmpRoot)).toBe(true);
      folders.remove('ses_one');
      folders.releaseTmpRoot();
      expect(existsSync(tmpRoot)).toBe(false);
      expect(() => folders.releaseTmpRoot()).not.toThrow();
      expect(() => new SessionFolders('/r').releaseTmpRoot()).not.toThrow();
    });

    it('has a default root beside the heavy-run queue folder, never below it, and room for a Unix socket', () => {
      const root = join(defaultSessionTmpRoot(), '0123abcd');
      expect(root).toMatch(/\/projectman-(\d+|user)-tmp\/0123abcd$/);
      // The members' sandboxes write `/tmp/projectman-<uid>`: the root is not that folder or below it.
      const queueParent = defaultHeavyLockDir().replace(/\/[^/]+$/, '');
      expect(queueParent).toMatch(/\/projectman-(\d+|user)$/);
      expect(`${root}/`.startsWith(`${queueParent}/`)).toBe(false);
      expect(`${queueParent}/`.startsWith(`${root}/`)).toBe(false);
      // The directory is `<session id>.<6 hex>` (an id is `ses_` and 18 characters); tools add a name like
      // `tsx-501/12345.pipe` (a socket's path may be 104 bytes).
      const tmp = join(root, `ses_${'x'.repeat(18)}.abcdef`);
      expect(Buffer.byteLength(tmp)).toBeLessThanOrEqual(72);
      expect(Buffer.byteLength(join(tmp, 'tsx-501', '12345.pipe'))).toBeLessThan(104);
    });
  });
});
