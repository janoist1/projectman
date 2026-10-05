import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { NANOGPT_MIN_CODEX_VERSION } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AmbientConfigLocations, ProviderStatus } from '../../../contracts';
import { resolveCommand, runQuietly } from '../../cli';
import { inspectAmbientConfig } from '../../managed-vm';
import { createCodexAdapter } from '../codex';
import { buildCodexArgs, NANOGPT_CODEX_PROVIDER } from '../codex/args';
import type { ProviderAdapter } from '../types';

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
    const version = cliVersion?.split('.').map(Number);
    const minimum = NANOGPT_MIN_CODEX_VERSION.split('.').map(Number);
    const good =
      version &&
      (version[0]! > minimum[0]! ||
        (version[0] === minimum[0] &&
          (version[1]! > minimum[1]! || (version[1] === minimum[1] && version[2]! >= minimum[2]!))));
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
    planUsage: { get: async () => null },
    noteTranscript: undefined,
    loginCommand: ['--version'],
    parseLogin: parseVersion,
    async checkLogin(env) {
      const status = parseVersion(
        await runQuietly(opts.bin, ['--version'], { ...env, CODEX_HOME: opts.codexHome }),
      );
      if (!status.loggedIn) return status;
      if (await hasAuth()) return { ...status, loggedIn: false, problem: 'chatgpt_login' };
      if (!(await opts.nanogptKey())) return { ...status, loggedIn: false, problem: 'no_key' };
      return status;
    },
    async launch(input) {
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
      });
      if (ambientConfig.length > 0)
        throw new NanogptStartError('nanogpt_setup_incomplete', { ambientConfig });
      const key = await opts.nanogptKey();
      if (!key) throw new NanogptStartError('nanogpt_key_missing');
      await mkdir(opts.codexHome, { recursive: true, mode: 0o700 });
      await chmod(opts.codexHome, 0o700);
      const command = buildCodexArgs({ ...input, realCwd, provider: NANOGPT_CODEX_PROVIDER });
      return {
        ...resolveCommand(opts.bin, command.args),
        cliArgs: command.args,
        initialMessageSent: command.initialMessageSent,
        env: { CODEX_HOME: opts.codexHome, NANOGPT_API_KEY: key },
      };
    },
  };
}
