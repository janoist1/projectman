import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  ActorCredential,
  hasBoundOrigin,
  introducedErrors,
  isToleratedOnLoad,
  ProjectConfig,
  validateProjectConfig,
} from '@projectman/shared';
import type { Actor, BoundActor, ConfigIssue, ConfigVersionEntry } from '@projectman/shared';
import type { ConfigStore } from '../contracts';
import { attributedMessage, createCustomizationRepo } from './customization-repo';
import type { CustomizationRepo, GitIdentity } from './customization-repo';
import { ConfigStoreError } from './errors';
import type { GitResult } from './git';
import { mergeProjectFiles, parseYamlFile, PROJECT_FILES, splitProjectConfig } from './layout';
import type { ProjectFileName } from './layout';
import { migrateProjectConfig } from './migrations';

interface ConfigStoreOptions {
  /** Directory of the customization repository, e.g. ~/.projectman/customization. */
  rootDir: string;
  logger?: Pick<FastifyBaseLogger, 'warn'>;
  /** Committer of every commit (the author is whoever made the change). */
  committer?: GitIdentity;
  /**
   * The repository (and its serial queue) shared with the documents store; without it the store
   * creates its own for `rootDir`.
   */
  repo?: CustomizationRepo;
}

export interface GitConfigStore extends ConfigStore {
  readonly rootDir: string;
  /** Creates the repository with an initial commit if it does not exist yet. Idempotent. */
  init(): Promise<void>;
}

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/;
const VERSION_RE = /^[0-9a-f]{4,64}$/i;

/**
 * The actor the trailers of a commit describe, or undefined unless they agree: the old super mode (PM-757:
 * mode, handle, credential) or the connected Claude (decision 66: kind, handle, holder, credential).
 */
function superActorFromTrailers(trailers: {
  mode: string | undefined;
  handle: string | undefined;
  id: string | undefined;
  prefix: string | undefined;
  connected: {
    kind: string | undefined;
    handle: string | undefined;
    holder: string | undefined;
    approvedBy: string | undefined;
  };
}): BoundActor | undefined {
  const credential = ActorCredential.safeParse({ id: trailers.id, prefix: trailers.prefix });
  if (!credential.success) return undefined;
  const { connected } = trailers;
  const actor: Actor | null =
    trailers.mode === 'super' && trailers.handle
      ? {
          kind: 'ai',
          handle: trailers.handle,
          via: 'integrator',
          operatorMode: 'super',
          credential: credential.data,
        }
      : (connected.kind === 'human' || connected.kind === 'ai') && connected.handle && connected.holder
        ? {
            kind: connected.kind,
            handle: connected.handle,
            via: 'integrator',
            through: { holder: connected.holder, credential: credential.data },
            ...(connected.approvedBy ? { approvedBy: connected.approvedBy } : {}),
          }
        : null;
  return actor && hasBoundOrigin(actor) ? actor : undefined;
}

function assertKey(key: string): void {
  if (!PROJECT_KEY_RE.test(key)) throw new ConfigStoreError('invalid_key', `invalid project key: ${key}`);
}

/**
 * Parses and validates a merged configuration object (schema + invariants). A configuration that
 * is read back from storage reports the errors it may still carry (`isToleratedOnLoad`, rules
 * added after it was written) to `tolerated` instead of failing; a change (a save, a revert) may
 * carry none unless a previous configuration is supplied, in which case only introduced errors fail.
 */
function validate(
  raw: unknown,
  expectedKey: string,
  tolerated?: (issue: ConfigIssue) => void,
  previous?: ProjectConfig,
): ProjectConfig {
  const parsed = ProjectConfig.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigStoreError('invalid_config', 'configuration does not match the schema', {
      schemaIssues: parsed.error.issues,
    });
  }
  if (parsed.data.project.key !== expectedKey) {
    throw new ConfigStoreError('invalid_config', 'project key does not match its directory', {
      issues: [{ code: 'invalid_key', path: 'project.key', detail: parsed.data.project.key }],
    });
  }
  const issues =
    previous === undefined ? validateProjectConfig(parsed.data) : introducedErrors(previous, parsed.data);
  const errors = issues.filter((issue) => issue.severity !== 'warning');
  const kept = tolerated ? errors.filter(isToleratedOnLoad) : [];
  if (errors.length > kept.length) {
    throw new ConfigStoreError('invalid_config', 'configuration violates the team invariants', { issues });
  }
  kept.forEach((issue) => tolerated?.(issue));
  return parsed.data;
}

