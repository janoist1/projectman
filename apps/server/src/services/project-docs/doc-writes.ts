import { Effect, Exit, Scope } from 'effect';
import { runFork, runPromise } from '../../kernel';
import { makeDocWriteQueue, type DocWriteQueueEffects } from './write-queue';
import type { DocWriteSlotPeer } from './ports';
import {
  DocWriteFailure as DocWriteFailureSchema,
  LOCAL_ENGINE_ID,
  projectDocsOf,
  SUPER_AUDIT_REQUEST_ID,
  SYSTEM_SENDER,
} from '@projectman/shared';
import type {
  DocWriteFailure,
  ErrorCode,
  ExternalDocWriteState,
  ExternalToolOrigin,
  OperatorStepStatus,
  ProjectDoc,
  RepoConfig,
} from '@projectman/shared';
import { MergeError } from '../../contracts';
import type {
  BranchMerger,
  DocWriteExternalRunner,
  EngineDirectory,
  HistoryMainMoved,
  ReleaseWorkAdmission,
} from '../../contracts';
import type { DocWriteEdit, DocWritePatch, DocWriteRecord } from '../../db';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { applyDocEdits, isAppendOnly } from './doc-edits';
import {
  conflict,
  DomainError,
  externalToolOrigin,
  forbidden,
  integratorOwnerId,
  withoutIntegratorExecution,
} from '../../kernel';
import type { Messaging } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import { newId, SYSTEM_ACTOR } from '../../kernel';

export type { DocWriteFailure };

/** How long `request` waits for a write that runs at once before it answers `running`. */
export const DOC_WRITE_WAIT_MS = 60_000;
/** How long a bearer-MCP write waits for one that runs at once: its caller polls `get_project_doc_write`. */
export const EXTERNAL_DOC_WRITE_WAIT_MS = 5_000;

/** A write made through the bearer MCP (PM-784); the origin and the author come from the live scope. */
export interface ExternalDocWriteRequest {
  projectKey: string;
  baseCommit: string;
  /** One line: the commit subject. */
  message: string;
  edits: { doc: ProjectDoc; old_text: string; new_text: string }[];
}

export interface DocWriteRequest {
  projectKey: string;
  /** The Operator's handle: the write runs on its engine. */
  author: string;
  /** The owner whose request it runs under. */
  requestedBy: string;
  requestId: string;
  baseCommit: string;
  /** The commit subject; the trailers are added here. */
  message: string;
  edits: { doc: ProjectDoc; old_text: string; new_text: string }[];
}

export type DocWriteOutcome =
  | { id: string; state: 'published'; commit: string; paths: string[]; warning?: 'local_checkout' }
  | { id: string; state: 'queued'; waitingFor: string }
  | { id: string; state: 'running' }
  | { id: string; state: 'stale' }
  | { id: string; state: 'failed'; failure: DocWriteFailure; message: string };

type Ended =
  | { state: 'published'; commit: string; warning?: 'local_checkout' }
  | { state: 'stale' }
  | { state: 'failed'; failure: DocWriteFailure; message: string };

type Deps = {
  ctx: DomainContext;
  projects: ProjectService;
  engines: EngineDirectory;
  messaging: Pick<Messaging, 'send'>;
  merges: DocWriteSlotPeer;
  /** How long `request` waits for a write that runs at once (default `DOC_WRITE_WAIT_MS`). */
  waitMs?: number;
  /** The release gate (PM-752); absent: never held. */
  work?: ReleaseWorkAdmission;
  /** Runs after the published state commits; a failure must not affect the write. */
  onPublished?: (event: HistoryMainMoved) => void;
  /** Re-authorizes the writes made through the bearer MCP (PM-784); absent: they are refused. */
  external?: DocWriteExternalRunner;
  /** How long a bearer-MCP write waits for one that runs at once (default `EXTERNAL_DOC_WRITE_WAIT_MS`). */
  externalWaitMs?: number;
};

/** The key, the owner's membership or the Operator of a bearer-MCP write ended before it went up. */
class AuthorizationEnded extends Error {
  constructor(cause: unknown) {
    super('the credential of the write is no longer valid', { cause });
  }
}

/** An engine call that failed for a reason the caller reads: a refused path, an unknown commit, a git error. */
function readable(err: unknown): unknown {
  return err instanceof MergeError ? new DomainError('invalid_request', err.message) : err;
}

