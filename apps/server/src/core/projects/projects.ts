export function createProjectService(deps: ConstructorParameters<typeof ProjectService>[0]): ProjectService {
  return new ProjectService(deps);
}

import { isAbsolute } from 'node:path';
import {
  hasPendingOperatorAgreement,
  hasOperatorWaiverField,
  operatorWaiverChanged,
  DEFAULT_PROJECT_LANGUAGE,
  ProjectConfig,
  applyConfigPatch,
  configSchemaIssues,
  integratorConfigRefusal,
  isTheme,
  memberOf,
  operatorFixedChange,
  operatorConfigIssues,
  isOperatorActor,
  isSuperOperatorActor,
  hasSuperOrigin,
  operatorConfigVerdict,
  operatorApprovalOf,
  canonical,
  ownerOnlyChanges,
  unknownPatchRepo,
  superConfigMutations,
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
  SuperActor,
  OperatorOperation,
  OperatorApprovalWaiverRequest,
} from '@projectman/shared';
import { ConfigStoreError } from '../../config';
import type { ConfigStore, OperatorConfigAuthorization } from '../../contracts';
import type { ProjectRecord } from '../../db';
import { projectAccessFor } from '../members';
import { isoNow } from '../base';
import type { DomainContext, TemplateRegistry } from '../base';
import { conflict, DomainError, forbidden, invalid, notFound, ownerLoginRequired } from '../../kernel';
import { createSuperAuditService } from '../timeline';
import type { SuperAuditService, TimelineService } from '../timeline';
import { humanActor, KeyedMutex } from '../../kernel';
import {
  assertIntegratorAccess,
  assertOwnApproval,
  authorizeSuperMutation,
  integratorExecution,
} from '../../kernel';

/** The Operator is fixed (PM-473): nobody, whoever they are, changes it beyond its model, provider and effort. */
function assertOperatorFixed(previous: ProjectConfig | null, next: ProjectConfig): void {
  const issues = operatorConfigIssues(next);
  if (issues.length)
    throw invalid('invalid_config', 'configuration violates the Operator limits', { issues });
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
  operatorStepId?: string;
  operatorOperation?: OperatorOperation;
  operatorAgreementVersion?: number;
  operatorApprovalMode?: 'click' | 'waived';
  operator?: string;
  request?: string;
  approvedBy?: string;
  /** Internal provenance, never accepted from an HTTP request. */
  operatorRequestId?: string;
  operatorApprovalId?: string;
  via?: 'integrator';
  /** Set only from a bound super principal (PM-757); the commit records it. */
  superActor?: SuperActor;
  /** The owner whose current access authorizes a super-mode step (the token's owner). */
  authorizedBy?: string;
  /** The request a super-mode step belongs to (the audit's request id); a commit needs it. */
  superRequestId?: string;
  /** The audit entry that began a super-mode commit; set by the commit itself, for the trailer. */
  superAuditId?: string;
  name: string;
  email: string;
}

interface ConfigChangeMeta {
  actor: Actor;
  author: Author;
  message: string;
  /** Internal invitation acceptance may claim only this previously unbound seat. */
  invitationBinding?: { handle: string; email: string };
  /** Members who leave in this change and who takes over their open tasks (handle -> handle). */
  handovers?: Readonly<Record<string, string>>;
}

/** A human's edit of the configuration (settings: replace, patch or revert). */
interface ConfigEditMeta {
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
  email_send_policy: 'only an owner may change email approval policy',
  locations: 'only an owner may change filesystem locations',
  admin_or_account: 'only an owner may grant admin access or change account bindings',
  approval_policy: 'only an owner may change or remove human approval gates',
  release_approvers: 'only an owner may change the release approvers',
  owners: 'only an owner may change who is an owner',
  permissions: 'only an owner may change the permission mode or the approver of an AI member',
  review_test: 'only an owner may change the full test of a repository',
  operator_watch: 'only an owner may change how much the Operator does on its own on a signal',
  operator_approval_waiver: 'only an owner may change the Operator approval waiver',
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
  private readonly superAudit: SuperAuditService;
  private readonly isDirectory: (projectKey: string, path: string) => Promise<boolean>;
  private readonly cache = new Map<string, LoadedProject>();
  private readonly locks = new KeyedMutex();
  private operatorAuthorization?: OperatorConfigAuthorization;
  private agreementVersion?: (key: string) => Promise<number | null>;
  private readonly waiverEdits = new WeakSet<ConfigChangeMeta>();

