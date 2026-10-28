import { basename } from 'node:path';
import { execa } from 'execa';

export const EXEC_KILL_GRACE_MS = 5_000;
export const EXEC_DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export type ExecFailureReason =
  'exit_code' | 'timeout' | 'output_too_large' | 'spawn_failed' | 'canceled' | 'signal';

export interface ExecCommandOptions {
  /** The complete child environment, without inheritance from the parent. */
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  timeoutMs?: number;
  /** Limit in bytes for each output stream. */
  maxOutputBytes?: number;
  okExitCodes?: readonly number[] | 'any';
  input?: string;
  encoding?: 'utf8' | 'buffer';
  cancelSignal?: AbortSignal;
}

export interface ExecCommandResult<Out extends string | Buffer = string> {
  stdout: Out;
  stderr: string;
  exitCode: number;
}

interface Failure {
  reason: ExecFailureReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  code: string | null;
  stdout: string | Buffer;
  stderr: string;
}

export class ExecCommandError extends Error {
  readonly reason: ExecFailureReason;
  readonly file: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly code: string | null;
  readonly stdout: string | Buffer;
  readonly stderr: string;

  constructor(file: string, args: readonly string[], failure: Failure, options: ExecCommandOptions) {
    const name = basename(file);
    const messages: Record<ExecFailureReason, string> = {
      exit_code: `${name} exited with code ${failure.exitCode}`,
      timeout: `${name} did not finish within ${options.timeoutMs} ms`,
      output_too_large: `${name} printed more than ${options.maxOutputBytes ?? EXEC_DEFAULT_MAX_OUTPUT_BYTES} bytes`,
      spawn_failed: `${name} could not start${failure.code ? ` (${failure.code})` : ''}`,
      canceled: `${name} was canceled`,
      signal: `${name} was killed by ${failure.signal}`,
    };
    super(messages[failure.reason]);
    this.name = 'ExecCommandError';
    this.reason = failure.reason;
    this.file = file;
    this.args = [...args];
    this.exitCode = failure.exitCode;
    this.signal = failure.signal;
    this.code = failure.code;
    this.stdout = failure.stdout;
    this.stderr = failure.stderr;
  }
}

/** Internal factory: tests shorten the fixed production TERM-to-KILL grace period. */
export function createExecCommand({ killGraceMs }: { killGraceMs: number }) {
  function execCommand(
    file: string,
    args: readonly string[],
    options: ExecCommandOptions & { encoding: 'buffer' },
  ): Promise<ExecCommandResult<Buffer>>;
  function execCommand(
    file: string,
    args: readonly string[],
    options: ExecCommandOptions & { encoding?: 'utf8' },
  ): Promise<ExecCommandResult<string>>;
  async function execCommand(
    file: string,
    args: readonly string[],
    options: ExecCommandOptions,
  ): Promise<ExecCommandResult<string | Buffer>> {
    const result = await execa(file, args, {
      env: options.env,
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes ?? EXEC_DEFAULT_MAX_OUTPUT_BYTES,
      cancelSignal: options.cancelSignal,
      ...(options.input === undefined ? { stdin: 'ignore' as const } : { input: options.input }),
      extendEnv: false,
      cleanup: false,
      verbose: 'none',
      stripFinalNewline: false,
      reject: false,
      encoding: 'buffer',
      forceKillAfterDelay: killGraceMs,
      killSignal: 'SIGTERM',
      shell: false,
      preferLocal: false,
      windowsHide: true,
    });
    const bytes = Buffer.from(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
    const stdout = options.encoding === 'buffer' ? bytes : bytes.toString('utf8');
    const stderr = Buffer.from(
      result.stderr.buffer,
      result.stderr.byteOffset,
      result.stderr.byteLength,
    ).toString('utf8');
    let reason: ExecFailureReason | undefined;
    if (result.isCanceled) reason = 'canceled';
    else if (result.timedOut) reason = 'timeout';
    else if (result.isMaxBuffer) reason = 'output_too_large';
    else if (result.exitCode === undefined && result.signal === undefined) reason = 'spawn_failed';
    else if (result.signal !== undefined) reason = 'signal';
    else if (options.okExitCodes !== 'any' && !(options.okExitCodes ?? [0]).includes(result.exitCode!))
      reason = 'exit_code';
    if (reason !== undefined) {
      throw new ExecCommandError(
        file,
        args,
        {
          reason,
          exitCode: reason === 'exit_code' ? result.exitCode! : null,
          signal: result.signal ?? null,
          code: reason === 'spawn_failed' ? (result.code ?? null) : null,
          stdout,
          stderr,
        },
        options,
      );
    }
    return { stdout, stderr, exitCode: result.exitCode! };
  }
  return execCommand;
}

export const execCommand = createExecCommand({ killGraceMs: EXEC_KILL_GRACE_MS });