const pending = () =>
  conflict('docs_write_pending', 'a write of the project documents is already queued or running');

/** The commit trailers of a write made through the bearer MCP: the Operator, the key (id and prefix) and the call. */
function externalTrailers(origin: ExternalToolOrigin): string {
  return [
    `Projectman-Operator: ${origin.actor.handle}`,
    'Projectman-Operator-Mode: super',
    'Projectman-Via: integrator',
    `Projectman-Credential-Id: ${origin.actor.credential.id}`,
    `Projectman-Credential-Prefix: ${origin.actor.credential.prefix}`,
    `Projectman-External-Request: ${origin.requestId}`,
  ].join('\n');
}

/** A stored failure code as the closed list; a code from a newer or older build reads as `git_failed`. */
function failureOf(code: string | undefined): DocWriteFailure {
  const parsed = DocWriteFailureSchema.safeParse(code);
  return parsed.success ? parsed.data : 'git_failed';
}

/**
 * The Operator's writes of the decision log and the roadmap to the default branch (PM-495). A write is a row
 * in `doc_writes`, one open per project; it runs in the repository's merge slot, so it never overlaps a
 * member-initiated merge (`Merges` skips a repository while a write runs here, and runs the write first when the
 * slot frees). All git work is the engine's (`BranchMerger.readFile`, `commitFiles`, `push`, `advance`).
 */
export class DocWrites {
  private readonly deps: Deps;
  private scope = Scope.makeUnsafe();
  private queue: DocWriteQueueEffects;
  /** Writes whose caller still waits for the result: the answer is the tool's, so no message follows. */
  private readonly waiting = new Set<string>();
  private stopped = false;

  constructor(deps: Deps) {
    this.deps = deps;
    this.queue = this.makeQueue();
  }

  /** Whether a write runs in the repository's slot. */
  busy(projectKey: string, repo: string): boolean {
    return this.queue.slot(projectKey, repo) !== undefined;
  }

  /** The text of the project document on the default branch's head, on the Operator's engine. */
  async read(
    projectKey: string,
    member: string,
    doc: ProjectDoc,
  ): Promise<{ repo: RepoConfig; path: string; commit: string; text: string | null }> {
    const config = await this.deps.projects.config(projectKey);
    const docs = projectDocsOf(config);
    const path = docs?.[doc] ?? null;
    if (!docs || !path) throw this.notConfigured(doc);
    const merger = this.mergerOf(this.engineOf(projectKey, member));
    const read = await merger
      .readFile({ projectKey, repo: docs.repo.name }, { at: { base: docs.repo.defaultBranch }, path })
      .catch((err: unknown) => {
        throw readable(err);
      });
    return { repo: docs.repo, path, commit: read.commit, text: read.text };
  }

  /**
   * Checks the edits against the text at `baseCommit`, queues the write and starts it when the slot is free;
   * the answer waits for a write that runs at once. The refusals of the edits (422) come here, before anything
   * is queued.
   */
  async request(input: DocWriteRequest): Promise<DocWriteOutcome> {
    const { ctx } = this.deps;
    const { projectKey } = input;
    const { docs, edits } = await this.checkedEdits(projectKey, input.author, input.baseCommit, input.edits);
    const id = newId('dw');
    const now = isoNow(ctx);
    ctx.unitOfWork(() => {
      // The check above awaited: the slot may have been taken since.
      if (ctx.repos.docWrites.openOf(projectKey)) throw pending();
      const stepId = newId('ops');
      ctx.repos.docWrites.insert({
        id,
        projectKey,
        repo: docs.repo.name,
        base: docs.repo.defaultBranch,
        baseCommit: input.baseCommit,
        edits,
        message: `${input.message}\n\nProjectman-Operator: ${input.author}\nProjectman-Request: ${input.requestId}\nProjectman-Requested-By: ${input.requestedBy}`,
        author: input.author,
        requestedBy: input.requestedBy,
        requestId: input.requestId,
        stepId,
        engineId: this.engineOf(projectKey, input.author),
        state: 'queued',
        commitSha: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        externalOrigin: null,
      });
      ctx.repos.operatorRequests.insertStep({
        id: stepId,
        requestId: input.requestId,
        at: now,
        action: 'docs_write',
        status: 'queued',
        taskKey: null,
        member: null,
        changes: [],
        configVersion: null,
        inboxItemId: null,
        signalId: null,
        refusal: null,
      });
    });
    return this.started(id, projectKey, docs.repo.name, this.deps.waitMs ?? DOC_WRITE_WAIT_MS);
  }

