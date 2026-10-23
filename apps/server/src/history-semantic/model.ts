import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** The embedding model of the history search and the shape of its vectors (PM-767). */
export const EMBEDDING_DIMENSION = 384;
/** A chunk is at most this many tokens, the prefix and the special tokens included. */
export const CHUNK_TOKENS = 256;
/** The end of a chunk that the next one starts with, in tokens. */
export const CHUNK_OVERLAP_TOKENS = 32;
/** e5 models want these prefixes: a stored text is a passage, a question is a query. */
export const PASSAGE_PREFIX = 'passage: ';
export const QUERY_PREFIX = 'query: ';

const ModelManifest = z.object({
  modelId: z.string().min(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: z.number().int().positive(),
      }),
    )
    .min(1),
});
export type ModelManifest = z.infer<typeof ModelManifest>;

class ModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailable';
  }
}

export function readModelManifest(directory: string): ModelManifest {
  const path = join(directory, 'manifest.json');
  if (!existsSync(path)) throw new ModelUnavailable(`no history model prepared in ${directory}`);
  const parsed = ModelManifest.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new ModelUnavailable('the history model manifest is not valid');
  return parsed.data;
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Every file of the manifest is present with the pinned size and hash: a damaged model is never loaded. */
export async function verifyModelFiles(directory: string, manifest: ModelManifest): Promise<void> {
  for (const file of manifest.files) {
    const path = join(directory, manifest.modelId, file.path);
    if (!existsSync(path)) throw new ModelUnavailable(`the history model file ${file.path} is missing`);
    if (statSync(path).size !== file.bytes)
      throw new ModelUnavailable(`the history model file ${file.path} has the wrong size`);
    if ((await sha256Of(path)) !== file.sha256)
      throw new ModelUnavailable(`the history model file ${file.path} does not match its hash`);
  }
}

/**
 * Names one generation of vectors: the model, its pinned revision and everything else that decides what a vector
 * means. A vector of another generation is never a hit, and a change of any part makes the index build again.
 */
export function historyIndexKey(manifest: ModelManifest): string {
  return [
    manifest.modelId,
    manifest.revision.slice(0, 12),
    'q8',
    `d${EMBEDDING_DIMENSION}`,
    `c${CHUNK_TOKENS}o${CHUNK_OVERLAP_TOKENS}`,
    'p1',
  ].join('|');
}
