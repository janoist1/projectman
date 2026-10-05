import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderStatus } from '../../../contracts';
import { cliExists, runQuietly, type CommandOutput } from '../../cli';

export function geminiLoginCommand(configDir: string): string[] {
  const dir = path.join(configDir, 'login');
  return [
    '--gemini_dir',
    dir,
    '--log-file',
    path.join(dir, 'agy.log'),
    '--release_base_url',
    'http://127.0.0.1:9',
    'models',
  ];
}
export function parseGeminiLogin(out: CommandOutput): ProviderStatus {
  const base: ProviderStatus = {
    provider: 'gemini',
    checkedAt: new Date().toISOString(),
    loggedIn: null,
    method: null,
  };
  const version = /(?:Antigravity CLI|agy)\s+(\d+\.\d+\.\d+)/i.exec(`${out.stdout}\n${out.stderr}`)?.[1];
  if (version) {
    base.cliVersion = version;
    base.minCliVersion = '1.2.17';
  }
  if (out.code === 0 && /^\S+\t.+$/m.test(out.stdout)) return { ...base, loggedIn: true, method: 'google' };
  if (out.code !== 0 && /Please sign in/i.test(`${out.stderr}\n${out.stdout}`))
    return { ...base, loggedIn: false, method: 'none', problem: 'not_logged_in' };
  return {
    ...base,
    detail: out.error ?? (out.stderr.trim() || out.stdout.trim() || `exit code ${out.code}`),
  };
}
export async function checkGeminiLogin(
  bin: string,
  configDir: string | undefined,
  env: Record<string, string>,
): Promise<ProviderStatus> {
  const base = { provider: 'gemini' as const, checkedAt: new Date().toISOString(), method: null };
  if (!(await cliExists(bin, env.PATH))) return { ...base, loggedIn: false, problem: 'cli_missing' };
  if (!configDir) return { ...base, loggedIn: null, detail: 'Gemini config directory is required.' };
  const dir = path.join(configDir, 'login');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const log = path.join(dir, 'agy.log');
  // Do not mistake a previous probe's authentication method for this one.
  await rm(log, { force: true });
  const out = await runQuietly(bin, geminiLoginCommand(configDir), env);
  const status = parseGeminiLogin(out);
  const text = await readFile(log, 'utf8').catch(() => '');
  const methods = [...text.matchAll(/authMethod=([A-Za-z0-9_-]+)/g)];
  const method = methods.at(-1)?.[1];
  if (method && method !== 'consumer')
    return {
      ...status,
      loggedIn: false,
      method,
      problem: 'not_logged_in',
      detail: 'Gemini members require a Google consumer subscription login.',
    };
  return status;
}