  /**
   * The same write for the integrator's super credential (PM-784). The author, the origin and the owner come
   * from the live scope, never from the call; the edits go through the same checks. It answers after the
   * write was queued, or finished within a short wait: `get_project_doc_write` reads it from there.
   */
  async requestExternal(input: ExternalDocWriteRequest): Promise<DocWriteOutcome> {
    const { ctx } = this.deps;
    const { projectKey } = input;
    if (!this.deps.external)
      throw forbidden('integrator_not_allowed', 'document writes through the bearer MCP are not available');
    const config = await this.deps.projects.config(projectKey);
    const origin = externalToolOrigin(config);
    if (!SUPER_AUDIT_REQUEST_ID.test(origin.requestId) || /[\r\n]/.test(input.message))
      throw new DomainError('invalid_request', 'the request id or the message cannot go into a commit');
    const author = origin.actor.handle;
    const { docs, edits } = await this.checkedEdits(projectKey, author, input.baseCommit, input.edits);
    const id = newId('dw');
    const now = isoNow(ctx);
    ctx.unitOfWork(() => {
      if (ctx.repos.docWrites.openOf(projectKey)) throw pending();
      ctx.repos.docWrites.insert({
        id,
        projectKey,
        repo: docs.repo.name,
        base: docs.repo.defaultBranch,
        baseCommit: input.baseCommit,
        edits,
        message: `${input.message}\n\n${externalTrailers(origin)}`,
        author,
        requestedBy: null,
        requestId: null,
        stepId: null,
        engineId: this.engineOf(projectKey, author),
        state: 'queued',
        commitSha: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        externalOrigin: origin,
      });
    });
    return this.started(
      id,
      projectKey,
      docs.repo.name,
      this.deps.externalWaitMs ?? EXTERNAL_DOC_WRITE_WAIT_MS,
    );
  }

  /** One document write the same owner's keys made (PM-784); another owner's, a member's or a missing one is `not_found`. */
  async externalState(projectKey: string, writeId: string): Promise<ExternalDocWriteState> {
    const config = await this.deps.projects.config(projectKey);
    const owner = integratorOwnerId(config, 'read');
    const row = this.deps.ctx.repos.docWrites.get(writeId);
    if (
      !owner ||
      !row ||
      row.projectKey !== projectKey ||
      !row.externalOrigin ||
      row.externalOrigin.ownerUserId !== owner
    )
      throw new DomainError('not_found', `Document write ${writeId} does not exist.`, { status: 404 });
    const published = row.state === 'published';
    return {
      write_id: row.id,
      state: row.state,
      commit: published ? row.commitSha : null,
      paths: [...new Set(row.edits.map((edit) => edit.path))],
      warning: published && row.error?.code === 'local_checkout' ? 'local_checkout' : null,
      failure: row.state === 'failed' ? failureOf(row.error?.code) : null,
    };
  }

  /** The edits checked against the text at `baseCommit`: the refusals (422) come here, before anything is queued. */
  private async checkedEdits(
    projectKey: string,
    author: string,
    baseCommit: string,
    requested: { doc: ProjectDoc; old_text: string; new_text: string }[],
  ) {
    const { ctx, projects } = this.deps;
    const config = await projects.config(projectKey);
    const docs = projectDocsOf(config);
    if (!docs) throw this.notConfigured();
    if (ctx.repos.docWrites.openOf(projectKey)) throw pending();
    const located = requested.map((edit) => {
      const path = docs[edit.doc];
      if (!path) throw this.notConfigured(edit.doc);
      return { path, old_text: edit.old_text, new_text: edit.new_text };
    });
    const merger = this.mergerOf(this.engineOf(projectKey, author));
    const ref = { projectKey, repo: docs.repo.name };
    const edits: DocWriteEdit[] = [];
    for (const path of new Set(located.map((edit) => edit.path))) {
      const mine = located.filter((edit) => edit.path === path);
      const before = (
        await merger.readFile(ref, { at: { commit: baseCommit }, path }).catch((err: unknown) => {
          throw readable(err);
        })
      ).text;
      const after = applyDocEdits(before ?? '', mine);
      if (path === docs.decisions && !isAppendOnly(before ?? '', after))
        throw new DomainError(
          'docs_not_append_only',
          'the decision log only takes new lines: no existing line may change or go',
          { status: 422, details: { path } },
        );
      if (after !== (before ?? '')) edits.push(...mine);
    }
    if (edits.length === 0)
      throw new DomainError('docs_unchanged', 'the edits change none of the files', { status: 422 });
    return { docs, edits };
  }

