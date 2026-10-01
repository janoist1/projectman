import { execFile } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDirs } from '../test-helpers';
import { openConfined } from './confined';
import { readTranscript } from './reader';
import { TranscriptTailer } from './tailer';

/** Files a worker controls (PM-140): the server must not follow, block on or leave the home. */
const exec = promisify(execFile);
const dirs = tempDirs();
let home: string;
let outside: string;

beforeEach(async () => {
  home = await dirs.make('pm-confined-home-');
  outside = await dirs.make('pm-confined-outside-');
  await writeFile(path.join(outside, 'secret.jsonl'), '{"type":"user","message":"SECRET"}\n');
  await mkdir(path.join(home, 'projects'));
  await writeFile(path.join(home, 'projects', 'ok.jsonl'), '');
});
afterEach(() => dirs.cleanup());

describe('opening a file in a worker home', () => {
  it('opens a regular file inside the home', async () => {
    const handle = await openConfined(path.join(home, 'projects', 'ok.jsonl'), home);
    await handle.close();
  });

  it('refuses a symlink, a symlinked directory, a file outside and a directory', async () => {
    await symlink(path.join(outside, 'secret.jsonl'), path.join(home, 'link.jsonl'));
    await symlink(outside, path.join(home, 'escape'));
    for (const target of [
      path.join(home, 'link.jsonl'),
      path.join(home, 'escape', 'secret.jsonl'),
      path.join(outside, 'secret.jsonl'),
      path.join(home, 'projects'),
    ])
      await expect(openConfined(target, home), target).rejects.toThrow();
  });

  it('does not block on a named pipe', async () => {
    const fifo = path.join(home, 'projects', 'pipe.jsonl');
    await exec('mkfifo', [fifo]);
    const started = Date.now();
    await expect(openConfined(fifo, home)).rejects.toThrow(/regular file/);
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(readTranscript(fifo, { confineTo: home })).rejects.toThrow();
  });

  it('reads nothing through a directory swapped for a symlink later (tailer)', async () => {
    const dir = path.join(home, 'conv');
    await mkdir(dir);
    await writeFile(path.join(dir, 'secret.jsonl'), '');
    const lines: string[] = [];
    const tailer = new TranscriptTailer({
      path: path.join(dir, 'secret.jsonl'),
      from: 'start',
      onLines: (l) => lines.push(...l),
      confineTo: home,
      pollIntervalMs: 20,
    });
    await tailer.start();
    await exec('rm', ['-rf', dir]);
    await symlink(outside, dir);
    await tailer.poll();
    await new Promise((resolve) => setTimeout(resolve, 60));
    tailer.stop();
    expect(lines).toEqual([]);
  });
});
