import { readFile } from 'node:fs/promises';
import { VmReadinessReport, evaluateVmReadiness } from '@projectman/shared';
import type { RuntimeBoundaryStatus } from '@projectman/shared';

/**
 * The readiness part of the boundary verdict: the root-written report of deploy/vm/verify.sh,
 * judged by the shared rule (`evaluateVmReadiness`) and refused when it is missing, malformed,
 * for another profile version or older than the configured limit. Fail closed: any doubt is a
 * problem code.
 */
export async function readinessProblems(opts: {
  file: string;
  profileVersion: number;
  maxAgeMs: number;
  now: Date;
  read?: (file: string) => Promise<string>;
}): Promise<{ problems: string[]; readiness: RuntimeBoundaryStatus['readiness'] }> {
  let text: string;
  try {
    text = await (opts.read ?? ((f) => readFile(f, 'utf8')))(opts.file);
  } catch {
    return { problems: ['readiness_report_missing'], readiness: null };
  }
  let report: VmReadinessReport;
  try {
    report = VmReadinessReport.parse(JSON.parse(text));
  } catch {
    return { problems: ['readiness_report_invalid'], readiness: null };
  }
  const verdict = evaluateVmReadiness(report, { now: opts.now, maxAgeMs: opts.maxAgeMs });
  const problems: string[] = [];
  if (report.profile.version !== opts.profileVersion || verdict.problems.some((p) => p.startsWith('report is for')))
    problems.push('readiness_wrong_profile');
  if (verdict.problems.some((p) => p.includes('too old')))
    problems.push('readiness_report_stale');
  if (verdict.problems.some((p) => p.startsWith('duplicated'))) problems.push('readiness_report_invalid');
  for (const id of [...verdict.missing, ...verdict.failed, ...verdict.unverified]) problems.push(`readiness:${id}`);
  return {
    problems,
    readiness: {
      generatedAt: report.generatedAt,
      profileVersion: report.profile.version,
      missing: verdict.missing,
      failed: verdict.failed,
      unverified: verdict.unverified,
      pending: verdict.pending,
    },
  };
}
