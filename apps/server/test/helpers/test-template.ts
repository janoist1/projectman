import {
  DEFAULT_PRIORITY_SETTERS,
  DEFAULT_PREREQUISITE_OVERRIDE,
  DEFAULT_PROJECT_MANAGER_LIFECYCLE,
  DEFAULT_PROJECT_MANAGER_MOVES,
  DEFAULT_TASK_CREATE_ACCESS,
  DEFAULT_VIEWER_RECIPIENTS,
  ProjectConfig,
} from '@projectman/shared';
import type { ProjectConfigInput } from '@projectman/shared';
import { migrateAcceptanceGates } from '@projectman/templates';
import type { BuildTemplateInput, ProjectTemplate } from '@projectman/templates';

/**
 * A small team and pipeline used by the tests:
 *   backlog (queue) -> development (work) -> code_review (step)
 *   -> merge (gate: labels code-review-ok + merge-ok, an owner approval)
 *   -> release (gate: labels pr-merged + release-ok, a release approval the owner may give) -> done
 */
/**
 * The test project as a current configuration: with the acceptance gates and labels the config migration
 * adds (PM-1135), so that a saved and loaded configuration equals it.
 */
function testConfigInput(input: BuildTemplateInput): ProjectConfigInput {
  return migrateAcceptanceGates(plainConfigInput(input));
}

function plainConfigInput(input: BuildTemplateInput): ProjectConfigInput {
  return {
    schemaVersion: 1,
    project: {
      key: input.key,
      name: input.name,
      workspacePath: input.workspacePath,
      repos: [{ name: 'web', path: '.', github: 'acme/web', requireMerge: false }],
      language: input.language,
      templateId: 'test',
    },
    team: {
      cardMover: input.cardMover ?? { kind: 'worker' },
      projectManagerMoves: DEFAULT_PROJECT_MANAGER_MOVES,
      projectManagerLifecycle: [...DEFAULT_PROJECT_MANAGER_LIFECYCLE],
      prerequisiteOverride: DEFAULT_PREREQUISITE_OVERRIDE,
      prioritySetters: [...DEFAULT_PRIORITY_SETTERS],
      viewerRecipients: DEFAULT_VIEWER_RECIPIENTS,
      taskCreateAccess: DEFAULT_TASK_CREATE_ACCESS,
      // Stored explicitly, as the migration writes it (PM-1097).
      complexitySetters: ['requirements_analysis', 'task_breakdown'],
      // Stored explicitly, as the migration writes it; the developer, so that tests may drop the review stage.
      merger: input.merger ?? { kind: 'developer' },
      members: [
        {
          kind: 'human',
          handle: input.owner.handle,
          displayName: input.owner.displayName,
          access: 'owner',
          // The owner approves releases: the release gate takes the release approval duty's label only.
          roles: ['operator'],
          email: input.owner.email,
        },
        {
          kind: 'ai',
          handle: 'dev-1',
          displayName: 'Dev One',
          role: 'developer',
          sponsor: input.owner.handle,
        },
        {
          kind: 'ai',
          handle: 'dev-2',
          displayName: 'Dev Two',
          role: 'developer',
          sponsor: input.owner.handle,
        },
        {
          kind: 'ai',
          handle: 'cr',
          displayName: 'Reviewer',
          role: 'code_review',
          sponsor: input.owner.handle,
        },
        // Every project has a project manager (PM-429); on leave, so it starts no sessions here.
        {
          kind: 'ai',
          handle: 'pm',
          displayName: 'Project Manager',
          role: 'project_manager',
          sponsor: input.owner.handle,
          onLeave: true,
        },
      ],
      limits: { maxConcurrentAi: 3, pauseAbovePlanUsagePercent: 80 },
    },
    pipeline: {
      columns: [
        { id: 'todo', name: 'To do' },
        { id: 'doing', name: 'Doing' },
        { id: 'review', name: 'Review' },
        { id: 'done', name: 'Done' },
      ],
      stages: [
        { id: 'backlog', name: 'Backlog', kind: 'queue', owners: [input.owner.handle], columnId: 'todo' },
        {
          id: 'development',
          name: 'Development',
          kind: 'work',
          owners: ['dev-1', 'dev-2'],
          columnId: 'doing',
        },
        { id: 'code_review', name: 'Code review', kind: 'step', owners: ['cr'], columnId: 'review' },
        {
          id: 'merge',
          name: 'Merge',
          kind: 'step',
          owners: [input.owner.handle],
          columnId: 'review',
          gate: {
            conditions: [
              { type: 'has_label', label: 'code-review-ok' },
              { type: 'has_label', label: 'merge-ok' },
            ],
          },
        },
        {
          id: 'release',
          name: 'Release',
          kind: 'release',
          owners: [input.owner.handle],
          columnId: 'review',
          gate: {
            conditions: [
              { type: 'has_label', label: 'pr-merged' },
              { type: 'has_label', label: 'release-ok' },
            ],
          },
        },
        { id: 'done', name: 'Done', kind: 'done', owners: [], columnId: 'done' },
      ],
      labels: [
        {
          id: 'code-review-ok',
          name: 'Code review ok',
          group: 'code-review',
          setBy: { duties: ['code_review'] },
          notByAuthor: true,
          clearedWhen: ['moved_back', 'pr_updated'],
        },
        {
          id: 'code-review-changes',
          name: 'Code review: changes',
          group: 'code-review',
          setBy: { duties: ['code_review'] },
          notByAuthor: true,
          requiresComment: true,
          notifyAssignee: true,
        },
        { id: 'pr-merged', name: 'PR merged', setBy: 'system' },
        {
          id: 'merge-ok',
          name: 'Merge approved',
          setBy: { members: [input.owner.handle], humansOnly: true },
          clearedWhen: ['moved_back'],
        },
        {
          id: 'release-ok',
          name: 'Release approved',
          setBy: { duties: ['release_approval'], humansOnly: true },
          clearedWhen: ['moved_back'],
        },
        { id: 'waiting', name: 'Waiting for an answer', blocks: true },
      ],
    },
  };
}

