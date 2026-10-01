import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_FILE_NAME_BYTES } from '@projectman/shared';
import type { AttachmentRef, AttachmentStorage } from '../src/contracts';
import {
  contentDisposition,
  createAttachmentStorage,
  sanitizeFileName,
  sniffMediaType,
} from '../src/domain/attachments';
import { pngBytes } from './helpers/attachments';

describe('sanitizeFileName', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\secret.txt', 'secret.txt'],
    ['/var/data/', 'file'],
    ['a/b\\c/d.png', 'd.png'],
    ['.hidden', 'hidden'],
    ['  spaced   out  .png ', 'spaced out .png'],
    ['name.', 'name'],
    ['', 'file'],
    ['..', 'file'],
    ['.', 'file'],
    ['\u0000\u0001\u001f', 'file'],
    ['bad\u0000name\r\n.png', 'badname.png'],
    ['fake\u202egnp.exe', 'fakegnp.exe'],
    ['zero\u2066width\u2069.txt', 'zerowidth.txt'],
    ['árvíztűrő tükörfúrógép.png', 'árvíztűrő tükörfúrógép.png'],
    ['e\u0301.png', '\u00e9.png'],
  ])('%j becomes %j', (raw, clean) => {
    expect(sanitizeFileName(raw)).toBe(clean);
  });

  it('accepts a missing name', () => {
    expect(sanitizeFileName(undefined)).toBe('file');
  });

  it('cuts a long name to the byte limit, keeping the extension and whole characters', () => {
    const long = `${'á'.repeat(300)}.png`;
    const clean = sanitizeFileName(long);
    expect(Buffer.byteLength(clean)).toBeLessThanOrEqual(MAX_ATTACHMENT_FILE_NAME_BYTES);
    expect(clean.endsWith('.png')).toBe(true);
    expect(clean).toMatch(/^á+\.png$/);
    const noExtension = sanitizeFileName('x'.repeat(1000));
    expect(Buffer.byteLength(noExtension)).toBe(MAX_ATTACHMENT_FILE_NAME_BYTES);
  });
});

