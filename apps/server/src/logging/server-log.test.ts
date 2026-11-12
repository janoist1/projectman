import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeRequest } from '../http';
import { createServerLogStream, removeRetiredEngineLogs, serverLogFile } from './server-log';

describe('server log file (PM-444)', () => {
  let dir: string;
  let terminal: string[];
  const terminalStream = { isTTY: true, write: (text: string) => terminal.push(text) };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pm-server-log-'));
    terminal = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('names the files below the home logs folder', () => {
    expect(serverLogFile('/h', 'server')).toBe(path.join('/h', 'logs', 'server.log'));
    expect(serverLogFile('/h', 'engine')).toBe(path.join('/h', 'logs', 'engine.log'));
  });

  it('writes every line to the terminal and to the file', () => {
    const file = serverLogFile(dir, 'server');
    const stream = createServerLogStream(file, { terminal: terminalStream });
    stream.write('{"msg":"a"}\n');
    stream.write('{"msg":"b"}\n');
    expect(terminal.join('')).toBe('{"msg":"a"}\n{"msg":"b"}\n');
    expect(readFileSync(file, 'utf8')).toBe('{"msg":"a"}\n{"msg":"b"}\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps appending to the file of an earlier start', () => {
    const file = serverLogFile(dir, 'server');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'old\n');
    createServerLogStream(file, { terminal: terminalStream }).write('new\n');
    expect(readFileSync(file, 'utf8')).toBe('old\nnew\n');
  });

  it('makes no terminal copy without a TTY', () => {
    const file = serverLogFile(dir, 'engine');
    createServerLogStream(file, { terminalOnly: true, terminal: { ...terminalStream, isTTY: false } }).write(
      'line\n',
    );
    expect(terminal).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('line\n');
  });

  it('keeps server stdout logging without a TTY for container log collection', () => {
    const file = serverLogFile(dir, 'server');
    createServerLogStream(file, { terminal: { ...terminalStream, isTTY: false } }).write('line\n');
    expect(terminal).toEqual(['line\n']);
    expect(readFileSync(file, 'utf8')).toBe('line\n');
  });

  it('removes only retired single-mode logs on engine startup', () => {
    const logs = path.join(dir, 'logs');
    mkdirSync(logs);
    for (const name of [
      'live-server.log',
      'server.log',
      'server.log.1',
      'engine.log',
      'engine.log.1',
      'engine-service.err.log',
      'server.log.other',
    ])
      writeFileSync(path.join(logs, name), 'old');
    removeRetiredEngineLogs(dir);
    expect(readdirSync(logs).sort()).toEqual([
      'engine-service.err.log',
      'engine.log',
      'engine.log.1',
      'server.log.other',
    ]);
  });

  it('rotates by size and keeps a bounded number of files', () => {
    const file = serverLogFile(dir, 'server');
    const stream = createServerLogStream(file, { maxBytes: 100, keep: 3, terminal: terminalStream });
    for (let i = 0; i < 50; i += 1) stream.write(`${String(i).padStart(2, '0')}${'x'.repeat(37)}\n`);
    expect(readdirSync(path.dirname(file)).sort()).toEqual(['server.log', 'server.log.1', 'server.log.2']);
    for (const name of ['server.log', 'server.log.1', 'server.log.2'])
      expect(statSync(path.join(path.dirname(file), name)).size).toBeLessThanOrEqual(100);
    // The newest line is in the live file; the terminal still got all of them.
    expect(readFileSync(file, 'utf8')).toContain('49');
    expect(terminal).toHaveLength(50);
  });

  it('keeps logging to the terminal when the file cannot be written, and says so once', () => {
    const file = serverLogFile(dir, 'server');
    const stream = createServerLogStream(file, { terminal: terminalStream });
    // A folder in the file's place makes every append fail.
    rmSync(file, { force: true });
    mkdirSync(file);
    stream.write('one\n');
    stream.write('two\n');
    expect(terminal.filter((line) => line === 'one\n' || line === 'two\n')).toHaveLength(2);
    const warnings = terminal.filter((line) => line.includes('cannot be written'));
    expect(warnings).toHaveLength(1);
  });

  it('records Fastify log lines without invitation or hook tokens', async () => {
    const file = serverLogFile(dir, 'server');
    const stream = createServerLogStream(file, { terminal: terminalStream });
    const app = Fastify({ logger: { level: 'info', stream, serializers: { req: serializeRequest } } });
    app.get('/api/invites/:token', async () => ({ ok: true }));
    await app.inject({ method: 'GET', url: '/api/invites/secret-token-123?next=/x' });
    await app.close();
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('incoming request');
    expect(text).toContain('/api/invites/[redacted]');
    expect(text).not.toContain('secret-token-123');
  });
});
