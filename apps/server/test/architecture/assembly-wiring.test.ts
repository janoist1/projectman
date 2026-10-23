import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { describe, expect, test } from 'vitest';

/**
 * `assembly.ts` only creates the modules and wires them together: factory calls and one call
 * towards the module per event subscription. A business decision (a branch, a loop, a function
 * of its own) belongs inside a module, where it has a test and one place (PM-950, PM-951).
 *
 * The ceilings are today's baseline: the logic that is still there is moved out slice by slice,
 * and each slice lowers its ceiling. A new branch or function declaration in the assembly fails
 * here; move it into a module instead of raising the number.
 */
const MAX_BRANCHES = 77;
// `createDomain` and `createHistoryDocumentReader`.
const MAX_FUNCTION_DECLARATIONS = 2;

/**
 * Count the branching statements and function declarations of a TypeScript source. esbuild
 * drops the comments and prints one fixed layout, so a plain pattern per keyword is enough.
 */
function measure(source: string): { branches: number; functionDeclarations: number } {
  const { code } = transformSync(source, { loader: 'ts', format: 'esm', logLevel: 'silent' });
  const count = (pattern: RegExp) => [...code.matchAll(pattern)].length;
  return {
    branches: count(/\b(?:if|for|while|switch) \(|\bdo \{|\btry \{/g),
    functionDeclarations: count(/^\s*(?:export )?(?:async )?function\b/gm),
  };
}

describe('assembly.ts', () => {
  test('measure counts branches and function declarations', () => {
    const sample =
      '// if (comment) {}\nfunction a() { if (x) { for (const y of z) {} } try { b(); } catch {} }';
    expect(measure(sample)).toEqual({ branches: 3, functionDeclarations: 1 });
  });

  test('stays wiring: no new branch or function of its own', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/assembly.ts', import.meta.url)), 'utf8');
    const { branches, functionDeclarations } = measure(source);
    // On failure: move the new logic into a module; do not raise the ceilings.
    expect(branches).toBeLessThanOrEqual(MAX_BRANCHES);
    expect(functionDeclarations).toBeLessThanOrEqual(MAX_FUNCTION_DECLARATIONS);
  });
});
