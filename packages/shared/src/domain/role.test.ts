import { describe, expect, it } from 'vitest';
import { RoleView } from '../api/dto';
import { CustomRoleDefinition, RoleOverrides } from './role';

const steward = {
  id: 'data_steward',
  name: 'Data steward',
  summary: 'Keeps the reference data clean.',
  holders: 'both',
};

describe('role texts', () => {
  it('lets a custom role say when to turn to it, and keeps older roles without it', () => {
    expect(CustomRoleDefinition.parse({ ...steward, whenToAsk: 'When data looks wrong.' }).whenToAsk).toBe(
      'When data looks wrong.',
    );
    expect(CustomRoleDefinition.parse(steward).whenToAsk).toBeUndefined();
    expect(CustomRoleDefinition.safeParse({ ...steward, whenToAsk: 'x'.repeat(281) }).success).toBe(false);
  });

  it('lets a project rewrite the texts of a built-in role, each one optional', () => {
    const overrides = RoleOverrides.parse({
      qa: { duties: ['testing_acceptance'], whenToAsk: 'When a feature is ready to try.' },
      devops: { duties: ['deployment'], summary: 'Deploys.', notTheirJob: 'Does not build features.' },
    });
    expect(overrides.qa).toEqual({
      duties: ['testing_acceptance'],
      instructions: '',
      whenToAsk: 'When a feature is ready to try.',
    });
    expect(overrides.devops?.whenToAsk).toBeUndefined();
    expect(RoleOverrides.safeParse({ qa: { duties: [], notTheirJob: 'x'.repeat(201) } }).success).toBe(false);
  });

  it('reads role views from older servers without the text', () => {
    const view = RoleView.parse({ ...steward, notTheirJob: '', builtIn: false });
    expect(view.whenToAsk).toBeUndefined();
  });
});
