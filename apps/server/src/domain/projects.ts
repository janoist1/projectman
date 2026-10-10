import { isAbsolute } from 'node:path';
import {
  DEFAULT_PROJECT_LANGUAGE,
  ProjectConfig,
  applyConfigPatch,
  configSchemaIssues,
  integratorConfigRefusal,
  isTheme,
  memberOf,
  operatorFixedChange,
  ownerOnlyChanges,
  unknownPatchRepo,
  validateProjectConfig,
} from '@projectman/shared';
import type {
  Actor,
  CardMover,
  ConfigVersionEntry,
  CreateProjectRequest,
  HumanAccess,
  OwnerOnlyChange,
  PatchConfigRequest,
  ProjectPreview,
  ProjectSummary,
} from '@projectman/shared';
import { ConfigStoreError } from '../config/errors';
import type { ConfigStore } from '../contracts';
import type { ProjectRecord } from '../db';
import { projectAccessFor } from './access';
import { isoNow } from './context';
import type { DomainContext, TemplateRegistry } from './context';
import { conflict, DomainError, forbidden, invalid, notFound, ownerLoginRequired } from './errors';
import type { TimelineService } from './timeline';
import { humanActor, KeyedMutex } from './util';

/** The Operator is fixed (PM-473): nobody, whoever they are, changes it beyond its model, provider and effort. */
function assertOperatorFixed(previous: ProjectConfig | null, next: ProjectConfig): void {
  const fixed = operatorFixedChange(previous, next);
  if (fixed) {
    throw conflict(
      'operator_fixed',
      'the Operator is fixed: only its model, provider and effort can change',
      fixed,
    );
  }
}

export interface LoadedProject {
  config: ProjectConfig;
  version: string;
}

export interface Author {
  via?: 'integrator';
  name: string;
  email: string;
}

export interface ConfigChangeMeta {
  actor: Actor;
  author: Author;
  message: string;
  /** Internal invitation acceptance may claim only this previously unbound seat. */
  invitationBinding?: { handle: string; email: string };
  /** Members who leave in this change and who takes over their open tasks (handle -> handle). */
  handovers?: Readonly<Record<string, string>>;
}

/** A human's edit of the configuration (settings: replace, patch or revert). */
export interface ConfigEditMeta {
  actor: Actor;
  author: Author;
  /** Commit message; a default describes the change. */
  message?: string;
  /** Rejects the edit with 409 config_conflict unless the configuration is still at this version. */
  expectedVersion?: string;
}

export interface ConfigChange {
  projectKey: string;
  /** null when the project was just created or imported. */
  previous: ProjectConfig | null;
  next: ProjectConfig;
  version: string;
  actor: Actor;
  /** Members who left in this change and who takes over their open tasks (handle -> handle). */
  handovers?: Readonly<Record<string, string>>;
}

/** Handle of the human who creates a project from a template. */
export const OWNER_HANDLE = 'owner';

const OWNER_ONLY_MESSAGES: Record<OwnerOnlyChange, string> = {
  locations: 'only an owner may change filesystem locations',
  admin_or_account: 'only an owner may grant admin access or change account bindings',
  approval_policy: 'only an owner may change or remove human approval gates',
  release_approvers: 'only an owner may change the release approvers',
  owners: 'only an owner may change who is an owner',
  permissions: 'only an owner may change the permission mode or the approver of an AI member',
};

/** The card mover a create request names; absent means the worker. */
function cardMoverOfRequest(choice: CreateProjectRequest['cardMover']): CardMover {
  if (choice === 'creator') return { kind: 'human', handle: OWNER_HANDLE };
  return { kind: choice ?? 'worker' };
}

function fromConfigError(err: unknown): never {
  if (err instanceof ConfigStoreError) {
    switch (err.code) {
      case 'invalid_config':
      case 'invalid_yaml':
        throw new DomainError('invalid_config', err.message, { status: 422, details: err.details });
      case 'not_found':
        throw new DomainError('not_found', err.message, { status: 404 });
      case 'unknown_version':
        throw invalid('unknown_version', err.message);
      case 'invalid_key':
        throw invalid('invalid_request', err.message);
    }
  }
  throw err;
}

/** An invalid configuration in a settings edit: 400 config_invalid with `{ issues }`. */
export function configInvalid(message: string, details: unknown): DomainError {
  const schemaIssues = (details as { schemaIssues?: unknown } | undefined)?.schemaIssues;
  return invalid(
    'config_invalid',
    message,
    Array.isArray(schemaIssues) ? { issues: configSchemaIssues(schemaIssues) } : details,
  );
}

