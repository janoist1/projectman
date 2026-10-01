import { describe, expect, it } from 'vitest';
import {
  evaluateManagedVmActivation,
  managedVmPermissions,
  MANAGED_VM_ACTIVATION_CHECKS,
  parseExecutionProfile,
} from './managed-vm';
import { VM_CHECKS, VM_PROFILE_NAME, VM_PROFILE_VERSION, VmReadinessReport } from './vm-readiness';

function report(status: Record<string, 'pass' | 'fail' | 'unverified'> = {}) {
  return VmReadinessReport.parse({
    schemaVersion: 1,
    profile: { name: VM_PROFILE_NAME, version: VM_PROFILE_VERSION },
    generatedAt: '2026-10-01T12:00:00Z',
    host: { os: 'Ubuntu 24.04 LTS', kernel: '6.8.0', arch: 'aarch64' },
    checks: VM_CHECKS.map((check) => ({
      id: check.id,
      status: status[check.id] ?? (check.required ? 'pass' : 'unverified'),
      evidence: `measured ${check.id}`,
    })),
  });
}

describe('execution profile setting', () => {
  it('defaults to legacy and accepts only the two known profiles', () => {
    expect(parseExecutionProfile(undefined)).toBe('legacy');
    expect(parseExecutionProfile('')).toBe('legacy');
    expect(parseExecutionProfile('  managed_vm ')).toBe('managed_vm');
    expect(parseExecutionProfile('legacy')).toBe('legacy');
    expect(() => parseExecutionProfile('managed-vm')).toThrow(/unknown execution profile/);
    expect(() => parseExecutionProfile('strict')).toThrow(/unknown execution profile/);
    expect(() => parseExecutionProfile('true')).toThrow(/unknown execution profile/);
  });
});

describe('managed VM activation', () => {
  const full = Object.fromEntries(MANAGED_VM_ACTIVATION_CHECKS.map((id) => [id, 'pass' as const]));

  it('is active only for a ready report in which the launcher and the domain gate passed', () => {
    expect(evaluateManagedVmActivation(report(full))).toMatchObject({ active: true, notPassed: [] });
  });

  it('is not active while the launcher and the domain gate are unverified', () => {
    expect(
      evaluateManagedVmActivation(report({ launcher: 'unverified', 'domain-gate': 'unverified' })),
    ).toMatchObject({
      active: false,
      notPassed: ['launcher', 'domain-gate'],
    });
  });

  it('is not active when one of the activation checks failed or only one passed', () => {
    expect(evaluateManagedVmActivation(report({ ...full, launcher: 'fail' })).notPassed).toEqual([
      'launcher',
    ]);
    expect(evaluateManagedVmActivation(report({ launcher: 'unverified' }))).toMatchObject({
      active: false,
      notPassed: ['launcher'],
    });
  });

  it('is not active when a required check failed, whatever the launcher says', () => {
    const result = evaluateManagedVmActivation(report({ ...full, 'gate-blocks-host': 'fail' }));
    expect(result.active).toBe(false);
    expect(result.readiness.failed).toEqual(['gate-blocks-host']);
  });

  it('is not active for an old report', () => {
    const result = evaluateManagedVmActivation(report(full), {
      now: new Date('2026-10-03T12:00:00Z'),
      maxAgeMs: 24 * 60 * 60_000,
    });
    expect(result.active).toBe(false);
    expect(result.readiness.problems).toEqual(['report is too old or dated in the future']);
  });
});

describe('managed VM permissions', () => {
  it('runs every mode question-free, without an inner sandbox, except the research-only plan mode', () => {
    for (const mode of [undefined, 'default', 'acceptEdits', 'auto', 'bypassPermissions', 'nonsense']) {
      expect(managedVmPermissions(mode)).toEqual({
        claude: 'bypassPermissions',
        sandbox: 'danger-full-access',
        approval: 'never',
      });
    }
    expect(managedVmPermissions('plan')).toEqual({ claude: 'plan', sandbox: 'read-only', approval: 'never' });
  });
});