describe('contentDisposition', () => {
  it('writes a plain fallback and the real name percent encoded', () => {
    expect(contentDisposition('attachment', 'report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
    expect(contentDisposition('inline', 'árvíz.png')).toBe(
      `inline; filename="_rv_z.png"; filename*=UTF-8''%C3%A1rv%C3%ADz.png`,
    );
  });

  it.each([
    'a"b.png',
    'a\\b.png',
    'a;b=c.png',
    'a%22b.png',
    "a'(b)*.png",
    'x"; filename="evil.html',
    'a\r\nSet-Cookie: x=1',
    'a\nb',
  ])('cannot be made to end the value or add a parameter: %j', (name) => {
    const value = contentDisposition('attachment', name);
    expect(value).not.toMatch(/[\r\n]/);
    const [head, fallback, extended, ...rest] = value.split('; ');
    expect(head).toBe('attachment');
    expect(rest).toEqual([]);
    expect(fallback).toMatch(/^filename="[^"\\%;]*"$/);
    expect(extended).toMatch(/^filename\*=UTF-8''[A-Za-z0-9%._~!$&+=@:-]*$/);
    expect(decodeURIComponent(extended!.slice("filename*=UTF-8''".length))).toBe(name);
  });
});

describe('sniffMediaType', () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);
  const text = (value: string) => new TextEncoder().encode(value);

  it.each([
    ['PNG', pngBytes(), 'image/png'],
    ['JPEG', bytes(0xff, 0xd8, 0xff, 0xdb), 'image/jpeg'],
    ['GIF87a', text('GIF87a......'), 'image/gif'],
    ['GIF89a', text('GIF89a......'), 'image/gif'],
    ['WebP', Buffer.concat([text('RIFF'), Buffer.alloc(4), text('WEBPVP8L')]), 'image/webp'],
    ['PDF', text('%PDF-1.4\n'), 'application/pdf'],
  ])('knows %s from its content', (_, head, type) => {
    expect(sniffMediaType(head)).toBe(type);
  });

  it.each([
    ['HTML', text('<!DOCTYPE html><html>')],
    ['HTML after a BOM', Buffer.concat([bytes(0xef, 0xbb, 0xbf), text('<html>')])],
    ['SVG', text('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['XML', text('<?xml version="1.0"?><svg/>')],
    ['JavaScript', text('alert(1)')],
    ['a PDF header that is not at the start', text(' %PDF-1.4')],
    ['a WAV file (RIFF, not WebP)', Buffer.concat([text('RIFF'), Buffer.alloc(4), text('WAVEfmt ')])],
    ['a cut PNG signature', pngBytes().subarray(0, 7)],
    ['a cut GIF header', text('GIF8')],
    ['nothing', new Uint8Array()],
    ['an executable', bytes(0x4d, 0x5a, 0x90, 0x00)],
    ['a ZIP', bytes(0x50, 0x4b, 0x03, 0x04)],
  ])('treats %s as unknown', (_, head) => {
    expect(sniffMediaType(head)).toBe('application/octet-stream');
  });
});

describe('attachment storage on disk', () => {
  let root: string;
  let outside: string;
  let storage: AttachmentStorage;
  const ref: AttachmentRef = { projectKey: 'AR', taskKey: 'AR-1', id: 'att_abcdef0123456789' };

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'pm-storage-'));
    root = join(base, 'attachments');
    outside = join(base, 'outside');
    mkdirSync(outside);
    storage = createAttachmentStorage(root);
  });
  afterEach(() => {
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  const write = async (target: AttachmentRef, content: Buffer | string) => {
    const writer = await storage.create(target);
    await pipeline(Readable.from([Buffer.from(content)]), writer.stream);
    await writer.publish();
  };
  const read = async (target: AttachmentRef, size: number) =>
    Buffer.concat(await (await storage.openRead(target, size)).toArray());

  it('stores a file privately under its keys and id, and reads it back', async () => {
    await write(ref, 'hello world');
    const file = join(root, 'AR', 'AR-1', ref.id);
    expect(readFileSync(file, 'utf8')).toBe('hello world');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const dir of [root, join(root, 'AR'), join(root, 'AR', 'AR-1')]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect((await read(ref, 11)).toString()).toBe('hello world');
    expect(readdirSync(join(root, 'AR', 'AR-1'))).toEqual([ref.id]);
  });

  it('shows no published file before publish, and nothing after a discard', async () => {
    const writer = await storage.create(ref);
    await pipeline(Readable.from([Buffer.from('half')]), writer.stream);
    expect(readdirSync(join(root, 'AR', 'AR-1'))).toEqual([`${ref.id}.part`]);
    await expect(storage.openRead(ref, 4)).rejects.toThrow();
    await writer.discard();
    expect(readdirSync(join(root, 'AR', 'AR-1'))).toEqual([]);
    await writer.discard();
  });

  it.each([
    [{ ...ref, id: '../../outside/evil' }],
    [{ ...ref, id: 'att_abcdef0123456789/../x' }],
    [{ ...ref, taskKey: '../../outside' }],
    [{ ...ref, taskKey: 'AR-1/..' }],
    [{ ...ref, projectKey: '..' }],
    [{ ...ref, projectKey: 'ar' }],
    [{ ...ref, id: 'not-an-id' }],
  ])('refuses a reference that is not made of keys and a generated id: %j', async (bad) => {
    await expect(storage.create(bad)).rejects.toThrow('unsafe');
    await expect(storage.openRead(bad, 1)).rejects.toThrow('unsafe');
    await expect(storage.remove(bad)).rejects.toThrow('unsafe');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('never writes through a symlinked directory', async () => {
    await write(ref, 'first');
    // The task's directory replaced by a link to somewhere else.
    rmSync(join(root, 'AR', 'AR-1'), { recursive: true });
    symlinkSync(outside, join(root, 'AR', 'AR-1'));
    await expect(storage.create({ ...ref, id: 'att_abcdef0123456780' })).rejects.toThrow('unsafe');
    await expect(storage.openRead(ref, 5)).rejects.toThrow('unsafe');
    expect(readdirSync(outside)).toEqual([]);
    // Likewise one level up.
    rmSync(join(root, 'AR'), { recursive: true });
    symlinkSync(outside, join(root, 'AR'));
    await expect(storage.create(ref)).rejects.toThrow('unsafe');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('never reads through a symlink in place of the file', async () => {
    await write(ref, 'real');
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'real'); // same size as the metadata says
    const file = join(root, 'AR', 'AR-1', ref.id);
    rmSync(file);
    symlinkSync(secret, file);
    await expect(storage.openRead(ref, 4)).rejects.toThrow();
    // Removing takes the link and leaves its target.
    await storage.remove(ref);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(secret, 'utf8')).toBe('real');
  });

  it('never creates a file through a symlink at the temporary name', async () => {
    mkdirSync(join(root, 'AR', 'AR-1'), { recursive: true });
    const target = join(outside, 'target.txt');
    writeFileSync(target, 'untouched');
    symlinkSync(target, join(root, 'AR', 'AR-1', `${ref.id}.part`));
    await expect(storage.create(ref)).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });

  it('reads only a regular file of the size on record', async () => {
    await write(ref, 'abcdef');
    await expect(storage.openRead(ref, 5)).rejects.toThrow('size');
    await expect(storage.openRead(ref, 7)).rejects.toThrow('size');
    const file = join(root, 'AR', 'AR-1', ref.id);
    rmSync(file);
    mkdirSync(file);
    await expect(storage.openRead(ref, 0)).rejects.toThrow();
  });

  it('removes a file and its temporary twin, and a missing one is fine', async () => {
    await write(ref, 'x');
    writeFileSync(join(root, 'AR', 'AR-1', `${ref.id}.part`), 'y');
    await storage.remove(ref);
    expect(readdirSync(join(root, 'AR', 'AR-1'))).toEqual([]);
    await storage.remove(ref);
    await storage.remove({ ...ref, taskKey: 'AR-7' });
    await storage.removeTemporary({ ...ref, taskKey: 'AR-7' });
  });

  it('lists regular files only and follows no link while scanning', async () => {
    await write(ref, 'x');
    writeFileSync(join(root, 'AR', 'AR-1', `${ref.id}.part`), 'y');
    symlinkSync(join(outside, 'nothing'), join(root, 'AR', 'AR-1', 'att_link000000001'));
    mkdirSync(join(root, 'AR', 'AR-1', 'att_dir0000000001'));
    mkdirSync(join(outside, 'AR-9'));
    writeFileSync(join(outside, 'AR-9', 'att_outside000001'), 'z');
    symlinkSync(outside, join(root, 'ZZ'));
    writeFileSync(join(root, 'notes.txt'), 'not an attachment');
    expect(
      (await storage.scan()).map((file) => `${file.projectKey}/${file.taskKey}/${file.name}`).sort(),
    ).toEqual([`AR/AR-1/${ref.id}`, `AR/AR-1/${ref.id}.part`]);
  });

  it('may live behind a link the owner set up for the whole root', async () => {
    const base = mkdtempSync(join(tmpdir(), 'pm-link-'));
    try {
      mkdirSync(join(base, 'disk'));
      symlinkSync(join(base, 'disk'), join(base, 'attachments'));
      const linked = createAttachmentStorage(join(base, 'attachments'));
      const writer = await linked.create(ref);
      await pipeline(Readable.from([Buffer.from('on another disk')]), writer.stream);
      await writer.publish();
      expect(readFileSync(join(base, 'disk', 'AR', 'AR-1', ref.id), 'utf8')).toBe('on another disk');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
