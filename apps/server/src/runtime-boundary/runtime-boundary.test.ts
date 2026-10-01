import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VM_CHECKS, VM_PROFILE_NAME, VM_PROFILE_VERSION } from '@projectman/shared';
import type { VmReadinessReport } from '@projectman/shared';
import type { SessionLauncher } from '../contracts';
import {
  createRuntimeBoundary,
  disabledRuntimeBoundary,
  loadBoundaryConfig,
  workerForUid,
  workerLayout,
} from './index';
import { memberOfPath } from './config';
import { parsePasswd } from './launcher/accounts';
import { readinessProblems } from './readiness';
import { testBoundaryConfig } from './test-helpers';

const NOW = new Date('2026-10-01T12:00:00.000Z');

function report(
  patch: {
    status?: Record<string, 'pass' | 'fail' | 'unverified'>;
    omit?: string[];
    version?: number;
    at?: string;
  } = {},
): VmReadinessReport {
  return {
    schemaVersion: 1,
    profile: { name: VM_PROFILE_NAME, version: patch.version ?? VM_PROFILE_VERSION },
    generatedAt: patch.at ?? '2026-10-01T11:30:00.000Z',
    host: { os: 'ubuntu 24.04', kernel: '6.8.0', arch: 'aarch64' },
    checks: VM_CHECKS.filter((c) => !patch.omit?.includes(c.id)).map((c) => ({
      id: c.id,
      status: patch.status?.[c.id] ?? 'pass',
      evidence: 'measured',
    })),
  };
}

const launcher = (up: boolean): SessionLauncher => ({
  ping: async () => up,
  start: async () => {
    throw new Error('not used');
  },
  run: async () => {
    throw new Error('not used');
  },
});

describe('the boundary configuration', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads a valid file and refuses anything else', () => {
    dir = mkdtempSync(join(tmpdir(), 'pm-boundary-'));
    const file = join(dir, 'boundary.json');
    writeFileSync(file, JSON.stringify(testBoundaryConfig()));
    expect(loadBoundaryConfig(file)).toEqual(testBoundaryConfig());
    writeFileSync(file, JSON.stringify({ ...testBoundaryConfig(), vm: true }));
    expect(() => loadBoundaryConfig(file)).toThrow(/invalid boundary configuration/);
    writeFileSync(file, JSON.stringify({ ...testBoundaryConfig(), appDir: 'srv/projectman' }));
    expect(() => loadBoundaryConfig(file)).toThrow(/invalid boundary configuration/);
    writeFileSync(
      file,
      JSON.stringify({
        ...testBoundaryConfig(),
        egress: { ...testBoundaryConfig().egress, host: '0.0.0.0' },
      }),
    );
    expect(() => loadBoundaryConfig(file)).toThrow(/invalid boundary configuration/);
    writeFileSync(
      file,
      JSON.stringify({
        ...testBoundaryConfig(),
        workers: { ...testBoundaryConfig().workers, uidMin: 30000, uidMax: 20000 },
      }),
    );
    expect(() => loadBoundaryConfig(file)).toThrow(/uidMin/);
    expect(() => loadBoundaryConfig(join(dir, 'missing.json'))).toThrow(/cannot read/);
  });

  it('lays out worker paths and refuses odd names', () => {
    const layout = workerLayout(testBoundaryConfig());
    expect(layout.home('dev')).toBe('/var/lib/projectman-work/pmw-dev');
    expect(layout.workspaces('dev')).toBe('/var/lib/projectman-work/pmw-dev/workspaces');
    expect(layout.sessions('dev', 'PM')).toBe('/var/lib/projectman-work/pmw-dev/sessions/PM');
    expect(layout.spoolIn('dev')).toBe('/var/lib/projectman-spool/dev/in');
    expect(layout.spoolOut('dev')).toBe('/var/lib/projectman-spool/dev/out');
    expect(() => layout.home('../root')).toThrow();
    expect(() => layout.sessions('dev', '../x')).toThrow();
  });

  it('tells which member a worker path belongs to', () => {
    const config = testBoundaryConfig();
    expect(memberOfPath(config, '/var/lib/projectman-work/pmw-dev/workspaces/AR')).toBe('dev');
    expect(memberOfPath(config, '/var/lib/projectman-work/pmw-dev')).toBe('dev');
    expect(memberOfPath(config, '/var/lib/projectman-work/dev/x')).toBeNull();
    expect(memberOfPath(config, '/var/lib/projectman-work')).toBeNull();
    expect(memberOfPath(config, '/var/lib/projectman/data/repos/app')).toBeNull();
    expect(memberOfPath(config, '/var/lib/projectman-work/pmw-dev/../pmw-qa/x')).toBe('qa');
  });

  it('maps a uid back to its worker only inside the worker range and home', () => {
    const accounts = parsePasswd(
      [
        'projectman:x:19000:19000::/var/lib/projectman:/usr/sbin/nologin',
        'pmw-dev:x:20001:20001::/var/lib/projectman-work/pmw-dev:/usr/sbin/nologin',
        'pmw-odd:x:20003:20003::/home/odd:/usr/sbin/nologin',
      ].join('\n'),
    );
    const lookup = { byName: (n: string) => accounts.get(n) ?? null, list: () => [...accounts.values()] };
    expect(workerForUid(testBoundaryConfig(), lookup, 20001)).toBe('dev');
    expect(workerForUid(testBoundaryConfig(), lookup, 19000)).toBeNull();
    expect(workerForUid(testBoundaryConfig(), lookup, 20003)).toBeNull();
    expect(workerForUid(testBoundaryConfig(), lookup, 20500)).toBeNull();
  });
});

