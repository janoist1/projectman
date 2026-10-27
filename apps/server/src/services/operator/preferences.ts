import {
  coordinationMemberOf,
  isOperator,
  isProjectManager,
  memberOf,
  OperatorPreferenceData,
  ownerHandles,
} from '@projectman/shared';
import type { OperatorPreferenceDocument, SessionStartCause, WorkItemRef } from '@projectman/shared';
import type { OperatorKnowledgeStore, ToolContext } from '../../contracts';
import type { DomainContext } from '../../core/base';
import { isoNow } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import { forbidden } from '../../kernel';
import type { OperatorRequests } from './requests';

/** Personal style only. Neither the caller nor preference data can select another person. */
export class OperatorPreferences {
  private readonly deps: {
    ctx: DomainContext;
    projects: Pick<ProjectService, 'config'>;
    requests: Pick<OperatorRequests, 'openFor'>;
    store: OperatorKnowledgeStore;
  };

  constructor(deps: OperatorPreferences['deps']) {
    this.deps = deps;
  }

  async get(ctx: ToolContext): Promise<OperatorPreferenceDocument> {
    return this.deps.store.readPreference(ctx.projectKey, await this.personFor(ctx, false));
  }

  async set(
    ctx: ToolContext,
    expectedRevision: number,
    preference: OperatorPreferenceData,
  ): Promise<OperatorPreferenceDocument> {
    const data = OperatorPreferenceData.parse(preference);
    const handle = await this.personFor(ctx, true);
    return this.deps.store.compareAndSwapPreference(ctx.projectKey, handle, expectedRevision, {
      schemaVersion: 1,
      revision: expectedRevision + 1,
      data,
      updatedAt: isoNow(this.deps.ctx),
    });
  }

  /** REST callers already proved their own login and project membership. */
  async me(projectKey: string, handle: string): Promise<OperatorPreferenceDocument> {
    const config = await this.deps.projects.config(projectKey);
    if (memberOf(config, handle)?.kind !== 'human')
      throw forbidden('operator_owner_only', 'the preference belongs to a current human member');
    return this.deps.store.readPreference(projectKey, handle);
  }

  async list(projectKey: string) {
    const config = await this.deps.projects.config(projectKey);
    const items = await Promise.all(
      config.team.members
        .filter((member) => member.kind === 'human')
        .map(async ({ handle }) => ({ handle, preference: await this.me(projectKey, handle) })),
    );
    return { items };
  }

  /** Only the current person's five enums cross the server/engine context boundary. */
  async forConversation(
    projectKey: string,
    member: string,
    workItem: WorkItemRef,
    cause: SessionStartCause | null,
  ): Promise<OperatorPreferenceData | undefined> {
    if (workItem.type !== 'general') return undefined;
    const config = await this.deps.projects.config(projectKey);
    const caller = memberOf(config, member);
    const pm = isProjectManager(caller);
    if (
      pm
        ? coordinationMemberOf(config)?.handle !== member || workItem.with !== undefined
        : !isOperator(caller)
    )
      return undefined;
    const by = cause?.by;
    if (
      !cause ||
      !['message', 'answer', 'conversation'].includes(cause.kind) ||
      by?.kind !== 'human' ||
      !by.handle ||
      by.via ||
      memberOf(config, by.handle)?.kind !== 'human'
    )
      return undefined;
    if (workItem.with !== undefined ? workItem.with !== by.handle : !ownerHandles(config).includes(by.handle))
      return undefined;
    return (await this.deps.store.readPreference(projectKey, by.handle)).data;
  }

  private async personFor(ctx: ToolContext, write: boolean): Promise<string> {
    const config = await this.deps.projects.config(ctx.projectKey);
    const caller = memberOf(config, ctx.member);
    const pm = isProjectManager(caller);
    if (!isOperator(caller) && !pm)
      throw forbidden(
        'operator_only',
        'only the Operator or project manager may use conversational preferences',
      );
    if (pm && coordinationMemberOf(config)?.handle !== ctx.member)
      throw forbidden('project_manager_only', 'preferences require the selected active project manager');
    const session = this.deps.ctx.repos.sessions.get(ctx.sessionId);
    if (
      !session ||
      session.projectKey !== ctx.projectKey ||
      session.member !== ctx.member ||
      session.workItem.type !== 'general'
    )
      throw forbidden('operator_owner_only', 'preferences require the current Operator conversation');
    const request = this.deps.requests.openFor(session.id);
    const withHandle = session.workItem.with;
    if (pm) {
      if (withHandle !== undefined)
        throw forbidden(
          'operator_owner_only',
          'preferences require the internal project manager conversation',
        );
      if (!request || !['message', 'answer'].includes(request.source))
        throw forbidden('operator_no_request', 'preferences require an open personal owner request');
      if (
        request.projectKey !== ctx.projectKey ||
        memberOf(config, request.fromHandle)?.kind !== 'human' ||
        !ownerHandles(config).includes(request.fromHandle)
      )
        throw forbidden('operator_owner_only', 'the open request must belong to a current human owner');
      return request.fromHandle;
    }
    if (withHandle !== undefined) {
      const by = session.startCause?.by;
      if (
        memberOf(config, withHandle)?.kind !== 'human' ||
        by?.kind !== 'human' ||
        by.via ||
        by.handle !== withHandle ||
        (request && (request.projectKey !== ctx.projectKey || request.fromHandle !== withHandle))
      )
        throw forbidden('operator_owner_only', 'the guest must be the person who opened this conversation');
      if (write && !request)
        throw forbidden('operator_no_request', 'a preference change needs an open personal request');
      return withHandle;
    }
    if (request) {
      if (
        request.projectKey !== ctx.projectKey ||
        memberOf(config, request.fromHandle)?.kind !== 'human' ||
        !ownerHandles(config).includes(request.fromHandle)
      )
        throw forbidden('operator_owner_only', 'the open request must belong to a current human owner');
      return request.fromHandle;
    }
    if (write) throw forbidden('operator_no_request', 'a preference change needs an open personal request');
    const owners = ownerHandles(config).filter((handle) => memberOf(config, handle)?.kind === 'human');
    if (owners.length === 1) return owners[0]!;
    throw forbidden('operator_preference_no_person', 'this conversation has no unambiguous human recipient');
  }
}
