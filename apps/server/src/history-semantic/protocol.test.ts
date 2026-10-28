import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSION } from './model';
import { WorkerMessage } from './protocol';

const embedded = (vector: unknown) => ({ type: 'embedded', id: 1, indexKey: 'k', vector });

describe('the worker message vectors', () => {
  it('accepts exactly one vector of the model size', () => {
    expect(WorkerMessage.safeParse(embedded(new Float32Array(EMBEDDING_DIMENSION))).success).toBe(true);
  });

  it.each([
    ['a shorter vector', new Float32Array(EMBEDDING_DIMENSION - 1)],
    [
      'a vector with a NaN',
      Float32Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => (i === 7 ? NaN : 0)),
    ],
    ['a plain array', Array.from({ length: EMBEDDING_DIMENSION }, () => 0)],
  ])('refuses %s', (_name, vector) => {
    expect(WorkerMessage.safeParse(embedded(vector)).success).toBe(false);
  });
});
