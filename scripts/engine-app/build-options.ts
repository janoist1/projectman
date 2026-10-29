export interface HeldLock {
  release(): Promise<void>;
}

/**
 * The seams of the preparation. Production code gives none of them; tests pass fakes. Nothing here can widen
 * what the preparation may touch: a missing sandbox, queue or builder is an error, never a host fallback.
 */
export interface BuildOptions {
  /** Stops the preparation like an interrupt of the process does. */
  signal?: AbortSignal;
  /** The engine's home (`PROJECTMAN_HOME`), which no build step may read; default `PROJECTMAN_HOME` or `~/.projectman`. */
  engineHome?: string;
  /** The user's home, closed to the sandboxed steps; default `deps.homeDir`. */
  userHome?: string;
  /** The root of the sandbox run directory (`pmft-…`); default `os.tmpdir()`, or `/tmp` when that path is too long. */
  tmpDir?: string;
  /** The environment the sandbox's allow list is taken from; default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  timeouts?: Partial<Record<'install' | 'build' | 'check', number>>;
}

export const DEFAULT_TIMEOUTS = {
  install: 30 * 60_000,
  build: 10 * 60_000,
  check: 2 * 60_000,
};
