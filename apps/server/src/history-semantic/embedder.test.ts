import { describe, expect, it, vi } from 'vitest';

const transformers = vi.hoisted(() => ({
  env: { allowRemoteModels: true } as Record<string, unknown>,
  AutoTokenizer: { from_pretrained: vi.fn(async () => ({ encode: () => [1, 2, 3] })) },
  pipeline: vi.fn(async () => async () => ({ data: new Float32Array(384) })),
}));
vi.mock('@huggingface/transformers', () => transformers);

import { createEmbedder } from './embedder';
import type { ModelManifest } from './model';

describe('the embedder loading', () => {
  it('reads only local files and never allows remote models', async () => {
    const manifest = { modelId: 'Xenova/multilingual-e5-small' } as ModelManifest;

    await createEmbedder('/models/history', manifest);

    expect(transformers.env).toMatchObject({ allowRemoteModels: false, localModelPath: '/models/history' });
    expect(transformers.AutoTokenizer.from_pretrained).toHaveBeenCalledWith(
      manifest.modelId,
      expect.objectContaining({ local_files_only: true }),
    );
    expect(transformers.pipeline).toHaveBeenCalledWith(
      'feature-extraction',
      manifest.modelId,
      expect.objectContaining({ local_files_only: true }),
    );
  });
});