  useOperatorAuthorization(
    port: OperatorConfigAuthorization,
    agreementVersion: (key: string) => Promise<number | null>,
  ): void {
    this.operatorAuthorization = port;
    this.agreementVersion = agreementVersion;
  }

  async setOperatorApprovalWaiver(key: string, input: OperatorApprovalWaiverRequest, meta: ConfigEditMeta) {
    assertOwnApproval(meta.actor);
    return this.locks.run(`config:${key}`, async () => {
      const current = await this.load(key);
      const person = memberOf(current.config, meta.actor.handle);
      if (
        meta.actor.kind !== 'human' ||
        meta.actor.via ||
        meta.author.via ||
        person?.kind !== 'human' ||
        person.access !== 'owner'
      )
        throw forbidden(
          'owner_approval_required',
          'only an owner using their own login may change the waiver',
        );
      if (current.version !== input.baseVersion) throw conflict('config_conflict', 'configuration changed');
      const agreementVersion = await this.agreementVersion?.(key);
      if (input.enabled && agreementVersion !== input.agreementVersion)
        throw conflict('operator_knowledge_stale', 'the approved agreement changed or is missing');
      const next = structuredClone(current.config);
      next.team.operatorApprovalWaiver = input.enabled;
      const commit = { actor: meta.actor, author: meta.author, message: 'Update Operator approval waiver' };
      this.waiverEdits.add(commit);
      const saved = await this.commitLocked(key, current, next, commit);
      return {
        version: saved.version,
        enabled: input.enabled,
        agreementVersion: agreementVersion ?? input.agreementVersion,
      };
    });
  }

