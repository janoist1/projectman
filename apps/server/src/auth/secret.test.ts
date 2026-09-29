import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateSecret } from './secret';

describe('persistent cookie signing secret', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pm-secret-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('reuses the saved key and restricts its permissions', () => {
    const path = join(home, 'secret');
    const existing = 'existing-signing-key-that-must-never-change';
    writeFileSync(path, `${existing}\n`, { mode: 0o644 });
    expect(loadOrCreateSecret(home)).toBe(existing);
    expect(loadOrCreateSecret(home)).toBe(existing);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('creates a durable key without leaving a temporary file', () => {
    const key = loadOrCreateSecret(home);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(loadOrCreateSecret(home)).toBe(key);
    expect(readdirSync(home)).toEqual(['secret']);
  });

  it('refuses to silently rotate a malformed key and invalidate saved cookies', () => {
    const path = join(home, 'secret');
    writeFileSync(path, 'truncated\n');
    expect(() => loadOrCreateSecret(home)).toThrow('restore it to preserve existing logins');
    expect(readFileSync(path, 'utf8')).toBe('truncated\n');
  });
});