export function createConfigStore(opts: ConfigStoreOptions): GitConfigStore {
  const rootDir = opts.rootDir;
  const logger = opts.logger ?? {
    warn: (details: unknown, message?: string) => console.warn(message, details),
  };
  const repo = opts.repo ?? createCustomizationRepo({ rootDir, committer: opts.committer });
  const { exclusive, commit } = repo;
  const git = (args: string[], okCodes?: number[]): Promise<GitResult> => repo.git(args, okCodes);
  const ensureInit = repo.init;

  const projectPath = (key: string) => `projects/${key}`;

  async function projectVersion(key: string): Promise<string> {
    const log = await git(['log', '-1', '--format=%H', '--', projectPath(key)]);
    const version = log.stdout.trim();
    return version || (await git(['rev-parse', 'HEAD'])).stdout.trim();
  }

  async function hasStagedChanges(path: string): Promise<boolean> {
    return (await git(['diff', '--cached', '--quiet', '--', path], [1])).code === 1;
  }

  async function assertProjectPaths(key: string): Promise<void> {
    for (const relative of [
      'projects',
      projectPath(key),
      ...PROJECT_FILES.map((file) => `${projectPath(key)}/${file}`),
    ]) {
      const info = await lstat(join(rootDir, relative)).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (info?.isSymbolicLink())
        throw new ConfigStoreError('invalid_config', 'symlinks are forbidden in project configuration');
    }
  }

  /**
   * Merges, migrates (older shapes) and validates the parsed files of a project. The working tree
   * is stored configuration: it loads with the errors it may still carry, which are logged (every
   * change refuses them). An earlier version is read to be restored, which is a change.
   */
  function toConfig(
    key: string,
    files: Record<ProjectFileName, unknown>,
    source: 'stored' | 'change',
  ): ProjectConfig {
    const migrated = migrateProjectConfig(mergeProjectFiles(files), { projectKey: key, logger });
    return validate(
      migrated,
      key,
      source === 'stored'
        ? (issue) =>
            logger.warn(
              { projectKey: key, code: issue.code, path: issue.path, detail: issue.detail },
              'Loaded a stored configuration that breaks a rule added later; changes are refused until it is fixed',
            )
        : undefined,
    );
  }

  async function readWorkingTree(key: string): Promise<Record<ProjectFileName, unknown>> {
    await assertProjectPaths(key);
    const dir = join(rootDir, projectPath(key));
    const files = {} as Record<ProjectFileName, unknown>;
    for (const file of PROJECT_FILES) {
      const path = join(dir, file);
      files[file] = existsSync(path) ? parseYamlFile(file, await readFile(path, 'utf8')) : undefined;
    }
    return files;
  }

  async function writeProject(key: string, contents: Record<ProjectFileName, string>): Promise<void> {
    await assertProjectPaths(key);
    const dir = join(rootDir, projectPath(key));
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const file of PROJECT_FILES) await writeFile(join(dir, file), contents[file]);
  }

  /** The project's files and validated configuration as of a commit. */
  async function readVersion(
    key: string,
    version: string,
  ): Promise<{ commitId: string; contents: Record<ProjectFileName, string>; config: ProjectConfig }> {
    if (!VERSION_RE.test(version))
      throw new ConfigStoreError('unknown_version', `unknown version: ${version}`);
    const resolved = await git(['rev-parse', '--verify', '-q', `${version}^{commit}`], [1, 128]);
    if (resolved.code !== 0) throw new ConfigStoreError('unknown_version', `unknown version: ${version}`);
    const commitId = resolved.stdout.trim();
    const path = projectPath(key);
    const contents = {} as Record<ProjectFileName, string>;
    const parsed = {} as Record<ProjectFileName, unknown>;
    for (const file of PROJECT_FILES) {
      const show = await git(['show', `${commitId}:${path}/${file}`], [128]);
      if (show.code !== 0) {
        throw new ConfigStoreError('unknown_version', `version ${version} has no ${file} for ${key}`);
      }
      contents[file] = show.stdout;
      parsed[file] = parseYamlFile(file, show.stdout);
    }
    return { commitId, contents, config: toConfig(key, parsed, 'change') };
  }

  return {
    rootDir,
    init: ensureInit,

    async list() {
      await ensureInit();
      return exclusive(async () => {
        const dir = join(rootDir, 'projects');
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
          .filter((e) => e.isDirectory() && PROJECT_KEY_RE.test(e.name))
          .filter((e) => existsSync(join(dir, e.name, 'project.yaml')))
          .map((e) => e.name)
          .sort();
      });
    },

    async load(projectKey) {
      assertKey(projectKey);
      await ensureInit();
      return exclusive(async () => {
        if (!existsSync(join(rootDir, projectPath(projectKey), 'project.yaml'))) {
          throw new ConfigStoreError('not_found', `no configuration for project ${projectKey}`);
        }
        const config = toConfig(projectKey, await readWorkingTree(projectKey), 'stored');
        return { config, version: await projectVersion(projectKey) };
      });
    },

    async save(projectKey, config, meta) {
      assertKey(projectKey);
      await ensureInit();
      const valid = validate(config, projectKey, undefined, meta.previous);
      return exclusive(async () => {
        await writeProject(projectKey, splitProjectConfig(valid));
        const path = projectPath(projectKey);
        await git(['add', '-A', '--', path]);
        if (!(await hasStagedChanges(path))) return { version: await projectVersion(projectKey) };
        return {
          version: await commit(attributedMessage(meta.message, meta.author), meta.author, [path]),
        };
      });
    },

    async history(projectKey, limit = 50, offset = 0) {
      assertKey(projectKey);
      await ensureInit();
      const n = Math.max(1, Math.min(500, Math.floor(limit)));
      const log = await git([
        'log',
        `-n${n}`,
        `--skip=${Math.max(0, Math.floor(offset))}`,
        '--format=%H%x1f%an%x1f%aI%x1f%B%x1e',
        '--',
        projectPath(projectKey),
      ]);
      return log.stdout
        .split('\x1e')
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record): ConfigVersionEntry => {
          const [version = '', author = '', at = '', message = ''] = record.split('\x1f');
          const body = message.trim();
          const separator = body.lastIndexOf('\n\n');
          const ending = separator >= 0 ? body.slice(separator + 2) : '';
          const hasTrailers =
            ending.length > 0 &&
            ending
              .split('\n')
              .every((line) =>
                /^Projectman-(?:Via|Operator|Operator-Mode|Operator-Handle|Connected-Kind|Connected-Handle|Connected-Holder|Connected-Approved-By|Credential-Id|Credential-Prefix|Audit-Id|Request|Approved-By|Step|Request-Id|Agreement-Version|Approval-Mode): ?[^\r\n]*$/.test(
                  line,
                ),
              );
          const trailer = (name: string) =>
            hasTrailers
              ? ending.match(new RegExp(`(?:^|\\n)Projectman-${name}: ?([^\\r\\n]*)`))?.[1]?.trim()
              : undefined;
          const via = trailer('Via') === 'integrator';
          const operator = trailer('Operator');
          const request = trailer('Request');
          const approvedBy = trailer('Approved-By');
          const superActor = superActorFromTrailers({
            mode: trailer('Operator-Mode'),
            handle: trailer('Operator-Handle'),
            id: trailer('Credential-Id'),
            prefix: trailer('Credential-Prefix'),
            connected: {
              kind: trailer('Connected-Kind'),
              handle: trailer('Connected-Handle'),
              holder: trailer('Connected-Holder'),
              approvedBy: trailer('Connected-Approved-By'),
            },
          });
          return {
            version,
            author,
            at,
            message: hasTrailers ? body.slice(0, separator).trim() : body,
            ...(via ? { via: 'integrator' } : {}),
            ...(superActor ? { actor: superActor } : {}),
            ...(superActor && trailer('Audit-Id') ? { superAuditId: trailer('Audit-Id') } : {}),
            ...(operator ? { operator } : {}),
            ...(request !== undefined ? { request } : {}),
            ...(approvedBy ? { approvedBy } : {}),
            ...(trailer('Step') ? { operatorStepId: trailer('Step') } : {}),
            ...(trailer('Request-Id') ? { operatorRequestId: trailer('Request-Id') } : {}),
            ...(trailer('Agreement-Version')
              ? { operatorAgreementVersion: Number(trailer('Agreement-Version')) }
              : {}),
            ...(trailer('Approval-Mode') === 'waived' || trailer('Approval-Mode') === 'click'
              ? { operatorApprovalMode: trailer('Approval-Mode') as 'click' | 'waived' }
              : {}),
          };
        });
    },

    async hasSuperAuditCommit(projectKey, auditId) {
      assertKey(projectKey);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(auditId)) return false;
      await ensureInit();
      const line = `Projectman-Audit-Id: ${auditId}`;
      const log = await git([
        'log',
        '--fixed-strings',
        `--grep=${line}`,
        '--format=%B%x1e',
        '--',
        projectPath(projectKey),
      ]);
      // The trailer is a whole line of the last paragraph, next to the super-mode or connected marker, not text in a message.
      return log.stdout.split('\x1e').some((record) => {
        const ending = record.trim().split('\n\n').at(-1)?.split('\n') ?? [];
        return (
          ending.includes(line) &&
          (ending.includes('Projectman-Operator-Mode: super') ||
            ending.some((entry) => entry.startsWith('Projectman-Connected-Holder: ')))
        );
      });
    },

    async loadVersion(projectKey, version) {
      assertKey(projectKey);
      await ensureInit();
      // Committed objects are immutable: no need to wait for writes.
      return (await readVersion(projectKey, version)).config;
    },

    async revertTo(projectKey, version, meta) {
      assertKey(projectKey);
      await ensureInit();
      return exclusive(async () => {
        const { commitId, contents } = await readVersion(projectKey, version);
        const path = projectPath(projectKey);
        await writeProject(projectKey, contents);
        await git(['add', '-A', '--', path]);
        if (!(await hasStagedChanges(path))) return { version: await projectVersion(projectKey) };
        const message = `Revert ${projectKey} configuration to ${commitId.slice(0, 12)}`;
        return {
          version: await commit(attributedMessage(message, meta.author), meta.author, [path]),
        };
      });
    },
  };
}
