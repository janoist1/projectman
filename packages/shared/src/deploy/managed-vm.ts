import type { PermissionMode } from '../domain/member';
import {
  evaluateVmReadiness,
  type EvaluateOptions,
  type VmReadiness,
  type VmReadinessReport,
} from './vm-readiness';

/**
 * The execution profile of a session (PM-141, part of PM-135).
 *
 * - `legacy`: the Mac installation as it always was: permission modes, the command broker, the
 *   per-provider sandbox. Nothing in it changes.
 * - `managed_vm`: the owner's verified managed VM (docs/VM.md). The boundary (accounts, protected
 *   paths, network gate, launcher) is outside the CLIs, so the CLIs run without local approval
 *   questions. It is an installation setting the owner makes and a verified readiness report
 *   backs; a member's `permissionMode`, a repository file or an environment flag alone never
 *   selects it (`evaluateManagedVmActivation`).
 */
export const EXECUTION_PROFILES = ['legacy', 'managed_vm'] as const;
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

export const DEFAULT_EXECUTION_PROFILE: ExecutionProfile = 'legacy';

/** The installation's profile from its setting; an unknown value is an error, never a fallback. */
export function parseExecutionProfile(value: string | undefined | null): ExecutionProfile {
  const text = value?.trim() ?? '';
  if (text === '') return DEFAULT_EXECUTION_PROFILE;
  if ((EXECUTION_PROFILES as readonly string[]).includes(text)) return text as ExecutionProfile;
  throw new Error(`unknown execution profile: ${text} (${EXECUTION_PROFILES.join(' or ')})`);
}

/**
 * The CLI versions the managed VM runs the no-local-approval settings on. They are the versions
 * `deploy/vm/profile.env` pins (a test keeps the two in step): the runner refuses a CLI of another
 * version, because the settings the adapters pass (docs/PROVIDERS.md) were written and tried
 * against these, and a newer release may read the same flags differently.
 */
export const MANAGED_VM_PROVIDER_VERSIONS = {
  claude: ['2.1.284'],
  codex: ['0.159.1'],
} as const satisfies Record<'claude' | 'codex', readonly string[]>;
export type ManagedVmProvider = keyof typeof MANAGED_VM_PROVIDER_VERSIONS;
export function isManagedVmProvider(provider: string): provider is ManagedVmProvider {
  return Object.hasOwn(MANAGED_VM_PROVIDER_VERSIONS, provider);
}

/**
 * Checks that are only reported in the baseline readiness report (PM-137) but that the question-free
 * profile needs to pass: the protected launcher that starts sessions as the workers (PM-140) and
 * the domain-level network gate. Without them the boundary is not complete.
 */
export const MANAGED_VM_ACTIVATION_CHECKS = ['launcher', 'domain-gate'] as const;

export interface ManagedVmActivation {
  /** The boundary is complete: a ready report and every activation check passed. */
  active: boolean;
  readiness: VmReadiness;
  /** Activation checks that did not pass (missing, failed or unverified). */
  notPassed: string[];
}

/**
 * The one rule that lets the question-free profile start: the report is ready (the baseline's
 * rule) and the launcher and domain gate passed too. A flag is never an input.
 */
export function evaluateManagedVmActivation(
  report: VmReadinessReport,
  options: EvaluateOptions = {},
): ManagedVmActivation {
  const readiness = evaluateVmReadiness(report, options);
  const status = new Map(report.checks.map((check) => [check.id, check.status]));
  const notPassed = MANAGED_VM_ACTIVATION_CHECKS.filter((id) => status.get(id) !== 'pass');
  return { active: readiness.ready && notPassed.length === 0, readiness, notPassed };
}

/**
 * What the CLIs get in the managed VM, from the member's own mode: `plan` stays research-only
 * (a member never gets less free than it asked for, and `plan` is a choice about the work, not a
 * guard); every other mode runs without local questions. The member's mode is read, never
 * rewritten, so leaving the profile restores exactly what was configured.
 */
export function managedVmPermissions(mode: string | undefined) {
  const research = (mode as PermissionMode | undefined) === 'plan';
  return {
    claude: research ? ('plan' as const) : ('bypassPermissions' as const),
    sandbox: research ? ('read-only' as const) : ('danger-full-access' as const),
    approval: 'never' as const,
  };
}
