import { describe, expect, it } from 'vitest';
import {
  evaluateVmReadiness,
  formatVmReadiness,
  VM_CHECKS,
  VM_PROFILE_NAME,
  VM_PROFILE_VERSION,
  VmReadinessReport,
} from './vm-readiness';

function report(
  overrides: Partial<VmReadinessReport> = {},
  skip: string[] = [],
  status: Record<string, 'pass' | 'fail' | 'unverified'> = {},
) {
  return VmReadinessReport.parse({
    schemaVersion: 1,
    profile: { name: VM_PROFILE_NAME, version: VM_PROFILE_VERSION },
    generatedAt: '2026-10-01T12:00:00Z',
    host: { os: 'Ubuntu 24.04 LTS', kernel: '6.8.0', arch: 'aarch64' },
    checks: VM_CHECKS.filter((check) => !skip.includes(check.id)).map((check) => ({
      id: check.id,
      status: status[check.id] ?? (check.required ? 'pass' : 'unverified'),
      evidence: `measured ${check.id}`,
    })),
    ...overrides,
  });
}

describe('VM readiness contract', () => {
  it('is ready when every required check passed; the later parts stay pending', () => {
    const result = evaluateVmReadiness(report());
    expect(result).toMatchObject({ ready: true, missing: [], failed: [], unverified: [], problems: [] });
    expect(result.pending).toEqual(['egress-open', 'domain-gate', 'launcher', 'tailscale']);
  });

  it('is not ready when a required check is missing, failed or not measured', () => {
    expect(evaluateVmReadiness(report({}, ['gate-control']))).toMatchObject({
      ready: false,
      missing: ['gate-control'],
    });
    expect(evaluateVmReadiness(report({}, [], { 'worker-denied-read': 'fail' }))).toMatchObject({
      ready: false,
      failed: ['worker-denied-read'],
    });
    expect(evaluateVmReadiness(report({}, [], { 'gate-blocks-host': 'unverified' }))).toMatchObject({
      ready: false,
      unverified: ['gate-blocks-host'],
    });
  });

  it('does not need the reported-only checks', () => {
    expect(
      evaluateVmReadiness(report({}, ['tailscale', 'domain-gate', 'launcher', 'egress-open'])).ready,
    ).toBe(true);
  });

  it('refuses a report of another profile version, a duplicated check and a stale report', () => {
    expect(
      evaluateVmReadiness(report({ profile: { name: VM_PROFILE_NAME, version: VM_PROFILE_VERSION + 1 } }))
        .ready,
    ).toBe(false);
    expect(
      evaluateVmReadiness(report({ profile: { name: 'other', version: VM_PROFILE_VERSION } })).ready,
    ).toBe(false);
    const duplicated = report();
    duplicated.checks.push({ id: 'os', status: 'pass', evidence: 'again' });
    expect(evaluateVmReadiness(duplicated).problems).toEqual(['duplicated check os']);
    const now = new Date('2026-10-01T12:30:00Z');
    expect(evaluateVmReadiness(report(), { now, maxAgeMs: 60 * 60_000 }).ready).toBe(true);
    expect(evaluateVmReadiness(report(), { now, maxAgeMs: 10 * 60_000 }).problems).toHaveLength(1);
    expect(
      evaluateVmReadiness(report(), { now: new Date('2026-10-01T11:00:00Z'), maxAgeMs: 60 * 60_000 }).ready,
    ).toBe(false);
  });

  it('is not satisfied by a claim: unknown fields, such as a VM flag, make the report invalid', () => {
    const claim = { ...report(), vm: true };
    expect(VmReadinessReport.safeParse(claim).success).toBe(false);
    expect(
      VmReadinessReport.safeParse({
        ...report(),
        checks: [{ id: 'os', status: 'pass', evidence: 'x', vm: true }],
      }).success,
    ).toBe(false);
    expect(
      VmReadinessReport.safeParse({ ...report(), checks: [{ id: 'os', status: 'pass', evidence: '' }] })
        .success,
    ).toBe(false);
    expect(
      VmReadinessReport.safeParse({ ...report(), checks: [{ id: 'os', status: 'yes', evidence: 'x' }] })
        .success,
    ).toBe(false);
  });

  it('keeps the check list consistent: unique ids, required checks cover every group', () => {
    const ids = VM_CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of [
      'versions',
      'accounts',
      'protected-paths',
      'host-isolation',
      'network-gate',
      'service',
    ]) {
      expect(VM_CHECKS.some((check) => check.group === group && check.required)).toBe(true);
    }
  });

  it('prints every check, the problems and the verdict', () => {
    const bad = report({}, ['gate-control'], { 'worker-denied-read': 'fail' });
    const text = formatVmReadiness(bad, evaluateVmReadiness(bad));
    expect(text).toContain('FAIL      required worker-denied-read: measured worker-denied-read');
    expect(text).toContain('MISSING   required gate-control: -');
    expect(text).toContain('NOT READY.');
    const good = report();
    expect(formatVmReadiness(good, evaluateVmReadiness(good))).toContain(
      'READY: every required check passed.',
    );
  });
});
