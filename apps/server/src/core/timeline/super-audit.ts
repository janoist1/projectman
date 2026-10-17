import { SUPER_AUDIT_NAME, SUPER_AUDIT_REQUEST_ID } from '@projectman/shared';
import type { SuperAuditOutcome, SuperAuditPage, SuperAuditQuery } from '@projectman/shared';
import type { SuperExecutionContext } from '../../contracts';
import type { StoredSuperAudit } from '../../db';
import { isoNow } from '../base';
import type { DomainContext } from '../base';
import { DomainError, invalid, newId } from '../../kernel';

/** What one audited operation is aimed at. */
export interface SuperAuditOptions {
  taskKey?: string | null;
}

/** How a lost response is settled: whether the effect with this audit entry's id landed. */
export type CommittedCheck = (auditId: string) => Promise<boolean>;

/**
 * The audit of the Operator's super mode (PM-757): one entry per step made with a super credential. It
 * keeps the operation's name, its target and the credential's prefix, and nothing else: no request, no
 * configuration and no raw error. Names, error codes and request ids come from a closed vocabulary and are
 * checked here, so an unchecked value fails the operation instead of reaching the audit.
 *
 * Two shapes, by what the operation changes:
 * - `run`: a domain change in the database. The change and its `succeeded` entry are one transaction; a refusal
 *   or a failure rolls the change back and is audited after it.
 * - `runExternal`: a change outside the database (the configuration's git commit). A `started` entry is
 *   written first (the durable intent), the commit carries its id as a trailer, and the result follows. When
 *   the response is lost, the commit decides: found is `succeeded`, absent is `failed`, and an answer that
 *   cannot be had is `unknown`, never a made-up success (`settleOpen` settles what a crash left).
 */
export class SuperAuditService {
  private readonly ctx: DomainContext;

  constructor(ctx: DomainContext) {
    this.ctx = ctx;
  }

  run<T>(
    exec: SuperExecutionContext,
    operation: string,
    work: () => T extends PromiseLike<unknown> ? never : T,
    opts: SuperAuditOptions = {},
  ): T {
    this.assertVocabulary(exec, operation);
    let result: T;
    try {
      result = this.ctx.unitOfWork(() => {
        const value = work();
        this.write(exec, operation, 'succeeded', null, opts);
        return value;
      });
    } catch (error) {
      this.writeError(exec, operation, error, opts);
      throw error;
    }
    return result;
  }

  async runExternal<T>(
    exec: SuperExecutionContext,
    operation: string,
    work: (auditId: string) => Promise<T>,
    opts: SuperAuditOptions & { committed: CommittedCheck },
  ): Promise<T> {
    this.assertVocabulary(exec, operation);
    const started = this.write(exec, operation, 'started', null, opts);
    let result: T;
    try {
      result = await work(started.id);
    } catch (error) {
      if (error instanceof DomainError && error.status < 500) {
        this.write(exec, operation, 'refused', codeOf(error), opts, started.id);
      } else {
        const landed = await opts.committed(started.id).then(
          (found) => found,
          () => null,
        );
        this.write(
          exec,
          operation,
          landed === true ? 'succeeded' : landed === false ? 'failed' : 'unknown',
          landed === true ? null : codeOf(error),
          opts,
          started.id,
        );
      }
      throw error;
    }
    this.write(exec, operation, 'succeeded', null, opts, started.id);
    return result;
  }

  /**
   * Settles the `started` entries a crash left without a result: the effect that landed is `succeeded`, one that
   * did not is `failed`, and one that cannot be told is `unknown`. Returns how many it settled.
   */
  async settleOpen(projectKey: string, committed: CommittedCheck): Promise<number> {
    let settled = 0;
    for (const entry of this.ctx.repos.superAudit.unsettled(projectKey)) {
      const landed = await committed(entry.id).then(
        (found) => found,
        () => null,
      );
      this.ctx.repos.superAudit.insert({
        ...entry,
        id: newId('saud'),
        outcome: landed === true ? 'succeeded' : landed === false ? 'failed' : 'unknown',
        errorCode: landed === true ? null : landed === false ? 'operation_lost' : 'operation_unknown',
        settlesId: entry.id,
        createdAt: isoNow(this.ctx),
      });
      settled += 1;
    }
    return settled;
  }

  /** A page of the project's audit, newest first, optionally one token's (by its prefix). */
  list(projectKey: string, query: SuperAuditQuery): SuperAuditPage {
    if (query.before && !this.ctx.repos.superAudit.has(projectKey, query.before))
      throw invalid('invalid_request', 'unknown audit cursor');
    const page = this.ctx.repos.superAudit.list(projectKey, {
      limit: query.limit,
      ...(query.prefix ? { prefix: query.prefix } : {}),
      ...(query.before ? { before: query.before } : {}),
    });
    // The id of the key stays inside: the audit shows the token by its prefix.
    return {
      entries: page.entries.map(({ keyId: _keyId, settlesId: _settlesId, ...entry }) => entry),
      nextBefore: page.nextBefore,
    };
  }

  private assertVocabulary(exec: SuperExecutionContext, operation: string): void {
    if (!SUPER_AUDIT_NAME.test(operation))
      throw new Error('a super-mode operation needs a plain identifier as its audited name');
    if (!SUPER_AUDIT_REQUEST_ID.test(exec.requestId))
      throw new Error('a super-mode operation needs a plain identifier as its request id');
  }

  private write(
    exec: SuperExecutionContext,
    operation: string,
    outcome: SuperAuditOutcome,
    errorCode: string | null,
    opts: SuperAuditOptions,
    settlesId: string | null = null,
  ): StoredSuperAudit {
    const entry: StoredSuperAudit = {
      id: newId('saud'),
      projectKey: exec.projectKey,
      taskKey: opts.taskKey ?? null,
      keyId: exec.actor.credential.id,
      prefix: exec.actor.credential.prefix,
      operatorMode: 'super',
      requestId: exec.requestId,
      handoffId: exec.handoffId ?? null,
      operation,
      outcome,
      errorCode,
      settlesId,
      createdAt: isoNow(this.ctx),
    };
    this.ctx.repos.superAudit.insert(entry);
    return entry;
  }

  /** A refusal or a failure after the rollback: its code only, never the message. */
  private writeError(
    exec: SuperExecutionContext,
    operation: string,
    error: unknown,
    opts: SuperAuditOptions,
  ): void {
    const refused = error instanceof DomainError && error.status < 500;
    this.write(exec, operation, refused ? 'refused' : 'failed', codeOf(error), opts);
  }
}

/** The error code of a domain error when it is a plain identifier; every other error is an `internal_error`. */
function codeOf(error: unknown): string {
  return error instanceof DomainError && SUPER_AUDIT_NAME.test(error.code) ? error.code : 'internal_error';
}

export function createSuperAuditService(ctx: DomainContext): SuperAuditService {
  return new SuperAuditService(ctx);
}
