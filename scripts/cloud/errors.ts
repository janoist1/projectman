/** Exit status: 0 done, 1 failed, 2 refused (a precondition is missing or the state is dangerous), 64 bad usage. */
type CloudExitCode = 1 | 2 | 64;

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

type CloudTransportCode =
  'cloud_ssh_auth_timeout' | 'cloud_ssh_unavailable' | 'cloud_host_busy' | 'cloud_host_identity_mismatch';

/**
 * The SSH-over-SSM transport to the machine failed (PM-748). An internal scripts contract: the CLI still
 * exits 0, 1, 2 or 64. `commandStarted` is `no` only when the remote command provably never began; after a
 * lost answer it is `unknown` and the caller must reconcile the machine's state before it acts again.
 * `retryable` says whether repeating the same call later is safe (never true after an unknown write).
 */
export class CloudTransportError extends CloudError {
  readonly code: CloudTransportCode;
  readonly commandStarted: 'no' | 'unknown';
  readonly retryable: boolean;

  constructor(
    code: CloudTransportCode,
    message: string,
    options: { commandStarted: 'no' | 'unknown'; retryable: boolean; exitCode?: CloudExitCode },
  ) {
    super(message, options.exitCode ?? 1);
    this.name = 'CloudTransportError';
    this.code = code;
    this.commandStarted = options.commandStarted;
    this.retryable = options.retryable;
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
