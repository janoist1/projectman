import { z } from 'zod';

/**
 * The readiness contract of the managed VM profile (PM-137, part of PM-135).
 *
 * `deploy/vm/verify.sh` measures the machine and writes a report: one entry per check, each with
 * a status and the evidence it saw. This module is the only place that says which checks exist,
 * which ones are required and when a report counts as ready. A machine is ready because
 * measurements passed, never because something claims to be a VM: the report schema is strict, so
 * a report that carries a `vm: true` style flag is refused, and a missing check is a failure.
 */

/** Bump when a check is added, removed or changes meaning; an old report is then not ready. */
export const VM_PROFILE_VERSION = 1;
export const VM_PROFILE_NAME = 'managed-vm';
const CLOCK_SKEW_MS = 5 * 60_000;

export const VmCheckStatus = z.enum(['pass', 'fail', 'unverified']);
export type VmCheckStatus = z.infer<typeof VmCheckStatus>;

export type VmCheckGroup =
  'versions' | 'accounts' | 'protected-paths' | 'host-isolation' | 'network-gate' | 'service';

export interface VmCheckDefinition {
  id: string;
  group: VmCheckGroup;
  /** A required check must pass for the baseline to be ready; the others are reported only. */
  required: boolean;
  /** What a pass means, in one sentence. */
  meaning: string;
}

/**
 * Every check of the profile. The ones that are not required describe work that later parts of
 * PM-135 deliver (the protected launcher and the domain-level network gate, PM-140) or that depends
 * on the network of the day; the report shows their state so nobody mistakes them for done.
 */
export const VM_CHECKS: readonly VmCheckDefinition[] = [
  // versions
  { id: 'os', group: 'versions', required: true, meaning: 'The guest runs the pinned Linux release.' },
  {
    id: 'node',
    group: 'versions',
    required: true,
    meaning: 'Node has the pinned major version and is at least the minimum.',
  },
  {
    id: 'claude-cli',
    group: 'versions',
    required: true,
    meaning: 'The Claude Code CLI is the pinned version, installed in the root-owned prefix.',
  },
  {
    id: 'codex-cli',
    group: 'versions',
    required: true,
    meaning: 'The Codex CLI is the pinned version, installed in the root-owned prefix.',
  },
  {
    id: 'app-build',
    group: 'versions',
    required: true,
    meaning:
      'The app is built from a recorded commit and is owned by root, so no account of the service or the workers can change it.',
  },
  // accounts
  {
    id: 'service-account',
    group: 'accounts',
    required: true,
    meaning: 'The service runs as its own unprivileged account with no sudo rights.',
  },
  {
    id: 'workers-present',
    group: 'accounts',
    required: true,
    meaning: 'At least two worker accounts exist, in the reserved uid range, each with its own group.',
  },
  {
    id: 'workers-unprivileged',
    group: 'accounts',
    required: true,
    meaning: 'No worker has sudo rights, an extra group, a usable password or a way to log in.',
  },
  // protected paths
  {
    id: 'paths-owner-mode',
    group: 'protected-paths',
    required: true,
    meaning: 'The protected paths have the expected owner and mode.',
  },
  {
    id: 'worker-denied-read',
    group: 'protected-paths',
    required: true,
    meaning: 'No worker can read the data directory, the database, the cookie secret or the service home.',
  },
  {
    id: 'worker-denied-write',
    group: 'protected-paths',
    required: true,
    meaning: 'No worker can write the app, the boundary configuration, the gate rules or the service unit.',
  },
  {
    id: 'worker-isolation',
    group: 'protected-paths',
    required: true,
    meaning: "No worker can read or write another worker's home.",
  },
  {
    id: 'no-credential-copies',
    group: 'protected-paths',
    required: true,
    meaning: 'No provider or GitHub login file lies in a worker home: the login is not a standing copy.',
  },
  {
    id: 'proc-hidden',
    group: 'protected-paths',
    required: true,
    meaning: 'A worker cannot see the processes (and arguments) of other accounts.',
  },
  {
    id: 'service-hardening',
    group: 'protected-paths',
    required: true,
    meaning: 'The service unit carries its hardening settings.',
  },
  // host isolation
  {
    id: 'no-host-mounts',
    group: 'host-isolation',
    required: true,
    meaning: 'No directory of the host is shared into the guest.',
  },
  {
    id: 'no-agent-forwarding',
    group: 'host-isolation',
    required: true,
    meaning: 'SSH agent forwarding is off and no agent socket exists.',
  },
  {
    id: 'worker-sockets',
    group: 'host-isolation',
    required: true,
    meaning:
      'No worker can use a control socket (container, hypervisor or guest agent) outside the allowed list.',
  },
  {
    id: 'listeners',
    group: 'host-isolation',
    required: true,
    meaning: 'Only loopback and the SSH port listen; the app listens on loopback only.',
  },
  // network gate
  {
    id: 'gate-loaded',
    group: 'network-gate',
    required: true,
    meaning: 'The system-managed egress rules are loaded and start at boot.',
  },
  {
    id: 'gate-control',
    group: 'network-gate',
    required: true,
    meaning:
      'A listener on a private address of the guest accepts the root user but refuses the service and a worker.',
  },
  {
    id: 'gate-blocks-host',
    group: 'network-gate',
    required: true,
    meaning:
      'Neither the service nor a worker can connect to the host, the gateway, the LAN, the metadata address or the tailnet.',
  },
  {
    id: 'egress-open',
    group: 'network-gate',
    required: false,
    meaning:
      'A worker can still reach the public internet (a registry); a gate that blocks everything is not usable.',
  },
  {
    id: 'domain-gate',
    group: 'network-gate',
    required: false,
    meaning: 'Outgoing traffic is limited to allowed domains (the protected network gate of PM-140).',
  },
  {
    id: 'launcher',
    group: 'network-gate',
    required: false,
    meaning: 'The protected launcher starts sessions as the worker accounts (PM-140).',
  },
  // service
  {
    id: 'service-active',
    group: 'service',
    required: true,
    meaning: 'The service is active and serves the API on loopback.',
  },
  {
    id: 'tailscale',
    group: 'service',
    required: false,
    meaning: 'Tailscale Serve proxies the loopback port, and Funnel is off.',
  },
];

