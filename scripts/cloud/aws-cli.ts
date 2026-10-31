import type { z } from 'zod';
import type { CloudDeps, RunResult } from './deps';
import { CloudError } from './errors';

/**
 * The `aws` CLI v2 as the cloud commands use it (PM-534): always argv, never a shell, `--output json`, and the
 * profile and region from the configuration on every call. No AWS SDK. A secret never goes into `args`; the
 * only secrets that pass here come back on the standard output of `iam create-access-key`.
 *
 * Two ways to authenticate (PM-1197): a named profile of this computer (every command but one), or the ambient
 * credentials of the environment (`runner-deploy` on a GitHub runner, where `configure-aws-credentials` has put
 * the OIDC session into the environment); the ambient mode adds no `--profile`.
 */

type AwsAuth = { kind: 'profile'; profile: string } | { kind: 'ambient' };

interface AwsTarget {
  auth: AwsAuth;
  region: string;
}

/** The target of a call made with a named profile. */
export function profileTarget(target: { profile: string; region: string }): AwsTarget {
  return { auth: { kind: 'profile', profile: target.profile }, region: target.region };
}

interface AwsCallOptions {
  signal?: AbortSignal;
  /** Suppress raw AWS output in protected administration protocols. */
  redactErrors?: boolean;
}

/** A failed `aws` call; `awsCode` is the error code the CLI prints (`NoSuchEntity`, `404`, …) when there is one. */
export class AwsCallError extends CloudError {
  readonly awsCode: string | null;
  readonly operation: string;

  constructor(operation: string, awsCode: string | null, message: string) {
    super(message, 1);
    this.name = 'AwsCallError';
    this.awsCode = awsCode;
    this.operation = operation;
  }
}

const CALL_TIMEOUT_MS = 120_000;
const ERROR_CODE = /An error occurred \(([^)]+)\)/;

export class AwsCli {
  private readonly deps: CloudDeps;
  private readonly target: AwsTarget;
  private readonly options: AwsCallOptions;

  constructor(deps: CloudDeps, target: AwsTarget, options: AwsCallOptions = {}) {
    this.deps = deps;
    this.target = target;
    this.options = options;
  }

  /** The argv of a call: the global options first, so the profile and the region are never forgotten. */
  argv(args: readonly string[]): string[] {
    const { auth, region } = this.target;
    return [
      ...(auth.kind === 'profile' ? ['--profile', auth.profile] : []),
      '--region',
      region,
      '--output',
      'json',
      ...args,
    ];
  }

  private async exec(args: readonly string[]): Promise<RunResult> {
    if (this.options.signal?.aborted) throw new CloudError('interrupted');
    return this.deps.run('aws', this.argv(args), {
      timeoutMs: CALL_TIMEOUT_MS,
      ...(this.options.signal ? { signal: this.options.signal } : {}),
      ...(this.options.redactErrors
        ? {
            env: {
              AWS_CLI_AUTO_PROMPT: 'off',
              AWS_PAGER: '',
            },
          }
        : {}),
    });
  }

  private fail(args: readonly string[], result: RunResult): AwsCallError {
    const operation = `${args[0] ?? 'aws'} ${args[1] ?? ''}`.trim();
    if (result.code === 127)
      return new AwsCallError(operation, null, 'the aws CLI is not installed (https://aws.amazon.com/cli/)');
    const text = (result.stderr || result.stdout).trim();
    const code = ERROR_CODE.exec(text)?.[1] ?? null;
    if (this.options.redactErrors)
      return new AwsCallError(
        operation,
        code && /^[A-Za-z0-9]{1,80}$/.test(code) ? code : null,
        `aws ${operation} failed (${code && /^[A-Za-z0-9]{1,80}$/.test(code) ? code : 'transport or CLI error'})`,
      );
    const lastLine = text.split('\n').filter(Boolean).slice(-1)[0] ?? `exit status ${result.code}`;
    return new AwsCallError(operation, code, `aws ${operation} failed: ${lastLine}`);
  }

  /** The parsed JSON the call prints (`{}` when it prints nothing); a failure throws `AwsCallError`. */
  async call(args: readonly string[]): Promise<unknown> {
    const result = await this.exec(args);
    if (result.code !== 0) throw this.fail(args, result);
    const text = result.stdout.trim();
    if (text === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      // The output may hold a secret: say nothing of it.
      throw new AwsCallError(`${args[0]} ${args[1]}`, null, `aws ${args[0]} ${args[1]} printed no JSON`);
    }
  }

  /** `call`, but an error with one of the codes is the answer `null` (the thing does not exist). */
  async callOrNull(args: readonly string[], notFoundCodes: readonly string[]): Promise<unknown | null> {
    try {
      return await this.call(args);
    } catch (error) {
      if (error instanceof AwsCallError && error.awsCode && notFoundCodes.includes(error.awsCode))
        return null;
      throw error;
    }
  }

  /** `call`, with the answer checked against a schema. */
  async callAs<S extends z.ZodType>(args: readonly string[], schema: S): Promise<z.output<S>> {
    return this.parse(args, await this.call(args), schema);
  }

  async callAsOrNull<S extends z.ZodType>(
    args: readonly string[],
    notFoundCodes: readonly string[],
    schema: S,
  ): Promise<z.output<S> | null> {
    const value = await this.callOrNull(args, notFoundCodes);
    return value === null ? null : this.parse(args, value, schema);
  }

  private parse<S extends z.ZodType>(args: readonly string[], value: unknown, schema: S): z.output<S> {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new AwsCallError(
        `${args[0]} ${args[1]}`,
        null,
        `aws ${args[0]} ${args[1]} answered in an unexpected shape`,
      );
    return result.data;
  }

  /** Runs `aws --version`; the result is the version text. */
  async version(): Promise<string> {
    const result = await this.deps.run('aws', ['--version'], { timeoutMs: 30_000 });
    if (result.code === 127)
      throw new AwsCallError('version', null, 'the aws CLI is not installed (https://aws.amazon.com/cli/)');
    if (result.code !== 0) throw this.fail(['--version'], result);
    // CLI v2 prints on the standard output, v1 on the standard error.
    return (result.stdout || result.stderr).trim();
  }
}
