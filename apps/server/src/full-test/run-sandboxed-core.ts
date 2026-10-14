import { spawn } from 'node:child_process';
import { Deferred, Effect } from 'effect';
import { OutputTail } from './output';
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
      let timedOut = false;
      let aborted = false;
      const child = yield* Effect.sync(() => {
        const child = spawn(run.file, run.args, {
          cwd: run.cwd,
          env: run.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => tail.push(chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => tail.push(chunk));
        child.on('error', (spawnError) =>
          Deferred.doneUnsafe(exited, Effect.succeed({ exitCode: null, signal: null, spawnError })),
        );
        child.on('close', (exitCode, signal) =>
          Deferred.doneUnsafe(exited, Effect.succeed({ exitCode, signal })),
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
      // A child that detached itself may outlive the shell; the group is stopped either way.
      yield* Effect.addFinalizer(() => Effect.sync(() => killGroup('SIGKILL')));
      const stop = (mark: () => void) =>
        Effect.sync(() => {
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
        ),
      );
      const end = yield* Deferred.await(exited);
      return { ...end, timedOut, aborted, output: tail.value() };
    }),
  );
