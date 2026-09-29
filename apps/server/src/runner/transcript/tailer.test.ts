import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDirs, waitFor } from '../test-helpers';
import { TranscriptTailer } from './tailer';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

function collect() {
  const lines: string[] = [];
  return { lines, onLines: (batch: string[]) => lines.push(...batch) };
}

describe('TranscriptTailer', () => {
  it('waits for a file that does not exist yet, then delivers complete lines only', async () => {
    const file = path.join(await dirs.make(), 't.jsonl');
    const sink = collect();
    const tailer = new TranscriptTailer({
      path: file,
      from: 'start',
      onLines: sink.onLines,
      pollIntervalMs: 20,
    });
    await tailer.start();
    expect(sink.lines).toEqual([]);

    await writeFile(file, '{"a":1}\n{"b":');
    await waitFor(() => sink.lines.length === 1, { what: 'first line' });
    expect(sink.lines).toEqual(['{"a":1}']);

    await appendFile(file, '2}\n\n{"c":3}\n');
    await waitFor(() => sink.lines.length === 3, { what: 'completed lines' });
    expect(sink.lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    tailer.stop();
  });

  it('starts at the end of an existing file when asked (resumed conversation)', async () => {
    const file = path.join(await dirs.make(), 't.jsonl');
    await writeFile(file, '{"old":1}\n{"old":2}\n');
    const sink = collect();
    const tailer = new TranscriptTailer({
      path: file,
      from: 'end',
      onLines: sink.onLines,
      pollIntervalMs: 20,
    });
    await tailer.start();
    await appendFile(file, '{"new":1}\n');
    await waitFor(() => sink.lines.length === 1, { what: 'new line' });
    expect(sink.lines).toEqual(['{"new":1}']);
    tailer.stop();
  });

  it('handles multi-byte characters and lines longer than one read', async () => {
    const file = path.join(await dirs.make(), 't.jsonl');
    const sink = collect();
    const tailer = new TranscriptTailer({
      path: file,
      from: 'start',
      onLines: sink.onLines,
      pollIntervalMs: 20,
    });
    await tailer.start();
    const long = JSON.stringify({ text: 'árvíztűrő tükörfúrógép 🚀 '.repeat(60_000) });
    await writeFile(file, `${long}\n{"x":"é"}\n`);
    await waitFor(() => sink.lines.length === 2, { what: 'long line', timeoutMs: 20_000 });
    expect(sink.lines[0]).toBe(long);
    expect(sink.lines[1]).toBe('{"x":"é"}');
    tailer.stop();
  });

  it('starts over when the file is truncated', async () => {
    const file = path.join(await dirs.make(), 't.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}\n');
    const sink = collect();
    const tailer = new TranscriptTailer({
      path: file,
      from: 'start',
      onLines: sink.onLines,
      pollIntervalMs: 20,
    });
    await tailer.start();
    expect(sink.lines).toHaveLength(2);
    await writeFile(file, '{"z":0}\n');
    await waitFor(() => sink.lines.length === 3, { what: 'restart' });
    expect(sink.lines[2]).toBe('{"z":0}');
    tailer.stop();
  });
});