/** Settings edits answer with the codes the settings editor handles (config_invalid). */
function asConfigEditError(err: unknown): never {
  if (err instanceof DomainError && err.code === 'invalid_config')
    throw configInvalid(err.message, err.details);
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
  private readonly isDirectory: (projectKey: string, path: string) => Promise<boolean>;
  private readonly cache = new Map<string, LoadedProject>();
  private readonly locks = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    configStore: ConfigStore;
    templates: TemplateRegistry;
    timeline: TimelineService;
    /** Whether a path is a directory on the engine the project's work runs on (PM-312). */
    isDirectory: (projectKey: string, path: string) => Promise<boolean>;
  }) {
    this.ctx = deps.ctx;
    this.configStore = deps.configStore;
    this.templates = deps.templates;
    this.timeline = deps.timeline;
    this.isDirectory = deps.isDirectory;
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

  /** Already loaded at startup or on config commits; no filesystem access. */
  cachedConfig(key: string): ProjectConfig | undefined {
    return this.cache.get(key)?.config;
  }

  async config(key: string): Promise<ProjectConfig> {
    return (await this.load(key)).config;
  }

  async history(key: string, limit?: number): Promise<ConfigVersionEntry[]> {
    if (!this.has(key)) throw notFound('project', key);
    return this.configStore.history(key, limit).catch(fromConfigError);
  }

  /**
   * The configuration a create would save: the template's, with the request's name, workspace,
   * repositories and card mover. Reads no disk and changes nothing.
   */
  buildConfig(req: CreateProjectRequest, creator: Author): ProjectConfig {
    const template = this.templates.get(req.templateId);
    if (!template) throw invalid('unknown_template', `unknown template: ${req.templateId}`);
    const built = template.build({
      key: req.key,
      name: req.name,
      workspacePath: req.workspacePath,
      language: DEFAULT_PROJECT_LANGUAGE,
      owner: { handle: OWNER_HANDLE, displayName: creator.name, email: creator.email },
      cardMover: cardMoverOfRequest(req.cardMover),
    });
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
    return parsed.data;
  }

  /** What a create with this request would make and what is wrong with it; no side effects. */
  preview(req: CreateProjectRequest, creator: Author): ProjectPreview {
    const config = this.buildConfig(req, creator);
    return { config, issues: validateProjectConfig(config) };
  }

  async create(req: CreateProjectRequest, creator: Author): Promise<ProjectSummary> {
    return this.locks.run(`config:${req.key}`, async () => {
      if (this.has(req.key) || (await this.configStore.list()).includes(req.key)) {
        throw conflict('project_exists', `project ${req.key} already exists`);
      }
      const config = this.buildConfig(req, creator);
      if (!isAbsolute(req.workspacePath) || !(await this.isDirectory(req.key, req.workspacePath))) {
        throw invalid('workspace_not_found', `workspace directory not found: ${req.workspacePath}`);
      }
      // The rule is the invariant's (one place); creation answers it with a code of its own.
      if (validateProjectConfig(config).some((issue) => issue.code === 'duplicate_repo')) {
        throw invalid('duplicate_repo', 'repository names must be unique');
      }
      assertOperatorFixed(null, config);
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
        {
          projectKey: req.key,
          previous: null,
          next: config,
          version,
          actor: { ...humanActor(OWNER_HANDLE), ...(creator.via ? { via: creator.via } : {}) },
        },
        message,
      );
      return toSummary(record);
    });
  }

  /** Replaces the whole configuration (a settings edit). */
  async save(key: string, config: ProjectConfig, meta: ConfigEditMeta): Promise<LoadedProject> {
    return this.edit(key, meta, () => ({ next: config, message: 'Update configuration' }));
  }

  /** Changes the sections present in `patch` (a settings edit); `patch.baseVersion` rejects stale edits. */
  async patch(
    key: string,
    patch: PatchConfigRequest,
    meta: Omit<ConfigEditMeta, 'message' | 'expectedVersion'>,
  ): Promise<LoadedProject> {
    return this.edit(
      key,
      { ...meta, message: patch.message, expectedVersion: patch.baseVersion },
      (current) => {
        const unknownRepo = unknownPatchRepo(current, patch);
        if (unknownRepo !== null) throw invalid('unknown_repo', `unknown repository: ${unknownRepo}`);
        return {
          next: applyConfigPatch(current, patch),
          message: patch.pipeline ? 'Update pipeline' : patch.limits ? 'Update limits' : 'Update project',
        };
      },
    );
  }

  /** Settings edits: stale edits are 409 config_conflict, invalid results 400 config_invalid. */
  private async edit(
    key: string,
    meta: ConfigEditMeta,
    change: (current: ProjectConfig) => { next: ProjectConfig; message: string },
  ): Promise<LoadedProject> {
    return this.locks.run(`config:${key}`, async () => {
      const current = await this.load(key);
      if (meta.expectedVersion && meta.expectedVersion !== current.version) {
        throw conflict('config_conflict', 'the configuration changed since it was loaded', {
          currentVersion: current.version,
        });
      }
      const { next, message } = change(current.config);
      if (next.project.key !== key) throw invalid('invalid_request', 'project key cannot be changed');
      return this.commitLocked(key, current, next, {
        actor: meta.actor,
        author: meta.author,
        message: meta.message ?? message,
      }).catch(asConfigEditError);
    });
  }

  /** Read-modify-write of the configuration; `change` edits the draft and returns the commit message. */
  async update(
    key: string,
    meta: Omit<ConfigChangeMeta, 'message'>,
    change: (draft: ProjectConfig) => string,
  ): Promise<LoadedProject> {
    return this.locks.run(`config:${key}`, async () => {
      const current = await this.load(key);
      const draft = structuredClone(current.config);
      const message = change(draft);
      return this.commitLocked(key, current, draft, { ...meta, message });
    });
  }

  /** Restores an earlier version in a new commit (a settings edit, under the same rules as any commit). */
  async revert(key: string, version: string, meta: { actor: Actor; author: Author }): Promise<LoadedProject> {
    return this.locks.run(`config:${key}`, async () => {
      const current = await this.load(key);
      const target = await this.configStore
        .loadVersion(key, version)
        .catch(fromConfigError)
        .catch(asConfigEditError);
      this.assertCommitAllowed(key, current.config, target, meta);
      await this.configStore
        .revertTo(key, version, { author: meta.author })
        .catch(fromConfigError)
        .catch(asConfigEditError);
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
  static assertChangeAllowed(
    previous: ProjectConfig,
    next: ProjectConfig,
    access: HumanAccess,
    invitationBinding?: ConfigChangeMeta['invitationBinding'],
  ): void {
    if (access === 'owner') return;
    const [change] = ownerOnlyChanges(previous, next, { invitationBinding });
    if (change) throw forbidden('owner_only', OWNER_ONLY_MESSAGES[change]);
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
          await this.ctx.events.emit('config_changed', {
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

  /**
   * Rules for every configuration commit, whoever makes it: the actor's owner-only rules, and
   * no stage may disappear while tasks occupy it (409 stage_in_use).
   */
  private assertCommitAllowed(
    key: string,
    previous: ProjectConfig,
    next: ProjectConfig,
    meta: Pick<ConfigChangeMeta, 'actor' | 'invitationBinding'>,
  ): void {
    const member = memberOf(previous, meta.actor.handle);
    if (meta.actor.kind !== 'system') {
      if (meta.actor.kind !== 'human' || member?.kind !== 'human')
        throw forbidden('insufficient_access', 'only human members may change the configuration');
      ProjectService.assertChangeAllowed(previous, next, member.access, meta.invitationBinding);
    } else {
      ProjectService.assertChangeAllowed(previous, next, 'admin');
    }
    assertOperatorFixed(previous, next);
    if (meta.actor.via === 'integrator') {
      const refusal = integratorConfigRefusal(previous, next);
      if (refusal) throw ownerLoginRequired(refusal);
    }
    const stageIds = new Set(next.pipeline.stages.map((stage) => stage.id));
    const removed = previous.pipeline.stages.filter((stage) => !stageIds.has(stage.id));
    if (!removed.length) return;
    // A theme has the first stage's id because the field is required, but it is in no stage (PM-192).
    const tasks = this.ctx.repos.tasks.list(key).filter((task) => !isTheme(task));
    for (const stage of removed) {
      const count = tasks.filter((task) => task.stageId === stage.id).length;
      if (count) {
        throw conflict('stage_in_use', 'tasks still occupy the removed stage', {
          stageId: stage.id,
          tasks: count,
        });
      }
    }
  }

  private async commitLocked(
    key: string,
    current: LoadedProject,
    next: ProjectConfig,
    meta: ConfigChangeMeta,
  ): Promise<LoadedProject> {
    this.assertCommitAllowed(key, current.config, next, meta);
    const { version } = await this.configStore
      .save(key, next, { author: meta.author, message: meta.message, previous: current.config })
      .catch(fromConfigError);
    const loaded: LoadedProject = { config: ProjectConfig.parse(next), version };
    this.cache.set(key, loaded);
    if (version !== current.version) {
      this.touchRecord(key, loaded);
      await this.announce(
        {
          projectKey: key,
          previous: current.config,
          next: loaded.config,
          version,
          actor: meta.actor,
          ...(meta.handovers ? { handovers: meta.handovers } : {}),
        },
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
    await this.ctx.events.emit('config_changed', change);
  }
}
