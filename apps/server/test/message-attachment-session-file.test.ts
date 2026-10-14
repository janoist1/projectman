import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_MCP_IMAGE_RESULTS } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { sessionFileName } from '../src/core/attachments';
import { pdfBytes } from './helpers/attachments';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/** The file of a message reaches the reader's session folder (PM-518). */
describe('message attachment in the session folder (PM-518)', () => {
  let h: DomainHarness;
  let dev: ToolContext;
  let folder: string;

  beforeEach(async () => {
    h = await createDomainHarness({ sessionFolders: true });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    dev = { sessionId: started.session!.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
    folder = h.runner.lastStarted().sandbox!.env!.PROJECTMAN_SESSION_DIR!;
  });
  afterEach(() => h.cleanup());

  const sendFile = async (content: Buffer, fileName: string, to = 'dev-1') => {
    const file = await h.domain.messageAttachments.upload({
      projectKey: 'AR',
      actor: OWNER_ACTOR,
      fileName,
      content: Readable.from([content]),
    });
    await h.domain.messaging.send(
      'AR',
      'owner',
      { to: [to], text: 'See the file.', taskKey: null, attachmentIds: [file.id] },
      { actor: OWNER_ACTOR },
    );
    return file;
  };
  const read = (id: string, ctx = dev) => h.domain.teamTools.readMessageAttachment(ctx, { attachmentId: id });
  const realPng = () =>
    sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366ff' } })
      .png()
      .toBuffer();
  const setProvider = (provider: 'claude' | 'codex' | 'gemini' | 'nanogpt') =>
    h.repos.sessions.update(dev.sessionId, { provider });

  it('copies a file the content cannot show into the caller’s session folder, private and byte for byte', async () => {
    const bytes = pdfBytes();
    const file = await sendFile(bytes, 'plan.pdf');
    const reading = await read(file.id);

    expect(reading.content).toEqual({ kind: 'none', reason: 'type' });
    const expected = join(folder, `${file.id}-plan.pdf`);
    expect(reading.file).toEqual({ path: expected });
    expect(readFileSync(expected).equals(bytes)).toBe(true);
    expect(lstatSync(expected).mode & 0o777).toBe(0o600);
  });

  it('gives the same path for the same file when it is read again', async () => {
    const file = await sendFile(pdfBytes(), 'plan.pdf');
    const first = await read(file.id);
    const second = await read(file.id);
    expect(second.file).toEqual(first.file);
    expect(readdirSync(folder).filter((entry) => entry.startsWith('msa_'))).toEqual([`${file.id}-plan.pdf`]);
  });

  it('does not hand a text or an image the claude way a file: the content shows it', async () => {
    const text = await sendFile(Buffer.from('a short note'), 'note.txt');
    const image = await sendFile(await realPng(), 'shot.png');
    expect((await read(text.id)).file).toBeUndefined();
    const reading = await read(image.id);
    expect(reading.content.kind).toBe('image');
    expect(reading.file).toBeUndefined();
    expect(readdirSync(folder).filter((entry) => entry.startsWith('msa_'))).toEqual([]);
  });

  it('puts an image into the folder for a provider whose CLI does not show MCP images', async () => {
    const png = await realPng();
    const image = await sendFile(png, 'shot.png');
    setProvider('gemini');
    const reading = await read(image.id);
    expect(reading.content).toEqual({ kind: 'none', reason: 'type' });
    expect(readFileSync(reading.file!.path).equals(png)).toBe(true);

    setProvider('codex');
    expect((await read(image.id)).content.kind).toBe('image');
  });

  it('writes into the caller’s own folder only, never into another session’s', async () => {
    await h.domain.tasks.create('AR', { title: 'Another' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-2', {
      actor: OWNER_ACTOR,
      author: OWNER,
      assignee: 'dev-2',
    });
    const otherFolder = h.runner.lastStarted().sandbox!.env!.PROJECTMAN_SESSION_DIR!;
    expect(otherFolder).not.toBe(folder);
    const file = await sendFile(pdfBytes(), 'plan.pdf');

    const reading = await read(file.id);
    expect(reading.file!.path.startsWith(`${folder}/`)).toBe(true);
    expect(readdirSync(otherFolder).filter((entry) => entry.startsWith('msa_'))).toEqual([]);
    expect(started.session!.id).not.toBe(dev.sessionId);
  });

  it('returns the reading without a file when the session has no folder of its own', async () => {
    const file = await sendFile(pdfBytes(), 'plan.pdf');
    rmSync(folder, { recursive: true, force: true });
    h.repos.sessions.update(dev.sessionId, { endedAt: new Date().toISOString(), state: 'exited' });
    const reading = await read(file.id);
    expect(reading.content).toEqual({ kind: 'none', reason: 'type' });
    expect(reading.file).toBeUndefined();
  });

  it('refuses a session that is not the caller’s, whatever the context says', async () => {
    const file = await sendFile(pdfBytes(), 'plan.pdf');
    const reading = await read(file.id, { ...dev, member: 'dev-2' }).catch((err: unknown) => err);
    // dev-2 is not a recipient of the message: not found, and nothing written.
    expect(reading).toMatchObject({ code: 'not_found' });
    expect(readdirSync(folder).filter((entry) => entry.startsWith('msa_'))).toEqual([]);
  });

  it('keeps the file and writes nothing through a link the agent put at its name', async () => {
    const file = await sendFile(pdfBytes(), 'plan.pdf');
    const elsewhere = join(h.dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(folder, `${file.id}-plan.pdf`));
    const reading = await read(file.id);
    expect(reading.file).toEqual({ path: join(folder, `${file.id}-plan.pdf`) });
    expect(lstatSync(reading.file!.path).isFile()).toBe(true);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('replaces a file of the same name that holds other bytes', async () => {
    const bytes = pdfBytes();
    const file = await sendFile(bytes, 'plan.pdf');
    const stale = join(folder, `${file.id}-plan.pdf`);
    writeFileSync(stale, 'something else');
    const reading = await read(file.id);
    expect(reading.file).toEqual({ path: stale });
    expect(readFileSync(stale).equals(bytes)).toBe(true);
  });

  describe('the name in the folder', () => {
    it('is the id and the name, with the separators replaced', () => {
      expect(sessionFileName('msa_abc', 'a/b\\c.pdf')).toBe('msa_abc-a_b_c.pdf');
    });

    it('is cut to the file name limit, keeping the extension', () => {
      const name = sessionFileName('msa_abc', `${'é'.repeat(300)}.pdf`);
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
      expect(name.endsWith('.pdf')).toBe(true);
      expect(name.startsWith('msa_abc-é')).toBe(true);
    });

    it('is cut without an extension too', () => {
      const name = sessionFileName('msa_abc', 'x'.repeat(400));
      expect(Buffer.byteLength(name)).toBe(255);
    });
  });
});

describe('which providers show an image in a tool result (PM-518)', () => {
  it('lists claude and codex, and not gemini or nanogpt', () => {
    expect(PROVIDER_MCP_IMAGE_RESULTS).toEqual({
      claude: true,
      codex: true,
      gemini: false,
      nanogpt: false,
    });
  });
});
