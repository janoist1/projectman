import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hu } from '../../web/src/i18n/hu';

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
      /\b(?:conflict|invalid|forbidden|DomainError|apiError)\(\s*([A-Z_]+)\b/g,
    )) {
      expect(constants.has(match[1]!), `Unresolved error constant: ${match[1]}`).toBe(true);
      codes.add(constants.get(match[1]!)!);
    }
    // Helpers and route responses declare their stable code as the first argument.
    for (const match of source.matchAll(
      /\b(?:conflict|invalid|forbidden|DomainError|apiError)\(\s*['"]([a-z_]+)['"]/g,
    )) {
      codes.add(match[1]!);
    }
    // Include framework mappings, status fallbacks and dynamic scheduled-run fallbacks.
    if (filename.endsWith('/api/errors.ts') || filename.endsWith('/api/schedules.ts')) {
      for (const match of source.matchAll(/['"]([a-z]+(?:_[a-z]+)+)['"]/g)) codes.add(match[1]!);
    }
    // WebSocket errors carry their code in message rather than ApiError.code.
    for (const match of source.matchAll(/type:\s*['"]error['"],\s*message:\s*['"]([a-z_]+)['"]/g)) {
      codes.add(match[1]!);
    }
  }
  return codes;
}

describe('server error translations', () => {
  it('provides a Hungarian message for every source-declared REST and WebSocket error code', async () => {
    const codes = await serverErrorCodes();
    expect(codes.has('gate_blocked')).toBe(true);
    expect(codes.has('invalid_command')).toBe(true);
    expect(codes.has('unsupported_media_type')).toBe(true);
    const messages: Record<string, string> = hu.errors.codes;
    expect([...codes].filter((code) => !messages[code]?.trim()).sort()).toEqual([]);
  });
});
