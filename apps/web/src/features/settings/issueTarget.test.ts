import { describe, expect, it } from 'vitest';
import { MockBackend } from '../../mocks/backend';
import { issueTarget } from './issueTarget';

describe('configuration issue targets', () => {
  const config = new MockBackend().config;
  it.each(['pipeline.stages.3.gate.conditions.0.label', 'pipeline.stages[3].gate.conditions[0].label'])(
    'normalizes %s',
    (path) => {
      expect(issueTarget(path, config)).toEqual({
        section: 'pipeline',
        show: { type: 'stage', id: config.pipeline.stages[3]!.id },
        field: 'gate.conditions.0.label',
      });
    },
  );
  it.each(['stages', 'columns', 'labels'] as const)('looks up %s by index in both formats', (collection) => {
    const expected = {
      section: collection === 'labels' ? 'labels' : 'pipeline',
      show: {
        type: collection === 'stages' ? 'stage' : collection === 'columns' ? 'column' : 'label',
        id: config.pipeline[collection][0]!.id,
      },
      field: 'name',
    };
    expect(issueTarget(`pipeline.${collection}.0.name`, config)).toEqual(expected);
    expect(issueTarget(`pipeline.${collection}[0].name`, config)).toEqual(expected);
  });
  it.each([
    ['team.members[0].role', 'team'],
    ['team.roles.0', 'duties'],
    ['team.roleOverrides.developer', 'duties'],
    ['team.releaseFourEyes', 'duties'],
    ['team.boundary.enabled', 'duties'],
    ['team', 'duties'],
    ['team.limits.aiEnabled', 'limits'],
    ['project.repos[0].name', 'repos'],
    ['project.name', 'project'],
    ['pipeline', 'pipeline'],
    ['pipeline.labels', 'pipeline'],
    ['pipeline.stages[999].name', 'pipeline'],
  ])('maps %s to %s', (path, section) => expect(issueTarget(path, config)?.section).toBe(section));
  it.each(['unknown', 'teamwork', 'projector', 'pipelines'])('leaves unrelated path %s untargeted', (path) =>
    expect(issueTarget(path, config)).toBeNull(),
  );
});
