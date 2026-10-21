import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AdministrationSetupError,
  assertPrivateDir,
  assertSocketFile,
  ensurePrivateDir,
  readFileTail,
  readPrivateFile,
  removeStaleSocket,
  writeFileAtomic,
} from './secure-fs';
import { unixSocketsWork } from './test-helpers';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'adm-fs-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const reason = async (action: Promise<unknown>) => {
  try {
    await action;
  } catch (err) {
    if (err instanceof AdministrationSetupError) return err.reason;
    throw err;
  }
  return null;
};

describe('private directory', () => {
  it('creates a missing directory closed to group and others', async () => {
    const dir = path.join(root, 'state');
    await ensurePrivateDir(dir);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
  });

  it('refuses a directory that is open, a link, a file or missing, and never loosens or tightens it', async () => {
    const open = path.join(root, 'open');
    await mkdir(open, { mode: 0o755 });
    await chmod(open, 0o755);
    expect(await reason(assertPrivateDir(open))).toBe('too_open');
    expect(await reason(ensurePrivateDir(open))).toBe('too_open');
    expect((await lstat(open)).mode & 0o777).toBe(0o755);

    const real = path.join(root, 'real');
    await ensurePrivateDir(real);
    const link = path.join(root, 'link');
    await symlink(real, link);
    expect(await reason(assertPrivateDir(link))).toBe('symlink');

    const file = path.join(root, 'file');
    await writeFile(file, 'x');
    expect(await reason(assertPrivateDir(file))).toBe('not_directory');
    expect(await reason(assertPrivateDir(path.join(root, 'absent')))).toBe('missing');
  });

  it('refuses a directory of another user', async () => {
    const dir = path.join(root, 'state');
    await ensurePrivateDir(dir);
    const uid = process.getuid!();
    expect(await reason(assertPrivateDir(dir, uid + 1))).toBe('wrong_owner');
  });
});

describe('atomic private files', () => {
  it('writes a 0600 file and replaces it without leaving a temporary file', async () => {
    const dir = path.join(root, 'state');
    await ensurePrivateDir(dir);
    await writeFileAtomic(dir, 'one.json', '{"a":1}');
    await writeFileAtomic(dir, 'one.json', '{"a":2}');
    expect(await readFile(path.join(dir, 'one.json'), 'utf8')).toBe('{"a":2}');
    expect((await lstat(path.join(dir, 'one.json'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['one.json']);
  });

  it('refuses a name that is not a plain file name and a target that is a link', async () => {
    const dir = path.join(root, 'state');
    await ensurePrivateDir(dir);
    for (const name of ['../escape', 'a/b', '', '..', 'x y'])
      expect(await reason(writeFileAtomic(dir, name, 'x')), name).toBe('unsupported');
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'keep');
    await symlink(outside, path.join(dir, 'link.json'));
    expect(await reason(writeFileAtomic(dir, 'link.json', 'overwritten'))).toBe('symlink');
    expect(await readFile(outside, 'utf8')).toBe('keep');
  });

  it('reads only a regular file of the service user that is closed to others', async () => {
    const dir = path.join(root, 'state');
    await ensurePrivateDir(dir);
    expect(await readPrivateFile(path.join(dir, 'absent'), 100)).toBeNull();
    await writeFileAtomic(dir, 'ok.txt', 'hello');
    expect(await readPrivateFile(path.join(dir, 'ok.txt'), 100)).toBe('hello');
    expect(await reason(readPrivateFile(path.join(dir, 'ok.txt'), 3))).toBe('too_large');
    expect(await reason(readPrivateFile(path.join(dir, 'ok.txt'), 100, process.getuid!() + 1))).toBe(
      'wrong_owner',
    );

    await chmod(path.join(dir, 'ok.txt'), 0o644);
    expect(await reason(readPrivateFile(path.join(dir, 'ok.txt'), 100))).toBe('too_open');

    await symlink(path.join(dir, 'ok.txt'), path.join(dir, 'link.txt'));
    expect(await reason(readPrivateFile(path.join(dir, 'link.txt'), 100))).toBe('symlink');
    expect(await reason(readPrivateFile(dir, 100))).toBe('not_file');
  });

  it('reads the end of a log file that others may read, and refuses a link or a file others may write', async () => {
    const file = path.join(root, 'service.log');
    expect(await readFileTail(file, 100)).toBeNull();
    await writeFile(file, 'first\nsecond\nthird\n');
    await chmod(file, 0o644);
    expect(await readFileTail(file, 1000)).toMatchObject({ text: 'first\nsecond\nthird\n', complete: true });
    expect(await readFileTail(file, 6)).toMatchObject({ text: 'third\n', complete: false });
    expect(await reason(readFileTail(file, 100, process.getuid!() + 1))).toBe('wrong_owner');

    await chmod(file, 0o666);
    expect(await reason(readFileTail(file, 100))).toBe('too_open');
    const link = path.join(root, 'link.log');
    await symlink(file, link);
    expect(await reason(readFileTail(link, 100))).toBe('symlink');
  });
});

const socketsWork = await unixSocketsWork();

describe.skipIf(!socketsWork)('socket file', () => {
  const listen = (file: string) =>
    new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(file, () => resolve(server));
    });

  it('accepts a closed socket and refuses a link, a plain file and an open socket', async () => {
    const dir = path.join(root, 's');
    await ensurePrivateDir(dir);
    const file = path.join(dir, 'sock');
    const server = await listen(file);
    try {
      await chmod(file, 0o600);
      await assertSocketFile(file);
      expect(await reason(assertSocketFile(file, process.getuid!() + 1))).toBe('wrong_owner');

      const link = path.join(dir, 'link');
      await symlink(file, link);
      expect(await reason(assertSocketFile(link))).toBe('symlink');

      await chmod(file, 0o666);
      expect(await reason(assertSocketFile(file))).toBe('too_open');
    } finally {
      server.close();
    }
    const plain = path.join(dir, 'plain');
    await writeFile(plain, 'x');
    expect(await reason(assertSocketFile(plain))).toBe('not_socket');
    expect(await reason(assertSocketFile(path.join(dir, 'absent')))).toBe('missing');
  });

  it('removes a stale socket but never anything else', async () => {
    const dir = path.join(root, 's');
    await ensurePrivateDir(dir);
    const file = path.join(dir, 'sock');
    const server = await listen(file);
    // Something answers on it: a second supervisor must not take the socket over.
    expect(await reason(removeStaleSocket(file))).toBe('in_use');
    expect((await lstat(file)).isSocket()).toBe(true);
    // A probe that finds nobody listening makes the same file a stale leftover.
    await removeStaleSocket(file, undefined, async () => 'stale');
    server.close();
    await expect(lstat(file)).rejects.toThrow();
    await removeStaleSocket(file);

    const plain = path.join(dir, 'plain');
    await writeFile(plain, 'x');
    expect(await reason(removeStaleSocket(plain))).toBe('not_socket');
    expect(await readFile(plain, 'utf8')).toBe('x');
  });
});
