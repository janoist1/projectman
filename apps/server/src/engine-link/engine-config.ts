import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { SelectablePermissionMode } from '@projectman/shared';
import { isLoopbackHostname } from '../http/local-guard';

/** `<PROJECTMAN_HOME>/engine.json`: what the engine process may serve and where the cloud is (PM-314). */

export const ENGINE_CONFIG_FILE = 'engine.json';
export const ENGINE_KEY_FILE = 'engine.key';
export const ENGINE_STATUS_FILE = 'engine-status.json';
export const ENGINE_AUDIT_FILE = 'engine-audit.jsonl';

const ProjectKey = z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/);
const RepoName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);

export const EngineConfig = z.strictObject({
  schemaVersion: z.literal(1),
  /** `https://…`; `http://` only for a loopback host (tests). */
  cloudUrl: z.string().url(),
  engineId: z.string().regex(/^eng_[a-z0-9]{12}$/),
  name: z.string().min(1).max(64).optional(),
  /** Absolute path of the machine key file; default `<home>/engine.key`. */
  keyFile: z.string().optional(),
  /** A JSON object of extra link headers (e.g. Cloudflare Access service token); must be 0600. */
  linkHeadersFile: z.string().optional(),
  projects: z.array(z.strictObject({ project: ProjectKey, workspacePath: z.string().min(1) })),
  repos: z.array(
    z.strictObject({
      project: ProjectKey,
      repo: RepoName,
      path: z.string().min(1),
      fullTestCommand: z.string().min(1).max(500).optional(),
    }),
  ),
  maxPermissionMode: SelectablePermissionMode.default('auto'),
  allowRemoteTerminalInput: z.boolean().default(true),
});
export type EngineConfig = z.infer<typeof EngineConfig>;

/** A configuration problem the person starting the engine can fix; `code` is stable for tests. */
export class EngineConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EngineConfigError';
    this.code = code;
  }
}

export interface EngineFiles {
  config: string;
  key: string;
  status: string;
  auditDir: string;
  audit: string;
  attachmentsCache: string;
}

export function engineFiles(home: string, config?: Pick<EngineConfig, 'keyFile'>): EngineFiles {
  const auditDir = path.join(home, 'logs');
  return {
    config: path.join(home, ENGINE_CONFIG_FILE),
    key: config?.keyFile ?? path.join(home, ENGINE_KEY_FILE),
    status: path.join(home, ENGINE_STATUS_FILE),
    auditDir,
    audit: path.join(auditDir, ENGINE_AUDIT_FILE),
    attachmentsCache: path.join(home, 'attachments-cache'),
  };
}

