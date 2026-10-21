import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiagnosticLogEntry } from '../contracts';
import {
  createServiceLogReader,
  entriesOfFileText,
  entryOfJournalLine,
  filterEntries,
  levelOfText,
} from './service-logs';
import { fakeHost } from './test-helpers';

const entry = (at: string, level: DiagnosticLogEntry['level'], message: string): DiagnosticLogEntry => ({
  at,
  level,
  code: 'service_log',
  message,
});

describe('levelOfText', () => {
  it.each([
    ['2026-10-17T10:00:00Z ERROR something broke', 'error'],
    ['level=warn msg="slow"', 'warn'],
    ['{"level":50,"msg":"x"}', 'error'],
    ['{"level":"warning","msg":"x"}', 'warn'],
    ['[info] started', 'info'],
    ['a line that says nothing about its level', 'info'],
    ['there was no error in this lowercase mention', 'info'],
  ])('reads %s as %s', (line, level) => {
    expect(levelOfText(line)).toBe(level);
  });
});

describe('the lines of a log file', () => {
  const MODIFIED = new Date('2026-10-17T12:00:00.000Z');

  it('takes the time and level each line states, carries the time to a line without one and redacts', () => {
    const text = [
      '2026-10-17T10:00:00.000Z INFO started token=SuperSecretValue123',
      '    at stack line without a time',
      '2026-10-17T10:05:00Z WARN slow request',
      '',
    ].join('\n');
    expect(entriesOfFileText(text, true, MODIFIED)).toEqual([
      entry('2026-10-17T10:00:00.000Z', 'info', '2026-10-17T10:00:00.000Z INFO started token=[redacted]'),
      entry('2026-10-17T10:00:00.000Z', 'info', 'at stack line without a time'),
      entry('2026-10-17T10:05:00.000Z', 'warn', '2026-10-17T10:05:00Z WARN slow request'),
    ]);
  });

  it('drops the first line of a tail that starts inside a line and dates an untimed line by the file', () => {
    const entries = entriesOfFileText('cut-off half line\nplain line\n', false, MODIFIED);
    expect(entries).toEqual([entry('2026-10-17T12:00:00.000Z', 'info', 'plain line')]);
  });

  it('cuts a long line to the entry size', () => {
    const [long] = entriesOfFileText(`${'word '.repeat(600)}\n`, true, MODIFIED);
    expect(long!.message.length).toBeLessThanOrEqual(1000);
  });
});

describe('filterEntries', () => {
  const entries = [
    entry('2026-10-17T10:00:00.000Z', 'info', 'alpha started'),
    entry('2026-10-17T10:01:00.000Z', 'warn', 'beta slow'),
    entry('2026-10-17T10:02:00.000Z', 'error', 'gamma failed token=[redacted]'),
    entry('2026-10-17T10:03:00.000Z', 'info', 'delta done'),
  ];

  it('keeps the entries at or above the level', () => {
    expect(filterEntries(entries, { limit: 10, minLevel: 'warn' }).map((e) => e.level)).toEqual([
      'warn',
      'error',
    ]);
  });

  it('keeps the entries from the time on', () => {
    const kept = filterEntries(entries, { limit: 10, since: '2026-10-17T10:02:00.000Z' });
    expect(kept.map((e) => e.message)).toEqual(['gamma failed token=[redacted]', 'delta done']);
  });

  it('matches the text of the redacted line, without regard to case, and never a secret', () => {
    expect(filterEntries(entries, { limit: 10, contains: 'BETA' })).toHaveLength(1);
    expect(filterEntries(entries, { limit: 10, contains: 'SuperSecretValue123' })).toEqual([]);
  });

  it('returns the newest entries, oldest first, up to the limit', () => {
    expect(filterEntries(entries, { limit: 2 }).map((e) => e.message)).toEqual([
      'gamma failed token=[redacted]',
      'delta done',
    ]);
  });

  it('lets the oldest entries go when the escaped lines would not fit one answer', () => {
    const heavy = Array.from({ length: 200 }, (_, index) =>
      entry('2026-10-17T10:00:00.000Z', 'info', `${index} ${'"'.repeat(990)}`),
    );
    const kept = filterEntries(heavy, { limit: 200 });
    expect(kept.length).toBeLessThan(200);
    expect(kept.at(-1)!.message.startsWith('199 ')).toBe(true);
  });
});

describe('journalctl lines', () => {
  const line = (fields: Record<string, unknown>) =>
    JSON.stringify({ __REALTIME_TIMESTAMP: '1792231200000000', PRIORITY: '6', MESSAGE: 'ok', ...fields });

  it('reads the time, the priority and a redacted message', () => {
    expect(entryOfJournalLine(line({ PRIORITY: '3', MESSAGE: 'failed pmk_AbCdEf123456' }))).toEqual(
      entry('2026-10-17T10:00:00.000Z', 'error', 'failed [redacted]'),
    );
    expect(entryOfJournalLine(line({ PRIORITY: '4' }))).toMatchObject({ level: 'warn' });
  });

  it('reads a binary message and skips a line that is not a message', () => {
    expect(entryOfJournalLine(line({ MESSAGE: [104, 105] }))).toMatchObject({ message: 'hi' });
    expect(entryOfJournalLine('not json')).toBeNull();
    expect(entryOfJournalLine(JSON.stringify({ PRIORITY: '6' }))).toBeNull();
  });
});

describe('the service log reader', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'adm-svclog-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('asks journalctl for a fixed unit, with a wider scan only when a filter needs it', async () => {
    const asked: string[][] = [];
    const host = fakeHost({
      exec: async (file, args) => {
        asked.push([file, ...args]);
        return `${JSON.stringify({ __REALTIME_TIMESTAMP: '1792231200000000', PRIORITY: '6', MESSAGE: 'hello' })}\n`;
      },
    });
    const reader = createServiceLogReader({ host, service: { kind: 'systemd', unit: 'app.service' } });
    expect(reader.available()).toBe(true);
    expect(await reader.read({ limit: 20 })).toHaveLength(1);
    await reader.read({ limit: 20, minLevel: 'error' });
    expect(asked).toEqual([
      ['/usr/bin/journalctl', '-u', 'app.service', '-o', 'json', '--no-pager', '-n', '20'],
      ['/usr/bin/journalctl', '-u', 'app.service', '-o', 'json', '--no-pager', '-n', '1000'],
    ]);
  });

  it('reads the configured log file of a launchd service from its end', async () => {
    const logFile = path.join(dir, 'service.log');
    await writeFile(logFile, '2026-10-17T10:00:00Z INFO one\n2026-10-17T10:01:00Z ERROR two\n');
    const reader = createServiceLogReader({
      host: fakeHost({ uid: process.getuid?.() ?? null }),
      service: { kind: 'launchd', label: 'com.example.app', logFile },
    });
    expect(reader.available()).toBe(true);
    const entries = await reader.read({ limit: 1 });
    expect(entries).toMatchObject([{ level: 'error', message: '2026-10-17T10:01:00Z ERROR two' }]);
  });

  it('is unavailable for a launchd service without a log file and empty when the file is missing', async () => {
    const host = fakeHost({ uid: process.getuid?.() ?? null });
    expect(
      createServiceLogReader({ host, service: { kind: 'launchd', label: 'com.example.app' } }).available(),
    ).toBe(false);
    const missing = createServiceLogReader({
      host,
      service: { kind: 'launchd', label: 'com.example.app', logFile: path.join(dir, 'none.log') },
    });
    expect(await missing.read({ limit: 5 })).toEqual([]);
  });
});
