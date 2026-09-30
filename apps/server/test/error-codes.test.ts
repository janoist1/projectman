import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@projectman/shared';

const serverSources = fileURLToPath(new URL('../src/', import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(filename)
        : Promise.resolve(filename.endsWith('.ts') && !filename.endsWith('.test.ts') ? [filename] : []);
    }),
  );
  return files.flat();
}

/**
 * Codes the server sources name where they raise errors. The compiler checks them against
 * ErrorCode already; this also catches a code smuggled in with a cast.
 */
async function serverErrorCodes(): Promise<Set<string>> {
  const codes = new Set<string>();
  const files = await sourceFiles(serverSources);
  const sources = await Promise.all(files.map((filename) => readFile(filename, 'utf8')));
  const constants = new Map<string, string>();
  for (const source of sources) {
    for (const match of source.matchAll(/\bconst\s+([A-Z_]+)\s*=\s*['"]([a-z_]+)['"]/g)) {
      constants.set(match[1]!, match[2]!);
    }
  }
  for (const [index, filename] of files.entries()) {
    const source = sources[index]!;
    for (const match of source.matchAll(
      /\b(?:conflict|invalid|forbidden|unavailable|DomainError|apiError|errorEvent)\(\s*([A-Z_]+)\b/g,
    )) {
      expect(constants.has(match[1]!), `Unresolved error constant: ${match[1]}`).toBe(true);
      codes.add(constants.get(match[1]!)!);
    }
    // Helpers and route responses declare their stable code as the first argument.
    for (const match of source.matchAll(
      /\b(?:conflict|invalid|forbidden|unavailable|DomainError|apiError|errorEvent)\(\s*['"]([a-z_]+)['"]/g,
    )) {
      codes.add(match[1]!);
    }
    // Framework mappings and status fallbacks.
    if (filename.endsWith('/api/errors.ts')) {
      for (const match of source.matchAll(/['"]([a-z]+(?:_[a-z]+)+)['"]/g)) codes.add(match[1]!);
    }
  }
  return codes;
}

// The web's locale is typed against the same list, so each of these codes has a Hungarian text.
describe('server error codes', () => {
  it('raises only codes of the shared list', async () => {
    const codes = await serverErrorCodes();
    expect(codes.has('gate_blocked')).toBe(true);
    expect(codes.has('invalid_command')).toBe(true);
    expect(codes.has('unsupported_media_type')).toBe(true);
    const known = new Set<string>(ERROR_CODES);
    expect([...codes].filter((code) => !known.has(code)).sort()).toEqual([]);
  });
});
