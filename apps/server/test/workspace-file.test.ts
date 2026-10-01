import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openWorkspaceFile, WorkspaceFileRefusal } from '../src/domain';
import type { WorkspaceFile, WorkspaceFileHooks } from '../src/domain';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('opening a file of the working directory', () => {
  let dir: string;
  /** The session's working directory. */
  let root: string;
  /** A directory next to it, outside. */
  let outside: string;
  const opened: WorkspaceFile[] = [];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pm-workspace-file-')));
    root = join(dir, 'app');
    outside = join(dir, 'secrets');
    mkdirSync(join(root, 'shots'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'shots', 'login.png'), 'inside');
    writeFileSync(join(outside, 'login.png'), 'outside secret');
  });
  afterEach(async () => {
    for (const file of opened.splice(0)) await file.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const open = async (
    requested: string,
    opts: { maxBytes?: number; hooks?: WorkspaceFileHooks; root?: string } = {},
  ) => {
    const file = await openWorkspaceFile(opts.root ?? root, requested, {
      maxBytes: opts.maxBytes ?? 1000,
      hooks: opts.hooks,
    });
    opened.push(file);
    return file;
  };
  const refusal = async (promise: Promise<unknown>): Promise<WorkspaceFileRefusal> => {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WorkspaceFileRefusal);
    return err as WorkspaceFileRefusal;
  };

  it('opens a regular file by a relative or an absolute path inside, and reads it from the handle', async () => {
    const relative = await open('shots/login.png');
    expect(relative).toMatchObject({ name: 'login.png', size: 6 });
    expect((await readAll(relative.stream())).toString()).toBe('inside');
    await relative.verifyUnchanged();

    const absolute = await open(join(root, 'shots', 'login.png'));
    expect((await readAll(absolute.stream())).toString()).toBe('inside');
    // A `..` that stays inside is resolved by its components.
    const roundabout = await open('shots/../shots/./login.png');
    expect(roundabout.name).toBe('login.png');
  });

  it('takes the working directory as recorded or resolved, and resolves a linked one only once', async () => {
    const linkedRoot = join(dir, 'linked-app');
    symlinkSync(root, linkedRoot);
    const viaLink = await open(join(linkedRoot, 'shots', 'login.png'), { root: linkedRoot });
    expect((await readAll(viaLink.stream())).toString()).toBe('inside');
    const viaReal = await open(join(root, 'shots', 'login.png'), { root: linkedRoot });
    expect(viaReal.size).toBe(6);
  });

  it.each([
    ['a parent directory', '../secrets/login.png'],
    ['an absolute path elsewhere', '/etc/hosts'],
    ['a sibling whose name starts the same', '../app2/login.png'],
    ['the working directory itself', '.'],
  ])('refuses %s', async (_what, requested) => {
    mkdirSync(join(dir, 'app2'));
    writeFileSync(join(dir, 'app2', 'login.png'), 'sibling');
    const err = await refusal(open(requested));
    expect(err.reason).toBe('outside');
    expect(err.message).toContain('not inside your working directory');
  });

  it('refuses a sibling directory with the same prefix given as an absolute path', async () => {
    mkdirSync(join(dir, 'app-private'));
    writeFileSync(join(dir, 'app-private', 'key.pem'), 'secret');
    expect((await refusal(open(join(dir, 'app-private', 'key.pem')))).reason).toBe('outside');
  });

  it('refuses a symbolic link to a file outside, and to a file inside', async () => {
    symlinkSync(join(outside, 'login.png'), join(root, 'out.png'));
    symlinkSync(join(root, 'shots', 'login.png'), join(root, 'in.png'));
    expect((await refusal(open('out.png'))).reason).toBe('link');
    expect((await refusal(open('in.png'))).reason).toBe('link');
  });

  it('refuses a path through a linked directory', async () => {
    symlinkSync(outside, join(root, 'docs'));
    const err = await refusal(open('docs/login.png'));
    expect(err.reason).toBe('link');
    expect(err.message).toContain('symbolic link');
  });

  it('refuses a file with another hard link (the other name may be anywhere)', async () => {
    linkSync(join(outside, 'login.png'), join(root, 'hard.png'));
    expect((await refusal(open('hard.png'))).reason).toBe('link');
  });

  it('refuses a directory, a FIFO and a missing file, without blocking on the FIFO', async () => {
    expect((await refusal(open('shots'))).reason).toBe('not_a_file');
    execFileSync('mkfifo', [join(root, 'pipe')]);
    const fifo = await refusal(open('pipe'));
    expect(fifo.reason).toBe('not_a_file');
    expect(fifo.message).toContain('not a regular file');
    expect((await refusal(open('nothing.png'))).reason).toBe('missing');
    expect((await refusal(open('shots/login.png/x'))).reason).toBe('missing');
    expect((await refusal(open(''))).reason).toBe('invalid');
  });

  it('takes a file of exactly the limit and refuses one byte more before reading it', async () => {
    writeFileSync(join(root, 'exact.bin'), Buffer.alloc(1000, 1));
    writeFileSync(join(root, 'over.bin'), Buffer.alloc(1001, 1));
    const exact = await open('exact.bin');
    expect((await readAll(exact.stream())).length).toBe(1000);
    await exact.verifyUnchanged();
    const err = await refusal(open('over.bin'));
    expect(err.reason).toBe('too_large');
    expect(err.message).toBe('over.bin is 1001 bytes; an attachment is at most 1000 bytes.');
  });

  describe('a path changed between the checks and the open', () => {
    it('refuses a directory swapped for a link to the outside', async () => {
      const err = await refusal(
        open('shots/login.png', {
          hooks: {
            beforeOpen() {
              renameSync(join(root, 'shots'), join(root, 'shots-before'));
              symlinkSync(outside, join(root, 'shots'));
            },
          },
        }),
      );
      expect(err.reason).toBe('changed');
    });

    it('refuses it when the directory was swapped back after the open', async () => {
      const err = await refusal(
        open('shots/login.png', {
          hooks: {
            beforeOpen() {
              renameSync(join(root, 'shots'), join(root, 'shots-before'));
              symlinkSync(outside, join(root, 'shots'));
            },
            afterOpen() {
              unlinkSync(join(root, 'shots'));
              renameSync(join(root, 'shots-before'), join(root, 'shots'));
            },
          },
        }),
      );
      expect(err.reason).toBe('changed');
    });

    it('refuses the checked file itself once it was moved out behind a link', async () => {
      const err = await refusal(
        open('shots/login.png', {
          hooks: {
            beforeOpen() {
              rmSync(join(outside, 'login.png'));
              renameSync(join(root, 'shots', 'login.png'), join(outside, 'login.png'));
              rmSync(join(root, 'shots'), { recursive: true });
              symlinkSync(outside, join(root, 'shots'));
            },
          },
        }),
      );
      expect(err.reason).toBe('changed');
    });

    it('refuses the file replaced by a link (the open does not follow it)', async () => {
      const err = await refusal(
        open('shots/login.png', {
          hooks: {
            beforeOpen() {
              unlinkSync(join(root, 'shots', 'login.png'));
              symlinkSync(join(outside, 'login.png'), join(root, 'shots', 'login.png'));
            },
          },
        }),
      );
      expect(err.reason).toBe('link');
    });
  });

  describe('a file that changes while it is read', () => {
    it('refuses one that grew', async () => {
      const file = await open('shots/login.png');
      appendFileSync(join(root, 'shots', 'login.png'), ' and more');
      // At most one byte more than its size at the open is read: never the whole growth.
      expect((await readAll(file.stream())).toString()).toBe('inside ');
      const err = await refusal(file.verifyUnchanged());
      expect(err.reason).toBe('changed');
      expect(err.message).toContain('changed while it was read');
    });

    it('refuses one that shrank', async () => {
      const file = await open('shots/login.png');
      writeFileSync(join(root, 'shots', 'login.png'), 'in');
      await readAll(file.stream());
      expect((await refusal(file.verifyUnchanged())).reason).toBe('changed');
    });

    it('refuses one rewritten in place with the same size', async () => {
      const file = await open('shots/login.png');
      await readAll(file.stream());
      writeFileSync(join(root, 'shots', 'login.png'), 'INSIDE');
      utimesSync(join(root, 'shots', 'login.png'), new Date(), new Date(Date.now() + 5_000));
      expect((await refusal(file.verifyUnchanged())).reason).toBe('changed');
    });
  });
});
