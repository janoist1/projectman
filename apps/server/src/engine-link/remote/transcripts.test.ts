import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRemoteTranscripts } from './transcripts';

describe('remote transcript read (PM-1116)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pm-remote-transcripts-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const readerFor = (upload: unknown) => {
    const file = path.join(dir, 'upload.json');
    writeFileSync(file, JSON.stringify(upload));
    return createRemoteTranscripts({
      hub: { available: () => true, call: async () => ({}) } as never,
      transfers: {
        issueUpload: () => ({ token: 't', take: () => ({ path: file }), dispose: () => {} }),
      } as never,
    });
  };

  it('validates the uploaded items and refuses an upload that is not a list of chat items', async () => {
    const item = { id: 'a', kind: 'assistant_text', ts: '2026-10-01T10:00:00.000Z', text: 'hi' };
    await expect(readerFor([item]).read('/x.jsonl', { engineId: 'eng_a' as never })).resolves.toEqual([item]);
    await expect(
      readerFor({ items: [item] }).read('/x.jsonl', { engineId: 'eng_a' as never }),
    ).rejects.toThrow();
    await expect(
      readerFor([item, { id: 'b' }]).read('/x.jsonl', { engineId: 'eng_a' as never }),
    ).rejects.toThrow();
  });
});
