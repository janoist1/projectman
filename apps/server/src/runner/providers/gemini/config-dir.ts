import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LaunchInput } from '../types';
import { FAST_HOOK_TIMEOUT_S, forwarderCommand, permissionHookTimeoutS } from '../../hook-forwarder';

export const GEMINI_DENY_FALLBACK = JSON.stringify({
  decision: 'deny',
  reason: 'projectman did not answer; the tool call was blocked.',
});
const SAFE_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Workspace config would run hooks or MCP programs outside projectman's gate. */
export async function assertNoWorkspaceConfig(cwd: string, extra: readonly string[]): Promise<void> {
  const check = async (dir: string) => {
    for (const name of ['hooks.json', 'mcp_config.json'])
      if (await exists(path.join(dir, '.agents', name)))
        throw new Error('Gemini workspace .agents configuration is forbidden.');
  };
  let dir = await realpath(cwd);
  while (true) {
    await check(dir);
    if ((await exists(path.join(dir, '.git'))) || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  for (const dir of extra) await check(await realpath(dir));
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
}

export async function prepareGeminiDir(configDir: string | undefined, input: LaunchInput): Promise<string> {
  if (!configDir) throw new Error('Gemini config directory is required.');
  const { spec } = input;
  if (!SAFE_ID.test(spec.sessionId)) throw new Error('Invalid Gemini session id.');
  await assertNoWorkspaceConfig(spec.cwd, spec.additionalDirectories ?? []);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  configDir = await realpath(configDir);
  let dir = path.join(configDir, spec.sessionId);
  if (spec.resume) {
    if (!UUID.test(spec.claudeSessionId)) throw new Error('Invalid Gemini conversation id.');
    let found: string | undefined;
    for (const entry of await readdir(configDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const candidate = path.join(configDir, entry.name);
      const brain = path.join(candidate, 'antigravity-cli', 'brain', spec.claudeSessionId);
      if (
        (await exists(brain)) &&
        (await lstat(brain)).isDirectory() &&
        (await realpath(brain)).startsWith(`${candidate}/`)
      ) {
        found = candidate;
        break;
      }
    }
    if (!found) throw new Error('Gemini conversation directory was not found; refusing to resume.');
    dir = found;
  } else {
    await mkdir(dir, { mode: 0o700 });
  }
  // Resumed directories are writable by the CLI: never follow a replaced config parent.
  for (const relative of ['config', 'antigravity-cli', 'antigravity-cli/cache']) {
    const subdir = path.join(dir, relative);
    if (!(await exists(subdir))) await mkdir(subdir, { mode: 0o700 });
    if (!(await lstat(subdir)).isDirectory() || (await realpath(subdir)) !== subdir)
      throw new Error('Gemini configuration directory must not contain symlinks.');
  }
  const hooks: Record<string, unknown> = {};
  for (const event of ['PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']) {
    const timeout =
      event === 'PreToolUse' ? permissionHookTimeoutS(input.permissionTimeoutMs) : FAST_HOOK_TIMEOUT_S;
    const hook = {
      type: 'command',
      command: forwarderCommand(`${input.hookUrl}/${event}`, process.execPath, {
        printResponse: true,
        maxTimeS: timeout,
        fallbackOutput: event === 'PreToolUse' ? GEMINI_DENY_FALLBACK : '{}',
      }),
      timeout,
    };
    hooks[event] = event.includes('ToolUse') ? [{ matcher: '', hooks: [hook] }] : [hook];
  }
  await atomicJson(path.join(dir, 'config', 'hooks.json'), { projectman: hooks });
  await atomicJson(path.join(dir, 'config', 'mcp_config.json'), {
    mcpServers: { team: { url: spec.mcpUrl } },
  });
  const settingsPath = path.join(dir, 'antigravity-cli', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (await exists(settingsPath)) {
    if (!(await lstat(settingsPath)).isFile()) throw new Error('Gemini settings must be a regular file.');
    const data: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Gemini settings.');
    settings = data as Record<string, unknown>;
  }
  await atomicJson(settingsPath, {
    ...settings,
    toolPermission: 'always-proceed',
    colorScheme: 'dark',
    trustedWorkspaces: await Promise.all(
      [spec.cwd, ...(spec.additionalDirectories ?? [])].map((p) => realpath(p)),
    ),
  });
  await atomicJson(path.join(dir, 'antigravity-cli', 'cache', 'onboarding.json'), {
    consumerOnboardingComplete: true,
    enterpriseOnboardingComplete: false,
    onboardingComplete: true,
  });
  return dir;
}
