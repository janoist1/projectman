import { describe, expect, it } from 'vitest';
import { AdministrationCommandSchema, SocketParams, SupervisorConfig } from './schemas';

const HUB = { kind: 'hub' } as const;

describe('process cleanup on the wire', () => {
  it('accepts the one selector and refuses an unknown one or an extra key', () => {
    const command = { kind: 'process_cleanup', target: HUB, selector: 'orphan_test_workers' };
    expect(AdministrationCommandSchema.safeParse(command).success).toBe(true);
    expect(AdministrationCommandSchema.safeParse({ ...command, selector: 'everything' }).success).toBe(false);
    expect(AdministrationCommandSchema.safeParse({ ...command, pattern: 'node' }).success).toBe(false);
  });

  it('carries the cleanup through the submit parameters of the socket and the engine link', () => {
    const submit = {
      operationId: 'op1',
      requestId: 'req1',
      command: { kind: 'process_cleanup', target: HUB, selector: 'orphan_test_workers' },
    };
    expect(SocketParams.submit.safeParse(submit).success).toBe(true);
    submit.command.selector = 'kill_all';
    expect(SocketParams.submit.safeParse(submit).success).toBe(false);
  });
});

describe('log filters on the wire', () => {
  it('accepts a request without filters (an older caller) and with every filter', () => {
    expect(SocketParams.logs.safeParse({ target: HUB, limit: 5 }).success).toBe(true);
    expect(
      SocketParams.logs.safeParse({
        target: HUB,
        limit: 5,
        source: 'service',
        minLevel: 'warn',
        since: '2026-10-17T10:00:00.000Z',
        contains: 'timeout',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['an unknown source', { source: 'kernel' }],
    ['an unknown level', { minLevel: 'debug' }],
    ['a time that is not ISO', { since: 'yesterday' }],
    ['a text longer than 100 characters', { contains: 'x'.repeat(101) }],
    ['an empty text', { contains: '' }],
    ['a key that is not a filter', { unit: 'other.service' }],
  ])('refuses %s', (_name, extra) => {
    expect(SocketParams.logs.safeParse({ target: HUB, limit: 5, ...extra }).success).toBe(false);
  });
});

describe('the supervisor configuration', () => {
  const base = {
    version: 1,
    target: HUB,
    stateDir: '/var/lib/pm',
    socketPath: '/var/lib/pm/s.sock',
  };

  it('takes an optional log file for a launchd service only', () => {
    const launchd = { kind: 'launchd', label: 'com.example.app', logFile: '/var/log/app.log' };
    expect(SupervisorConfig.safeParse({ ...base, service: launchd }).success).toBe(true);
    expect(
      SupervisorConfig.safeParse({
        ...base,
        service: { kind: 'systemd', unit: 'app.service', logFile: '/var/log/app.log' },
      }).success,
    ).toBe(false);
  });
});
