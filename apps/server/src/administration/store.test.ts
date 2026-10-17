import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdministrationCommand } from '../contracts';
import { journalLine, parseDiagnosticLine, readDiagnostics } from './diagnostics';
import { ensurePrivateDir } from './secure-fs';
import { commandKey, createDiagnosticsJournal, createOperationStore } from './store';
import type { OperationRecord } from './store';

const NOW = new Date('2026-10-17T10:00:00.000Z');
const HUB = { kind: 'hub' } as const;

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'adm-store-'));
  await ensurePrivateDir(stateDir);
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const record = (
  operationId: string,
  state: OperationRecord['job']['state'],
  createdAt = NOW.toISOString(),
): OperationRecord => ({
  operationId,
  requestId: 'req1',
  command: { kind: 'deploy', releaseId: 'rel1' },
  job: { operationId, state, result: null, errorCode: null, updatedAt: createdAt },
  createdAt,
});

describe('operation store', () => {
  it('keeps one private file per operation and finds the unfinished ones oldest first', async () => {
    const store = await createOperationStore(stateDir);
    await store.create(record('b', 'running', '2026-10-17T10:00:02.000Z'));
    await store.create(record('a', 'accepted', '2026-10-17T10:00:01.000Z'));
    await store.create(record('c', 'succeeded'));
    expect((await store.unfinished()).map((entry) => entry.operationId)).toEqual(['a', 'b']);
    const file = path.join(stateDir, 'operations', 'a.json');
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(path.dirname(file))).mode & 0o777).toBe(0o700);

    const updated = await store.setJob('a', record('a', 'succeeded').job);
    expect(updated.job.state).toBe('succeeded');
    expect((await store.get('a'))?.command).toEqual({ kind: 'deploy', releaseId: 'rel1' });
    expect(await store.get('missing')).toBeNull();
    await expect(store.setJob('missing', record('missing', 'failed').job)).rejects.toThrow();
  });

  it('refuses an operation id that is not a plain id, so no path can be built from it', async () => {
    const store = await createOperationStore(stateDir);
    await expect(store.get('../escape')).rejects.toThrow();
    await expect(store.create(record('a/b', 'accepted'))).rejects.toThrow();
  });

  it('does not trust a file that was edited into something else', async () => {
    const store = await createOperationStore(stateDir);
    await store.create(record('a', 'accepted'));
    const file = path.join(stateDir, 'operations', 'a.json');
    const edited = { ...JSON.parse(await readFile(file, 'utf8')), command: { kind: 'shell', argv: ['sh'] } };
    await writeFile(file, JSON.stringify(edited), { mode: 0o600 });
    expect(await store.get('a')).toBeNull();
    expect(await store.unfinished()).toEqual([]);
  });

  it('prunes the oldest finished operations and never an unfinished one', async () => {
    const store = await createOperationStore(stateDir);
    await store.create(record('keep-running', 'running', '2026-10-17T09:00:00.000Z'));
    for (let index = 0; index < 205; index += 1)
      await store.create(
        record(
          `done-${String(index).padStart(3, '0')}`,
          'succeeded',
          `2026-10-17T10:00:00.${String(index).padStart(3, '0')}Z`,
        ),
      );
    const names = await readdir(path.join(stateDir, 'operations'));
    expect(names.length).toBeLessThanOrEqual(201);
    expect(names).toContain('keep-running.json');
    expect(names).toContain('done-204.json');
    expect(names).not.toContain('done-000.json');
  }, 60_000);
});

describe('command key', () => {
  it('does not depend on the order of keys', () => {
    const a: AdministrationCommand = { kind: 'restart', target: HUB, expectedBootId: 'b1' };
    const b = { expectedBootId: 'b1', target: { kind: 'hub' }, kind: 'restart' } as AdministrationCommand;
    expect(commandKey(a)).toBe(commandKey(b));
    expect(commandKey(a)).not.toBe(commandKey({ ...a, expectedBootId: 'b2' }));
  });
});

