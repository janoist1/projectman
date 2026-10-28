import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { Deferred, Effect } from 'effect';
import { OutputTail } from './output';
import { PROCESS_GROUP_GUARD } from './process-group-guard';
import type { SandboxedEnd } from './run-sandboxed';

export interface GroupRun {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  killGraceMs: number;
  signal: AbortSignal;
}

export const runProcessGroup = (run: GroupRun): Effect.Effect<SandboxedEnd> =>
  Effect.scoped(
    Effect.gen(function* () {
      const tail = new OutputTail();
      const exited = Deferred.makeUnsafe<Omit<SandboxedEnd, 'timedOut' | 'aborted' | 'output'>>();
      const stopped = Deferred.makeUnsafe<void>();
      const escalated = Deferred.makeUnsafe<void>();
      let timedOut = false;
      let aborted = false;
      let commandEnd: Omit<SandboxedEnd, 'timedOut' | 'aborted' | 'output'> | undefined;
      const child = yield* Effect.sync(() => {
        const child = spawn(
          process.execPath,
          ['-e', PROCESS_GROUP_GUARD, JSON.stringify([run.file, run.args, run.killGraceMs])],
          {
            cwd: run.cwd,
            env: run.env,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          },
        );
        child.stdout!.setEncoding('utf8').on('data', (chunk: string) => tail.push(chunk));
        child.stderr!.setEncoding('utf8').on('data', (chunk: string) => tail.push(chunk));
        child.on('message', (message: unknown) => {
          if (!message || typeof message !== 'object') return;
          const end = message as Record<string, unknown>;
          if (
            (end.exitCode === null || (typeof end.exitCode === 'number' && Number.isInteger(end.exitCode))) &&
            (end.signal === null ||
              (typeof end.signal === 'string' && Object.hasOwn(constants.signals, end.signal)))
          )
            commandEnd = {
              exitCode: end.exitCode as number | null,
              signal: end.signal as NodeJS.Signals | null,
              ...(typeof end.error === 'string' ? { spawnError: new Error(end.error) } : {}),
            };
        });
        child.on('error', (spawnError) =>
          Deferred.doneUnsafe(exited, Effect.succeed({ exitCode: null, signal: null, spawnError })),
        );
        child.on('close', (exitCode, signal) =>
          Deferred.doneUnsafe(exited, Effect.succeed(commandEnd ?? { exitCode, signal })),
        );
        return child;
      });
      const killGroup = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* The group is already gone. */
        }
      };
      // Descendants may outlive the shell, even when they have closed its output pipes.
      yield* Effect.addFinalizer(() => Effect.sync(() => killGroup('SIGKILL')));
      const stop = (mark: () => void) =>
        Effect.sync(() => {
          if (timedOut || aborted) return;
          mark();
          killGroup('SIGTERM');
          Deferred.doneUnsafe(stopped, Effect.void);
        });
      const abort = Effect.callback<void>((resume) => {
        const onAbort = () => resume(Effect.void);
        if (run.signal.aborted) onAbort();
        else run.signal.addEventListener('abort', onAbort, { once: true });
        return Effect.sync(() => run.signal.removeEventListener('abort', onAbort));
      });
      yield* Effect.forkScoped(
        Effect.sleep(Math.max(1, run.timeoutMs)).pipe(
          Effect.andThen(
            stop(() => {
              timedOut = true;
            }),
          ),
        ),
      );
      yield* Effect.forkScoped(
        abort.pipe(
          Effect.andThen(
            stop(() => {
              aborted = true;
            }),
          ),
        ),
      );
      yield* Effect.forkScoped(
        Deferred.await(stopped).pipe(
          Effect.andThen(Effect.sleep(run.killGraceMs)),
          Effect.andThen(Effect.sync(() => killGroup('SIGKILL'))),
          Effect.andThen(Deferred.succeed(escalated, undefined)),
        ),
      );
      const end = yield* Deferred.await(exited);
      // Closing the leader's pipes must not cancel escalation for surviving descendants.
      // Keep the scope (and its grace-period fiber) alive until the whole group was killed.
      if (timedOut || aborted) yield* Deferred.await(escalated);
      return { ...end, timedOut, aborted, output: tail.value() };
    }),
  );
