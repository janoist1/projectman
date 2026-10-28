import { describe, expect, it } from 'vitest';
import { OWNER_COMMAND_OUTPUT_BYTES } from '@projectman/shared';
import {
  AdministrationCommandSchema,
  AdministrationResultSchema,
  SocketParams,
  SupervisorConfig,
} from './schemas';

const HUB = { kind: 'hub' } as const;

describe('owner command on the wire', () => {
  const command = { kind: 'owner_command', target: HUB, command: 'pwd', reason: 'Inspect fixture' };
  it('defaults the timeout to 120 seconds', () => {
    expect(AdministrationCommandSchema.parse(command)).toMatchObject({ timeoutSeconds: 120 });
  });
  it.each([
    { command: 'printf safe\u202eunsafe' },
    { cwd: '/fixture/\u200bhidden' },
    { reason: 'Inspect\u0085fixture' },
  ])('refuses hidden formatting and C1 controls in owner approval fields: %j', (fields) => {
    expect(AdministrationCommandSchema.safeParse({ ...command, ...fields }).success).toBe(false);
  });
  it('checks the JSON-encoded output budget, including escaping and quotes', () => {
    const result = {
      kind: 'owner_command',
      exitCode: 0,
      signal: null,
      stdout: '"'.repeat((OWNER_COMMAND_OUTPUT_BYTES - 2) / 2),
      stderr: '',
      truncated: true,
      durationMs: 1,
    };
    expect(AdministrationResultSchema.safeParse(result).success).toBe(true);
    expect(AdministrationResultSchema.safeParse({ ...result, stdout: result.stdout + 'x' }).success).toBe(
      false,
    );
  });
  it.each([
    { cwd: 'relative' },
    { cwd: `/${'a'.repeat(500)}` },
    { cwd: '/a\0b' },
    { command: '' },
    { command: 'a'.repeat(2001) },
    { command: 'a\0b' },
    { timeoutSeconds: 0 },
    { timeoutSeconds: 601 },
    { timeoutSeconds: 1.5 },
    { reason: '' },
    { reason: 'a'.repeat(501) },
  ])('refuses invalid command fields: %j', (fields) => {
    expect(AdministrationCommandSchema.safeParse({ ...command, ...fields }).success).toBe(false);
  });
  it('requires an absolute shell in the protected opt-in configuration', () => {
    const base = {
      version: 1,
      target: HUB,
      stateDir: '/state',
      socketPath: '/socket',
      service: { kind: 'systemd', unit: 'pm.service' },
    };
    expect(SupervisorConfig.safeParse({ ...base, ownerCommand: { shell: '/bin/sh' } }).success).toBe(true);
    expect(SupervisorConfig.safeParse({ ...base, ownerCommand: { shell: 'sh' } }).success).toBe(false);
  });
});

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