describe('the readiness verdict', () => {
  const judge = (text: string | null, profileVersion = VM_PROFILE_VERSION) =>
    readinessProblems({
      file: '/report.json',
      profileVersion,
      maxAgeMs: 3_600_000,
      now: NOW,
      read: async () => {
        if (text === null) throw new Error('ENOENT');
        return text;
      },
    });

  it('is clean for a current report whose checks all passed', async () => {
    const result = await judge(JSON.stringify(report()));
    expect(result.problems).toEqual([]);
    expect(result.readiness).toMatchObject({ profileVersion: VM_PROFILE_VERSION, failed: [], pending: [] });
  });

  it('fails closed for a missing, malformed, stale, foreign or failing report', async () => {
    expect((await judge(null)).problems).toEqual(['readiness_report_missing']);
    expect((await judge('{')).problems).toEqual(['readiness_report_invalid']);
    expect((await judge(JSON.stringify({ ...report(), vm: true }))).problems).toEqual([
      'readiness_report_invalid',
    ]);
    expect((await judge(JSON.stringify(report({ at: '2026-10-01T10:00:00.000Z' })))).problems).toEqual([
      'readiness_report_stale',
    ]);
    expect((await judge(JSON.stringify(report({ version: VM_PROFILE_VERSION - 1 })))).problems).toContain(
      'readiness_wrong_profile',
    );
    expect((await judge(JSON.stringify(report()), VM_PROFILE_VERSION + 1)).problems).toContain(
      'readiness_wrong_profile',
    );
    expect(
      (
        await judge(
          JSON.stringify(report({ status: { 'gate-loaded': 'fail', launcher: 'unverified' }, omit: ['os'] })),
        )
      ).problems,
    ).toEqual(expect.arrayContaining(['readiness:os', 'readiness:gate-loaded']));
  });
});

describe('the runtime boundary', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function boundary(opts: { up?: boolean; egress?: boolean; text?: string | null } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'pm-boundary-'));
    return createRuntimeBoundary({
      config: testBoundaryConfig({ profileVersion: VM_PROFILE_VERSION }),
      launcher: launcher(opts.up ?? true),
      egressUp: () => opts.egress ?? true,
      now: () => NOW,
      readReport: async () => {
        const text = opts.text === undefined ? JSON.stringify(report()) : opts.text;
        if (text === null) throw new Error('ENOENT');
        return text;
      },
    });
  }

  it('is ready only when the report, the launcher and the proxy all hold', async () => {
    await expect(boundary().status()).resolves.toMatchObject({
      mode: 'managed_vm',
      ready: true,
      problems: [],
      launcher: 'up',
      egress: 'up',
    });
    await expect(boundary({ up: false }).status()).resolves.toMatchObject({
      ready: false,
      problems: ['launcher_unreachable'],
      launcher: 'down',
    });
    await expect(boundary({ egress: false }).status()).resolves.toMatchObject({
      ready: false,
      problems: ['egress_proxy_down'],
    });
    await expect(boundary({ text: null }).status()).resolves.toMatchObject({
      ready: false,
      problems: ['readiness_report_missing'],
    });
  });

  it('reuses a fresh verdict and measures again on request', async () => {
    let up = true;
    dir = mkdtempSync(join(tmpdir(), 'pm-boundary-'));
    const b = createRuntimeBoundary({
      config: testBoundaryConfig({ profileVersion: VM_PROFILE_VERSION }),
      launcher: { ...launcher(true), ping: async () => up },
      egressUp: () => true,
      now: () => NOW,
      readReport: async () => JSON.stringify(report()),
    });
    expect((await b.status()).ready).toBe(true);
    up = false;
    expect((await b.status()).ready).toBe(true);
    expect((await b.status({ refresh: true })).ready).toBe(false);
  });

  it('is off and never ready outside the managed VM', async () => {
    const off = disabledRuntimeBoundary(() => NOW);
    expect(off.launcher).toBeNull();
    await expect(off.status()).resolves.toMatchObject({
      mode: 'off',
      ready: false,
      problems: ['not_configured'],
    });
  });
});
