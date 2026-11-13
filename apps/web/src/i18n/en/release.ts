/** The release of the instance (PM-387, PM-492). */
export const release = {
  /** The step of a deploy a release stopped in, as a noun phrase: "Stuck at: {step}". */
  steps: {
    fetch: 'download from GitHub',
    build: 'build',
    test: 'release test',
    config_check: 'checking the configuration',
    pause: 'pausing the running work',
    stop: 'stopping the old version',
    backup: 'database backup',
    switch: 'switching to the new version',
    verify: 'checking the new version',
    rollback: 'rolling back to the old version',
    publish: 'tag and GitHub release',
  },
} as const;
