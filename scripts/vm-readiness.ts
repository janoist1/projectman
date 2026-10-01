// The verdict on a managed-VM readiness report (PM-137).
//
//   npx tsx scripts/vm-readiness.ts REPORT.json [MAX_AGE_MINUTES]
//
// REPORT.json comes from deploy/vm/verify.sh. Exit status: 0 ready, 1 not ready, 2 the report
// cannot be read or is not a report. The rule itself is evaluateVmReadiness() in packages/shared.
import { readFileSync } from 'node:fs';
import { evaluateVmReadiness, formatVmReadiness, VmReadinessReport } from '@projectman/shared';

const [file, maxAgeMinutes] = process.argv.slice(2);
if (!file) {
  console.error('usage: tsx scripts/vm-readiness.ts REPORT.json [MAX_AGE_MINUTES]');
  process.exit(2);
}

let report: VmReadinessReport;
try {
  const parsed = VmReadinessReport.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    console.error(
      `not a readiness report: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
    process.exit(2);
  }
  report = parsed.data;
} catch (error) {
  console.error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const maxAgeMs = maxAgeMinutes ? Number(maxAgeMinutes) * 60_000 : undefined;
const readiness = evaluateVmReadiness(report, maxAgeMs === undefined ? {} : { maxAgeMs });
console.log(formatVmReadiness(report, readiness));
process.exit(readiness.ready ? 0 : 1);
