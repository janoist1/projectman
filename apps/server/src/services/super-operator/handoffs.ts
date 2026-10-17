import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  SUPER_AUDIT_NAME,
  SUPER_TERMINAL_STATES,
  SuperCommandUnclassifiable,
  canonical,
  memberOf,
  operatorOf,
  ownerHandles,
  ownerReservedEffect,
  questionPayloadOf,
  superCommandEffects,
} from '@projectman/shared';
import type {
  Actor,
  InboxItem,
  ListSuperHandoffsQuery,
  OwnerReservedEffect,
  ProjectConfig,
  RequestSuperOperationRequest,
  SuperActor,
  SuperCommand,
  SuperHandoff,
  SuperOperation,
  SuperState,
} from '@projectman/shared';
import type { SuperExecutionContext, SuperMutationAuthorizer } from '../../contracts';
import type { DomainContext } from '../../core/base';
import { isoNow } from '../../core/base';
import type { InboxService } from '../../core/inbox';
import type { ProjectAccess } from '../../core/members';
import type { ProjectService } from '../../core/projects';
import type { SuperAuditService, TimelineService } from '../../core/timeline';
import type { StoredSuperHandoff, StoredSuperOperation } from '../../db';
import {
  DomainError,
  SYSTEM_ACTOR,
  attributedActor,
  conflict,
  forbidden,
  humanActor,
  integratorExecution,
  invalid,
  newId,
  notFound,
} from '../../kernel';

/** How long the owner has to answer the question about a reserved effect. */
export const SUPER_OWNER_QUESTION_TTL_MS = 24 * 60 * 60 * 1000;

/** The owner's two answers to the question about a super operation. */
export const SUPER_OWNER_YES = 'yes';
export const SUPER_OWNER_NO = 'no';

/** What an executor gets: the command, who runs it and the exact state it was checked against. */
export interface SuperExecutorJob {
  handoff: SuperHandoff | null;
  operation: SuperOperation;
  command: SuperCommand;
  access: ProjectAccess;
  config: ProjectConfig;
  configVersion: string;
}

/**
 * Runs one kind of command. The service registers none by itself: a command whose kind has no executor in
 * this installation is refused (`super_executor_unavailable`), never run some other way.
 */
export type SuperCommandExecutor = (job: SuperExecutorJob) => Promise<void>;

/** What the authorizer of the mutations lets through while an operation runs: the effects the owner agreed to. */
interface Grant {
  projectKey: string;
  operationId: string;
  effects: ReadonlySet<OwnerReservedEffect>;
}

const publicHandoff = (h: StoredSuperHandoff): SuperHandoff => ({
  id: h.id,
  projectKey: h.projectKey,
  taskKey: h.taskKey,
  requestedBy: h.requestedBy,
  reason: h.reason,
  command: h.command,
  expectedConfigVersion: h.expectedConfigVersion,
  state: h.state,
  operationId: h.operationId,
  createdAt: h.createdAt,
  updatedAt: h.updatedAt,
});