  /** Starts the queued row when its slot is free and waits `waitMs` for the write that runs at once. */
  private async started(
    id: string,
    projectKey: string,
    repo: string,
    waitMs: number,
  ): Promise<DocWriteOutcome> {
    const { ctx, merges } = this.deps;
    this.waiting.add(id);
    this.pump();
    const running = this.queue.slot(projectKey, repo);
    if (running?.row.id !== id) {
      this.waiting.delete(id);
      return { id, state: 'queued', waitingFor: merges.holder(projectKey, repo) ?? '' };
    }
    await runPromise(
      this.queue.wait(running, waitMs, () => {
        // From here the result comes as a message: no tool answer will carry it.
        this.waiting.delete(id);
      }),
    );
    const wasWaiting = this.waiting.delete(id);
    return this.outcomeOf(ctx.repos.docWrites.get(id)!, wasWaiting);
  }

  /** The writes the last server left running continue; the others start when their slot is free. */
  async init(): Promise<void> {
    this.stopped = false;
    for (const row of this.deps.ctx.repos.docWrites.list('running')) {
      try {
        await this.recover(row);
      } catch (err) {
        this.deps.ctx.logger.warn({ err, writeId: row.id }, 'could not recover a document write');
        this.save(row.id, { state: 'queued', commitSha: null });
      }
    }
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await runPromise(Scope.close(this.scope, Exit.void));
    this.scope = Scope.makeUnsafe();
    this.queue = this.makeQueue();
  }

  private makeQueue(): DocWriteQueueEffects {
    return Effect.runSync(
      Scope.provide(
        makeDocWriteQueue({
          ctx: this.deps.ctx,
          start: (row) => this.save(row.id, { state: 'running' }),
          run: (row) => this.run(row),
          peer: this.deps.merges,
          stopped: () => this.stopped,
          ...(this.deps.work ? { work: this.deps.work } : {}),
        }),
        this.scope,
      ),
    );
  }

  /** Starts the queued writes whose repository slot is free. */
  pump(): void {
    // The queue is autonomous work: a bearer call that happens to start it lends it no authority.
    withoutIntegratorExecution(() => runFork(this.queue.pump));
  }

  private run(row: DocWriteRecord): Promise<void> {
    return withoutIntegratorExecution(() =>
      this.runRow(row).catch((err: unknown) => {
        this.deps.ctx.logger.warn({ err, writeId: row.id }, 'a document write failed');
        this.end(row, {
          state: 'failed',
          failure: 'git_failed',
          message: err instanceof Error ? err.message : 'the write failed',
        });
      }),
    );
  }

  private async runRow(row: DocWriteRecord): Promise<void> {
    if (row.externalOrigin) return this.runExternal(row, row.externalOrigin);
    // A row without any request and without an origin cannot be told apart from a forged one: it never runs.
    if (!row.requestedBy || !row.requestId || !row.stepId) return this.revoked(row);
    return this.execute(row, async () => {});
  }

  /** A write made through the bearer MCP runs under a fresh scope of its key, and is checked again before it goes up. */
  private async runExternal(row: DocWriteRecord, origin: ExternalToolOrigin): Promise<void> {
    const runner = this.deps.external;
    if (!runner) return this.revoked(row);
    let started = false;
    try {
      await runner.run(row.projectKey, origin, async (assertActive) => {
        started = true;
        const check = async () => {
          try {
            await assertActive();
          } catch (err) {
            throw new AuthorizationEnded(err);
          }
        };
        await check();
        await this.execute(row, check);
      });
    } catch (err) {
      if (started && !(err instanceof AuthorizationEnded)) throw err;
      this.revoked(row);
    }
  }

  private revoked(row: DocWriteRecord): void {
    this.end(row, {
      state: 'failed',
      failure: 'authorization_revoked',
      message: 'the credential of the write is no longer valid',
    });
  }

  private engineOf(projectKey: string, member: string): string {
    return this.deps.engines.engineFor(projectKey, member) ?? LOCAL_ENGINE_ID;
  }