describe('diagnostics', () => {
  it('writes only a known code with allowed, well-formed fields', () => {
    const line = journalLine('2026-10-17T10:00:00.000Z', 'submit_accepted', {
      operationId: 'op1',
      kind: 'restart',
      errorCode: 'Not A Token; rm -rf',
      bootId: 'x'.repeat(500),
      exitCode: 1.5,
      durationMs: 12,
    });
    expect(JSON.parse(line)).toEqual({
      at: '2026-10-17T10:00:00.000Z',
      code: 'submit_accepted',
      fields: { operationId: 'op1', kind: 'restart', durationMs: 12 },
    });
  });

  it('shows a caller a short fixed-form message and the level of the code, not of the line', () => {
    const entry = parseDiagnosticLine(
      JSON.stringify({
        at: '2026-10-17T10:00:00.000Z',
        level: 'info',
        code: 'restart_failed',
        message: 'free text with TOKEN=abc',
        fields: { operationId: 'op1', errorCode: 'administration_failed', extra: 'dropped' },
      }),
    );
    expect(entry).toEqual({
      at: '2026-10-17T10:00:00.000Z',
      level: 'error',
      code: 'restart_failed',
      message: 'restart_failed operationId=op1 errorCode=administration_failed',
    });
    expect(JSON.stringify(entry)).not.toContain('TOKEN');
  });

  it('skips lines that are not ours: bad JSON, unknown codes, a bad time, an oversized line', () => {
    const good = journalLine('2026-10-17T10:00:00.000Z', 'supervisor_started');
    const text = [
      'not json',
      JSON.stringify({ at: '2026-10-17T10:00:00.000Z', code: 'free_text' }),
      JSON.stringify({ at: 'yesterday', code: 'supervisor_started' }),
      JSON.stringify({ at: '2026-10-17T10:00:00.000Z', code: 'supervisor_started', pad: 'x'.repeat(5000) }),
      good,
    ].join('\n');
    expect(readDiagnostics(text, 10).map((entry) => entry.code)).toEqual(['supervisor_started']);
  });

  it('returns the newest entries, never more than 200', () => {
    const lines = Array.from({ length: 300 }, (_, index) =>
      journalLine(`2026-10-17T10:00:00.${String(index).padStart(3, '0')}Z`, 'submit_accepted', {
        operationId: `op${index}`,
      }),
    );
    const all = readDiagnostics(lines.join('\n'), 1000);
    expect(all).toHaveLength(200);
    expect(all.at(-1)?.message).toContain('op299');
    expect(readDiagnostics(lines.join('\n'), 3).map((entry) => entry.message)).toEqual([
      'submit_accepted operationId=op297',
      'submit_accepted operationId=op298',
      'submit_accepted operationId=op299',
    ]);
  });
});

describe('diagnostics journal', () => {
  it('appends private lines and reads them back in order', async () => {
    const journal = await createDiagnosticsJournal(stateDir, () => NOW);
    await journal.append('supervisor_started');
    await journal.append('submit_accepted', { operationId: 'op1', kind: 'restart' });
    expect((await journal.read(10)).map((entry) => entry.code)).toEqual([
      'supervisor_started',
      'submit_accepted',
    ]);
    expect((await lstat(path.join(stateDir, 'journal.log'))).mode & 0o777).toBe(0o600);
  });

  it('rotates once the file is large and keeps reading across the rotation', async () => {
    const journal = await createDiagnosticsJournal(stateDir, () => NOW);
    const pad = 'x'.repeat(50);
    for (let index = 0; index < 2000; index += 1)
      await journal.append('submit_accepted', { operationId: `${pad}-${index}`, kind: 'restart' });
    const names = await readdir(stateDir);
    expect(names).toContain('journal.log.1');
    const entries = await journal.read(200);
    expect(entries).toHaveLength(200);
    expect(entries.at(-1)?.message).toContain('-1999');
  }, 60_000);
});
