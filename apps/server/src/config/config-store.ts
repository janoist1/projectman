import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectConfig, validateProjectConfig } from '@projectman/shared';
import type { ConfigVersionEntry } from '@projectman/shared';
import type { ConfigStore } from '../contracts';
import { ConfigStoreError } from './errors';
import { runGit } from './git';
import type { GitResult } from './git';
import { mergeProjectFiles, parseYamlFile, PROJECT_FILES, splitProjectConfig } from './layout';
import type { ProjectFileName } from './layout';

export interface GitIdentity {
  name: string;
  email: string;
}

export interface ConfigStoreOptions {
  /** Directory of the customization repository, e.g. ~/.projectman/customization. */
  rootDir: string;
  /** Committer of every commit (the author is whoever made the change). */
  committer?: GitIdentity;
}

export interface GitConfigStore extends ConfigStore {
  readonly rootDir: string;
  /** Creates the repository with an initial commit if it does not exist yet. Idempotent. */
  init(): Promise<void>;
}

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/;
const VERSION_RE = /^[0-9a-f]{4,64}$/i;
const DEFAULT_COMMITTER: GitIdentity = { name: 'projectman', email: 'projectman@localhost' };

const README = `# projectman customization repository

Project configuration (team, pipeline, limits, role instructions) managed by projectman.
Every change made in the app is a commit here, so any version can be restored.

    projects/<KEY>/project.yaml   project, repositories, team limits
    projects/<KEY>/team.yaml      members
    projects/<KEY>/pipeline.yaml  board columns and stages
`;

/** Strips characters that would break the "Name <email>" author format. */
function cleanIdentity(identity: GitIdentity): GitIdentity {
  const clean = (s: string) => s.replace(/[<>\r\n]/g, '').trim();
  return { name: clean(identity.name) || 'unknown', email: clean(identity.email) || 'unknown@localhost' };
}

function assertKey(key: string): void {
  if (!PROJECT_KEY_RE.test(key)) throw new ConfigStoreError('invalid_key', `invalid project key: ${key}`);
}

/** Parses and validates a merged configuration object (schema + invariants). */
function validate(raw: unknown, expectedKey: string): ProjectConfig {
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
  const issues = validateProjectConfig(parsed.data);
  if (issues.length > 0) {
    throw new ConfigStoreError('invalid_config', 'configuration violates the team invariants', { issues });
  }
  return parsed.data;
}