export function testConfig(overrides: Partial<BuildTemplateInput> = {}): ProjectConfig {
  return ProjectConfig.parse(
    testConfigInput({
      key: 'AR',
      name: 'acme',
      workspacePath: '/tmp/acme',
      language: 'en',
      owner: { handle: 'owner', displayName: 'Owner', email: 'owner@example.com' },
      ...overrides,
    }),
  );
}

/**
 * A project whose gates do not wait for a system label (`pr-merged`): without a GitHub
 * repository nothing sets it, and a gate nothing can pass does not save (`gate_unreachable`).
 */
export function dropSystemLabelGates(config: ProjectConfig): void {
  const system = new Set(config.pipeline.labels.filter((label) => label.setBy === 'system').map((l) => l.id));
  for (const stage of config.pipeline.stages)
    if (stage.gate)
      stage.gate.conditions = stage.gate.conditions.filter(
        (condition) => !(condition.type === 'has_label' && system.has(condition.label)),
      );
}

/** The first repository is local-only: no GitHub, and so no pull request gate. */
export function makeLocalOnly(config: ProjectConfig): void {
  delete config.project.repos[0]!.github;
  dropSystemLabelGates(config);
}

/** A project without any repository, and so without a pull request gate. */
export function makeRepoless(config: ProjectConfig): void {
  config.project.repos = [];
  dropSystemLabelGates(config);
}

export const testTemplate: ProjectTemplate = {
  id: 'test',
  nameKey: 'templates.test.name',
  descriptionKey: 'templates.test.description',
  checklist: [],
  build: (input) => ProjectConfig.parse(testConfigInput(input)),
};

/** The test template with its project manager on duty from creation (the checklist notice goes to it). */
export const testTemplateWithActivePm: ProjectTemplate = {
  ...testTemplate,
  build: (input) => {
    const config = ProjectConfig.parse(testConfigInput(input));
    for (const member of config.team.members)
      if (member.handle === 'pm' && member.kind === 'ai') member.onLeave = false;
    return config;
  },
};