export function loadEngineConfig(home: string): EngineConfig {
  const file = engineFiles(home).config;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new EngineConfigError(
      'config_missing',
      `No engine configuration at ${file}. Run "npm run engine -- init" first.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new EngineConfigError('config_invalid', `${file} is not valid JSON.`);
  }
  const parsed = EngineConfig.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EngineConfigError(
      'config_invalid',
      `${file} is not a valid engine configuration: ${issue?.path.join('.') || '(root)'}: ${issue?.message}`,
    );
  }
  return parsed.data;
}

/** Writes the file atomically; mode 0600 even though it holds no secret. */
export function saveEngineConfig(home: string, config: EngineConfig): void {
  const file = engineFiles(home).config;
  writeSecretFile(file, `${JSON.stringify(EngineConfig.parse(config), null, 2)}\n`);
}

/** Atomic write with mode 0600 (a temp file in the same directory, then rename). */
export function writeSecretFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/**
 * Reads a secret file (the machine key, the link headers): a regular file of the current user that
 * no group or other can read. A looser mode is refused rather than fixed: the key may already have
 * been read by someone else.
 */
export function readSecretFile(file: string, what: string): string {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    throw new EngineConfigError('secret_missing', `The ${what} file ${file} does not exist.`);
  }
  if (!stat.isFile())
    throw new EngineConfigError('secret_not_regular', `The ${what} file ${file} is not a regular file.`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    throw new EngineConfigError('secret_wrong_owner', `The ${what} file ${file} belongs to another user.`);
  if ((stat.mode & 0o077) !== 0)
    throw new EngineConfigError(
      'secret_permissions',
      `The ${what} file ${file} is readable by group or others (mode ${(stat.mode & 0o777).toString(8)}); run chmod 600 on it.`,
    );
  const value = readFileSync(file, 'utf8').trim();
  if (!value) throw new EngineConfigError('secret_empty', `The ${what} file ${file} is empty.`);
  return value;
}

const LinkHeaders = z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(2000));
const FORBIDDEN_LINK_HEADERS = new Set([
  'authorization',
  'host',
  'upgrade',
  'connection',
  'content-length',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
]);

/** Extra headers sent with every link and upload request. `authorization` is never taken from here. */
export function readLinkHeaders(file: string): Record<string, string> {
  let json: unknown;
  try {
    json = JSON.parse(readSecretFile(file, 'link headers'));
  } catch (error) {
    if (error instanceof EngineConfigError) throw error;
    throw new EngineConfigError('link_headers_invalid', `The link headers file ${file} is not valid JSON.`);
  }
  const parsed = LinkHeaders.safeParse(json);
  if (!parsed.success)
    throw new EngineConfigError(
      'link_headers_invalid',
      `The link headers file ${file} must be an object of header names and values.`,
    );
  for (const name of Object.keys(parsed.data))
    if (FORBIDDEN_LINK_HEADERS.has(name.toLowerCase()))
      throw new EngineConfigError('link_headers_invalid', `The link header ${name} is not allowed.`);
  return parsed.data;
}

/** The cloud's origin: `https`, or `http` only for a loopback host. Returns it without a path. */
export function cloudOrigin(cloudUrl: string): URL {
  const url = new URL(cloudUrl);
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new EngineConfigError(
      'cloud_url_insecure',
      'The cloud URL must be https:// (http:// is accepted for a loopback address only).',
    );
  if (url.username || url.password)
    throw new EngineConfigError('cloud_url_invalid', 'The cloud URL must not contain credentials.');
  return new URL(url.origin);
}

/** `wss://` for an `https://` cloud, `ws://` for a loopback `http://` cloud. */
export function linkUrl(cloudUrl: string, linkPath: string): string {
  const origin = cloudOrigin(cloudUrl);
  origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  return new URL(linkPath, origin).toString();
}

export function httpUrl(cloudUrl: string, urlPath: string): string {
  return new URL(urlPath, cloudOrigin(cloudUrl)).toString();
}

export interface ResolvedEngineConfig extends EngineConfig {
  name: string;
  keyFile: string;
  /** Real (symlink-free) absolute paths. */
  projects: Array<{ project: string; workspacePath: string }>;
  repos: Array<{ project: string; repo: string; path: string; fullTestCommand?: string }>;
}

function realAbsolute(value: string, what: string): string {
  if (!path.isAbsolute(value))
    throw new EngineConfigError('path_not_absolute', `${what} must be an absolute path: ${value}`);
  try {
    return realpathSync(value);
  } catch {
    throw new EngineConfigError('path_missing', `${what} does not exist: ${value}`);
  }
}

/** Checks the cloud URL and resolves every path with `realpath` (symlinks cannot widen a root later). */
export function resolveEngineConfig(config: EngineConfig, home: string): ResolvedEngineConfig {
  cloudOrigin(config.cloudUrl);
  const projects = config.projects.map((entry) => ({
    project: entry.project,
    workspacePath: realAbsolute(entry.workspacePath, `The workspace of ${entry.project}`),
  }));
  const repos = config.repos.map((entry) => {
    const project = projects.find((candidate) => candidate.project === entry.project);
    if (!project)
      throw new EngineConfigError(
        'project_not_set',
        `The repo ${entry.project}/${entry.repo} belongs to a project without a workspace.`,
      );
    const real = realAbsolute(entry.path, `The repo ${entry.project}/${entry.repo}`);
    const rel = path.relative(project.workspacePath, real);
    if (rel.startsWith('..') || path.isAbsolute(rel))
      throw new EngineConfigError(
        'repo_outside_workspace',
        `The repo ${entry.project}/${entry.repo} is not inside the workspace of ${entry.project}.`,
      );
    return { ...entry, path: real };
  });
  return {
    ...config,
    name: config.name ?? os.hostname(),
    keyFile: config.keyFile ?? engineFiles(home).key,
    projects,
    repos,
  };
}

export function configExists(home: string): boolean {
  return existsSync(engineFiles(home).config);
}
