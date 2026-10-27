import { relative } from 'node:path';
import type { Reporter } from 'vitest/reporters';

export const FILE_EVENT_PREFIX = 'merge-test file: ';

/** Runs in Vitest's controller, including while a worker is collecting a file. */
export default class MergeTestReporter implements Reporter {
  onTestModuleQueued: Reporter['onTestModuleQueued'] = (module) => {
    this.report('start', module);
  };

  onTestModuleEnd: Reporter['onTestModuleEnd'] = (module) => {
    this.report('end', module);
  };

  private report(phase: 'start' | 'end', module: Parameters<NonNullable<Reporter['onTestModuleQueued']>>[0]) {
    console.log(
      FILE_EVENT_PREFIX +
        JSON.stringify({ phase, id: module.id, file: relative(process.cwd(), module.moduleId) }),
    );
  }
}
