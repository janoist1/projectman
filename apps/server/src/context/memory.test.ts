import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemberMemoryStore, formatMemoryEntry, recentMemory } from './memory';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pm-memory-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function clock(...isoTimes: string[]): () => Date {
  const times = isoTimes.map((t) => new Date(t));
  return () => times.shift() ?? new Date('2030-01-01T00:00:00Z');
}

describe('member memory store', () => {
  it('reads nothing for a member without memory', async () => {
    const store = createMemberMemoryStore({ rootDir: root });
    expect(await store.read('AR', 'fe-1')).toBe('');
  });

  it('appends timestamped entries to <root>/<KEY>/<handle>.md', async () => {
    const store = createMemberMemoryStore({
      rootDir: root,
      now: clock('2026-09-29T10:00:00.123Z', '2026-09-29T11:30:00.000Z'),
    });
    await store.append('AR', 'fe-1', '  Run the mail preview before opening a pull request.  ');
    await store.append('AR', 'fe-1', 'Staging uses the sandbox payment keys.');

    const file = await readFile(path.join(root, 'AR', 'fe-1.md'), 'utf8');
    expect(file).toBe(
      '## 2026-09-29T10:00:00Z\nRun the mail preview before opening a pull request.\n\n' +
        '## 2026-09-29T11:30:00Z\nStaging uses the sandbox payment keys.\n\n',
    );
    expect(await store.read('AR', 'fe-1')).toBe(file.trim());
  });

  it('keeps members and projects apart', async () => {
    const store = createMemberMemoryStore({ rootDir: root, now: clock() });
    await store.append('AR', 'qa', 'qa in AR');
    await store.append('AR', 'devops', 'devops in AR');
    await store.append('XY', 'qa', 'qa in XY');
    expect(await store.read('AR', 'qa')).toContain('qa in AR');
    expect(await store.read('AR', 'qa')).not.toContain('XY');
    expect(await store.read('AR', 'devops')).toContain('devops in AR');
    expect(await store.read('XY', 'qa')).toContain('qa in XY');
  });

  it('returns only the most recent whole entries within the limit', async () => {
    const store = createMemberMemoryStore({ rootDir: root, maxReadBytes: 300, now: clock() });
    for (let i = 0; i < 20; i++) {
      await store.append('AR', 'qa', `Learning ${String(i).padStart(2, '0')} ${'x'.repeat(40)}`);
    }
    const text = await store.read('AR', 'qa');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300);
    expect(text.startsWith('## ')).toBe(true);
    expect(text).toContain('Learning 19');
    expect(text).not.toContain('Learning 00');
    for (const entry of text.split('\n\n')) {
      expect(entry).toMatch(/^## \S+\nLearning \d\d x{40}$/);
    }
  });

  it('keeps an entry that starts exactly at the cut', async () => {
    const older = formatMemoryEntry(new Date('2026-09-01T00:00:00Z'), 'older');
    const newer = formatMemoryEntry(new Date('2026-09-02T00:00:00Z'), 'newer');
    await mkdir(path.join(root, 'AR'));
    await writeFile(path.join(root, 'AR', 'qa.md'), older + newer);
    const store = createMemberMemoryStore({ rootDir: root, maxReadBytes: Buffer.byteLength(newer) });
    expect(await store.read('AR', 'qa')).toBe(newer.trim());
  });

  it('cuts at a line boundary inside one large entry, also between multi-byte characters', async () => {
    const smile = String.fromCodePoint(0x1f600);
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i} ${smile.repeat(5)}`);
    await mkdir(path.join(root, 'AR'));
    await writeFile(path.join(root, 'AR', 'qa.md'), formatMemoryEntry(new Date(0), lines.join('\n')));
    const store = createMemberMemoryStore({ rootDir: root, maxReadBytes: 101 });
    const text = await store.read('AR', 'qa');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(101);
    expect(text.endsWith(lines[29] ?? '')).toBe(true);
    expect(text.split('\n').every((line) => lines.includes(line))).toBe(true);
    expect(text).not.toContain(String.fromCharCode(0xfffd));
  });

  it('rejects empty notes and unsafe paths', async () => {
    const store = createMemberMemoryStore({ rootDir: root });
    await expect(store.append('AR', 'fe-1', ' \n ')).rejects.toThrow('memory note is empty');
    await expect(store.read('../etc', 'fe-1')).rejects.toThrow('invalid project key');
    await expect(store.read('AR', '../../secrets')).rejects.toThrow('invalid member handle');
    await expect(store.append('AR', 'Fe_1', 'note')).rejects.toThrow('invalid member handle');
  });
});

describe('recentMemory', () => {
  it('returns short text trimmed and complete', () => {
    expect(recentMemory('  ## a\nnote\n\n', 100)).toEqual({ text: '## a\nnote', truncated: false });
  });

  it('keeps the newest entries of long text and says it cut', () => {
    const text = ['one', 'two', 'three'].map((n, i) => formatMemoryEntry(new Date(i * 1000), n)).join('');
    const result = recentMemory(text, 60);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('## 1970-01-01T00:00:01Z\ntwo\n\n## 1970-01-01T00:00:02Z\nthree');
  });
});
