import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mergeTestPassedSteps } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const Cache = z.object({
  version: z.literal(1),
  entries: z.array(
    z.object({
      key: z.string().regex(/^[a-f0-9]{64}$/i),
      at: z.string().datetime({ offset: true }),
      runId: z.string(),
    }),
  ),
});
type Entry = z.infer<typeof Cache>['entries'][number];

async function readEntries(file: string): Promise<Entry[]> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  return Cache.parse(JSON.parse(content)).entries.filter((entry) => Date.parse(entry.at) >= cutoff);
}

/** Engine-owned cache: only its disposable key list is exposed to the sandbox (PM-845). */
export async function prepareStepCache(
  file: string | undefined,
  passedKeysFile: string,
  runId: string,
  logger: FastifyBaseLogger,
): Promise<{ passedKeysFile: string; record(output: string): Promise<void> } | undefined> {
  if (!file) return undefined;
  try {
    const entries = await readEntries(file);
    await writeFile(passedKeysFile, entries.map((entry) => entry.key).join('\n'), { mode: 0o400 });
  } catch (err) {
    logger.warn({ err, runId }, 'could not read the merge-test step cache; running without it');
    return undefined;
  }
  return {
    passedKeysFile,
    async record(output) {
      const keys = mergeTestPassedSteps(output);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        // Re-read after the run so entries another executor added meanwhile are retained.
        const entries = new Map((await readEntries(file)).map((entry) => [entry.key, entry]));
        const at = new Date(Date.now()).toISOString();
        for (const key of keys) entries.set(key, { key, at, runId });
        const newest = [...entries.values()]
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
          .slice(0, MAX_ENTRIES);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify({ version: 1, entries: newest }), {
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporary, file);
      } catch (err) {
        logger.warn({ err, runId }, 'could not write the merge-test step cache; ignoring it');
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    },
  };
}