export function createConfigStore(opts: ConfigStoreOptions): GitConfigStore {
  const rootDir = opts.rootDir;
  const committer = cleanIdentity(opts.committer ?? DEFAULT_COMMITTER);
  let queue: Promise<unknown> = Promise.resolve();
  let initialized: Promise<void> | null = null;

  /** Serializes repository mutations (git's index is not concurrent). */
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  const git = (args: string[], okCodes?: number[]): Promise<GitResult> =>
    runGit(rootDir, args, {
      okCodes,
      env: { GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email },
    });

  async function commit(message: string, author: GitIdentity, paths: string[]): Promise<string> {
    const a = cleanIdentity(author);
    await git([
      'commit',
      '-q',
      '--no-verify',
      '-m',
      message,
      `--author=${a.name} <${a.email}>`,
      '--',
      ...paths,
    ]);
    return (await git(['rev-parse', 'HEAD'])).stdout.trim();
  }

  async function ensureInit(): Promise<void> {
    initialized ??= exclusive(async () => {
      await mkdir(rootDir, { recursive: true });
      if (!existsSync(join(rootDir, '.git'))) await git(['init', '-q', '-b', 'main']);
      const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], [1]);
      if (head.code !== 0) {
        await writeFile(join(rootDir, 'README.md'), README);
        await git(['add', 'README.md']);
        await commit('Initialize customization repository', committer, ['README.md']);
      }
      await mkdir(join(rootDir, 'projects'), { recursive: true });
    }).catch((err) => {
      initialized = null;
      throw err;
    });
    return initialized;
  }

  const projectPath = (key: string) => `projects/${key}`;

  async function projectVersion(key: string): Promise<string> {
    const log = await git(['log', '-1', '--format=%H', '--', projectPath(key)]);
    const version = log.stdout.trim();
    return version || (await git(['rev-parse', 'HEAD'])).stdout.trim();
  }

  async function hasStagedChanges(path: string): Promise<boolean> {
    return (await git(['diff', '--cached', '--quiet', '--', path], [1])).code === 1;
  }

  async function readWorkingTree(key: string): Promise<Record<ProjectFileName, unknown>> {
    const dir = join(rootDir, projectPath(key));
    const files = {} as Record<ProjectFileName, unknown>;
    for (const file of PROJECT_FILES) {
      const path = join(dir, file);
      files[file] = existsSync(path) ? parseYamlFile(file, await readFile(path, 'utf8')) : undefined;
    }
    return files;
  }

  async function writeProject(key: string, contents: Record<ProjectFileName, string>): Promise<void> {
    const dir = join(rootDir, projectPath(key));
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const file of PROJECT_FILES) await writeFile(join(dir, file), contents[file]);
  }

  return {
    rootDir,
    init: ensureInit,

    async list() {
      await ensureInit();
      const dir = join(rootDir, 'projects');
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && PROJECT_KEY_RE.test(e.name))
        .filter((e) => existsSync(join(dir, e.name, 'project.yaml')))
        .map((e) => e.name)
        .sort();
    },

    async load(projectKey) {
      assertKey(projectKey);
      await ensureInit();
      if (!existsSync(join(rootDir, projectPath(projectKey), 'project.yaml'))) {
        throw new ConfigStoreError('not_found', `no configuration for project ${projectKey}`);
      }
      const config = validate(mergeProjectFiles(await readWorkingTree(projectKey)), projectKey);
      return { config, version: await projectVersion(projectKey) };
    },

    async save(projectKey, config, meta) {
      assertKey(projectKey);
      await ensureInit();
      const valid = validate(config, projectKey);
      return exclusive(async () => {
        await writeProject(projectKey, splitProjectConfig(valid));
        const path = projectPath(projectKey);
        await git(['add', '-A', '--', path]);
        if (!(await hasStagedChanges(path))) return { version: await projectVersion(projectKey) };
        return { version: await commit(meta.message, meta.author, [path]) };
      });
    },

    async history(projectKey, limit = 50) {
      assertKey(projectKey);
      await ensureInit();
      const n = Math.max(1, Math.min(500, Math.floor(limit)));
      const log = await git([
        'log',
        `-n${n}`,
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
          return { version, author, at, message: message.trim() };
        });
    },

    async revertTo(projectKey, version, meta) {
      assertKey(projectKey);
      await ensureInit();
      if (!VERSION_RE.test(version))
        throw new ConfigStoreError('unknown_version', `unknown version: ${version}`);
      return exclusive(async () => {
        const resolved = await git(['rev-parse', '--verify', '-q', `${version}^{commit}`], [1, 128]);
        if (resolved.code !== 0) throw new ConfigStoreError('unknown_version', `unknown version: ${version}`);
        const commitId = resolved.stdout.trim();
        const path = projectPath(projectKey);

        const contents = {} as Record<ProjectFileName, string>;
        const parsed = {} as Record<ProjectFileName, unknown>;
        for (const file of PROJECT_FILES) {
          const show = await git(['show', `${commitId}:${path}/${file}`], [128]);
          if (show.code !== 0) {
            throw new ConfigStoreError(
              'unknown_version',
              `version ${version} has no ${file} for ${projectKey}`,
            );
          }
          contents[file] = show.stdout;
          parsed[file] = parseYamlFile(file, show.stdout);
        }
        validate(mergeProjectFiles(parsed), projectKey);

        await writeProject(projectKey, contents);
        await git(['add', '-A', '--', path]);
        if (!(await hasStagedChanges(path))) return { version: await projectVersion(projectKey) };
        const message = `Revert ${projectKey} configuration to ${commitId.slice(0, 12)}`;
        return { version: await commit(message, meta.author, [path]) };
      });
    },
  };
}
