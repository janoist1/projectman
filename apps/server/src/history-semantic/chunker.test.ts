import { describe, expect, it } from 'vitest';
import { lineIndex, planChunk } from './chunker';
import type { ChunkPlan } from './chunker';
import { CHUNK_TOKENS } from './model';

/** Four characters a token, two special tokens: enough to exercise the planner without the real tokenizer. */
const count = (text: string) => Math.ceil(text.length / 4) + 2;

function planAll(text: string): ChunkPlan[] {
  const plans: ChunkPlan[] = [];
  let from = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const plan = planChunk(text, from, count);
    plans.push(plan);
    if (plan.last) return plans;
    from = plan.nextChar;
  }
  throw new Error('the plan does not end');
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('planChunk', () => {
  it('plans a short text as one last chunk', () => {
    expect(planAll('A short text.')).toEqual([{ startChar: 0, endChar: 13, last: true, nextChar: 13 }]);
  });

  it('covers a long text with bounded, overlapping chunks that make progress', () => {
    const text = words(1200);
    const plans = planAll(text);
    expect(plans.length).toBeGreaterThan(2);
    expect(plans[0]!.startChar).toBe(0);
    expect(plans.at(-1)!.endChar).toBe(text.length);
    plans.forEach((plan, i) => {
      expect(count(`passage: ${text.slice(plan.startChar, plan.endChar)}`)).toBeLessThanOrEqual(CHUNK_TOKENS);
      const next = plans[i + 1];
      if (!next) return;
      expect(next.startChar).toBeGreaterThan(plan.startChar);
      expect(next.startChar).toBeLessThan(plan.endChar);
    });
  });

  it('plans the same chunks when it resumes from a stored position', () => {
    const text = words(900);
    const plans = planAll(text);
    const resumed = planChunk(text, plans[1]!.startChar, count);
    expect(resumed).toEqual(plans[1]);
  });

  it('ends a chunk at a paragraph boundary when one is near the end', () => {
    const head = words(100);
    const text = `${head}\n\n${words(300)}`;
    const first = planChunk(text, 0, count);
    expect(first.endChar).toBe(head.length + 2);
  });

  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(2000);
    for (const plan of planAll(text)) {
      expect(text.charCodeAt(plan.startChar) & 0xfc00).not.toBe(0xdc00);
      if (plan.endChar < text.length) expect(text.charCodeAt(plan.endChar) & 0xfc00).not.toBe(0xdc00);
    }
  });

  it('skips the blanks before a chunk and finds nothing in blank text', () => {
    expect(planChunk('   \n  x', 0, count).startChar).toBe(6);
    expect(planChunk(' \n\t ', 0, count)).toMatchObject({ last: true, startChar: 4, endChar: 4 });
  });
});

describe('lineIndex', () => {
  it('numbers the lines of the original text from 1', () => {
    const lineOf = lineIndex('a\nbc\n\nd');
    expect([0, 1, 2, 4, 5, 6].map(lineOf)).toEqual([1, 1, 2, 2, 3, 4]);
  });
});
