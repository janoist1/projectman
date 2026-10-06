import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { cliVersionAtLeast, NANOGPT_MIN_CODEX_VERSION } from '@projectman/shared';
import type { PlanUsage } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AmbientConfigLocations, ProviderStatus } from '../../../contracts';
import { resolveCommand, runQuietly } from '../../cli';
import { inspectCodexMcpServers, inspectAmbientConfig } from '../../managed-vm';
import { createCodexAdapter } from '../codex';
import { CodexTranscriptParser } from '../codex/transcript';
import { buildCodexArgs, codexCliReadRoot, codexDeniedPaths, NANOGPT_CODEX_PROVIDER } from '../codex/args';
import type { ProviderAdapter } from '../types';

const SubscriptionUsage = z.object({
  degraded: z.boolean().optional(),
  weeklyInputTokens: z.object({
    percentUsed: z.number().nonnegative(),
    resetAt: z.number().int().nonnegative().nullable(),
  }),
});

export class NanogptStartError extends Error {
  readonly code: 'nanogpt_key_missing' | 'nanogpt_setup_incomplete' | 'provider_unsupported';
  readonly details: Record<string, unknown>;
  constructor(code: NanogptStartError['code'], details: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.details = { provider: 'nanogpt', ...details };
  }
}

export function createNanogptAdapter(opts: {
  bin: string;
  codexHome: string;
  nanogptKey: () => Promise<string | null>;
  logger: FastifyBaseLogger;
  ambientConfig?: AmbientConfigLocations;
  fetch?: typeof fetch;
}): ProviderAdapter {
  const codex = createCodexAdapter(opts);
  async function hasAuth(): Promise<boolean> {
    try {
      await lstat(path.join(opts.codexHome, 'auth.json'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return true;
    }
  }
  const parseVersion = (out: Awaited<ReturnType<typeof runQuietly>>): ProviderStatus => {
    const cliVersion = out.stdout.match(/codex-cli\s+(\d+\.\d+\.\d+)/)?.[1];
    const good = cliVersion !== undefined && cliVersionAtLeast(cliVersion, NANOGPT_MIN_CODEX_VERSION);
    return {
      provider: 'nanogpt',
      loggedIn: Boolean(good && out.code === 0 && !out.error),
      method: 'api_key',
      checkedAt: new Date().toISOString(),
      cliVersion,
      minCliVersion: NANOGPT_MIN_CODEX_VERSION,
      ...(!good || out.code !== 0 || out.error
        ? { problem: out.error ? ('cli_missing' as const) : ('cli_too_old' as const) }
        : {}),
    };
  };
  return {
    ...codex,
    provider: 'nanogpt',
    label: 'NanoGPT',
    createTranscriptParser: (parserOpts) =>
      new CodexTranscriptParser({ ...parserOpts, detectRateLimit: true }),
    planUsage: {
      async get(): Promise<PlanUsage | null> {
        try {
          const key = await opts.nanogptKey();
          if (!key) return null;
          const response = await (opts.fetch ?? fetch)('https://api.nano-gpt.com/api/subscription/v1/usage', {
            headers: { 'x-api-key': key },
            signal: AbortSignal.timeout(10_000),
            redirect: 'error',
          });
          if (!response.ok) {
            await response.body?.cancel();
            return null;
          }
          const parsed = SubscriptionUsage.safeParse(await response.json());
          if (!parsed.success || parsed.data.degraded) return null;
          const weekly = parsed.data.weeklyInputTokens;
          const reset = weekly.resetAt === null ? null : new Date(weekly.resetAt);
          if (reset && !Number.isFinite(reset.getTime())) return null;
          const percent = weekly.percentUsed * 100;
          if (!Number.isFinite(percent)) return null;
          return {
            fiveHourPercent: null,
            fiveHourResetsAt: null,
            weeklyPercent: percent,
            weeklyResetsAt: reset?.toISOString() ?? null,
            fetchedAt: new Date().toISOString(),
          };
        } catch {
          // Neither credentials nor provider response bodies belong in logs.
          return null;
        }
      },
    },
    noteTranscript: undefined,
    loginCommand: ['--version'],
    parseLogin: parseVersion,
    async checkLogin(env) {
      const status = parseVersion(
        await runQuietly(opts.bin, ['--version'], { ...env, CODEX_HOME: opts.codexHome }),
      );
      if (!status.loggedIn) return status;
      if (await hasAuth()) return { ...status, loggedIn: false, method: 'chatgpt', problem: 'chatgpt_login' };
      if (!(await opts.nanogptKey())) return { ...status, loggedIn: false, problem: 'no_key' };
      return status;
    },
    async launch(input) {
      if (
        input.cliPath &&
        codexCliReadRoot(input.cliPath, codexDeniedPaths({ spec: input.spec, codexHome: opts.codexHome }))
          .kind === 'misplaced'
      )
        throw new NanogptStartError('nanogpt_setup_incomplete', {
          problem: 'cli_location',
          cliPath: input.cliPath,
        });
      if (input.spec.permissionMode === 'bypassPermissions')
        throw new NanogptStartError('nanogpt_setup_incomplete');
      if (input.spec.policy?.execution?.profile === 'managed_vm')
        throw new NanogptStartError('provider_unsupported', { profile: 'managed_vm' });
      if (await hasAuth())
        throw new NanogptStartError('nanogpt_setup_incomplete', { problem: 'chatgpt_login' });
      const realCwd = await realpath(input.spec.cwd).catch(() => input.spec.cwd);
      const ambientConfig = await inspectAmbientConfig({
        provider: 'nanogpt',
        cwd: realCwd,
        env: { CODEX_HOME: opts.codexHome },
        locations: opts.ambientConfig,
        projectFolder: 'any',
      });
      if (ambientConfig.length > 0)
        throw new NanogptStartError('nanogpt_setup_incomplete', { ambientConfig });
      const userMcp = await inspectCodexMcpServers({ codexHome: opts.codexHome });
      if (userMcp.unresolved.length)
        throw new NanogptStartError('nanogpt_setup_incomplete', {
          problem: 'mcp_config',
          ambientConfig: userMcp.unresolved,
        });
      const key = await opts.nanogptKey();
      if (!key) throw new NanogptStartError('nanogpt_key_missing');
      await mkdir(opts.codexHome, { recursive: true, mode: 0o700 });
      await chmod(opts.codexHome, 0o700);
      const command = buildCodexArgs({
        ...input,
        realCwd,
        codexHome: opts.codexHome,
        provider: NANOGPT_CODEX_PROVIDER,
        disabledMcpServers: userMcp.names,
      });
      return {
        ...resolveCommand(opts.bin, command.args),
        cliArgs: command.args,
        initialMessageSent: command.initialMessageSent,
        env: { CODEX_HOME: opts.codexHome, NANOGPT_API_KEY: key },
      };
    },
  };
}
