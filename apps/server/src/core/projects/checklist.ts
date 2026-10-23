import {
  ChecklistItem,
  MAX_CHECKLIST_ITEMS,
  checklistConditionHolds,
  checklistProgress,
} from '@projectman/shared';
import type { ProjectChecklist, ProjectConfig, SetChecklistItemStateRequest } from '@projectman/shared';
import { BASE_CHECKLIST, getLocale } from '@projectman/templates';
import type { OperatorKnowledgeStore } from '../../contracts';
import { conflict, DomainError, KeyedMutex } from '../../kernel';
import { isoNow } from '../base';
import type { DomainContext } from '../base';
import type { TaskService } from '../tasks';
import type { ProjectService } from './projects';

interface ChecklistFacts {
  config: ProjectConfig;
  agreementApproved: boolean;
  taskCount: number;
}

export class ChecklistService {
  private readonly lock = new KeyedMutex();
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    knowledge: OperatorKnowledgeStore;
  };
  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    knowledge: OperatorKnowledgeStore;
  }) {
    this.deps = deps;
    const { ctx } = deps;
    ctx.events.on('project_created', ({ projectKey, providerReady }) =>
      this.init(projectKey, providerReady).then(() => {}),
    );
    ctx.events.on('config_changed', (change) =>
      change.previous ? this.recheck(change.projectKey) : undefined,
    );
    ctx.events.on('task_cancelled', (task) => this.recheck(task.projectKey));
  }

  private changed(key: string) {
    this.deps.ctx.bus.publish({ type: 'project_checklist_changed', projectKey: key });
  }

  /** Every write uses the same validation, including writes by the Operator. */
  private write(key: string, input: ChecklistItem, position: number, facts: ChecklistFacts) {
    const item = ChecklistItem.parse(input);
    if (
      item.state === 'done' &&
      item.condition &&
      !checklistConditionHolds(item.condition, facts.config, facts)
    )
      throw conflict('checklist_condition_unmet', 'checklist condition is not met');
    this.deps.ctx.repos.checklists.put(key, item, position);
  }

  private async facts(key: string) {
    const config = await this.deps.projects.config(key);
    const knowledge = await this.deps.knowledge.readKnowledge(key);
    return {
      config,
      agreementApproved: knowledge.agreement !== null,
      taskCount: this.deps.tasks.list(key).filter((task) => task.status !== 'cancelled').length,
    };
  }

  async get(key: string): Promise<ProjectChecklist | null> {
    const stored = this.deps.ctx.repos.checklists.get(key);
    if (!stored) return null;
    const facts = await this.facts(key);
    const items = stored.items.map((item) => ({
      ...item,
      conditionHolds: item.condition ? checklistConditionHolds(item.condition, facts.config, facts) : null,
    }));
    return { ...stored, items, progress: checklistProgress(items) };
  }

  async init(key: string, providerReady = false): Promise<ProjectChecklist> {
    return this.lock.run(key, async () => {
      const { ctx } = this.deps;
      if (ctx.repos.checklists.get(key)) throw conflict('checklist_exists', 'checklist already exists');
      const facts = await this.facts(key);
      const locale = getLocale(facts.config.project.language);
      const at = isoNow(ctx);
      ctx.unitOfWork(() => {
        ctx.repos.checklists.create(key, null, at);
        BASE_CHECKLIST.forEach((base, position) => {
          const text = locale.checklist.items[base.id as keyof typeof locale.checklist.items];
          this.write(
            key,
            ChecklistItem.parse({
              ...base,
              ...text,
              source: 'base',
              templateId: null,
              conditionHolds: null,
              state: base.id === 'code' || (base.id === 'providers' && providerReady) ? 'done' : 'open',
              reason: null,
              reopened: null,
              updatedAt: at,
              updatedBy: 'system',
            }),
            position,
            facts,
          );
        });
        this.changed(key);
      });
      return (await this.get(key))!;
    });
  }

  /** Adds or replaces an item; the Operator uses this entry point too. */
  async put(key: string, input: ChecklistItem): Promise<ProjectChecklist> {
    return this.lock.run(key, async () => {
      const item = ChecklistItem.parse(input);
      const current = await this.get(key);
      if (!current) throw new DomainError('checklist_missing', 'checklist does not exist', { status: 404 });
      const index = current.items.findIndex((entry) => entry.id === item.id);
      if (index < 0 && current.items.length >= MAX_CHECKLIST_ITEMS)
        throw conflict('checklist_full', 'checklist is full');
      const facts = await this.facts(key);
      this.deps.ctx.unitOfWork(() => {
        this.write(key, item, index < 0 ? current.items.length : index, facts);
        this.changed(key);
      });
      return (await this.get(key))!;
    });
  }

  async setState(
    key: string,
    id: string,
    request: SetChecklistItemStateRequest,
    handle: string,
  ): Promise<ProjectChecklist> {
    return this.lock.run(key, async () => {
      const current = await this.get(key);
      if (!current) throw new DomainError('checklist_missing', 'checklist does not exist', { status: 404 });
      const index = current.items.findIndex((item) => item.id === id);
      const item = current.items[index];
      if (!item)
        throw new DomainError('checklist_item_not_found', 'checklist item does not exist', { status: 404 });
      if (request.state === 'open' && item.state === 'open') return current;
      const facts = await this.facts(key);
      const at = isoNow(this.deps.ctx);
      const reopened = request.state === 'open';
      this.deps.ctx.unitOfWork(() => {
        this.write(
          key,
          {
            ...item,
            state: request.state,
            reason: request.state === 'not_needed' ? request.reason : null,
            reopened: reopened ? 'owner' : null,
            updatedAt: at,
            updatedBy: handle,
          },
          index,
          facts,
        );
        this.changed(key);
      });
      if (reopened)
        await this.deps.ctx.events.emit('checklist_item_reopened', {
          projectKey: key,
          itemId: id,
          cause: 'owner',
          at,
        });
      return (await this.get(key))!;
    });
  }

  async recheck(key: string): Promise<void> {
    await this.lock.run(key, async () => {
      const current = await this.get(key);
      if (!current) return;
      const facts = await this.facts(key);
      const at = isoNow(this.deps.ctx);
      const reopened = current.items.filter((item) => item.state === 'done' && item.conditionHolds === false);
      this.deps.ctx.unitOfWork(() => {
        for (const item of reopened)
          this.write(
            key,
            { ...item, state: 'open', reopened: 'condition', updatedAt: at, updatedBy: 'system' },
            current.items.indexOf(item),
            facts,
          );
        if (reopened.length) this.changed(key);
      });
      for (const item of reopened)
        await this.deps.ctx.events.emit('checklist_item_reopened', {
          projectKey: key,
          itemId: item.id,
          cause: 'condition',
          at,
        });
    });
  }
}
