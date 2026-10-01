/** Seconds after the first signal during which another signal is not a forced exit. */
export const FORCE_EXIT_GRACE_MS = 3000;

export interface ShutdownOptions {
  /** Closes the server: sessions, then the database. */
  close: () => Promise<void>;
  exit: (code: number) => void;
  log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
  now?: () => number;
  graceMs?: number;
}

/**
 * Builds the signal handler. `npm start` (and the npm run chain behind it) forwards the signal
 * a second time right after the first, so a repeated signal only forces the exit once the
 * grace period has passed: a person pressing Ctrl-C again because the shutdown hangs.
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => void {
  const { close, exit, log, now = Date.now, graceMs = FORCE_EXIT_GRACE_MS } = options;
  let startedAt: number | null = null;
  return (signal) => {
    if (startedAt !== null) {
      if (now() - startedAt < graceMs) {
        log.info({ signal }, 'ignoring repeated signal during shutdown');
        return;
      }
      log.warn({ signal }, 'forced exit');
      exit(1);
      return;
    }
    startedAt = now();
    log.info({ signal }, 'shutting down');
    close().then(
      () => exit(0),
      (err: unknown) => {
        log.error({ err }, 'shutdown failed');
        exit(1);
      },
    );
  };
}
