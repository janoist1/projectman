import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_CHANGE_MAX_WAIT_MS, ProjectChangeEventsResponse, routes } from '@projectman/shared';
import { ApiError } from './http';
import { ClientFileError, writeFileAtomic } from './files';
import { type CommandContext, UsageError } from './context';

const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** A write to standard output that did not complete: the consumer is gone. */
class OutputClosedError extends Error {}

function write(ctx: CommandContext, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.io.stdout.write(line, (error) =>
      error ? reject(new OutputClosedError('standard output is closed')) : resolve(),
    );
  });
}

/**
 * The cursor file holds a cursor and nothing secret. It is read as it is (an empty or missing file starts at the
 * beginning of the journal); the server judges the cursor, so an expired or foreign one is the server's refusal.
 */
function readCursorFile(file: string, credentialFiles: readonly string[]): string | undefined {
  const resolved = path.resolve(file);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    /* a first run: no file yet */
  }
  if (stat?.isSymbolicLink()) throw new UsageError('the cursor file is a symbolic link');
  if (stat && !stat.isFile()) throw new UsageError('the cursor file is not a regular file');
  if (stat && stat.size > 4096) throw new UsageError('the cursor file is too large');
  const real = stat ? fs.realpathSync(resolved) : resolved;
  if (credentialFiles.includes(real)) throw new UsageError('the cursor file is a credential file');
  if (!stat) return undefined;
  const text = fs.readFileSync(resolved, 'utf8').trim();
  return text === '' ? undefined : text;
}

/**
 * `events follow`: long-polls the project's journal and prints each event as one line. The cursor file moves on
 * only behind an event that was written out completely, so an interrupted consumer sees that event again on the
 * next run (the cursor of each line lets it drop a repeat). A network failure is retried with a growing pause;
 * an authentication failure or a refusal (an expired cursor too) ends the command.
 */
export async function followEvents(
  ctx: CommandContext,
  options: { project: string; cursor: string | undefined; cursorFile: string | undefined },
): Promise<number> {
  let cursor = options.cursor;
  if (options.cursorFile !== undefined) {
    try {
      const stored = readCursorFile(options.cursorFile, ctx.credentials.credentialFiles);
      cursor = options.cursor ?? stored;
    } catch (error) {
      if (error instanceof ClientFileError) throw new UsageError(error.message);
      throw error;
    }
  }
  const { signal } = ctx.io;
  let pause = RETRY_FIRST_MS;
  while (!signal.aborted) {
    let page: ProjectChangeEventsResponse;
    try {
      const search = new URLSearchParams({ waitMs: String(PROJECT_CHANGE_MAX_WAIT_MS) });
      if (cursor !== undefined) search.set('after', cursor);
      const response = await ctx.api.send({
        method: 'GET',
        path: `${routes.projectEvents(options.project)}?${search.toString()}`,
        write: false,
        signal,
      });
      page = ProjectChangeEventsResponse.parse(response.json);
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof ApiError && error.kind === 'network') {
        ctx.note(`${error.message}; trying again in ${Math.round(pause / 1000)} s`);
        await ctx.io.delay(pause, signal);
        pause = Math.min(pause * 2, RETRY_MAX_MS);
        continue;
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError('protocol', 'unexpected_response', 'the server answered in an unexpected shape');
    }
    pause = RETRY_FIRST_MS;
    for (const event of page.events) {
      const line = ctx.json
        ? JSON.stringify(event)
        : `${event.at} ${event.kind} ${event.entityId ?? '-'} ${event.cursor}`;
      await write(ctx, `${line}\n`);
      cursor = event.cursor;
      if (options.cursorFile !== undefined) writeFileAtomic(path.resolve(options.cursorFile), `${cursor}\n`);
    }
  }
  return 0;
}

export { OutputClosedError };
