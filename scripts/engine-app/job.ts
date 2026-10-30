import type { ComputeJobDefinition } from '@projectman/shared';

/**
 * The engine app as a compute job (PM-1156): built on a hosted macOS runner, ad-hoc signed until there is a
 * Developer ID, and fetched back with `npm run engine-app -- fetch`. The disk image is not an output: installing
 * unpacks the zip, so the Mac does not download the image (PM-1157). `docs/DEPLOY.md` "On GitHub (PM-1156)"
 * lists the same values for the registration in `engine.json` and in the hub's `repoComputeJobs`.
 */
export const ENGINE_APP_JOB = {
  id: 'engine-app',
  runsOn: 'macos-15',
  node: '22',
  timeoutMinutes: 60,
  outputs: ['app/projectman-motor.json', 'app/projectman-motor.zip'],
  command:
    'npm ci && npm run engine-app -- package --commit "$PROJECTMAN_JOB_COMMIT" --out "$RUNNER_TEMP/engine-package" && ' +
    'npm run engine-app -- build --package "$RUNNER_TEMP/engine-package/$PROJECTMAN_JOB_COMMIT" --out "$PROJECTMAN_JOB_OUT/app" --ad-hoc',
} satisfies ComputeJobDefinition;