const REQUIRED = VM_CHECKS.filter((check) => check.required).map((check) => check.id);

export const VmCheckResult = z
  .object({
    id: z.string().min(1).max(64),
    status: VmCheckStatus,
    /** What was measured. Never a secret: paths, modes, counts, versions and error names only. */
    evidence: z.string().min(1).max(600),
  })
  .strict();
export type VmCheckResult = z.infer<typeof VmCheckResult>;

export const VmReadinessReport = z
  .object({
    schemaVersion: z.literal(1),
    profile: z.object({ name: z.string(), version: z.number().int() }).strict(),
    generatedAt: z.string().datetime({ offset: true }),
    host: z.object({ os: z.string(), kernel: z.string(), arch: z.string() }).strict(),
    checks: z.array(VmCheckResult).max(200),
  })
  .strict();
export type VmReadinessReport = z.infer<typeof VmReadinessReport>;

export interface VmReadiness {
  /** The baseline is ready: the report is current and every required check passed. */
  ready: boolean;
  /** Required checks the report does not contain at all. */
  missing: string[];
  /** Required checks that failed. */
  failed: string[];
  /** Required checks that were not measured. */
  unverified: string[];
  /** Checks that are not required and did not pass: later parts of PM-135 or the network of the day. */
  pending: string[];
  /** Problems with the report itself: other profile, duplicated checks, an old report. */
  problems: string[];
}

export interface EvaluateOptions {
  now?: Date;
  /** Reports older than this are not ready. No limit when omitted. */
  maxAgeMs?: number;
}

/** A plain-text summary for the operator: every check with its status, then the verdict. */
export function formatVmReadiness(report: VmReadinessReport, readiness: VmReadiness): string {
  const byId = new Map(report.checks.map((check) => [check.id, check]));
  const lines = [
    `profile ${report.profile.name}@${report.profile.version}, ${report.host.os}, ${report.host.arch}, ${report.generatedAt}`,
  ];
  for (const definition of VM_CHECKS) {
    const check = byId.get(definition.id);
    const status = check ? check.status.toUpperCase() : 'MISSING';
    lines.push(
      `${status.padEnd(10)}${definition.required ? 'required ' : 'reported '}${definition.id}: ${check?.evidence ?? '-'}`,
    );
  }
  for (const problem of readiness.problems) lines.push(`PROBLEM   ${problem}`);
  lines.push(readiness.ready ? 'READY: every required check passed.' : 'NOT READY.');
  if (readiness.pending.length > 0)
    lines.push(
      `Not passed, not required (later parts of PM-135 or the network): ${readiness.pending.join(', ')}`,
    );
  return lines.join('\n');
}

/** The one rule: ready only when the report is for this profile, current and every required check passed. */
export function evaluateVmReadiness(report: VmReadinessReport, options: EvaluateOptions = {}): VmReadiness {
  const problems: string[] = [];
  if (report.profile.name !== VM_PROFILE_NAME || report.profile.version !== VM_PROFILE_VERSION) {
    problems.push(
      `report is for profile ${report.profile.name}@${report.profile.version}, not ${VM_PROFILE_NAME}@${VM_PROFILE_VERSION}`,
    );
  }
  if (options.maxAgeMs !== undefined) {
    const age = (options.now ?? new Date()).getTime() - Date.parse(report.generatedAt);
    // A few minutes of clock difference between the guest and the checker are normal.
    if (!(age >= -CLOCK_SKEW_MS && age <= options.maxAgeMs))
      problems.push('report is too old or dated in the future');
  }
  const byId = new Map<string, VmCheckResult>();
  for (const check of report.checks) {
    if (byId.has(check.id)) problems.push(`duplicated check ${check.id}`);
    else byId.set(check.id, check);
  }
  const missing: string[] = [];
  const failed: string[] = [];
  const unverified: string[] = [];
  for (const id of REQUIRED) {
    const check = byId.get(id);
    if (!check) missing.push(id);
    else if (check.status === 'fail') failed.push(id);
    else if (check.status === 'unverified') unverified.push(id);
  }
  const pending = VM_CHECKS.filter(
    (definition) => !definition.required && byId.get(definition.id)?.status !== 'pass',
  ).map((definition) => definition.id);
  const ready =
    problems.length === 0 && missing.length === 0 && failed.length === 0 && unverified.length === 0;
  return { ready, missing, failed, unverified, pending, problems };
}
