import {
  holdsOwnershipByEmail,
  memberOf,
  ownerHandles,
  projectManagerOf,
  questionPayloadOf,
} from '@projectman/shared';
import type { InboxItem, ProjectConfig } from '@projectman/shared';
import { getLocale, getTemplate, templates } from '@projectman/templates';
import type { HumanQuestionsPort, SetupProcessView, SetupSourceView, TemplatePreview } from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import { conflict, DomainError, forbidden } from '../../kernel';

/** How long an owner's yes lets the project manager read the other project (PM-1463). */
const SETUP_SOURCE_PERMISSION_MS = 24 * 60 * 60 * 1000;

/**
 * The lessons document of a project on the member's engine, as its default branch has it. Throws
 * `docs_not_configured` when the project keeps none, another error when the engine cannot be reached.
 */
type LessonsReader = (projectKey: string, member: string) => Promise<{ text: string | null }>;

/**
 * The project manager's setup ideas (PM-1463): a template built from this project's data, and another project of
 * the owner's, read only with that owner's own yes. Neither returns a person, a card, a message or a document.
 */
export class SetupSources {
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    questions: HumanQuestionsPort;
    readLessons: LessonsReader;
  };
  constructor(deps: SetupSources['deps']) {
    this.deps = deps;
  }

  /** The template list, or one template built with this project's key, name, folder, language and owner. */
  preview(config: ProjectConfig, ownerHandle: string | null, templateId?: string): TemplatePreview {
    if (templateId === undefined)
      return {
        templates: templates.map((template) => {
          const sample = template.build(this.buildInput(config, ownerHandle));
          return {
            id: template.id,
            stages: sample.pipeline.stages.length,
            humans: sample.team.members.filter((member) => member.kind === 'human').length,
            aiMembers: sample.team.members.filter((member) => member.kind === 'ai').length,
          };
        }),
      };
    const template = getTemplate(templateId);
    if (!template)
      throw new DomainError(
        'unknown_template',
        `No template "${templateId}"; these exist: ${templates.map((t) => t.id).join(', ')}.`,
        { status: 404 },
      );
    const built = template.build(this.buildInput(config, ownerHandle));
    const titles = getLocale(config.project.language).checklist.items;
    return {
      templateId: template.id,
      ...processView(built),
      humans: built.team.members.filter((member) => member.kind === 'human').length,
      checklist: template.checklist.map((item) => titles[item.id].title),
    };
  }

  /**
   * Opens the question to the requesting owner: which of their other projects the project manager may look at.
   * Their other projects are the ones they own under the same e-mail; with none, `setup_source_none`.
   */
  async ask(
    projectKey: string,
    caller: { member: string; sessionId: string },
    ownerHandle: string,
  ): Promise<{ inbox_item_id: string; candidates: string[] }> {
    const config = await this.deps.projects.config(projectKey);
    const owner = memberOf(config, ownerHandle);
    const email = owner?.kind === 'human' && owner.access === 'owner' ? owner.email : undefined;
    const candidates = email ? await this.ownedElsewhere(projectKey, email) : [];
    if (candidates.length === 0)
      throw conflict('setup_source_none', 'The owner has no other project of their own.');
    const text = getLocale(config.project.language).setupSource;
    const asked = await this.deps.questions.ask(
      projectKey,
      { kind: 'member', member: caller.member, sessionId: caller.sessionId },
      {
        question: text.question,
        details: text.details,
        setupSource: { owner: ownerHandle, candidates, noneLabel: text.none },
      },
    );
    return { inbox_item_id: asked.inboxItemId, candidates: candidates.map((candidate) => candidate.key) };
  }

  /**
   * The other project's process and lessons, when an owner of this project allowed exactly that project with their
   * own login in the last day and still owns it under the same e-mail; otherwise `setup_source_not_allowed`.
   */
  async read(projectKey: string, sourceKey: string): Promise<SetupSourceView> {
    const config = await this.deps.projects.config(projectKey);
    const source = sourceKey !== projectKey && this.deps.projects.has(sourceKey) ? sourceKey : null;
    const sourceConfig = source ? await this.deps.projects.config(source).catch(() => null) : null;
    if (!sourceConfig || !this.allowed(projectKey, config, sourceConfig, sourceKey))
      throw forbidden(
        'setup_source_not_allowed',
        `No owner allowed reading ${sourceKey} with their own login in the last day.`,
      );
    // Read where the other project's own project manager reads them; a project that keeps none has none.
    let lessons: string | null = null;
    let lessonsUnavailable = false;
    try {
      lessons = (await this.deps.readLessons(sourceKey, projectManagerOf(sourceConfig)?.handle ?? '')).text;
    } catch (err) {
      if (!(err instanceof DomainError && err.code === 'docs_not_configured')) lessonsUnavailable = true;
    }
    return {
      key: sourceConfig.project.key,
      name: sourceConfig.project.name,
      ...processView(sourceConfig),
      lessons,
      ...(lessonsUnavailable ? { lessonsUnavailable: true as const } : {}),
    };
  }

  private allowed(
    projectKey: string,
    config: ProjectConfig,
    sourceConfig: ProjectConfig,
    sourceKey: string,
  ): boolean {
    const since = new Date(this.deps.ctx.now().getTime() - SETUP_SOURCE_PERMISSION_MS).toISOString();
    const owners = ownerHandles(config);
    return this.deps.ctx.repos.inbox.listAnsweredQuestions(projectKey, since, true).some((item) => {
      const asked = questionPayloadOf(item)?.setupSource;
      const resolution = item.resolution;
      if (!asked || !resolution || resolution.optionId !== sourceKey) return false;
      if (resolution.by !== asked.owner || !owners.includes(resolution.by)) return false;
      if (!answeredByOwnLogin(resolution) || !asked.candidates.includes(sourceKey)) return false;
      const owner = memberOf(config, resolution.by);
      return owner?.kind === 'human' && holdsOwnershipByEmail(sourceConfig, owner.email);
    });
  }

  /** The owner's other projects, under the same e-mail; a project whose configuration cannot be read is left out. */
  private async ownedElsewhere(projectKey: string, email: string): Promise<{ key: string; name: string }[]> {
    const owned: { key: string; name: string }[] = [];
    for (const summary of this.deps.projects.summaries()) {
      if (summary.key === projectKey) continue;
      const other = await this.deps.projects.config(summary.key).catch(() => null);
      if (other && holdsOwnershipByEmail(other, email))
        owned.push({ key: summary.key, name: other.project.name });
    }
    return owned;
  }

  private buildInput(config: ProjectConfig, ownerHandle: string | null) {
    const owner = memberOf(config, ownerHandle ?? ownerHandles(config)[0]);
    return {
      key: config.project.key,
      name: config.project.name,
      workspacePath: config.project.workspacePath,
      language: config.project.language,
      owner: {
        handle: owner?.handle ?? 'owner',
        displayName: owner?.displayName ?? 'Owner',
        email: owner?.kind === 'human' ? (owner.email ?? '') : '',
      },
    };
  }
}

