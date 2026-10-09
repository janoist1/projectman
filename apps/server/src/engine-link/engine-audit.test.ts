import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineAudit } from './engine-audit';

describe('engine audit log', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'engine-audit-'));
    file = path.join(dir, 'logs', 'engine-audit.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lines = (name: string) =>
    readFileSync(name, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it('appends one JSON line per request, private to the user', () => {
    const audit = createEngineAudit(file, { now: () => new Date('2026-10-09T10:00:00Z') });
    audit.record({ reqId: 'r1', method: 'session.start', sessionId: 's1', outcome: 'ok' });
    audit.record({ reqId: 'r2', method: 'machine.signal', outcome: 'refused', code: 'signal_not_allowed' });
    expect(lines(file)).toEqual([
      {
        at: '2026-10-09T10:00:00.000Z',
        reqId: 'r1',
        method: 'session.start',
        sessionId: 's1',
        outcome: 'ok',
      },
      {
        at: '2026-10-09T10:00:00.000Z',
        reqId: 'r2',
        method: 'machine.signal',
        outcome: 'refused',
        code: 'signal_not_allowed',
      },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('rotates at the size limit and keeps the newest files only', () => {
    const audit = createEngineAudit(file, { maxBytes: 200, keep: 3 });
    for (let index = 0; index < 12; index += 1)
      audit.record({ reqId: `r${index}`, method: 'session.send', outcome: 'ok' });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
    for (const name of [file, `${file}.1`, `${file}.2`]) expect(statSync(name).size).toBeLessThanOrEqual(200);
    // The newest request is in the live file, and the files are in order, newest first.
    expect(lines(file).at(-1)!.reqId).toBe('r11');
    const newest = (name: string) => Number(String(lines(name).at(-1)!.reqId).slice(1));
    expect(newest(file)).toBeGreaterThan(newest(`${file}.1`));
    expect(newest(`${file}.1`)).toBeGreaterThan(newest(`${file}.2`));
  });

  it('continues in the file that is already there after a restart', () => {
    createEngineAudit(file).record({ reqId: 'r1', method: 'session.send', outcome: 'ok' });
    createEngineAudit(file).record({ reqId: 'r2', method: 'session.send', outcome: 'ok' });
    expect(lines(file).map((line) => line.reqId)).toEqual(['r1', 'r2']);
  });

  it('never fails a request when the file cannot be written', () => {
    const errors: unknown[] = [];
    const audit = createEngineAudit(file, { onError: (error) => errors.push(error) });
    rmSync(path.dirname(file), { recursive: true });
    expect(() => audit.record({ reqId: 'r1', method: 'session.send', outcome: 'ok' })).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});
