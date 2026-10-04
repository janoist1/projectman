import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { pngBytes } from './helpers/attachments';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';

const toolError = (promise: Promise<unknown>) => rejection(promise, TeamToolError);

/** `attach_file` from the session folder (PM-268): the second place a file may come from. */
describe('attach_file from the session folder (PM-268)', () => {
  let h: DomainHarness;
  let dev: ToolContext;
  let cwd: string;
  let folder: string;

  beforeEach(async () => {
    h = await createDomainHarness({ sessionFolders: true });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Another task' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    dev = { sessionId: started.session!.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
    cwd = started.session!.cwd;
    folder = join(h.sessionFoldersDir!, started.session!.id);
    mkdirSync(join(folder, 'shots', 'x'), { recursive: true });
    writeFileSync(join(folder, 'shots', 'x', '1512.png'), pngBytes(300));
  });
  afterEach(() => h.cleanup());

  const stored = () => h.repos.attachments.listReady('AR', 'AR-1');

  it('attaches a file of the folder by its absolute path, from a subfolder too', async () => {
    const { attachment } = await h.domain.teamTools.attachFile(dev, {
      taskKey: 'AR-1',
      path: join(folder, 'shots', 'x', '1512.png'),
    });
    expect(attachment).toMatchObject({
      fileName: '1512.png',
      size: 300,
      mediaType: 'image/png',
      uploadedBy: { kind: 'ai', handle: 'dev-1' },
    });
    expect(stored()).toHaveLength(1);
  });

  it('still attaches a relative path from the working directory', async () => {
    mkdirSync(join(cwd, 'shots'), { recursive: true });
    writeFileSync(join(cwd, 'shots', 'after.png'), pngBytes(120));
    const { attachment } = await h.domain.teamTools.attachFile(dev, {
      taskKey: 'AR-1',
      path: 'shots/after.png',
    });
    expect(attachment.fileName).toBe('after.png');
  });

  it('reads a relative path from the working directory, never from the folder', async () => {
    const err = await toolError(
      h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path: 'shots/x/1512.png' }),
    );
    expect(err.code).toBe('invalid');
    expect(stored()).toEqual([]);
  });

  it('refuses a path outside both places, and names both', async () => {
    const elsewhere = join(h.dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'secret.txt'), 'not for the task');
    // Beside the folder with a name that starts like it.
    mkdirSync(`${folder}-copy`);
    writeFileSync(join(`${folder}-copy`, 'secret.txt'), 'not for the task');
    for (const path of [join(elsewhere, 'secret.txt'), join(`${folder}-copy`, 'secret.txt')]) {
      const err = await toolError(h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path }));
      expect(err.code, path).toBe('forbidden');
      expect(err.message).toContain('your working directory');
      expect(err.message).toContain('your session folder');
      expect(err.message).toContain(folder);
    }
    // A path that climbs out of the folder.
    const climb = await toolError(
      h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path: join(folder, '..', 'x', 'y.png') }),
    );
    expect(climb.code).toBe('forbidden');
    expect(stored()).toEqual([]);
  });

  it('refuses the folder of another session', async () => {
    const other = join(h.sessionFoldersDir!, 'ses_other');
    mkdirSync(other);
    writeFileSync(join(other, 'theirs.png'), pngBytes(120));
    const err = await toolError(
      h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path: join(other, 'theirs.png') }),
    );
    expect(err.code).toBe('forbidden');
    expect(stored()).toEqual([]);
  });

  it('refuses a symbolic link, a hard link and a directory inside the folder', async () => {
    const elsewhere = join(h.dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'secret.txt'), 'not for the task');
    symlinkSync(join(elsewhere, 'secret.txt'), join(folder, 'soft.txt'));
    linkSync(join(elsewhere, 'secret.txt'), join(folder, 'hard.txt'));
    const soft = await toolError(
      h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path: join(folder, 'soft.txt') }),
    );
    expect(soft.message).toContain('symbolic link');
    const hard = await toolError(
      h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path: join(folder, 'hard.txt') }),
    );
    expect(hard.code).toBe('invalid');
    const directory = await toolError(
      h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path: join(folder, 'shots') }),
    );
    expect(directory.message).toContain('is a directory');
    expect(stored()).toEqual([]);
  });

  it('has no folder when the folder itself was replaced by a link', async () => {
    // The sandbox cannot do this (it does not write the root); the server still does not follow it.
    const elsewhere = join(h.dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'secret.png'), pngBytes(120));
    rmSync(folder, { recursive: true, force: true });
    symlinkSync(elsewhere, folder);
    const err = await toolError(
      h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path: join(folder, 'secret.png') }),
    );
    expect(err.code).toBe('forbidden');
    expect(stored()).toEqual([]);
  });

  it('has no folder to attach from once it is gone', async () => {
    const path = join(folder, 'shots', 'x', '1512.png');
    rmSync(folder, { recursive: true, force: true });
    const err = await toolError(h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path }));
    expect(err.code).toBe('forbidden');
    expect(stored()).toEqual([]);
  });
});

describe('attach_file without session folders (PM-268)', () => {
  let h: DomainHarness;
  afterEach(() => h.cleanup());

  it('keeps the old refusal, naming only the working directory', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    const dev = { sessionId: started.session!.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
    const err = await toolError(
      h.domain.teamTools.attachFile(dev, { taskKey: 'AR-1', path: join(h.dir, 'x.png') }),
    );
    expect(err.code).toBe('forbidden');
    expect(err.message).toContain('not inside your working directory');
    expect(err.message).not.toContain('session folder');
  });
});
