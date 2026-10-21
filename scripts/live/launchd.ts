import { DEFAULT_PAUSE_FORCE_AFTER_MS } from '@projectman/shared';
import type { ControlRequest, ControlResponse } from '@projectman/shared';
import { ControlUnreachable } from '../control/client';
import type { LiveDeps, RunResult } from './deps';
import { domainTarget, LiveError, plistFile } from './paths';

/** The pieces the install and the watcher share: launchctl, the control socket and the checks that a server came up. */

export const POLL_MS = 2_000;
export const VERIFY_TIMEOUT_MS = 120_000;
/** The pause waits for the sessions to stop (the forced stop comes after `DEFAULT_PAUSE_FORCE_AFTER_MS`). */
export const PAUSE_WAIT_MS = DEFAULT_PAUSE_FORCE_AFTER_MS + 60_000;

/** launchctl's "5: Input/output error" can persist while the old job is being torn down. */
const BOOTSTRAP_BUSY = 5;
const BOOTSTRAP_TIMEOUT_MS = 30_000;
const BOOTSTRAP_WAIT_MS = 500;
const BOOTOUT_TIMEOUT_MS = 120_000;
/** 3: "no such process" (not loaded); 113: could not find the service. Both mean there is nothing to unload. */
const NOT_LOADED = [3, 113];

/** What the launchd helpers use of the deps: the hybrid release's own LaunchAgent commands take the same (PM-751). */
export type LaunchdDeps = Pick<LiveDeps, 'run' | 'uid' | 'now' | 'sleep' | 'homeDir'>;

export const launchctl = (deps: LaunchdDeps, args: string[]): Promise<RunResult> =>
  deps.run('launchctl', args, { cwd: deps.homeDir, timeoutMs: 60_000 });

export async function isLoaded(deps: LaunchdDeps, label: string): Promise<boolean> {
  return (await launchctl(deps, ['print', domainTarget(deps.uid, label)])).status === 0;
}

/** Unloads a job and waits for launchd to release it; an absent job is no error. */
export async function bootout(deps: LaunchdDeps, label: string): Promise<RunResult> {
  const result = await launchctl(deps, ['bootout', domainTarget(deps.uid, label)]);
  if (result.status !== 0 && !NOT_LOADED.includes(result.status)) return result;
  if (!(await waitUntil(deps, BOOTOUT_TIMEOUT_MS, async () => !(await isLoaded(deps, label)), 500)))
    return { status: 1, stdout: result.stdout, stderr: `launchd did not unload ${label} within 120 s` };
  return { ...result, status: 0 };
}

export async function bootstrap(deps: LaunchdDeps, label: string): Promise<RunResult> {
  const args = ['bootstrap', `gui/${deps.uid}`, plistFile(deps.homeDir, label)];
  const deadline = deps.now().getTime() + BOOTSTRAP_TIMEOUT_MS;
  let result = await launchctl(deps, args);
  while (result.status === BOOTSTRAP_BUSY && deps.now().getTime() < deadline) {
    await deps.sleep(Math.min(BOOTSTRAP_WAIT_MS, deadline - deps.now().getTime()));
    result = await launchctl(deps, args);
  }
  return result;
}

/** One control request; null when the server does not answer. */
export async function tryControl(deps: LiveDeps, request: ControlRequest): Promise<ControlResponse | null> {
  try {
    return await deps.control(request);
  } catch (error) {
    if (error instanceof ControlUnreachable) return null;
    throw error;
  }
}

/** Polls until the check holds or the time is out; the clock and the waiting are the deps'. */
export async function waitUntil(
  deps: Pick<LiveDeps, 'now' | 'sleep'>,
  timeoutMs: number,
  check: () => Promise<boolean>,
  intervalMs = POLL_MS,
): Promise<boolean> {
  const deadline = deps.now().getTime() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (deps.now().getTime() >= deadline) return false;
    await deps.sleep(intervalMs);
  }
}

/** The server runs this commit, listens on the port and serves the setup endpoint. */
export async function verifyServer(
  deps: LiveDeps,
  options: { port: number; commit: string; timeoutMs?: number },
): Promise<boolean> {
  return waitUntil(deps, options.timeoutMs ?? VERIFY_TIMEOUT_MS, async () => {
    if (!(await deps.portListening(options.port))) return false;
    if ((await deps.httpStatus(`http://127.0.0.1:${options.port}/api/setup`)) !== 200) return false;
    const status = await tryControl(deps, { op: 'status' });
    return status?.ok === true && status.appVersion === options.commit;
  });
}

/** Asks for the pause and waits until every session has stopped. */
export async function pauseAndWait(
  deps: LiveDeps,
  reason: string,
): Promise<{ ok: boolean; message: string }> {
  const first = await tryControl(deps, { op: 'pause', reason });
  if (!first) return { ok: false, message: 'the server does not answer on its control socket' };
  if (!first.ok) return { ok: false, message: `${first.error.code}: ${first.error.message}` };
  const paused = await waitUntil(deps, PAUSE_WAIT_MS, async () => {
    const status = await tryControl(deps, { op: 'status' });
    return status?.ok === true && status.pause?.state === 'paused';
  });
  return paused ? { ok: true, message: '' } : { ok: false, message: 'the sessions did not stop in time' };
}

export async function resume(deps: LiveDeps): Promise<boolean> {
  const answer = await tryControl(deps, { op: 'resume' });
  return answer?.ok === true;
}

export async function waitPortFree(deps: LiveDeps, port: number, timeoutMs: number): Promise<boolean> {
  return waitUntil(deps, timeoutMs, async () => !(await deps.portListening(port)));
}

export function requireMac(deps: LiveDeps): void {
  if (deps.platform !== 'darwin')
    throw new LiveError('The live instance runs under launchd, which is macOS only.', 2);
}
