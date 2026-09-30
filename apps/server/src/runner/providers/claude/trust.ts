import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, mkdir, readFile, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Pre-accepting Claude Code's workspace trust dialog.
 *
 * An interactive session in a folder nobody trusted yet stops on a "Quick safety check: Is
 * this a project you created or one you trust?" screen before it can take input. Claude Code
 * has no flag for this; the documented way to trust a folder without the dialog is to set
 * `projects["<path>"].hasTrustDialogAccepted: true` in its global config (~/.claude.json, or
 * $CLAUDE_CONFIG_DIR/.claude.json). `<path>` is the git repository root (the main checkout's
 * root for a worktree) or, outside a repository, the folder itself.
 *
 * The write is minimal and safe: only that flag is added (a new project entry gets the same
 * defaults Claude Code writes), under the same lock Claude Code uses for this file
 * (proper-lockfile: a `<realpath>.lock` directory, stale after 10 s), after a fresh read,
 * through a temporary file and an atomic rename. A missing or unparseable config is left
 * untouched. No backup files are created.
 */

export type TrustOutcome =
  | { result: 'already_trusted'; key: string }
  | { result: 'trusted'; key: string }
  | { result: 'skipped'; key: string | null; reason: string };

/** Claude Code's global config file. */
export function defaultClaudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

/** Defaults Claude Code writes into a new `projects` entry. */
const NEW_PROJECT_ENTRY = {
  allowedTools: [] as string[],
  mcpContextUris: [] as string[],
  enabledMcpjsonServers: [] as string[],
  disabledMcpjsonServers: [] as string[],
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
};

/** proper-lockfile's default stale time, which Claude Code uses. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function git(cwd: string, args: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', ...args], { timeout: 10_000 }, (err, stdout) => {
      if (err) resolve(null);
      else
        resolve(
          stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean),
        );
    });
  });
}

/**
 * The folder Claude Code keys trust on: the repository root (for a worktree, the main
 * checkout's root) or the folder itself outside a repository.
 */
export async function trustKeyFor(cwd: string): Promise<{ key: string; inRepo: boolean }> {
  const dir = await realpath(cwd);
  const out =
    (await git(dir, ['--path-format=absolute', '--git-common-dir', '--show-toplevel'])) ??
    (await git(dir, ['--git-common-dir', '--show-toplevel']));
  if (out && out.length >= 2) {
    const commonDir = path.resolve(dir, out[0]!);
    const topLevel = path.resolve(dir, out[1]!);
    if (path.basename(commonDir) === '.git') return { key: path.dirname(commonDir), inRepo: true };
    return { key: topLevel, inRepo: true };
  }
  return { key: dir, inRepo: false };
}

function projectTrusted(config: Json, key: string): boolean {
  const projects = config.projects;
  if (!isRecord(projects)) return false;
  const entry = projects[key];
  return isRecord(entry) && entry.hasTrustDialogAccepted === true;
}

/** Trusted directly, or (outside a repository) through a trusted parent folder. */
export function isTrusted(config: Json, key: string, inRepo: boolean): boolean {
  if (projectTrusted(config, key)) return true;
  if (inRepo) return false;
  let dir = path.dirname(key);
  while (dir !== path.dirname(dir)) {
    if (projectTrusted(config, dir)) return true;
    dir = path.dirname(dir);
  }
  return false;
}

/** `config` with the trust flag set for `key`; everything else is kept as it is. */
export function withTrust(config: Json, key: string): Json {
  const projects = isRecord(config.projects) ? { ...config.projects } : {};
  const existing = projects[key];
  projects[key] = isRecord(existing)
    ? { ...existing, hasTrustDialogAccepted: true }
    : { ...NEW_PROJECT_ENTRY, hasTrustDialogAccepted: true };
  return { ...config, projects };
}

async function readConfig(file: string): Promise<Json | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Acquires the proper-lockfile style lock of `file`; null when it stays busy. */
async function acquireLock(file: string): Promise<(() => Promise<void>) | null> {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rmdir(lockPath).catch(() => undefined);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      const { mtimeMs } = await stat(lockPath);
      if (Date.now() - mtimeMs > LOCK_STALE_MS) {
        await rmdir(lockPath).catch(() => undefined); // abandoned by a crashed process
        continue;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // released meanwhile
      throw err;
    }
    if (Date.now() >= deadline) return null;
    await sleep(40 + Math.floor(Math.random() * 40));
  }
}

/** Writes through a temporary file in the same directory and renames it over `file`. */
async function writeAtomic(file: string, data: string): Promise<void> {
  const { mode } = await stat(file);
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.projectman-${randomBytes(6).toString('hex')}.tmp`,
  );
  const handle = await open(tmp, 'wx', mode & 0o777);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Makes sure Claude Code will not show the trust dialog for `cwd`, recording the trust in
 * `configPath` if needed.
 */
export async function ensureWorkspaceTrusted(configPath: string, cwd: string): Promise<TrustOutcome> {
  const { key, inRepo } = await trustKeyFor(cwd);
  const home = await realpath(os.homedir()).catch(() => os.homedir());
  if (key === home) {
    return { result: 'skipped', key, reason: 'Claude Code never persists trust for the home directory' };
  }

  let file: string;
  try {
    file = await realpath(configPath);
  } catch {
    return { result: 'skipped', key, reason: `Claude Code config not found at ${configPath}` };
  }

  const before = await readConfig(file);
  if (!before) return { result: 'skipped', key, reason: `${file} is not a JSON object` };
  if (isTrusted(before, key, inRepo)) return { result: 'already_trusted', key };

  const release = await acquireLock(file);
  if (!release) return { result: 'skipped', key, reason: `${file} stayed locked by another process` };
  try {
    const config = await readConfig(file); // fresh read under the lock
    if (!config) return { result: 'skipped', key, reason: `${file} is not a JSON object` };
    if (isTrusted(config, key, inRepo)) return { result: 'already_trusted', key };
    await writeAtomic(file, JSON.stringify(withTrust(config, key), null, 2));
    return { result: 'trusted', key };
  } finally {
    await release();
  }
}