/** The owner answered with their own login: nobody relayed, delegated or decided it for them, and no rule closed it. */
function answeredByOwnLogin(resolution: NonNullable<InboxItem['resolution']>): boolean {
  return (
    resolution.via === undefined &&
    resolution.actor === undefined &&
    resolution.superDecision === undefined &&
    resolution.ownerAnswerRelayed === undefined &&
    resolution.integratorTodo === undefined &&
    resolution.integratorFixLimit === undefined &&
    resolution.operatorQueue === undefined &&
    resolution.rule === undefined
  );
}

/** A project's process without its people: no member handle, display name or e-mail. */
function processView(config: ProjectConfig): SetupProcessView {
  const { pipeline, team } = config;
  return {
    stages: pipeline.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      kind: stage.kind,
      column: pipeline.columns.find((column) => column.id === stage.columnId)?.name ?? stage.columnId,
      ...(stage.duty ? { duty: stage.duty } : {}),
      ...(stage.gate ? { gate: stage.gate.conditions } : {}),
    })),
    labels: pipeline.labels.map((label) => ({
      id: label.id,
      name: label.name,
      ...(label.meaning ? { meaning: label.meaning } : {}),
      setBy:
        typeof label.setBy === 'string'
          ? label.setBy
          : {
              ...(label.setBy.duties ? { duties: label.setBy.duties } : {}),
              ...(label.setBy.humansOnly ? { humansOnly: true } : {}),
            },
    })),
    roles: team.roles.map((role) => ({ id: role.id, name: role.name, summary: role.summary })),
    aiMembers: team.members.flatMap((member) =>
      member.kind === 'ai'
        ? [
            {
              role: member.role,
              provider: member.provider ?? 'claude',
              ...(member.specialty ? { specialty: member.specialty } : {}),
            },
          ]
        : [],
    ),
  };
}
