import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ProjectConfig, humanApprovalChanged } from '@projectman/shared';
import type {
  Actor,
  ConfigVersionEntry,
  CreateProjectRequest,
  HumanAccess,
  ProjectSummary,
} from '@projectman/shared';
import { ConfigStoreError } from '../config/errors';
import type { ConfigStore } from '../contracts';
import type { ProjectRecord } from '../db';
import { ownersSignature, projectAccessFor, releaseApproversSignature } from './access';
import { isoNow } from './context';
import type { DomainContext, TemplateRegistry } from './context';
import { conflict, DomainError, forbidden, invalid, notFound } from './errors';
import type { TimelineService } from './timeline';
import { humanActor, KeyedMutex } from './util';

export interface LoadedProject {
  config: ProjectConfig;
  version: string;
}

export interface Author {
  name: string;
  email: string;
}

export interface ConfigChangeMeta {
  actor: Actor;
  author: Author;
  message: string;
}

export interface ConfigChange {
  projectKey: string;
  /** null when the project was just created or imported. */
  previous: ProjectConfig | null;
  next: ProjectConfig;
  version: string;
  actor: Actor;
}

export type ConfigChangeListener = (change: ConfigChange) => void | Promise<void>;

/** Language of new projects (humans and agents communicate in it). */
export const DEFAULT_PROJECT_LANGUAGE = 'hu';
/** Handle of the human who creates a project from a template. */
export const OWNER_HANDLE = 'owner';

function fromConfigError(err: unknown): never {
  if (err instanceof ConfigStoreError) {
    switch (err.code) {
      case 'invalid_config':
      case 'invalid_yaml':
        throw new DomainError('invalid_config', err.message, { status: 422, details: err.details });
      case 'not_found':
        throw new DomainError('not_found', err.message, { status: 404 });
      case 'unknown_version':
        throw new DomainError('unknown_version', err.message, { status: 400 });
      case 'invalid_key':
        throw new DomainError('invalid_request', err.message, { status: 400 });
    }
  }
  throw err;
}

function toSummary(p: ProjectRecord): ProjectSummary {
  return { key: p.key, name: p.name, templateId: p.templateId, configVersion: p.configVersion };
}

/**
 * Projects: the database row (key, name, config version) plus the configuration in the
 * customization repository, cached in memory and refreshed on every save.
 */
