/** Exit status: 0 done, 1 failed, 2 refused (a precondition is missing or the state is dangerous), 64 bad usage. */
export type CloudExitCode = 1 | 2 | 64;

export class CloudError extends Error {
  readonly exitCode: CloudExitCode;
  /** True once a `FAIL <step>: <reason>` line has been printed for it. */
  reported = false;

  constructor(message: string, exitCode: CloudExitCode = 1) {
    super(message);
    this.name = 'CloudError';
    this.exitCode = exitCode;
  }
}

/** A precondition is missing or the state is dangerous: nothing was changed (exit status 2). */
export function refused(message: string): CloudError {
  return new CloudError(message, 2);
}

/** Bad command line (exit status 64). */
export function badUsage(message: string): CloudError {
  return new CloudError(message, 64);
}
