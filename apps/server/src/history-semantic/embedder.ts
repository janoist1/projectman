import type { Db } from '../db';
import { EMBEDDING_DIMENSION, PASSAGE_PREFIX, QUERY_PREFIX } from './model';
import type { ModelManifest } from './model';

/** The model in a worker thread: it counts tokens and turns a passage or a question into a unit vector. */
export interface Embedder {
  /** Tokens of a text as the model reads it, the special tokens included. */
  countTokens(text: string): number;
  embedPassage(text: string): Promise<Float32Array>;
  embedQuery(text: string): Promise<Float32Array>;
}

interface Tokenizer {
  encode(text: string, options?: { add_special_tokens?: boolean }): number[];
}
interface Extractor {
  (text: string, options: { pooling: 'mean'; normalize: boolean }): Promise<{ data: Float32Array }>;
}

/**
 * Loads the pinned model from the local directory only: the network is never reached, whatever the package would
 * do by default. Both packages are loaded on demand, so a server that never searches by meaning never pays for them.
 */
export async function createEmbedder(modelDirectory: string, manifest: ModelManifest): Promise<Embedder> {
  const { env, AutoTokenizer, pipeline } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelDirectory;
  const tokenizer = (await AutoTokenizer.from_pretrained(manifest.modelId, {
    local_files_only: true,
  })) as unknown as Tokenizer;
  const extractor = (await pipeline('feature-extraction', manifest.modelId, {
    device: 'cpu',
    dtype: 'q8',
    local_files_only: true,
    session_options: {
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      executionMode: 'sequential',
      enableCpuMemArena: false,
      enableMemPattern: false,
    },
  })) as unknown as Extractor;

  const embed = async (text: string) => {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const vector = Float32Array.from(output.data);
    if (vector.length !== EMBEDDING_DIMENSION)
      throw new Error(`the model gave ${vector.length} values, not ${EMBEDDING_DIMENSION}`);
    return vector;
  };
  return {
    countTokens: (text) => tokenizer.encode(text).length,
    embedPassage: (text) => embed(PASSAGE_PREFIX + text),
    embedQuery: (text) => embed(QUERY_PREFIX + text),
  };
}

/** Loads the similarity functions into the worker's own connection; the main connection never has them. */
export async function loadVectorExtension(db: Db): Promise<void> {
  const sqliteVec = await import('sqlite-vec');
  sqliteVec.load(db);
  const probe = db
    .prepare('SELECT vec_distance_cosine(?, ?) AS distance')
    .get(Buffer.from(new Float32Array([1, 0]).buffer), Buffer.from(new Float32Array([1, 0]).buffer)) as {
    distance: number;
  };
  if (!(Math.abs(probe.distance) < 1e-6)) throw new Error('the vector extension answers wrongly');
}