export class ProjectService {
  private readonly ctx: DomainContext;
  private readonly configStore: ConfigStore;
  private readonly templates: TemplateRegistry;
  private readonly timeline: TimelineService;
  private readonly cache = new Map<string, LoadedProject>();
  private readonly listeners: ConfigChangeListener[] = [];
  private readonly locks = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    configStore: ConfigStore;
    templates: TemplateRegistry;
    timeline: TimelineService;
  }) {
    this.ctx = deps.ctx;
    this.configStore = deps.configStore;
    this.templates = deps.templates;
    this.timeline = deps.timeline;
  }

  /** Called after every committed configuration change (including project creation). */
  onConfigChanged(listener: ConfigChangeListener): void {
    this.listeners.push(listener);
  }

  summaries(): ProjectSummary[] {
    return this.ctx.repos.projects.list().map(toSummary);
  }

  summary(key: string): ProjectSummary {
    const row = this.ctx.repos.projects.get(key);
    if (!row) throw notFound('project', key);
    return toSummary(row);
  }

  has(key: string): boolean {
    return this.ctx.repos.projects.get(key) !== null;
  }

  async load(key: string): Promise<LoadedProject> {
    if (!this.has(key)) throw notFound('project', key);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const loaded = await this.configStore.load(key).catch(fromConfigError);
    this.cache.set(key, loaded);
    return loaded;
  }

  async config(key: string): Promise<ProjectConfig> {
    return (await this.load(key)).config;
  }

  async history(key: string, limit?: number): Promise<ConfigVersionEntry[]> {
    if (!this.has(key)) throw notFound('project', key);
    return this.configStore.history(key, limit).catch(fromConfigError);
  }

  async create(req: CreateProjectRequest, creator: Author): Promise<ProjectSummary> {
    return this.locks.run(`config:${req.key}`, async () => {
      if (this.has(req.key) || (await this.configStore.list()).includes(req.key)) {
        throw conflict('project_exists', `project ${req.key} already exists`);
      }
      const template = this.templates.get(req.templateId);
      if (!template) throw invalid('unknown_template', `unknown template: ${req.templateId}`);
      if (
        !isAbsolute(req.workspacePath) ||
        !existsSync(req.workspacePath) ||
        !statSync(req.workspacePath).isDirectory()
      ) {
        throw invalid('workspace_not_found', `workspace directory not found: ${req.workspacePath}`);
      }

      const built = template.build({
        key: req.key,
        name: req.name,
        workspacePath: req.workspacePath,
        language: DEFAULT_PROJECT_LANGUAGE,
        owner: { handle: OWNER_HANDLE, displayName: creator.name, email: creator.email },
      });
      const repoNames = (req.repos ?? []).map((r) => r.name);
      if (new Set(repoNames).size !== repoNames.length) {
        throw invalid('duplicate_repo', 'repository names must be unique');
      }
      const parsed = ProjectConfig.safeParse({
        ...built,
        project: {
          ...built.project,
          key: req.key,
          name: req.name,
          workspacePath: req.workspacePath,
          templateId: req.templateId,
          ...(req.repos ? { repos: req.repos } : {}),
        },
      });
      if (!parsed.success) {
        throw new DomainError('invalid_config', 'template produced an invalid configuration', {
          status: 422,
          details: { schemaIssues: parsed.error.issues },
        });
      }
      const config = parsed.data;
      if (projectAccessFor(config, creator.email)?.access !== 'owner') {
        throw new DomainError('invalid_config', 'template did not make the creator an owner', {
          status: 422,
        });
      }

      const message = `Create project ${req.key} from template ${req.templateId}`;
      const { version } = await this.configStore
        .save(req.key, config, { author: creator, message })
        .catch(fromConfigError);
      const at = isoNow(this.ctx);
      const record: ProjectRecord = {
        key: req.key,
        name: req.name,
        templateId: req.templateId,
        configVersion: version,
        createdAt: at,
        updatedAt: at,
      };
      this.ctx.repos.projects.insert(record);
      this.cache.set(req.key, { config, version });
      await this.announce(
        { projectKey: req.key, previous: null, next: config, version, actor: humanActor(OWNER_HANDLE) },
        message,
      );
      return toSummary(record);
    });
  }

  /**
   * Validates and commits a whole configuration. `check` runs against the current
   * configuration inside the lock (e.g. owner-only rules); `expectedVersion` rejects
   * stale edits.
   */
  async save(
    key: string,
    config: ProjectConfig,
    meta: ConfigChangeMeta & {
      check?: (previous: ProjectConfig, next: ProjectConfig) => void;
      expectedVersion?: string;
    },
  ): Promise<LoadedProject> {
    return this.locks.run(`config:${key}`, async () => {
      const current = await this.load(key);
      if (meta.expectedVersion && meta.expectedVersion !== current.version) {
        throw conflict('version_conflict', 'the configuration changed since it was loaded', {
          currentVersion: current.version,
        });
      }
      if (config.project.key !== key) throw invalid('invalid_request', 'project key cannot be changed');
      meta.check?.(current.config, config);
      return this.commitLocked(key, current, config, meta);
    });
  }

  /** Read-modify-write of the configuration; `change` edits the draft and returns the commit message. */
  async update(
    key: string,
    meta: { actor: Actor; author: Author },
    change: (draft: ProjectConfig) => string,
  ): Promise<LoadedProject> {
    return this.locks.run(`config:${key}`, async () => {
      const current = await this.load(key);
      const draft = structuredClone(current.config);
      const message = change(draft);
      return this.commitLocked(key, current, draft, { ...meta, message });
    });
  }

  async revert(key: string, version: string, meta: { actor: Actor; author: Author }): Promise<LoadedProject> {
    return this.locks.run(`config:${key}`, async () => {
      const current = await this.load(key);
      await this.configStore.revertTo(key, version, { author: meta.author }).catch(fromConfigError);
      const loaded = await this.configStore.load(key).catch(fromConfigError);
      this.cache.set(key, loaded);
      if (loaded.version !== current.version) {
        this.touchRecord(key, loaded);
        await this.announce(
          {
            projectKey: key,
            previous: current.config,
            next: loaded.config,
            version: loaded.version,
            actor: meta.actor,
          },
          `Revert to ${version}`,
        );
      }
      return loaded;
    });
  }

  /** Owner-only rules for configuration edits by humans. */
  static assertChangeAllowed(previous: ProjectConfig, next: ProjectConfig, access: HumanAccess): void {
    if (access === 'owner') return;
    if (humanApprovalChanged(previous, next)) {
      throw forbidden('owner_only', 'only an owner may change or remove human approval gates');
    }
    if (releaseApproversSignature(previous) !== releaseApproversSignature(next)) {
      throw forbidden('owner_only', 'only an owner may change the release approvers');
    }
    if (ownersSignature(previous) !== ownersSignature(next)) {
      throw forbidden('owner_only', 'only an owner may change who is an owner');
    }
  }

  /**
   * Startup: registers projects that exist in the customization repository but not in the
   * database, and refreshes the version of known ones (the repository may be edited by hand).
   */
  async syncFromStore(): Promise<void> {
    for (const key of await this.configStore.list()) {
      try {
        const loaded = await this.configStore.load(key);
        this.cache.set(key, loaded);
        const row = this.ctx.repos.projects.get(key);
        if (!row) {
          const at = isoNow(this.ctx);
          this.ctx.repos.projects.insert({
            key,
            name: loaded.config.project.name,
            templateId: loaded.config.project.templateId ?? null,
            configVersion: loaded.version,
            createdAt: at,
            updatedAt: at,
          });
          await this.notify({
            projectKey: key,
            previous: null,
            next: loaded.config,
            version: loaded.version,
            actor: { kind: 'system', handle: null },
          });
        } else if (row.configVersion !== loaded.version || row.name !== loaded.config.project.name) {
          this.touchRecord(key, loaded);
        }
      } catch (err) {
        this.ctx.logger.error({ err, projectKey: key }, 'could not load project configuration');
      }
    }
  }

  private async commitLocked(
    key: string,
    current: LoadedProject,
    next: ProjectConfig,
    meta: ConfigChangeMeta,
  ): Promise<LoadedProject> {
    const { version } = await this.configStore
      .save(key, next, { author: meta.author, message: meta.message })
      .catch(fromConfigError);
    const loaded: LoadedProject = { config: ProjectConfig.parse(next), version };
    this.cache.set(key, loaded);
    if (version !== current.version) {
      this.touchRecord(key, loaded);
      await this.announce(
        { projectKey: key, previous: current.config, next: loaded.config, version, actor: meta.actor },
        meta.message,
      );
    }
    return loaded;
  }

  private touchRecord(key: string, loaded: LoadedProject): void {
    this.ctx.repos.projects.update(key, {
      name: loaded.config.project.name,
      configVersion: loaded.version,
      updatedAt: isoNow(this.ctx),
    });
  }

  private async announce(change: ConfigChange, message: string): Promise<void> {
    this.timeline.append({
      projectKey: change.projectKey,
      actor: change.actor,
      type: 'config_changed',
      data: { version: change.version, message },
    });
    this.ctx.bus.publish({ type: 'config_changed', projectKey: change.projectKey, version: change.version });
    await this.notify(change);
  }

  private async notify(change: ConfigChange): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(change);
      } catch (err) {
        this.ctx.logger.error({ err, projectKey: change.projectKey }, 'config change listener failed');
      }
    }
  }
}