  constructor(deps: {
    ctx: DomainContext;
    configStore: ConfigStore;
    templates: TemplateRegistry;
    timeline: TimelineService;
    /** The super-mode audit (PM-757); one is made from `ctx` when the caller has none to share. */
    superAudit?: SuperAuditService;
    /** Whether a path is a directory on the engine the project's work runs on (PM-312). */
    isDirectory: (projectKey: string, path: string) => Promise<boolean>;
  }) {
    this.ctx = deps.ctx;
    this.configStore = deps.configStore;
    this.templates = deps.templates;
    this.timeline = deps.timeline;
    this.superAudit = deps.superAudit ?? createSuperAuditService(deps.ctx);
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

  /** Serializes private knowledge CAS with every configuration commit. Do not mutate projects in work. */
  async withConfigurationLock<T>(
    projectKey: string,
    work: (loaded: { config: ProjectConfig; version: string }) => Promise<T>,
  ): Promise<T> {
    return this.locks.run(`config:${projectKey}`, async () => work(await this.load(projectKey)));
  }

  async history(key: string, limit?: number, offset?: number): Promise<ConfigVersionEntry[]> {
    if (!this.has(key)) throw notFound('project', key);
    return this.configStore.history(key, limit, offset).catch(fromConfigError);
  }

  async versionConfig(key: string, version: string): Promise<ProjectConfig> {
    return this.configStore.loadVersion(key, version).catch(fromConfigError);
  }

  /**
   * The configuration a create would save: the template's, with the request's name, workspace,
   * repositories and card mover. Reads no disk and changes nothing.
   */
  buildConfig(req: CreateProjectRequest, creator: Author): ProjectConfig {
    const template = this.templates.get(req.templateId ?? 'starter');
    if (!template) throw invalid('unknown_template', `unknown template: ${req.templateId}`);
    const built = template.build({
      key: req.key,
      name: req.name,
      workspacePath: req.workspacePath,
      language: req.language ?? DEFAULT_PROJECT_LANGUAGE,
      provider: req.provider,
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
        templateId: req.templateId ?? 'starter',
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

      const message = `Create project ${req.key} from template ${config.project.templateId}`;
      const { version } = await this.configStore
        .save(req.key, config, { author: creator, message })
        .catch(fromConfigError);
      const at = isoNow(this.ctx);
      const record: ProjectRecord = {
        key: req.key,
        name: req.name,
        templateId: config.project.templateId ?? 'starter',
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
      await this.ctx.events.emit('project_created', {
        projectKey: req.key,
        providerReady: req.provider !== undefined,
      });
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
    if (hasOperatorWaiverField(patch))
      throw forbidden('owner_approval_required', 'use the dedicated owner waiver endpoint');
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
      // The Operator's commits, and the super mode's (PM-757, audited), restore the version as a plain commit.
      if (isOperatorActor(current.config, meta.actor) || hasSuperOrigin(meta.actor))
        return this.commitLocked(key, current, target, { ...meta, message: `Revert to ${version}` }).catch(
          asConfigEditError,
        );
      await this.assertCommitAllowed(key, current.config, target, meta);
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
  private async assertCommitAllowed(
    key: string,
    previous: ProjectConfig,
    next: ProjectConfig,
    meta: Pick<ConfigChangeMeta, 'actor' | 'author' | 'invitationBinding'>,
  ): Promise<void> {
    const executingOwner = assertIntegratorAccess(previous, 'write', meta.actor);
    if (operatorWaiverChanged(previous, next) && !this.waiverEdits.has(meta as ConfigChangeMeta))
      throw forbidden(
        'owner_approval_required',
        'the waiver can only change through its dedicated owner endpoint',
      );
    const member = memberOf(previous, meta.actor.handle);
    if (hasSuperOrigin(meta.actor)) {
      // A step in the Operator's super mode (PM-757): recorded as the Operator, authorized as the owner who
      // made the token. Only the author built from a bound principal can say so; an actor alone grants nothing.
      const owner = memberOf(previous, meta.author.authorizedBy);
      const bound = meta.author.superActor;
      if (
        !bound ||
        canonical(bound) !== canonical(meta.actor) ||
        meta.author.via !== 'integrator' ||
        meta.author.superRequestId !== integratorExecution()?.requestId ||
        !isSuperOperatorActor(previous, meta.actor) ||
        owner?.kind !== 'human' ||
        owner.access !== 'owner' ||
        owner.handle !== executingOwner?.handle ||
        owner.email?.trim().toLowerCase() !== meta.author.email.trim().toLowerCase()
      )
        throw forbidden('insufficient_access', 'the super-mode step is not backed by a current owner');
      ProjectService.assertChangeAllowed(previous, next, owner.access, meta.invitationBinding);
    } else if (isOperatorActor(previous, meta.actor)) {
      const request = meta.author.operatorRequestId
        ? this.ctx.repos.operatorRequests.get(meta.author.operatorRequestId)
        : null;
      if (
        !request ||
        request.projectKey !== key ||
        meta.author.operator !== meta.actor.handle ||
        meta.author.via
      )
        throw forbidden('operator_no_request', 'the Operator commit needs an owner request');
      const verdict = operatorConfigVerdict(previous, next, { operator: meta.actor.handle! });
      if (hasPendingOperatorAgreement(this.ctx.repos.inbox.listOpen('approval'), key, request.id))
        throw conflict('operator_agreement_pending', 'the request has a pending agreement');
      if (verdict.level === 'never')
        throw forbidden('operator_never', 'the Operator cannot make this change');
      const item = meta.author.operatorApprovalId
        ? this.ctx.repos.inbox.get(meta.author.operatorApprovalId)
        : null;
      const approval = item ? operatorApprovalOf(item) : null;
      const approver = memberOf(previous, meta.author.approvedBy);
      if (
        meta.author.operatorApprovalId &&
        (!item ||
          item.projectKey !== key ||
          item.state !== 'open' ||
          item.source !== meta.actor.handle ||
          !approval ||
          approval.stale ||
          approval.requestId !== request.id ||
          approver?.kind !== 'human' ||
          approver.access !== 'owner' ||
          canonical(approval.changes) !== canonical(verdict.changes))
      )
        throw conflict('operator_approval_stale', 'the approved configuration change no longer matches');
      if (meta.author.operatorApprovalMode === 'waived') {
        if (
          !this.operatorAuthorization ||
          !meta.author.operatorAgreementVersion ||
          !meta.author.operatorStepId ||
          !meta.author.operatorOperation
        )
          throw forbidden('owner_approval_required', 'the Operator change needs authorization');
        const authorization = await this.operatorAuthorization.authorize({
          projectKey: key,
          operator: meta.actor.handle!,
          requestId: request.id,
          previous,
          next,
          expectedAgreementVersion: meta.author.operatorAgreementVersion,
        });
        if (
          authorization.mode !== 'waived' ||
          authorization.agreementVersion !== meta.author.operatorAgreementVersion
        )
          throw forbidden('owner_approval_required', 'the Operator change needs approval');
      } else if (
        verdict.level === 'approval' &&
        !approval &&
        !this.operatorAuthorization?.autonomousCommit({
          projectKey: key,
          operator: meta.actor.handle!,
          requestId: request.id,
          previous,
          next,
        })
      )
        throw forbidden('owner_approval_required', 'the Operator change needs approval');
    } else if (meta.actor.kind !== 'system') {
      if (meta.actor.kind !== 'human' || member?.kind !== 'human')
        throw forbidden('insufficient_access', 'only human members may change the configuration');
      ProjectService.assertChangeAllowed(previous, next, member.access, meta.invitationBinding);
    } else {
      ProjectService.assertChangeAllowed(previous, next, 'admin');
    }
    assertOperatorFixed(previous, next);
    if (meta.actor.via === 'integrator' && !hasSuperOrigin(meta.actor)) {
      const refusal = integratorConfigRefusal(previous, next);
      if (refusal) throw ownerLoginRequired(refusal);
    }
    const stageIds = new Set(next.pipeline.stages.map((stage) => stage.id));
    const removed = previous.pipeline.stages.filter((stage) => !stageIds.has(stage.id));
    // A theme has the first stage's id because the field is required, but it is in no stage (PM-192).
    const tasks = removed.length ? this.ctx.repos.tasks.list(key).filter((task) => !isTheme(task)) : [];
    for (const stage of removed) {
      const count = tasks.filter((task) => task.stageId === stage.id).length;
      if (count) {
        throw conflict('stage_in_use', 'tasks still occupy the removed stage', {
          stageId: stage.id,
          tasks: count,
        });
      }
    }
    for (const command of superConfigMutations(previous, next))
      await authorizeSuperMutation({ projectKey: key, previous, actor: meta.actor, command });
  }

  private async commitLocked(
    key: string,
    current: LoadedProject,
    next: ProjectConfig,
    meta: ConfigChangeMeta,
  ): Promise<LoadedProject> {
    // A super-mode step is checked inside its audited step (a refusal is audited); every other one first.
    const superStep = hasSuperOrigin(meta.actor);
    if (!superStep) await this.assertCommitAllowed(key, current.config, next, meta);
    if (meta.author.operatorApprovalMode === 'click') {
      const version = await this.agreementVersion?.(key);
      if (version) meta.author.operatorAgreementVersion = version;
    }
    const stepId = meta.author.operatorStepId;
    if (stepId && meta.author.operatorOperation && meta.author.operatorRequestId) {
      if (
        !this.ctx.repos.operatorRequests
          .steps(meta.author.operatorRequestId)
          .some((step) => step.id === stepId)
      )
        throw forbidden('operator_no_request', 'the configuration commit needs its persisted request step');
      if (
        this.ctx.repos.operatorRequests
          .executions(key)
          .some(
            (intent) =>
              intent.requestId === meta.author.operatorRequestId &&
              intent.status === 'committed' &&
              intent.configVersion === current.version &&
              canonical(intent.operation) === canonical(meta.author.operatorOperation),
          )
      )
        throw forbidden('operator_no_request', 'this operation already committed for the owner request');
      this.ctx.unitOfWork(() =>
        this.ctx.repos.operatorRequests.prepareExecution({
          id: stepId,
          projectKey: key,
          requestId: meta.author.operatorRequestId!,
          operation: meta.author.operatorOperation!,
          changes: operatorConfigVerdict(current.config, next, { operator: meta.author.operator! }).changes,
          agreementVersion: meta.author.operatorAgreementVersion ?? null,
          approvalMode: meta.author.operatorApprovalMode ?? 'click',
          status: 'prepared',
          createdAt: isoNow(this.ctx),
          updatedAt: isoNow(this.ctx),
          configVersion: null,
          refusal: null,
        }),
      );
    }
    const save = (author: Author) =>
      this.configStore
        .save(key, next, { author, message: meta.message, previous: current.config })
        .catch(fromConfigError);
    const { version } = superStep
      ? await this.auditedSuperSave(
          key,
          meta,
          () => this.assertCommitAllowed(key, current.config, next, meta),
          save,
        )
      : await save(meta.author);
    if (stepId) this.finishOperatorExecution(key, stepId, version, meta.actor);
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

  /**
   * A configuration commit made in the Operator's super mode (PM-757), audited: the `started` entry is the
   * durable intent, its id goes into the commit as a trailer, and a response lost after the commit is settled from
   * that trailer. The execution context comes from the author a bound principal built, never from the actor.
   */
  private async auditedSuperSave(
    key: string,
    meta: ConfigChangeMeta,
    guard: () => Promise<void>,
    save: (author: Author) => Promise<{ version: string }>,
  ): Promise<{ version: string }> {
    const bound = meta.author.superActor;
    const requestId = meta.author.superRequestId;
    if (!bound || !requestId)
      throw forbidden('insufficient_access', 'a super-mode commit needs its execution context');
    return this.superAudit.runExternal(
      { projectKey: key, actor: bound, requestId },
      'config_commit',
      async (auditId) => {
        // The rules run inside the audited step: a refusal is an entry of the audit too.
        await guard();
        return save({ ...meta.author, superAuditId: auditId });
      },
      { committed: (auditId) => this.configStore.hasSuperAuditCommit(key, auditId) },
    );
  }

  /** Settles the super-mode configuration commits a crash left without a result (at startup, nothing in flight). */
  async settleSuperAudit(): Promise<number> {
    let settled = 0;
    for (const { key } of this.summaries())
      settled += await this.locks.run(`config:${key}`, () =>
        this.superAudit.settleOpen(key, async (auditId, operation) => {
          if (operation !== 'config_commit') throw new Error('the operation outcome is unknown');
          return this.configStore.hasSuperAuditCommit(key, auditId);
        }),
      );
    return settled;
  }

  finishOperatorExecution(key: string, stepId: string, version: string, actor: Actor): void {
    this.ctx.unitOfWork(() => {
      const intent = this.ctx.repos.operatorRequests.executions(key).find((entry) => entry.id === stepId);
      if (
        !intent ||
        !this.ctx.repos.operatorRequests.finishExecution(stepId, 'committed', isoNow(this.ctx), version)
      )
        return;
      if (intent.approvalMode === 'waived' && intent.agreementVersion !== null)
        this.timeline.append({
          projectKey: key,
          actor,
          type: 'operator_approval_waived',
          data: {
            requestId: intent.requestId,
            stepId,
            agreementVersion: intent.agreementVersion,
            changes: intent.changes,
          },
        });
    });
  }

  /** The caller holds the configuration lock; a commit may have finished before its save returned. */
  async recoverOperatorExecution(key: string, stepId: string, version: string, actor: Actor): Promise<void> {
    const loaded = await this.configStore.load(key).catch(fromConfigError);
    this.cache.set(key, loaded);
    this.touchRecord(key, loaded);
    this.finishOperatorExecution(key, stepId, version, actor);
  }

  private touchRecord(key: string, loaded: LoadedProject): void {
    this.ctx.repos.projects.update(key, {
      name: loaded.config.project.name,
      configVersion: loaded.version,
      updatedAt: isoNow(this.ctx),
    });
  }

  /** One audit event per member named a contact or taken off the list; a new project and a reorder add none. */
  private announceContactChanges(change: ConfigChange): void {
    if (!change.previous) return;
    const before = new Set(change.previous.team.contacts ?? []);
    const after = new Set(change.next.team.contacts ?? []);
    const changes = [
      ...[...after].filter((handle) => !before.has(handle)).map((handle) => ({ handle, contact: true })),
      ...[...before].filter((handle) => !after.has(handle)).map((handle) => ({ handle, contact: false })),
    ];
    for (const { handle, contact } of changes)
      this.timeline.append({
        projectKey: change.projectKey,
        actor: change.actor,
        type: 'team_contact_changed',
        data: { handle, contact, version: change.version },
      });
  }

  private async announce(change: ConfigChange, message: string): Promise<void> {
    this.timeline.append({
      projectKey: change.projectKey,
      actor: change.actor,
      type: 'config_changed',
      data: { version: change.version, message },
    });
    this.announceContactChanges(change);
    this.ctx.bus.publish({ type: 'config_changed', projectKey: change.projectKey, version: change.version });
    await this.ctx.events.emit('config_changed', change);
  }
}
