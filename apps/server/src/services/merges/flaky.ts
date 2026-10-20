import { mergeTestMarkedFiles } from '@projectman/shared';
import type { FullTestResult } from '../../contracts';

/** The test files a passed merge check reran once and then passed (PM-842); empty for any other result. */
export function flakyCheckFiles(result: Pick<FullTestResult, 'outcome' | 'outputTail'>): string[] {
  return result.outcome === 'passed' ? mergeTestMarkedFiles(result.outputTail, 'flaky') : [];
}

/** The system note a card gets when its merge check passed only after a rerun. */
export function flakyCheckNote(runId: string, files: readonly string[]): string {
  return `Merge check ${runId} passed after rerunning these test files once (flaky): ${files.join(', ')}`;
}
