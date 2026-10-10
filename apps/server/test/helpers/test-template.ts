import { ProjectConfig } from '@projectman/shared';
import type { ProjectConfigInput } from '@projectman/shared';
import type { BuildTemplateInput, ProjectTemplate } from '@projectman/templates';

/**
 * A small team and pipeline used by the tests:
 *   backlog (queue) -> development (work) -> code_review (step)
 *   -> merge (gate: labels code-review-ok + merge-ok, an owner approval)
 *   -> release (gate: labels pr-merged + release-ok, a release approval the owner may give) -> done
 */
export function testConfigInput(input: BuildTemplateInput): ProjectConfigInput {
  return {
    schemaVersion: 1,
    project: {
      key: input.key,
      name: input.name,
      workspacePath: input.workspacePath,
      repos: [{ name: 'web', path: '.', github: 'acme/web' }],
      language: input.language,
      templateId: 'test',
    },
    team: {
      cardMover: input.cardMover ?? { kind: 'worker' },
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
        // Every project has an Operator (PM-447). It cannot go on leave (PM-473); only the owner's own
        // message wakes it, so it starts no session unless a test sends one.
        {
          kind: 'ai',
          handle: 'operator',
          displayName: 'Operator',
          role: 'ai_operator',
          sponsor: input.owner.handle,
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
  build: (input) => ProjectConfig.parse(testConfigInput(input)),
};