  private mergerOf(engineId: string): BranchMerger {
    const merger = this.deps.engines.get(engineId)?.merger;
    if (!merger) throw conflict('engine_offline', 'the engine of the Operator is not connected');
    return merger;
  }

  private notConfigured(doc?: ProjectDoc): DomainError {
    return conflict(
      'docs_not_configured',
      doc
        ? `the project has no file set for the ${doc} document`
        : 'the project documents are not set up in any repository',
    );
  }

  private save(id: string, patch: Omit<DocWritePatch, 'updatedAt'>): void {
    this.deps.ctx.repos.docWrites.update(id, { ...patch, updatedAt: isoNow(this.deps.ctx) });
  }

  /** The tool's answer for a write that ended while the caller waited, or is still running. */
  private outcomeOf(row: DocWriteRecord, waited: boolean): DocWriteOutcome {
    if (!waited || row.state === 'running' || row.state === 'queued') return { id: row.id, state: 'running' };
    if (row.state === 'stale') return { id: row.id, state: 'stale' };
    if (row.state === 'failed') {
      const failure = failureOf(row.error?.code);
      return { id: row.id, state: 'failed', failure, message: row.error?.message ?? failure };
    }
    return {
      id: row.id,
      state: 'published',
      commit: row.commitSha!,
      paths: [...new Set(row.edits.map((edit) => edit.path))],
      ...(row.error?.code === 'local_checkout' ? { warning: 'local_checkout' as const } : {}),
    };
  }

  private async execute(row: DocWriteRecord, assertActive: () => Promise<void>): Promise<void> {
    const merger = this.deps.engines.get(row.engineId)?.merger;
    if (!merger)
      return this.end(row, {
        state: 'failed',
        failure: 'engine_offline',
        message: 'the engine of the Operator is not connected',
      });
    const ref = { projectKey: row.projectKey, repo: row.repo };
    const paths = [...new Set(row.edits.map((edit) => edit.path))];
    for (let attempt = 0; attempt < 2; attempt++) {
      const base = await merger.prepare(ref, { base: row.base, commit: row.baseCommit });
      if (base.relation === 'local_ahead' || base.relation === 'diverged')
        return this.end(row, {
          state: 'failed',
          failure: 'base_out_of_sync',
          message: 'the local default branch is ahead of or diverged from its upstream',
        });
      const onto = base.remote?.commit ?? base.local;
      // A file that moved since the commit the Operator read is not edited blind.
      const files: { path: string; text: string }[] = [];
      for (const path of paths) {
        const read = await merger.readFile(ref, { at: { commit: row.baseCommit }, path });
        const head = await merger.readFile(ref, { at: { commit: onto }, path });
        if (read.text !== head.text) return this.end(row, { state: 'stale' });
        try {
          files.push({
            path,
            text: applyDocEdits(
              head.text ?? '',
              row.edits.filter((edit) => edit.path === path),
            ),
          });
        } catch (err) {
          if (err instanceof DomainError) return this.end(row, { state: 'stale' });
          throw err;
        }
      }
      const built = await merger.commitFiles(ref, { onto, files, message: row.message });
      if (built.changed.length === 0)
        return this.end(row, {
          state: 'failed',
          failure: 'git_failed',
          message: 'the edits changed nothing',
        });
      this.save(row.id, { commitSha: built.commit });
      const conflicts = await merger.checkoutConflicts(ref, { base: row.base, changed: built.changed });
      if (conflicts.length)
        return this.end(row, {
          state: 'failed',
          failure: 'checkout_conflict',
          message: `uncommitted files overlap the write: ${conflicts.join(', ')}`,
        });
      // The last check before the write goes up: with a remote that is the push, without one the advance.
      await assertActive();
      if (base.remote) {
        const pushed = await merger.push(ref, { base: row.base, mergeCommit: built.commit });
        if (!pushed.ok) {
          // The remote moved between the fetch and the push: build again on its new head, once.
          if (pushed.reason === 'non_fast_forward' && attempt === 0) continue;
          return this.end(row, {
            state: 'failed',
            failure:
              pushed.reason === 'non_fast_forward'
                ? 'remote_moved'
                : pushed.reason === 'rejected'
                  ? 'push_rejected'
                  : 'remote_unreachable',
            message: pushed.message,
          });
        }
      }
      return this.advance(row, merger, base.local, built.commit, base.remote !== null);
    }
  }

