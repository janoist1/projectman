import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { refused } from './errors';

/**
 * The secrets store of the cloud commands (PM-534): `~/.config/projectman/cloud/`. It is under
 * `~/.config/projectman`, which the AI sessions' sandboxes already deny. The directory is mode 700, the
 * files 600; the loader refuses a wider mode and every symbolic link; a write goes to a 600 temporary file
 * that is renamed over the target.
 */

export const SECRETS_DIR_PARTS = ['.config', 'projectman', 'cloud'] as const;
export const CONFIG_FILE_NAME = 'config.json';
export const CLOUDFLARE_TOKEN_FILE_NAME = 'cloudflare-token';
export const ENV_FILE_NAME = 'cloud.env';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function secretsDir(homeDir: string): string {
  return path.join(homeDir, ...SECRETS_DIR_PARTS);
}

function modeText(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

function ownedByUs(uid: number): boolean {
  const mine = process.getuid?.();
  return mine === undefined || uid === mine;
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** What is wrong with the directory, or null when it is fine (or missing). */
export function secretsDirProblem(dir: string): string | null {
  const stat = lstatOrNull(dir);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return `${dir} is a symbolic link; the secrets store must be a real directory`;
  if (!stat.isDirectory()) return `${dir} is not a directory`;
  if (!ownedByUs(stat.uid)) return `${dir} belongs to another user`;
  if ((stat.mode & 0o077) !== 0)
    return `${dir} has mode ${modeText(stat.mode)}; it must be 700 (chmod 700 ${dir})`;
  return null;
}

/** What is wrong with a secret file, or null when it is fine (or missing). */
export function secretFileProblem(file: string): string | null {
  const stat = lstatOrNull(file);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return `${file} is a symbolic link; secret files must be regular files`;
  if (!stat.isFile()) return `${file} is not a regular file`;
  if (!ownedByUs(stat.uid)) return `${file} belongs to another user`;
  if ((stat.mode & 0o177) !== 0)
    return `${file} has mode ${modeText(stat.mode)}; it must be 600 (chmod 600 ${file})`;
  return null;
}

/** Refuses (exit status 2) a store whose directory has a wider mode than 700, or is a link. */
export function checkSecretsDir(dir: string): void {
  const problem = secretsDirProblem(dir);
  if (problem) throw refused(problem);
}

/** Creates the directory with mode 700 when it is missing, and checks it. */
export function ensureSecretsDir(dir: string): void {
  if (!lstatOrNull(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
  }
  checkSecretsDir(dir);
}

/** The content of a secret file, or null when it does not exist; refuses a wide mode or a link. */
export function readSecret(file: string): string | null {
  const problem = secretFileProblem(file);
  if (problem) throw refused(problem);
  if (!lstatOrNull(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

/** Atomic write: a temporary 600 file in the same directory, then `rename`. Refuses a link at the target. */
export function writeSecret(dir: string, name: string, content: string): string {
  ensureSecretsDir(dir);
  const target = path.join(dir, name);
  const problem = secretFileProblem(target);
  if (problem) throw refused(problem);
  const temporary = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', FILE_MODE);
  try {
    fs.fchmodSync(descriptor, FILE_MODE);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(descriptor);
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

/** The problems of the whole store: the directory and every secret file that exists. */
export function inspectSecrets(dir: string, files: readonly string[]): string[] {
  const problems: string[] = [];
  const dirProblem = secretsDirProblem(dir);
  if (dirProblem) problems.push(dirProblem);
  for (const file of new Set(files)) {
    const problem = secretFileProblem(file);
    if (problem) problems.push(problem);
  }
  return problems;
}

// ---- the env file (docker env-file format) ----

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvValues = Record<string, string>;

function assertEnvEntry(name: string, value: string): void {
  if (!ENV_NAME.test(name)) throw new Error(`"${name}" is not a valid env-file name`);
  if (/[\r\n\0]/.test(value)) throw new Error(`the value of ${name} has a line break`);
}

interface ParsedEnv {
  lines: string[];
  values: Map<string, string>;
}

function parseEnv(text: string, file: string): ParsedEnv {
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  const values = new Map<string, string>();
  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    const name = equals > 0 ? line.slice(0, equals) : '';
    if (!ENV_NAME.test(name)) throw refused(`${file} has a line that is not NAME=value`);
    values.set(name, line.slice(equals + 1));
  }
  return { lines, values };
}

/** The `NAME=value` pairs of the env file (empty when it does not exist); the value is everything after `=`. */
export function readEnvFile(file: string): Map<string, string> {
  return parseEnv(readSecret(file) ?? '', file).values;
}

/**
 * Sets some names and keeps every other line (comments and unknown names too). A new name goes to the end; a
 * repeated name keeps its first place. Nothing is written when no value changes. Returns the names that changed.
 */
export function updateEnvFile(file: string, updates: EnvValues): string[] {
  for (const [name, value] of Object.entries(updates)) assertEnvEntry(name, value);
  const { lines, values } = parseEnv(readSecret(file) ?? '', file);
  const changed = Object.entries(updates)
    .filter(([name, value]) => values.get(name) !== value)
    .map(([name]) => name);
  if (changed.length === 0) return [];
  const result = [...lines];
  for (const name of changed) {
    const value = updates[name]!;
    const indexes = result.flatMap((line, index) => (line.startsWith(`${name}=`) ? [index] : []));
    if (indexes.length === 0) {
      result.push(`${name}=${value}`);
      continue;
    }
    result[indexes[0]!] = `${name}=${value}`;
    for (const index of indexes.slice(1).reverse()) result.splice(index, 1);
  }
  writeSecret(path.dirname(file), path.basename(file), `${result.join('\n')}\n`);
  return changed;
}

/** Removes some names (every line of each) and keeps all other lines. Returns the names that were there. */
export function removeEnvNames(file: string, names: readonly string[]): string[] {
  const { lines, values } = parseEnv(readSecret(file) ?? '', file);
  const present = names.filter((name) => values.has(name));
  if (present.length === 0) return [];
  const kept = lines.filter((line) => !present.some((name) => line.startsWith(`${name}=`)));
  writeSecret(path.dirname(file), path.basename(file), kept.length === 0 ? '' : `${kept.join('\n')}\n`);
  return present;
}

/** A fresh restic repository password: 32 random bytes, base64url. */
export function newResticPassword(): string {
  return randomBytes(32).toString('base64url');
}