const publicOperation = (o: StoredSuperOperation): SuperOperation => ({
  id: o.id,
  projectKey: o.projectKey,
  taskKey: o.taskKey,
  handoffId: o.handoffId,
  state: o.state,
  requestId: o.requestId,
  command: o.command,
  ownerQuestionId: o.ownerQuestionId,
  errorCode: o.errorCode,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

const sha256 = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

/** The hash the owner's yes is given for: the exact command of one project. */
export const superCommandHash = (projectKey: string, command: SuperCommand): string =>
  sha256({ projectKey, command });

const isTerminal = (state: SuperState) => SUPER_TERMINAL_STATES.includes(state);

/** The error code of an executor's failure when it is a plain identifier; every other error is an `internal_error`. */
const codeOf = (error: unknown): string =>
  error instanceof DomainError && SUPER_AUDIT_NAME.test(error.code) ? error.code : 'internal_error';

/**
 * The durable hand-over of work to the super-mode integrator, and the operations it starts (PM-762).
 *
 * - `request`: the base Operator records what it asks the integrator to do. This grants no right to execute
 *   and no approval; it needs no token and survives a restart and an offline integrator.
 * - `execute`: the integrator, with its own super token, starts the handoff's operation. A command with no
 *   owner-reserved effect runs on the integrator's own power. One with a reserved effect (cost, deletion,
 *   publication, direction) opens a question for the owner and waits: only the owner's own login answers it
 *   (the inbox refuses a token, a relay and anyone else), and only a `yes` for this exact command, this exact
 *   configuration version and this token lets the re-execution run it.
 *
 * Every state change is a compare-and-set (`db/super-handoffs`), so two clients racing on one handoff cannot
 * both run it; a restart marks what was running `unknown` and never runs it again by itself.
 */
export class SuperHandoffService {
  private readonly ctx: DomainContext;
  private readonly projects: Pick<ProjectService, 'load' | 'versionConfig'>;
  private readonly inbox: Pick<InboxService, 'create' | 'get' | 'expire' | 'cancel'>;
  private readonly timeline: TimelineService;
  private readonly audit: SuperAuditService;
  private readonly executors = new Map<SuperCommand['kind'], SuperCommandExecutor>();
  private readonly grants = new AsyncLocalStorage<Grant>();

  constructor(deps: {
    ctx: DomainContext;
    projects: Pick<ProjectService, 'load' | 'versionConfig'>;
    inbox: Pick<InboxService, 'create' | 'get' | 'expire' | 'cancel'>;
    timeline: TimelineService;
    audit: SuperAuditService;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.inbox = deps.inbox;
    this.timeline = deps.timeline;
    this.audit = deps.audit;
  }

  /** Makes `kind` executable in this installation; nothing runs for a kind that has none. */
  registerExecutor(kind: SuperCommand['kind'], executor: SuperCommandExecutor): void {
    this.executors.set(kind, executor);
  }

  /**
   * The port the mutation checks of PM-759 ask. A reserved effect passes only inside a running operation of
   * the same project whose owner agreed to exactly that effect; everything else stays refused.
   */
  readonly authorizer: SuperMutationAuthorizer = {
    assertAllowed: async (input) => {
      let effect: OwnerReservedEffect | null;
      try {
        effect = ownerReservedEffect(input.previous, input.command);
      } catch {
        throw forbidden('integrator_not_allowed', 'unknown mutation projection');
      }
      if (!effect) return;
      const grant = this.grants.getStore();
      const operation = grant && this.ctx.repos.superHandoffs.operation(grant.projectKey, grant.operationId);
      if (
        !grant ||
        operation?.state !== 'running' ||
        input.projectKey !== grant.projectKey ||
        !grant.effects.has(effect)
      )
        throw forbidden('owner_approval_required', 'this effect requires a specific owner authorization', {
          effect,
        });
    },
  };

  /** The question the owner answers is closed by the inbox through this hook, in the same transaction. */
  readonly ownerAnswer = (item: InboxItem, optionId: string, at: string, handle: string): void => {
    const bound = questionPayloadOf(item)?.superOperation;
    const operation = bound && this.ctx.repos.superHandoffs.operation(item.projectKey, bound.operationId);
    if (
      !bound ||
      !operation ||
      operation.ownerQuestionId !== item.id ||
      operation.state !== 'waiting_owner' ||
      operation.commandHash !== bound.commandHash
    )
      throw conflict('inbox_item_closed', 'the super operation no longer waits for this answer');
    if (Date.parse(at) >= Date.parse(bound.expiresAt))
      throw conflict('super_operation_expired', 'the owner did not answer in time');
    if (optionId === SUPER_OWNER_YES)
      this.move(operation, 'pending', { handoff: 'pending', keepOperation: true }, humanActor(handle));
    else if (optionId === SUPER_OWNER_NO)
      this.move(
        operation,
        'cancelled',
        { handoff: 'cancelled', errorCode: 'owner_declined' },
        humanActor(handle),
      );
    else throw invalid('unknown_option', `unknown option: ${optionId}`);
  };

  // --- the base Operator's side -------------------------------------------------------------------------

  /** Records the hand-over. The same request id with the same content is the same handoff; other content is a conflict. */
  async request(
    projectKey: string,
    requester: Actor,
    input: RequestSuperOperationRequest,
  ): Promise<SuperHandoff> {
    const { config } = await this.projects.load(projectKey);
    if (!operatorOf(config)) throw invalid('invalid_request', 'the project has no Operator');
    if (input.taskKey && this.ctx.repos.tasks.get(input.taskKey)?.projectKey !== projectKey)
      throw notFound('task', input.taskKey);
    const content = superCommandHash(projectKey, input.command);
    const requestHash = sha256({
      taskKey: input.taskKey ?? null,
      reason: input.reason,
      command: input.command,
      expectedConfigVersion: input.expectedConfigVersion ?? null,
      content,
    });
    return this.ctx.unitOfWork(() => {
      const repo = this.ctx.repos.superHandoffs;
      const existing = repo.handoffByRequest(projectKey, input.requestId);
      if (existing) {
        if (existing.commandHash !== requestHash)
          throw conflict('super_request_conflict', 'this request id was used for another handoff');
        return publicHandoff(existing);
      }
      const at = isoNow(this.ctx);
      const handoff: StoredSuperHandoff = {
        id: newId('sho'),
        projectKey,
        taskKey: input.taskKey ?? null,
        requestId: input.requestId,
        requestedBy: requester,
        reason: input.reason,
        command: input.command,
        commandHash: requestHash,
        expectedConfigVersion: input.expectedConfigVersion ?? null,
        state: 'pending',
        operationId: null,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      };
      repo.insertHandoff(handoff);
      this.timeline.append({
        projectKey,
        taskKey: handoff.taskKey,
        actor: requester,
        type: 'super_handoff_changed',
        data: { handoffId: handoff.id, state: handoff.state },
      });
      return publicHandoff(handoff);
    });
  }

  // --- reading ----------------------------------------------------------------------------------------

  list(projectKey: string, query: ListSuperHandoffsQuery): SuperHandoff[] {
    this.sweep();
    return this.ctx.repos.superHandoffs
      .listHandoffs(projectKey, { ...(query.state ? { state: query.state } : {}), limit: query.limit })
      .map(publicHandoff);
  }

  handoff(projectKey: string, id: string): SuperHandoff {
    return publicHandoff(this.handoffOf(projectKey, id));
  }

  operation(projectKey: string, id: string): SuperOperation {
    const operation = this.ctx.repos.superHandoffs.operation(projectKey, id);
    if (!operation) throw notFound('super operation', id);
    return publicOperation(operation);
  }

  // --- the integrator's side --------------------------------------------------------------------------

  /**
   * Starts the handoff's operation, or resumes it after the owner's yes (the same request id). The operation is
   * returned in the state it reached: `waiting_owner` when the owner must decide first, otherwise the result.
   */
  async execute(
    projectKey: string,
    handoffId: string,
    requestId: string,
    access: ProjectAccess,
  ): Promise<SuperOperation> {
    const scope = integratorExecution();
    const actor = access.superActor;
    if (!actor || !scope || scope.principal.mode !== 'super')
      throw forbidden('integrator_not_allowed', 'only the integrator in super mode executes a handoff');
    const keyId = scope.principal.keyId;
    this.sweep();
    const handoff = this.handoffOf(projectKey, handoffId);
    const repo = this.ctx.repos.superHandoffs;
    const existing = repo.operationByRequest(projectKey, keyId, requestId);
    if (existing) {
      if (
        existing.handoffId !== handoff.id ||
        existing.commandHash !== superCommandHash(projectKey, handoff.command)
      )
        throw conflict('super_request_conflict', 'this request id was used for another operation');
      if (existing.state !== 'pending') return publicOperation(existing);
      return this.resume(existing, handoff, access, actor);
    }
    if (isTerminal(handoff.state))
      throw conflict('super_handoff_closed', `the handoff is ${handoff.state}`, { state: handoff.state });
    const open = handoff.operationId ? repo.operation(projectKey, handoff.operationId) : null;
    if (open && !isTerminal(open.state)) {
      if (open.state !== 'running' && open.keyId !== keyId)
        return this.refuseStale(open, actor, 'the operation belongs to another token');
      throw conflict('super_handoff_busy', 'the handoff already has an operation', {
        operationId: open.id,
        requestId: open.requestId,
        state: open.state,
      });
    }
    return this.start(handoff, keyId, requestId, access, actor);
  }

  // --- start --------------------------------------------------------------------------------------------

  private async start(
    handoff: StoredSuperHandoff,
    keyId: string,
    requestId: string,
    access: ProjectAccess,
    actor: SuperActor,
  ): Promise<SuperOperation> {
    const loaded = await this.projects.load(handoff.projectKey);
    if (handoff.expectedConfigVersion && handoff.expectedConfigVersion !== loaded.version)
      throw conflict('super_operation_stale', 'the configuration changed since the handoff was made');
    const executor = this.executorFor(handoff.command);
    const effects = await this.effectsOf(handoff, loaded.config, loaded.version);
    const exec = this.execContext(handoff.projectKey, actor, requestId, handoff.id);
    const operation = this.audit.run(
      exec,
      'super_operation_start',
      () => {
        const repo = this.ctx.repos.superHandoffs;
        const at = isoNow(this.ctx);
        const fresh = repo.handoff(handoff.projectKey, handoff.id);
        if (!fresh || fresh.revision !== handoff.revision || fresh.state !== 'pending')
          throw conflict('super_handoff_busy', 'another client started the handoff first');
        const waiting = effects.length > 0;
        const id = newId('sop');
        const stored: StoredSuperOperation = {
          id,
          projectKey: handoff.projectKey,
          taskKey: handoff.taskKey,
          keyId,
          requestId,
          handoffId: handoff.id,
          command: handoff.command,
          commandHash: superCommandHash(handoff.projectKey, handoff.command),
          expectedConfigVersion: loaded.version,
          state: waiting ? 'waiting_owner' : 'running',
          ownerQuestionId: null,
          expiresAt: null,
          errorCode: null,
          revision: 0,
          createdAt: at,
          updatedAt: at,
        };
        if (waiting) {
          stored.expiresAt = new Date(this.ctx.now().getTime() + SUPER_OWNER_QUESTION_TTL_MS).toISOString();
          stored.ownerQuestionId = this.openOwnerQuestion(handoff, stored, loaded.config, effects).id;
        }
        repo.insertOperation(stored);
        if (
          !repo.casHandoff(handoff.projectKey, handoff.id, fresh.revision, {
            state: stored.state,
            operationId: id,
            updatedAt: at,
          })
        )
          throw conflict('super_handoff_busy', 'another client started the handoff first');
        this.recordChange(stored, handoff.taskKey, attributedActor(access), handoff.id, stored.state);
        return stored;
      },
      { taskKey: handoff.taskKey },
    );
    if (operation.state === 'waiting_owner') return publicOperation(operation);
    return this.run(operation, handoff, executor, access, actor, loaded, new Set(effects));
  }

  /** The re-execution after the owner's yes: everything the yes was given for is checked again. */
  private async resume(
    operation: StoredSuperOperation,
    handoff: StoredSuperHandoff,
    access: ProjectAccess,
    actor: SuperActor,
  ): Promise<SuperOperation> {
    const loaded = await this.projects.load(operation.projectKey);
    if (!this.approved(operation, loaded.config))
      return this.refuseStale(operation, actor, 'the owner has not approved this operation');
    if (operation.expectedConfigVersion !== loaded.version)
      return this.refuseStale(operation, actor, 'the configuration changed since the owner answered');
    const executor = this.executorFor(operation.command);
    const effects = await this.effectsOf(handoff, loaded.config, loaded.version);
    const exec = this.execContext(operation.projectKey, actor, operation.requestId, handoff.id);
    const running = this.audit.run(
      exec,
      'super_operation_resume',
      () => {
        const fresh = this.ctx.repos.superHandoffs.operation(operation.projectKey, operation.id);
        if (!fresh || fresh.revision !== operation.revision || fresh.state !== 'pending')
          throw conflict('super_handoff_busy', 'another client resumed the operation first');
        return this.move(
          fresh,
          'running',
          { handoff: 'running', keepOperation: true },
          attributedActor(access),
        );
      },
      { taskKey: operation.taskKey },
    );
    return this.run(running, handoff, executor, access, actor, loaded, new Set(effects));
  }

  private async run(
    operation: StoredSuperOperation,
    handoff: StoredSuperHandoff,
    executor: SuperCommandExecutor,
    access: ProjectAccess,
    actor: SuperActor,
    loaded: { config: ProjectConfig; version: string },
    effects: ReadonlySet<OwnerReservedEffect>,
  ): Promise<SuperOperation> {
    const job: SuperExecutorJob = {
      handoff: publicHandoff(handoff),
      operation: publicOperation(operation),
      command: operation.command,
      access,
      config: loaded.config,
      configVersion: loaded.version,
    };
    const exec = this.execContext(operation.projectKey, actor, operation.requestId, handoff.id);
    const grant: Grant = { projectKey: operation.projectKey, operationId: operation.id, effects };
    let state: SuperState = 'succeeded';
    let errorCode: string | null = null;
    try {
      await this.audit.runExternal(
        exec,
        'super_operation_run',
        () => this.grants.run(grant, () => executor(job)),
        {
          taskKey: operation.taskKey,
          // What an executor changed outside the database cannot be told afterwards: never claim a success.
          committed: async () => {
            throw new Error('the operation outcome is unknown');
          },
        },
      );
    } catch (error) {
      // A refusal is a plain failure; anything else may have left an effect behind and is not guessed at.
      state = error instanceof DomainError && error.status < 500 ? 'failed' : 'unknown';
      errorCode = state === 'failed' ? codeOf(error) : 'operation_unknown';
    }
    const current = this.ctx.repos.superHandoffs.operation(operation.projectKey, operation.id);
    if (!current || current.state !== 'running') return publicOperation(current ?? operation);
    return publicOperation(
      this.ctx.unitOfWork(() =>
        this.move(current, state, { handoff: state, errorCode }, attributedActor(access)),
      ),
    );
  }

  // --- checks ---------------------------------------------------------------------------------------------

  private executorFor(command: SuperCommand): SuperCommandExecutor {
    const executor = this.executors.get(command.kind);
    if (!executor)
      throw new DomainError(
        'super_executor_unavailable',
        `no executor for ${command.kind} in this installation`,
        {
          status: 503,
        },
      );
    return executor;
  }

  /** The owner-reserved effects of the command against the configuration now; what cannot be classified is refused. */
  private async effectsOf(
    handoff: StoredSuperHandoff,
    config: ProjectConfig,
    configVersion: string,
  ): Promise<OwnerReservedEffect[]> {
    const command = handoff.command;
    const revertVersion =
      command.kind === 'operate' && command.operation.op === 'config_revert'
        ? command.operation.version
        : null;
    const target = revertVersion
      ? await this.projects.versionConfig(handoff.projectKey, revertVersion).catch(() => null)
      : null;
    try {
      return superCommandEffects(command, {
        config,
        configVersion,
        configAt: (version) => (version === revertVersion ? target : null),
      });
    } catch (error) {
      if (error instanceof SuperCommandUnclassifiable)
        throw forbidden('integrator_not_allowed', 'this command cannot be classified, so it is not run');
      throw error;
    }
  }

  /**
   * Whether the owner's yes stands: the question is closed with `yes` by a current owner using their own login
   * (no token, no relay), and it was asked for exactly this operation and command.
   */
  private approved(operation: StoredSuperOperation, config: ProjectConfig): boolean {
    const item = operation.ownerQuestionId ? this.ctx.repos.inbox.get(operation.ownerQuestionId) : null;
    const bound = item && questionPayloadOf(item)?.superOperation;
    const resolution = item?.resolution;
    if (!item || !bound || item.state !== 'resolved' || !resolution) return false;
    if (resolution.optionId !== SUPER_OWNER_YES) return false;
    if (resolution.via || resolution.actor || resolution.ownerAnswerRelayed) return false;
    const owner = memberOf(config, resolution.by);
    return (
      owner?.kind === 'human' &&
      owner.access === 'owner' &&
      bound.operationId === operation.id &&
      bound.commandHash === operation.commandHash &&
      bound.expectedConfigVersion === operation.expectedConfigVersion
    );
  }

  /** The operation can no longer be run as agreed: it is cancelled, the handoff is free to start again. */
  private refuseStale(operation: StoredSuperOperation, actor: SuperActor, why: string): never {
    this.ctx.unitOfWork(() => {
      const fresh = this.ctx.repos.superHandoffs.operation(operation.projectKey, operation.id);
      if (fresh && !isTerminal(fresh.state) && fresh.state !== 'running')
        this.move(fresh, 'cancelled', { handoff: 'pending', errorCode: 'super_operation_stale' }, actor);
      if (fresh?.ownerQuestionId) this.inbox.cancel(fresh.ownerQuestionId);
    });
    throw conflict('super_operation_stale', why);
  }

  // --- the owner's question ---------------------------------------------------------------------------

  private openOwnerQuestion(
    handoff: StoredSuperHandoff,
    operation: StoredSuperOperation,
    config: ProjectConfig,
    effects: readonly OwnerReservedEffect[],
  ): InboxItem {
    const operator = operatorOf(config);
    const assignees = ownerHandles(config);
    if (!operator || assignees.length === 0)
      throw invalid('invalid_request', 'the project has no Operator or no owner to ask');
    return this.inbox.create({
      projectKey: handoff.projectKey,
      kind: 'question',
      assignees,
      source: operator.handle,
      taskKey: handoff.taskKey,
      title: handoff.reason,
      payload: {
        question: handoff.reason,
        details: `Super operation ${operation.id} (${handoff.command.kind}); owner-reserved: ${effects.join(', ')}`,
        options: [SUPER_OWNER_YES, SUPER_OWNER_NO],
        // Only the owner's own login answers it; the server forces this whatever the asker says.
        responsePurpose: 'owner_decision',
        superOperation: {
          operationId: operation.id,
          commandHash: operation.commandHash,
          expectedConfigVersion: operation.expectedConfigVersion,
          expiresAt: operation.expiresAt!,
        },
      },
      options: [
        { id: SUPER_OWNER_YES, label: SUPER_OWNER_YES, style: 'primary' },
        { id: SUPER_OWNER_NO, label: SUPER_OWNER_NO, style: 'danger' },
      ],
    });
  }

  // --- keeping the records true ----------------------------------------------------------------------

  /**
   * What the lapse of time and a restart do: a waiting question the owner did not answer in time is expired
   * and its operation cancelled (the handoff can be started again); an operation that was running when the
   * server stopped may have had its effect, so it is marked `unknown` and never run again by itself.
   */
  sweep(): void {
    const now = this.ctx.now().getTime();
    for (const operation of this.ctx.repos.superHandoffs.openOperations()) {
      if (
        operation.state !== 'waiting_owner' ||
        !operation.expiresAt ||
        Date.parse(operation.expiresAt) > now
      )
        continue;
      this.ctx.unitOfWork(() => {
        const fresh = this.ctx.repos.superHandoffs.operation(operation.projectKey, operation.id);
        if (!fresh || fresh.state !== 'waiting_owner') return;
        this.move(
          fresh,
          'cancelled',
          { handoff: 'pending', errorCode: 'super_operation_expired' },
          SYSTEM_ACTOR,
        );
        if (fresh.ownerQuestionId) this.inbox.expire(fresh.ownerQuestionId);
      });
    }
  }

  /** Startup: everything that was running is `unknown` now, and the lapsed questions are settled. Returns how many it marked. */
  reconcile(): number {
    let marked = 0;
    for (const operation of this.ctx.repos.superHandoffs.openOperations()) {
      if (operation.state !== 'running') continue;
      const done = this.ctx.unitOfWork(() => {
        const fresh = this.ctx.repos.superHandoffs.operation(operation.projectKey, operation.id);
        if (!fresh || fresh.state !== 'running') return false;
        this.move(fresh, 'unknown', { handoff: 'unknown', errorCode: 'operation_unknown' }, SYSTEM_ACTOR);
        return true;
      });
      if (done) marked += 1;
    }
    this.sweep();
    return marked;
  }

  /**
   * Moves an operation and its handoff together in the caller's unit of work. `handoff` is the state the handoff
   * takes; with `keepOperation` it stays tied to the operation, otherwise (a finished attempt that can start
   * again) it is freed. Throws a conflict when someone moved either first.
   */
  private move(
    operation: StoredSuperOperation,
    state: SuperState,
    to: { handoff: SuperState; keepOperation?: boolean; errorCode?: string | null },
    actor: Actor,
  ): StoredSuperOperation {
    const repo = this.ctx.repos.superHandoffs;
    const at = isoNow(this.ctx);
    const patch = {
      state,
      updatedAt: at,
      ...(to.errorCode !== undefined ? { errorCode: to.errorCode } : {}),
    };
    if (!repo.casOperation(operation.projectKey, operation.id, operation.revision, patch))
      throw conflict('super_handoff_busy', 'the operation was moved by another client');
    const moved: StoredSuperOperation = {
      ...operation,
      state,
      errorCode: to.errorCode !== undefined ? to.errorCode : operation.errorCode,
      revision: operation.revision + 1,
      updatedAt: at,
    };
    const handoff = operation.handoffId ? repo.handoff(operation.projectKey, operation.handoffId) : null;
    if (handoff) {
      const keep = to.keepOperation || isTerminal(to.handoff);
      if (
        !repo.casHandoff(handoff.projectKey, handoff.id, handoff.revision, {
          state: to.handoff,
          operationId: keep ? operation.id : null,
          updatedAt: at,
        })
      )
        throw conflict('super_handoff_busy', 'the handoff was moved by another client');
    }
    this.recordChange(moved, operation.taskKey, actor, handoff?.id ?? null, to.handoff);
    return moved;
  }

  private recordChange(
    operation: StoredSuperOperation,
    taskKey: string | null,
    actor: Actor,
    handoffId: string | null,
    handoffState: SuperState,
  ): void {
    this.timeline.append({
      projectKey: operation.projectKey,
      taskKey,
      actor,
      type: 'super_operation_changed',
      data: { operationId: operation.id, state: operation.state, resultKind: operation.errorCode },
    });
    if (handoffId)
      this.timeline.append({
        projectKey: operation.projectKey,
        taskKey,
        actor,
        type: 'super_handoff_changed',
        data: { handoffId, state: handoffState },
      });
  }

  private handoffOf(projectKey: string, id: string): StoredSuperHandoff {
    const handoff = this.ctx.repos.superHandoffs.handoff(projectKey, id);
    if (!handoff) throw notFound('super handoff', id);
    return handoff;
  }

  private execContext(
    projectKey: string,
    actor: SuperActor,
    requestId: string,
    handoffId: string,
  ): SuperExecutionContext {
    return { projectKey, actor, requestId, handoffId };
  }
}

export function createSuperHandoffService(
  deps: ConstructorParameters<typeof SuperHandoffService>[0],
): SuperHandoffService {
  return new SuperHandoffService(deps);
}