  /** Moves the local default branch to the written commit; once the remote has it, the write is published either way. */
  private async advance(
    row: DocWriteRecord,
    merger: BranchMerger,
    from: string,
    commit: string,
    pushed: boolean,
  ): Promise<void> {
    const advanced = await merger.advance(
      { projectKey: row.projectKey, repo: row.repo },
      { base: row.base, from, to: commit },
    );
    if (advanced.ok) return this.end(row, { state: 'published', commit });
    if (pushed) return this.end(row, { state: 'published', commit, warning: 'local_checkout' });
    this.end(row, { state: 'failed', failure: 'local_checkout', message: advanced.message });
  }

  /** A `running` row from before a restart: published when its commit is already up, otherwise queued again. */
  private async recover(row: DocWriteRecord): Promise<void> {
    const merger = this.deps.engines.get(row.engineId)?.merger;
    if (row.commitSha && merger) {
      const ref = { projectKey: row.projectKey, repo: row.repo };
      const base = await merger.prepare(ref, { base: row.base, commit: row.commitSha });
      // With a remote the push is what counts; without one the local branch is all there is.
      const landed = base.remote ? base.contains.remote === true : base.contains.local;
      if (landed) {
        if (base.contains.local) return this.end(row, { state: 'published', commit: row.commitSha });
        return this.advance(row, merger, base.local, row.commitSha, base.remote !== null);
      }
    }
    this.save(row.id, { state: 'queued', commitSha: null });
  }

  /** Records how the write ended: its row and step, then a message to the Operator unless a tool call still waits. */
  private end(row: DocWriteRecord, ended: Ended): void {
    const { ctx } = this.deps;
    const error =
      ended.state === 'failed'
        ? { code: ended.failure, message: ended.message }
        : ended.state === 'published' && ended.warning
          ? {
              code: ended.warning,
              message: 'the default branch is up, but the local checkout could not follow',
            }
          : null;
    const refusal =
      ended.state === 'failed'
        ? { code: 'docs_write_failed' as ErrorCode, message: `${ended.failure}: ${ended.message}` }
        : ended.state === 'stale'
          ? {
              code: 'docs_stale' as ErrorCode,
              message: 'a file changed since the commit it was read at; read it again',
            }
          : undefined;
    const status: OperatorStepStatus =
      ended.state === 'published' ? 'done' : ended.state === 'stale' ? 'stale' : 'refused';
    ctx.unitOfWork(() => {
      this.save(row.id, {
        state: ended.state,
        ...(ended.state === 'published' ? { commitSha: ended.commit } : {}),
        error,
      });
      // A write made through the bearer MCP has no Operator step.
      if (row.stepId) ctx.repos.operatorRequests.updateStep(row.stepId, status, null, refusal);
    });
    if (ended.state === 'published') {
      try {
        this.deps.onPublished?.({
          projectKey: row.projectKey,
          repo: row.repo,
          base: row.base,
          commit: ended.commit,
        });
      } catch (err) {
        ctx.logger.warn({ err, writeId: row.id }, 'document publication callback failed');
      }
    }
    // The caller of a bearer-MCP write reads the result with `get_project_doc_write`: no message follows.
    if (this.waiting.has(row.id) || row.externalOrigin || !row.stepId) return;
    void this.tell(row, ended);
  }

  /** The Operator learns how a write that was not answered in the call ended; it is read with the owner's next message. */
  private async tell(row: DocWriteRecord, ended: Ended): Promise<void> {
    const paths = [...new Set(row.edits.map((edit) => edit.path))].join(', ');
    const subject = `Your write_project_docs ${row.id} (${row.message.split('\n')[0]})`;
    const text =
      ended.state === 'published'
        ? `${subject} is published as commit ${ended.commit}: ${paths}.${ended.warning ? ' The local checkout could not follow the default branch; tell the owner.' : ''}`
        : ended.state === 'stale'
          ? `${subject} was not written: ${paths} changed since the commit you read. Read the file again and show the owner the new text.`
          : `${subject} was not written (${ended.failure}): ${ended.message}`;
    try {
      await this.deps.messaging.send(
        row.projectKey,
        SYSTEM_SENDER,
        { to: [row.author], taskKey: null, text },
        { kind: 'info', actor: SYSTEM_ACTOR, untilInput: true },
      );
    } catch (err) {
      this.deps.ctx.logger.warn(
        { err, writeId: row.id },
        'could not tell the Operator how a document write ended',
      );
    }
  }
}
