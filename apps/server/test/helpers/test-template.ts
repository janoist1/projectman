import { ProjectConfig } from '@projectman/shared';
import type { ProjectConfigInput } from '@projectman/shared';
import type { BuildTemplateInput, ProjectTemplate } from '@projectman/templates';

/**
 * A small team and pipeline used by the tests:
 *   backlog (queue) -> development (work) -> code_review (review)
 *   -> merge (gate: labels code-review-ok + merge-ok, an owner approval)
 *   -> release (gate: labels pr-merged + release-ok, an owner approval) -> done
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
      members: [
        {
          kind: 'human',
          handle: input.owner.handle,
          displayName: input.owner.displayName,
          access: 'owner',
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
        { id: 'code_review', name: 'Code review', kind: 'review', owners: ['cr'], columnId: 'review' },
        {
          id: 'merge',
          name: 'Merge',
          kind: 'merge',
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
          clearedWhen: ['moved_back'],
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
          setBy: { members: [input.owner.handle], humansOnly: true },
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

export const testTemplate: ProjectTemplate = {
  id: 'test',
  nameKey: 'templates.test.name',
  descriptionKey: 'templates.test.description',
  build: (input) => ProjectConfig.parse(testConfigInput(input)),
};
