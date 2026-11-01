import { describe, expect, it } from 'vitest';
import { cardStateProblem, cardStateSpace } from '@projectman/shared';
import { templates } from './index';

/** Every open card of every template's configuration has an owner or a stated reason to wait (PM-1224). */
describe('the card duty of a template', () => {
  it.each(templates.map((template) => [template.id, template] as const))(
    '%s leaves no open card without an owner or a stated reason',
    (_id, template) => {
      const config = template.build({
        key: 'AR',
        name: 'Sample project',
        workspacePath: '/work/sample',
        language: 'en',
        owner: { handle: 'owner', displayName: 'Anna Example', email: 'anna@example.com' },
      });
      const problems: string[] = [];
      for (const state of cardStateSpace(config)) {
        const problem = cardStateProblem(state);
        if (problem && problems.length < 10) problems.push(problem);
      }
      expect(problems).toEqual([]);
    },
    60_000,
  );
});
