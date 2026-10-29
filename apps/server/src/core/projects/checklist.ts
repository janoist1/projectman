import {
  ChecklistItem,
  MAX_CHECKLIST_ITEMS,
  checklistConditionHolds,
  checklistProgress,
} from '@projectman/shared';
import type {
  ChecklistCondition,
  ProjectChecklist,
  ProjectConfig,
  SetChecklistItemStateRequest,
} from '@projectman/shared';
import { BASE_CHECKLIST, getLocale, getTemplate, summarizeTemplate, templates } from '@projectman/templates';
import type { OperatorKnowledgeStore } from '../../contracts';
import { conflict, DomainError, KeyedMutex } from '../../kernel';
import { isoNow } from '../base';
import type { DomainContext } from '../base';
import type { TaskService } from '../tasks';
import type { ProjectService } from './projects';

/** A new state of an item; `not_needed` always carries its reason. */
type ChecklistStateChange = { state: 'open' | 'done' } | { state: 'not_needed'; reason: string };

interface ChecklistFacts {
  config: ProjectConfig;
  agreementApproved: boolean;
  taskCount: number;
  engineConnected: boolean;
}

export class ChecklistService {
  private readonly lock = new KeyedMutex();
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    knowledge: OperatorKnowledgeStore;
    /** The project's engine reported the project in its hello (PM-1069); the runtime implements it. */
    engineHolds: (projectKey: string) => boolean;
  };
  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    knowledge: OperatorKnowledgeStore;
    engineHolds: (projectKey: string) => boolean;
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
      taskCount: this.deps.tasks.countNotCancelled(key),
      engineConnected: this.deps.engineHolds(key),
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
              state:
                base.id === 'code' ||
                (base.id === 'engine' && facts.engineConnected) ||
                (base.id === 'providers' && providerReady)
                  ? 'done'
                  : 'open',
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

  /** The owner's state change: opening an item again counts as a reopening by the owner. */
  async setState(
    key: string,
    id: string,
    request: SetChecklistItemStateRequest,
    handle: string,
  ): Promise<ProjectChecklist> {
    return this.changeState(key, id, request, handle, 'owner');
  }

  /** The Operator's state change: it may also settle an item as done, and opening is no reopening. */
  async setStateByOperator(
    key: string,
    id: string,
    change: ChecklistStateChange,
    handle: string,
  ): Promise<ProjectChecklist> {
    return this.changeState(key, id, change, handle, null);
  }

  private async changeState(
    key: string,
    id: string,
    change: ChecklistStateChange,
    handle: string,
    reopenedBy: 'owner' | null,
  ): Promise<ProjectChecklist> {
    return this.lock.run(key, async () => {
      const { current, index, item } = await this.itemOf(key, id);
      if (change.state === 'open' && item.state === 'open') return current;
      const facts = await this.facts(key);
      const at = isoNow(this.deps.ctx);
      const reopened = change.state === 'open' ? reopenedBy : null;
      this.deps.ctx.unitOfWork(() => {
        this.write(
          key,
          {
            ...item,
            state: change.state,
            reason: change.state === 'not_needed' ? change.reason : null,
            reopened,
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
          cause: reopened,
          at,
        });
      return (await this.get(key))!;
    });
  }

  /** What each template adds to a list, so the Operator can pick a base. */
  templateBases(): { id: string; checklist: string[] }[] {
    return templates.map((template) => {
      const { id, checklist } = summarizeTemplate(template);
      return { id, checklist };
    });
  }

  /** Adds an Operator item with a server-made `custom_<n>` id. */
  async add(
    key: string,
    input: { title: string; hint?: string | null; condition?: ChecklistCondition | null },
    handle: string,
  ): Promise<{ checklist: ProjectChecklist; itemId: string }> {
    return this.lock.run(key, async () => {
      const current = await this.existing(key);
      if (current.items.length >= MAX_CHECKLIST_ITEMS) throw conflict('checklist_full', 'checklist is full');
      const used = current.items.map((item) => Number(/^custom_(\d+)$/.exec(item.id)?.[1] ?? 0));
      const id = `custom_${Math.max(0, ...used) + 1}`;
      const facts = await this.facts(key);
      this.deps.ctx.unitOfWork(() => {
        this.write(
          key,
          ChecklistItem.parse({
            id,
            title: input.title,
            hint: input.hint ?? null,
            source: 'operator',
            templateId: null,
            condition: input.condition ?? null,
            conditionHolds: null,
            state: 'open',
            reason: null,
            reopened: null,
            updatedAt: isoNow(this.deps.ctx),
            updatedBy: handle,
          }),
          current.items.length,
          facts,
        );
        this.changed(key);
      });
      return { checklist: (await this.get(key))!, itemId: id };
    });
  }

  /** Changes the title and/or the hint of an item. */
  async edit(
    key: string,
    id: string,
    patch: { title?: string; hint?: string | null },
    handle: string,
  ): Promise<ProjectChecklist> {
    return this.update(key, id, handle, (item) => ({
      ...item,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.hint !== undefined ? { hint: patch.hint } : {}),
    }));
  }

  /** Binds a condition to an item, or takes it off with null; a done item keeps its state only if it holds. */
  async setCondition(
    key: string,
    id: string,
    condition: ChecklistCondition | null,
    handle: string,
  ): Promise<ProjectChecklist> {
    return this.update(key, id, handle, (item) => ({ ...item, condition }));
  }

  /** Adds the template's items the list does not have yet; never deletes or overwrites an item. */
  async applyTemplate(
    key: string,
    templateId: string,
    handle: string,
  ): Promise<{ checklist: ProjectChecklist; added: string[] }> {
    return this.lock.run(key, async () => {
      const template = getTemplate(templateId);
      if (!template) throw new DomainError('unknown_template', 'unknown template', { status: 404 });
      const current = await this.existing(key);
      const missing = template.checklist.filter(
        (entry) => !current.items.some((item) => item.id === entry.id),
      );
      if (current.items.length + missing.length > MAX_CHECKLIST_ITEMS)
        throw conflict('checklist_full', 'checklist is full');
      const facts = await this.facts(key);
      const locale = getLocale(facts.config.project.language);
      const at = isoNow(this.deps.ctx);
      this.deps.ctx.unitOfWork(() => {
        missing.forEach((entry, offset) => {
          const text = locale.checklist.items[entry.id];
          this.write(
            key,
            ChecklistItem.parse({
              id: entry.id,
              ...text,
              source: 'template',
              templateId,
              condition: entry.condition,
              conditionHolds: null,
              state: 'open',
              reason: null,
              reopened: null,
              updatedAt: at,
              updatedBy: handle,
            }),
            current.items.length + offset,
            facts,
          );
        });
        this.deps.ctx.repos.checklists.setBaseTemplate(key, templateId);
        this.changed(key);
      });
      return { checklist: (await this.get(key))!, added: missing.map((entry) => entry.id) };
    });
  }

  private async existing(key: string): Promise<ProjectChecklist> {
    const current = await this.get(key);
    if (!current) throw new DomainError('checklist_missing', 'checklist does not exist', { status: 404 });
    return current;
  }

  private async itemOf(key: string, id: string) {
    const current = await this.existing(key);
    const index = current.items.findIndex((item) => item.id === id);
    const item = current.items[index];
    if (!item)
      throw new DomainError('checklist_item_not_found', 'checklist item does not exist', { status: 404 });
    return { current, index, item };
  }

  private async update(
    key: string,
    id: string,
    handle: string,
    change: (item: ChecklistItem) => ChecklistItem,
  ): Promise<ProjectChecklist> {
    return this.lock.run(key, async () => {
      const { index, item } = await this.itemOf(key, id);
      const facts = await this.facts(key);
      this.deps.ctx.unitOfWork(() => {
        this.write(
          key,
          { ...change(item), updatedAt: isoNow(this.deps.ctx), updatedBy: handle },
          index,
          facts,
        );
        this.changed(key);
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
