import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChildEnv } from '../../env';
import { FAKE_CODEX, silentLogger, tempDirs } from '../../test-helpers';
import { createNanogptAdapter } from './index';
import type { StartSessionSpec } from '../../../contracts';
import { buildSessionPolicy } from '../../../../test/helpers/session-policy';
import { testConfig } from '../../../../test/helpers/test-template';

describe('NanoGPT adapter', () => {
  const dirs = tempDirs();
  afterEach(() => dirs.cleanup());
  async function harness(key: string | null = 'private-test-sentinel') {
    const cwd = await dirs.make();
    const codexHome = path.join(cwd, 'nano-home');
    const adapter = createNanogptAdapter({
      bin: FAKE_CODEX,
      codexHome,
      nanogptKey: async () => key,
      logger: silentLogger(),
      ambientConfig: { codexManaged: [] },
      fetch: async () => new Response(null, { status: 503 }),
    });
    const input = {
      spec: {
        sessionId: 'ses_test',
        claudeSessionId: '00000000-0000-4000-8000-000000000001',
        cwd,
        resume: false,
        provider: 'nanogpt' as const,
        displayName: 'test',
        mcpUrl: 'http://localhost/mcp',
        appendSystemPrompt: '',
        allowedTools: [],
        permissionMode: 'auto' as const,
        initialMessage: 'TEAM',
      },
      hookUrl: 'http://localhost/hook',
      sessionConfigDir: await dirs.make(),
      permissionTimeoutMs: 1000,
    };
    return { adapter, input, codexHome };
  }
  it('takes the capabilities of Codex, except that an image in a tool result is not promised (PM-518)', async () => {
    const { adapter } = await harness();
    expect(adapter.capabilities).toMatchObject({ toolGate: 'permission_request', mcpImageResults: false });
  });
  it('refuses an explicitly invalid worktree boundary before using the key', async () => {
    const h = await harness();
    await expect(
      h.adapter.launch({
        ...h.input,
        spec: {
          ...h.input.spec,
          policy: { access: 'task_worktree' },
          sandbox: { portable: { readBoundary: { deniedRoots: [], allowedPaths: [{}] } } },
        } as unknown as StartSessionSpec,
      }),
    ).rejects.toMatchObject({
      code: 'nanogpt_setup_incomplete',
      details: { problem: 'read_boundary', reason: 'invalid' },
    });
  });
  it('rejects an unknown CLI below the soft home boundary before using the key', async () => {
    const h = await harness();
    const cwd = h.input.spec.cwd;
    await expect(
      h.adapter.launch({
        ...h.input,
        spec: {
          ...h.input.spec,
          policy: {
            access: 'task_worktree',
            placement: { kind: 'task_worktree', path: cwd },
            permissions: { sandbox: 'read-only' },
            filesystem: { readableRoots: [cwd] },
          },
          sandbox: {
            portable: {
              allowWrite: [],
              env: {},
              readBoundary: { deniedRoots: [homedir()], allowedPaths: [{ path: cwd, kind: 'directory' }] },
            },
          },
        } as unknown as StartSessionSpec,
        cliPath: path.join(homedir(), 'unknown-cli/bin/codex'),
      }),
    ).rejects.toMatchObject({ code: 'nanogpt_setup_incomplete', details: { problem: 'cli_location' } });
  });
  it('uses custom provider arguments and private home and hides keys from shells', async () => {
    const h = await harness();
    const input = {
      ...h.input,
      spec: {
        ...h.input.spec,
        policy: buildSessionPolicy({
          config: testConfig(),
          role: 'developer',
          task: { repo: 'web' },
          placement: { kind: 'task_worktree', path: h.input.spec.cwd },
          permissionMode: 'auto',
        }),
        sandbox: { allowWrite: [], allowedDomains: [], allowLocalBinding: false, denyRead: [homedir()] },
      },
    };
    const launch = await h.adapter.launch(input);
    expect(launch.cliArgs.join('\n')).not.toContain(`"${homedir()}"="deny"`);
    expect(launch.cliArgs).toContain('model_provider="nanogpt"');
    expect(launch.cliArgs).toContain(
      'model_providers.nanogpt={name="NanoGPT",base_url="https://nano-gpt.com/api/v1",env_key="NANOGPT_API_KEY",wire_api="responses"}',
    );
    expect(launch.cliArgs).toContain('shell_environment_policy.exclude=["NANOGPT_API_KEY"]');
    expect(launch.cliArgs).toContain('z-ai/glm-5.3-flash-uncensored');
    expect(launch.cliArgs).not.toContain('--oss');
    expect(JSON.stringify(launch.cliArgs)).not.toContain('private-test-sentinel');
    // The hooks name the private target file, not the hook URL (PM-156).
    expect(JSON.stringify(launch.cliArgs)).not.toContain('http://localhost/hook');
    expect(JSON.stringify(launch.cliArgs)).toContain(path.join(h.input.sessionConfigDir, 'hook.curl'));
    expect(await readFile(path.join(h.input.sessionConfigDir, 'hook.curl'), 'utf8')).toBe(
      'url = "http://localhost/hook"\n',
    );
    // The team MCP bridge reads its URL from the session's folder too (PM-1170).
    expect(JSON.stringify(launch.cliArgs)).not.toContain('http://localhost/mcp');
    expect(JSON.stringify(launch.cliArgs)).toContain(path.join(h.input.sessionConfigDir, 'codex-mcp.json'));
    expect(await readFile(path.join(h.input.sessionConfigDir, 'codex-mcp.json'), 'utf8')).toBe(
      '{"url":"http://localhost/mcp"}',
    );
    expect(launch.env).toEqual({ CODEX_HOME: h.codexHome, NANOGPT_API_KEY: 'private-test-sentinel' });
    expect((await stat(h.codexHome)).mode & 0o777).toBe(0o700);
    expect(await h.adapter.planUsage.get()).toBeNull();
    // Every start has a private folder of its own.
    const resume = await h.adapter.launch({
      ...input,
      sessionConfigDir: await dirs.make(),
      spec: { ...input.spec, resume: true },
    });
    expect(resume.cliArgs[0]).toBe('resume');
    expect(resume.env).toEqual(launch.env);
    await writeFile(path.join(h.codexHome, 'auth.json'), '{}');
    await expect(h.adapter.launch(h.input)).rejects.toMatchObject({ code: 'nanogpt_setup_incomplete' });
    expect(await h.adapter.checkLogin({ FAKE_CODEX_VERSION: '0.159.1' })).toMatchObject({
      loggedIn: false,
      method: 'chatgpt',
      problem: 'chatgpt_login',
    });
    expect(await readFile(path.join(h.codexHome, 'auth.json'), 'utf8')).toBe('{}');
  });
  it('refuses an unknown CLI installation inside its denied home', async () => {
    const h = await harness();
    const cliPath = path.join(h.codexHome, 'tmp', 'codex');
    await expect(h.adapter.launch({ ...h.input, cliPath })).rejects.toMatchObject({
      code: 'nanogpt_setup_incomplete',
      details: { provider: 'nanogpt', problem: 'cli_location', cliPath },
    });
  });
  it('checks CLI version and key without running login or falling back', async () => {
    const h = await harness(null);
    expect(await h.adapter.checkLogin({ FAKE_CODEX_VERSION: '0.159.1' })).toMatchObject({
      loggedIn: false,
      method: 'api_key',
      problem: 'no_key',
    });
    expect(await h.adapter.checkLogin({ FAKE_CODEX_VERSION: '0.125.0' })).toMatchObject({
      loggedIn: false,
      problem: 'cli_too_old',
      minCliVersion: '0.159.1',
    });
    await expect(h.adapter.launch(h.input)).rejects.toMatchObject({ code: 'nanogpt_key_missing' });
    const ready = await harness();
    expect(await ready.adapter.checkLogin({ FAKE_CODEX_VERSION: '0.159.1' })).toMatchObject({
      loggedIn: true,
      method: 'api_key',
    });
    const missing = createNanogptAdapter({
      bin: path.join(ready.codexHome, 'missing-cli'),
      codexHome: ready.codexHome,
      nanogptKey: async () => 'test-key',
      logger: silentLogger(),
    });
    expect(await missing.checkLogin({})).toMatchObject({ loggedIn: false, problem: 'cli_missing' });
    await expect(
      ready.adapter.launch({
        ...ready.input,
        spec: { ...ready.input.spec, permissionMode: 'bypassPermissions' },
      }),
    ).rejects.toMatchObject({ code: 'nanogpt_setup_incomplete' });
  });
  it('does not ask for the key in its login check when the cloud holds it (PM-736)', async () => {
    const cwd = await dirs.make();
    const nanogptKey = vi.fn(async () => null);
    const adapter = createNanogptAdapter({
      bin: FAKE_CODEX,
      codexHome: path.join(cwd, 'nano-home'),
      nanogptKey,
      keyInCloud: true,
      logger: silentLogger(),
    });
    expect(await adapter.checkLogin({ FAKE_CODEX_VERSION: '0.159.1' })).toMatchObject({
      loggedIn: true,
      method: 'api_key',
    });
    expect(await adapter.checkLogin({ FAKE_CODEX_VERSION: '0.125.0' })).toMatchObject({
      loggedIn: false,
      problem: 'cli_too_old',
    });
    await mkdir(path.join(cwd, 'nano-home'), { recursive: true });
    await writeFile(path.join(cwd, 'nano-home', 'auth.json'), '{}');
    expect(await adapter.checkLogin({ FAKE_CODEX_VERSION: '0.159.1' })).toMatchObject({
      loggedIn: false,
      problem: 'chatgpt_login',
    });
    expect(nanogptKey).not.toHaveBeenCalled();
  });
  it('still refuses to start without a key when the cloud holds it (PM-736)', async () => {
    const h = await harness();
    const adapter = createNanogptAdapter({
      bin: FAKE_CODEX,
      codexHome: h.codexHome,
      nanogptKey: async () => null,
      keyInCloud: true,
      logger: silentLogger(),
      ambientConfig: { codexManaged: [] },
    });
    await expect(adapter.launch(h.input)).rejects.toMatchObject({ code: 'nanogpt_key_missing' });
  });
  it('strips inherited billing keys and restores only the trusted NanoGPT key', () => {
    const clean = buildChildEnv({
      NANOGPT_API_KEY: 'inherited',
      OPENAI_API_KEY: 'inherited',
      CODEX_API_KEY: 'inherited',
    });
    expect(clean).toEqual({});
    expect(buildChildEnv(clean, { NANOGPT_API_KEY: 'private-test-sentinel' })).toEqual({
      NANOGPT_API_KEY: 'private-test-sentinel',
    });
  });
  it('reads documented weekly token units through an authenticated read-only request', async () => {
    const resetAt = Date.parse('2026-10-11T12:00:00Z');
    const request = vi.fn(async () =>
      Response.json({
        active: true,
        state: 'active',
        degraded: false,
        weeklyInputTokens: { used: 59_977_486, limit: 60_000_000, percentUsed: 0.9996247667, resetAt },
        dailyInputTokens: null,
        routing: { paidFallbackEnabled: false },
      }),
    );
    const adapter = createNanogptAdapter({
      bin: FAKE_CODEX,
      codexHome: await dirs.make(),
      nanogptKey: async () => 'private-test-sentinel',
      logger: silentLogger(),
      fetch: request,
    });
    expect(await adapter.planUsage.get()).toMatchObject({
      fiveHourPercent: null,
      fiveHourResetsAt: null,
      weeklyPercent: 99.96247667,
      weeklyResetsAt: new Date(resetAt).toISOString(),
    });
    expect(request).toHaveBeenCalledWith('https://api.nano-gpt.com/api/subscription/v1/usage', {
      headers: { 'x-api-key': 'private-test-sentinel' },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });
  it.each([
    { degraded: true, weeklyInputTokens: { percentUsed: 1, resetAt: 1791720000000 } },
    { weeklyInputTokens: { percentUsed: null, resetAt: 1791720000000 } },
    { weeklyInputTokens: { percentUsed: '100', resetAt: 1791720000000 } },
    { weeklyInputTokens: { percentUsed: 1, resetAt: 'private-response-sentinel' } },
    { weeklyInputTokens: null },
  ])('returns unknown for degraded or invalid usage without logging response bodies', async (body) => {
    const logger = silentLogger();
    const warn = vi.spyOn(logger, 'warn');
    const error = vi.spyOn(logger, 'error');
    const adapter = createNanogptAdapter({
      bin: FAKE_CODEX,
      codexHome: await dirs.make(),
      nanogptKey: async () => 'private-test-sentinel',
      logger,
      fetch: async () => Response.json(body),
    });
    expect(await adapter.planUsage.get()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it('returns unknown for missing keys, rejected responses and network failures without logging secrets', async () => {
    const logger = silentLogger();
    const warn = vi.spyOn(logger, 'warn');
    for (const key of [null, 'private-test-sentinel']) {
      const request = vi.fn(async () => {
        throw new Error('private-test-sentinel private-response-sentinel');
      });
      const adapter = createNanogptAdapter({
        bin: FAKE_CODEX,
        codexHome: await dirs.make(),
        nanogptKey: async () => key,
        logger,
        fetch: request,
      });
      expect(await adapter.planUsage.get()).toBeNull();
      expect(request).toHaveBeenCalledTimes(key ? 1 : 0);
    }
    expect(warn).not.toHaveBeenCalled();
  });
  it.each(['project', 'user', 'managed'] as const)(
    'refuses dangerous %s configuration with names only',
    async (layer) => {
      const h = await harness();
      const file =
        layer === 'project'
          ? path.join(h.input.spec.cwd, '.codex', 'config.toml')
          : layer === 'user'
            ? path.join(h.codexHome, 'config.toml')
            : path.join(h.input.spec.cwd, 'managed-config.toml');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'notify = ["configuration-private-sentinel"]\n');
      const adapter =
        layer === 'managed'
          ? createNanogptAdapter({
              bin: FAKE_CODEX,
              codexHome: h.codexHome,
              nanogptKey: async () => 'test-key',
              logger: silentLogger(),
              ambientConfig: { codexManaged: [file] },
            })
          : h.adapter;
      let error: unknown;
      try {
        await adapter.launch(h.input);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: 'nanogpt_setup_incomplete',
        details: { provider: 'nanogpt', ambientConfig: expect.arrayContaining([{ file, keys: ['notify'] }]) },
      });
      expect(JSON.stringify(error)).not.toContain('configuration-private-sentinel');
    },
  );
  it.each([
    ['config.toml', '["mcp\\u005fservers".x]\ncommand = "private-hook-sentinel"', 'user'],
    ['config.toml', '"mcp\\u005fservers".x.command = "private-hook-sentinel"', 'user'],
    ['config.toml', '["mcp\\u005fservers".x]\ncommand = "private-hook-sentinel"', 'project'],
    ['anything.txt', 'private-hook-sentinel', 'project'],
    ['hooks.json', 'private-hook-sentinel', 'user'],
  ])('refuses %s in the %s layer on launch and resume', async (name, content, layer) => {
    const h = await harness();
    const dir = layer === 'project' ? path.join(h.input.spec.cwd, '.codex') : h.codexHome;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), content);
    for (const resume of [false, true]) {
      let error: unknown;
      try {
        await h.adapter.launch({ ...h.input, spec: { ...h.input.spec, resume } });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'nanogpt_setup_incomplete' });
      expect(JSON.stringify(error)).not.toContain('private-hook-sentinel');
    }
  });
});
