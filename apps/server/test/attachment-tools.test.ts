import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES } from '@projectman/shared';
import type { Attachment } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { pngBytes } from './helpers/attachments';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';

const toolError = (promise: Promise<unknown>) => rejection(promise, TeamToolError);

/**
 * The attachment team tools over the real domain and storage: what an AI member reads, attaches
 * and deletes, in whose name, from which directory, and what the server refuses.
 */
describe('attachment team tools', () => {
  let h: DomainHarness;
  /** dev-1 working on AR-1 in its worktree. */
  let dev: ToolContext;
  let cwd: string;

  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Another task' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    dev = { sessionId: started.session!.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
    cwd = started.session!.cwd;
    mkdirSync(join(cwd, 'shots'), { recursive: true });
    writeFileSync(join(cwd, 'shots', 'after.png'), pngBytes(300));
  });
  afterEach(() => h.cleanup());

  const ownerUpload = (taskKey = 'AR-1', fileName = 'before.png'): Promise<Attachment> =>
    h.domain.attachments.upload({
      projectKey: 'AR',
      taskKey,
      actor: OWNER_ACTOR,
      fileName,
      content: Readable.from([pngBytes(120)]),
    });
  const stored = (taskKey = 'AR-1') => h.repos.attachments.listReady('AR', taskKey);
  const events = (type: string) =>
    h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((event) => event.type === type);

  describe('attach_file', () => {
    it('attaches a file of the session directory in the calling AI member’s name', async () => {
      const { attachment } = await h.domain.teamTools.attachFile(dev, {
        taskKey: 'AR-1',
        path: 'shots/after.png',
      });
      expect(attachment).toMatchObject({
        fileName: 'after.png',
        size: 300,
        mediaType: 'image/png',
        uploadedBy: { kind: 'ai', handle: 'dev-1' },
      });
      // The audit names the AI member, never its sponsor.
      expect(events('attachment_added')).toMatchObject([
        { actor: { kind: 'ai', handle: 'dev-1' }, data: { fileName: 'after.png', size: 300 } },
      ]);
      // An absolute path inside the directory works too, for another task of the project.
      const other = await h.domain.teamTools.attachFile(dev, {
        taskKey: 'AR-2',
        path: join(cwd, 'shots', 'after.png'),
      });
      expect(other.attachment.taskKey).toBe('AR-2');
    });

    it('refuses files outside the session directory, links and directories, and stores nothing', async () => {
      const elsewhere = join(h.dir, 'elsewhere');
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, 'secret.txt'), 'not for the task');
      symlinkSync(join(elsewhere, 'secret.txt'), join(cwd, 'secret.txt'));
      // Next to the worktree, with a name that starts like it.
      mkdirSync(`${cwd}-copy`);
      writeFileSync(join(`${cwd}-copy`, 'secret.txt'), 'not for the task');

      for (const path of [
        '../../secret.txt',
        join(elsewhere, 'secret.txt'),
        join(`${cwd}-copy`, 'secret.txt'),
      ]) {
        const err = await toolError(h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path }));
        expect(err.code, path).toBe('forbidden');
        expect(err.message).toContain('not inside your working directory');
      }
      const link = await toolError(
        h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path: 'secret.txt' }),
      );
      expect(link).toMatchObject({ code: 'invalid' });
      expect(link.message).toContain('symbolic link');
      const directory = await toolError(
        h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path: 'shots' }),
      );
      expect(directory.message).toContain('is a directory');
      expect(stored()).toEqual([]);
      expect(events('attachment_added')).toEqual([]);
    });

    // The limit is 25 MB, so this test copies and checksums a file of that size: with the suite
    // running in parallel that is I/O bound and needs more than the default 5 s.
    it(
      'takes exactly the limit and refuses one byte more with a clear error, leaving nothing behind',
      { timeout: 30_000 },
      async () => {
        // Sparse files: only their size matters here, and nothing is written for the zeros.
        writeFileSync(join(cwd, 'exact.bin'), '');
        truncateSync(join(cwd, 'exact.bin'), MAX_ATTACHMENT_BYTES);
        writeFileSync(join(cwd, 'over.bin'), '');
        truncateSync(join(cwd, 'over.bin'), MAX_ATTACHMENT_BYTES + 1);
        const { attachment } = await h.domain.teamTools.attachFile(dev, {
          taskKey: 'AR-1',
          path: 'exact.bin',
        });
        expect(attachment.size).toBe(MAX_ATTACHMENT_BYTES);

        const err = await toolError(
          h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path: 'over.bin' }),
        );
        expect(err.code).toBe('invalid');
        expect(err.message).toBe(
          `over.bin is ${MAX_ATTACHMENT_BYTES + 1} bytes; an attachment is at most ${MAX_ATTACHMENT_BYTES} bytes. Nothing was attached.`,
        );
        expect(stored().map((a) => a.id)).toEqual([attachment.id]);
        expect(h.repos.attachments.inState('pending')).toEqual([]);
      },
    );

    it('refuses a file that changes while it is attached, and keeps no half attachment', async () => {
      await h.cleanup();
      let grow: (() => void) | undefined;
      h = await createDomainHarness({
        attachmentStorage: (inner) => ({
          openRead: (ref, size) => inner.openRead(ref, size),
          createThumbnail: (ref) => inner.createThumbnail(ref),
          openThumbnail: (ref) => inner.openThumbnail(ref),
          locate: (ref, size, mediaType) => inner.locate(ref, size, mediaType),
          taskDirectory: (projectKey, taskKey) => inner.taskDirectory(projectKey, taskKey),
          remove: (ref) => inner.remove(ref),
          removeTemporary: (ref) => inner.removeTemporary(ref),
          scan: () => inner.scan(),
          async create(ref) {
            const writer = await inner.create(ref);
            grow?.();
            return writer;
          },
        }),
      });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
      const session = started.session!;
      writeFileSync(join(session.cwd, 'log.txt'), 'first lines\n');
      grow = () => appendFileSync(join(session.cwd, 'log.txt'), 'a line written meanwhile\n');

      const err = await toolError(
        h.domain.teamTools.attachFile(
          { sessionId: session.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' },
          { taskKey: 'AR-1', path: 'log.txt' },
        ),
      );
      expect(err.code).toBe('invalid');
      expect(err.message).toBe(
        'log.txt changed while it was read; try again once it is complete. Nothing was attached.',
      );
      expect(stored()).toEqual([]);
      expect(h.repos.attachments.inState('pending')).toEqual([]);
      expect(await h.attachmentStorage.scan()).toEqual([]);
      expect(events('attachment_added')).toEqual([]);
    });

    it('works only from the directory the server recorded for the calling session', async () => {
      // A token of dev-1's session presented for another member, or for an unknown session.
      for (const ctx of [
        { ...dev, member: 'cr' },
        { ...dev, sessionId: 'ses_unknown' },
      ]) {
        const err = await toolError(
          h.domain.teamTools.attachFile(ctx, { taskKey: 'AR-1', path: 'shots/after.png' }),
        );
        expect(err.code).toBe('forbidden');
      }
      expect(stored()).toEqual([]);
    });

    it('refuses a task of another project and an unknown task', async () => {
      const workspace = join(h.dir, 'beta');
      mkdirSync(workspace);
      await h.domain.projects.create(
        { key: 'BX', name: 'beta', workspacePath: workspace, templateId: 'test' },
        OWNER,
      );
      await h.domain.tasks.create('BX', { title: 'Beta task' }, OWNER_ACTOR);
      for (const taskKey of ['BX-1', 'AR-99']) {
        const err = await toolError(h.domain.teamTools.attachFile(dev, { taskKey, path: 'shots/after.png' }));
        expect(err.code, taskKey).toBe('not_found');
      }
      expect(h.repos.attachments.listReady('BX', 'BX-1')).toEqual([]);
    });
  });

  describe('read_attachment', () => {
    it('gives the path of the stored file after the access check, without its content', async () => {
      const before = await ownerUpload();
      const located = await h.domain.teamTools.readAttachment(dev, {
        taskKey: 'AR-1',
        attachmentId: before.id,
      });
      expect(located.attachment).toMatchObject({
        id: before.id,
        fileName: 'before.png',
        mediaType: 'image/png',
      });
      const dir = await h.attachmentStorage.taskDirectory('AR', 'AR-1');
      // The readers of the agents tell an image by the extension: the path has it.
      expect(located.path).toBe(join(dir, `${before.id}.png`));
      expect(readFileSync(located.path)).toEqual(pngBytes(120));
      expect(located.readableWithoutAsking).toBe(true);
      const again = await h.domain.teamTools.readAttachment(dev, {
        taskKey: 'AR-1',
        attachmentId: before.id,
      });
      expect(again.path).toBe(located.path);

      // A file of an unknown type keeps its plain name.
      const notes = await h.domain.attachments.upload({
        projectKey: 'AR',
        taskKey: 'AR-1',
        actor: OWNER_ACTOR,
        fileName: 'notes.txt',
        content: Readable.from([Buffer.from('plain notes')]),
      });
      const plain = await h.domain.teamTools.readAttachment(dev, { taskKey: 'AR-1', attachmentId: notes.id });
      expect(plain.path).toBe(join(dir, notes.id));

      // Another task's file: the session has no read rule for that directory.
      const elsewhere = await ownerUpload('AR-2');
      const other = await h.domain.teamTools.readAttachment(dev, {
        taskKey: 'AR-2',
        attachmentId: elsewhere.id,
      });
      expect(other.readableWithoutAsking).toBe(false);
    });

    it('removes the extension view with the file, and a view left behind at the next start', async () => {
      await h.cleanup();
      h = await createDomainHarness({ persistent: true });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
      const ctx = { sessionId: started.session!.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
      const first = await ownerUpload();
      const second = await ownerUpload();
      for (const a of [first, second])
        await h.domain.teamTools.readAttachment(ctx, { taskKey: 'AR-1', attachmentId: a.id });
      const files = () => readdirSync(join(h.attachmentsDir, 'AR', 'AR-1')).sort();
      expect(files()).toEqual([first.id, `${first.id}.png`, second.id, `${second.id}.png`].sort());

      await h.domain.attachments.delete('AR', 'AR-1', first.id, OWNER_ACTOR);
      expect(files()).toEqual([second.id, `${second.id}.png`]);

      // The row went away while its view stayed (as after a crash): the next start removes the view.
      h.repos.attachments.remove(second.id);
      unlinkSync(join(h.attachmentsDir, 'AR', 'AR-1', second.id));
      h = await restartDomainHarness(h);
      expect(files()).toEqual([]);
    });

    it('refuses an attachment of another task, an unknown one, a deleted one and an invalid id', async () => {
      const before = await ownerUpload();
      const wrongTask = await toolError(
        h.domain.teamTools.readAttachment(dev, { taskKey: 'AR-2', attachmentId: before.id }),
      );
      expect(wrongTask).toMatchObject({ code: 'not_found' });
      expect(wrongTask.message).toContain('list_attachments');
      await h.domain.attachments.delete('AR', 'AR-1', before.id, OWNER_ACTOR);
      expect(
        (
          await toolError(
            h.domain.teamTools.readAttachment(dev, { taskKey: 'AR-1', attachmentId: before.id }),
          )
        ).code,
      ).toBe('not_found');
      expect(
        (
          await toolError(
            h.domain.teamTools.readAttachment(dev, { taskKey: 'AR-1', attachmentId: '../db.sqlite' }),
          )
        ).code,
      ).toBe('invalid');
    });
  });

  describe('delete_attachment', () => {
    it('deletes the caller’s own attachment under the REST rule, and refuses the others’', async () => {
      const own = (await h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path: 'shots/after.png' }))
        .attachment;
      const owners = await ownerUpload();

      const refused = await toolError(
        h.domain.teamTools.deleteAttachment(dev, { taskKey: 'AR-1', attachmentId: owners.id }),
      );
      expect(refused.code).toBe('forbidden');
      expect(refused.message).toContain('only the attachments you attached yourself');
      // Another AI member cannot delete dev-1's file either.
      const reviewer = { ...dev, member: 'cr', sessionId: 'ses_cr' };
      expect(
        (
          await toolError(
            h.domain.teamTools.deleteAttachment(reviewer, { taskKey: 'AR-1', attachmentId: own.id }),
          )
        ).code,
      ).toBe('forbidden');

      expect(
        await h.domain.teamTools.deleteAttachment(dev, { taskKey: 'AR-1', attachmentId: own.id }),
      ).toEqual({
        attachmentId: own.id,
        fileName: 'after.png',
      });
      expect(stored().map((a) => a.id)).toEqual([owners.id]);
      expect(events('attachment_deleted')).toMatchObject([
        { actor: { kind: 'ai', handle: 'dev-1' }, data: { attachmentId: own.id } },
      ]);
    });
  });

  describe('listing', () => {
    it('get_task shows the first attachments and the total; list_attachments pages the rest', async () => {
      const uploaded: Attachment[] = [];
      for (let i = 0; i < 23; i++) uploaded.push(await ownerUpload('AR-1', `shot-${i}.png`));

      const detail = await h.domain.teamTools.getTask(dev, { taskKey: 'AR-1' });
      expect(detail.attachments).toMatchObject({ total: 23, offset: 0 });
      expect(detail.attachments!.attachments.map((a) => a.fileName)).toEqual(
        uploaded.slice(0, 20).map((a) => a.fileName),
      );
      const rest = await h.domain.teamTools.listAttachments(dev, { taskKey: 'AR-1', offset: 20 });
      expect(rest).toMatchObject({ total: 23, offset: 20 });
      expect(rest.attachments.map((a) => a.id)).toEqual(uploaded.slice(20).map((a) => a.id));
      expect(
        (await toolError(h.domain.teamTools.listAttachments(dev, { taskKey: 'AR-1', limit: 0 }))).code,
      ).toBe('invalid');
    });
  });

  describe('sessions', () => {
    it('lets a new and a resumed task session read its own task’s attachment directory only, never write it', async () => {
      await ownerUpload();
      const dir = await h.attachmentStorage.taskDirectory('AR', 'AR-1');
      const first = h.runner.lastStarted();
      expect(first.allowedTools).toContain(`Read(/${dir}/**)`);
      expect(first.deniedTools).toContain(`Edit(/${dir}/**)`);
      // Not the storage root, not the server's home, not another task; never a working directory.
      const named = [...first.allowedTools, ...(first.deniedTools ?? [])].filter((rule) =>
        rule.includes(h.dir),
      );
      expect(named).toEqual([`Read(/${dir}/**)`, `Edit(/${dir}/**)`]);
      expect(first.writableRoots).toBeUndefined();
      expect(first.additionalDirectories).toBeUndefined();

      // The session ends and resumes: the rules are given again, and the brief input lists the file.
      h.runner.emit({
        type: 'transcript_path',
        sessionId: dev.sessionId,
        path: join(h.dir, 'transcript.jsonl'),
      });
      h.runner.emit({ type: 'exit', sessionId: dev.sessionId, exitCode: 0, signal: null });
      const resumed = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' });
      expect(resumed.resumed).toBe(true);
      expect(h.runner.lastStarted()).toMatchObject({
        resume: true,
        allowedTools: expect.arrayContaining([`Read(/${dir}/**)`]),
        deniedTools: expect.arrayContaining([`Edit(/${dir}/**)`]),
      });
      expect(h.contextBuilder.inputs.at(-1)!.attachments?.map((a) => a.fileName)).toEqual(['before.png']);
    });

    it('gives a subtask session the parent card’s attachments for its brief, when it has any (PM-228)', async () => {
      const parent = await h.domain.tasks.create('AR', { title: 'Parent' }, OWNER_ACTOR);
      const child = await h.domain.tasks.create('AR', { title: 'Child', parentKey: parent.key }, OWNER_ACTOR);
      const emptyParent = await h.domain.tasks.create('AR', { title: 'Empty parent' }, OWNER_ACTOR);
      const orphanChild = await h.domain.tasks.create(
        'AR',
        { title: 'Child of empty', parentKey: emptyParent.key },
        OWNER_ACTOR,
      );
      const shot = await ownerUpload(parent.key, 'parent-shot.png');
      const lastInput = () => h.contextBuilder.inputs.at(-1)!;

      await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: child.key });
      expect(lastInput().task?.key).toBe(child.key);
      // The session reads the parent's directory (and its own) without asking, and never edits it.
      const parentDir = await h.attachmentStorage.taskDirectory('AR', parent.key);
      const childDir = await h.attachmentStorage.taskDirectory('AR', child.key);
      const started = h.runner.lastStarted();
      expect(started.allowedTools).toEqual(
        expect.arrayContaining([`Read(/${parentDir}/**)`, `Read(/${childDir}/**)`]),
      );
      expect(started.deniedTools).toEqual(
        expect.arrayContaining([`Edit(/${parentDir}/**)`, `Edit(/${childDir}/**)`]),
      );
      const childSession = {
        sessionId: started.sessionId,
        projectKey: 'AR',
        member: 'dev-1',
        taskKey: child.key,
      };
      const parentFile = await h.domain.teamTools.readAttachment(childSession, {
        taskKey: parent.key,
        attachmentId: shot.id,
      });
      expect(parentFile.readableWithoutAsking).toBe(true);
      // A read-only command on the parent's file needs no human either.
      expect(
        await h.runnerModule.broker().decide(
          {
            sessionId: childSession.sessionId,
            toolName: 'Bash',
            toolInput: { command: `file ${parentFile.path}` },
            raw: {},
          },
          new AbortController().signal,
        ),
      ).toEqual({ behavior: 'allow' });
      // Not another card's: AR-1 is neither the child nor its parent.
      const elsewhere = await ownerUpload('AR-1', 'elsewhere.png');
      const other = await h.domain.teamTools.readAttachment(childSession, {
        taskKey: 'AR-1',
        attachmentId: elsewhere.id,
      });
      expect(other.readableWithoutAsking).toBe(false);
      expect(lastInput().parentAttachments).toMatchObject({ taskKey: parent.key });
      expect(lastInput().parentAttachments?.attachments.map((a) => a.fileName)).toEqual(['parent-shot.png']);
      expect(lastInput().attachments).toBeUndefined();

      // A parent without files is not named.
      await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: orphanChild.key });
      expect(lastInput().task?.key).toBe(orphanChild.key);
      expect(lastInput().parentAttachments).toBeUndefined();

      // A card without a parent has no such line.
      expect(h.contextBuilder.inputs[0]!.task?.key).toBe('AR-1');
      expect(h.contextBuilder.inputs[0]!.parentAttachments).toBeUndefined();
    });

    it('allows read-only commands in the task’s attachment directory, not in another task’s', async () => {
      const before = await ownerUpload();
      const elsewhere = await ownerUpload('AR-2');
      const located = await h.domain.teamTools.readAttachment(dev, {
        taskKey: 'AR-1',
        attachmentId: before.id,
      });
      const otherPath = (
        await h.domain.teamTools.readAttachment(dev, { taskKey: 'AR-2', attachmentId: elsewhere.id })
      ).path;
      const decide = (command: string) =>
        h.runnerModule
          .broker()
          .decide(
            { sessionId: dev.sessionId, toolName: 'Bash', toolInput: { command }, raw: {} },
            new AbortController().signal,
          );
      expect(await decide(`file ${located.path}`)).toEqual({ behavior: 'allow' });
      const asked = decide(`file ${otherPath}`);
      await expect.poll(() => h.domain.inbox.list('AR', { state: 'open' }).length).toBe(1);
      const item = h.domain.inbox.list('AR', { state: 'open' })[0]!;
      await h.domain.inbox.resolve('AR', item.id, { optionId: 'deny' }, { handle: 'owner', access: 'owner' });
      expect(await asked).toMatchObject({ behavior: 'deny' });
    });
  });
});
