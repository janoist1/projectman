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
import {
  makeSessionFolder,
  prepareSessionFoldersRoot,
  removeSessionFolder,
  sessionFolderOf,
  sweepSessionFolders,
} from '../src/domain/session-folders';

describe('session folders (PM-268)', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pm-session-folders-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const mode = (path: string) => statSync(path).mode & 0o777;

  it('names the folder of a session below the root, and refuses an id that could leave it', () => {
    expect(sessionFolderOf('/r', 'ses_a1-B2')).toBe('/r/ses_a1-B2');
    for (const id of ['../x', 'a/b', '', '..', '.', 'a b', 'x'.repeat(65)])
      expect(() => sessionFolderOf('/r', id)).toThrow(/Not a session id/);
  });

  it('makes the root and one session’s folder with mode 0700, and removes the folder with its content', () => {
    const root = join(base, 'projectman-sessions', 'abc');
    prepareSessionFoldersRoot(root);
    expect(mode(root)).toBe(0o700);
    const dir = sessionFolderOf(root, 'ses_one');
    makeSessionFolder(dir);
    expect(mode(dir)).toBe(0o700);
    mkdirSync(join(dir, 'shots', 'x'), { recursive: true });
    writeFileSync(join(dir, 'shots', 'x', '1.png'), 'png');
    removeSessionFolder(dir);
    expect(existsSync(dir)).toBe(false);
    // Removing what is not there is not an error.
    expect(() => removeSessionFolder(dir)).not.toThrow();
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

  describe('the sweep', () => {
    it('removes everything but the folders of the sessions to keep', () => {
      const root = join(base, 'root');
      prepareSessionFoldersRoot(root);
      for (const id of ['ses_keep', 'ses_old', 'ses_older']) makeSessionFolder(sessionFolderOf(root, id));
      writeFileSync(join(root, 'ses_old', 'a.png'), 'png');
      writeFileSync(join(root, 'stray-file'), 'x');
      const removed = sweepSessionFolders(root, (id) => id === 'ses_keep');
      expect(removed.sort()).toEqual(['ses_old', 'ses_older', 'stray-file']);
      expect(readdirSync(root)).toEqual(['ses_keep']);
    });

    it('removes a symbolic link as a link, and leaves its target alone', () => {
      const root = join(base, 'root');
      prepareSessionFoldersRoot(root);
      const outside = join(base, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'precious.txt'), 'keep me');
      symlinkSync(outside, join(root, 'ses_link'));
      expect(sweepSessionFolders(root, () => false)).toEqual(['ses_link']);
      expect(() => lstatSync(join(root, 'ses_link'))).toThrow();
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    });

    it('removes a link inside a folder as a link', () => {
      const root = join(base, 'root');
      prepareSessionFoldersRoot(root);
      const dir = sessionFolderOf(root, 'ses_one');
      makeSessionFolder(dir);
      const outside = join(base, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'precious.txt'), 'keep me');
      symlinkSync(outside, join(dir, 'escape'));
      removeSessionFolder(dir);
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    });
  });
});
