import { describe, expect, it } from 'vitest';
import type { RoleView } from '@projectman/shared';
import { builtInRoles } from '../mocks/fixtures';
import { aiRoleView, hireableRoles, humanRoleName, roleView } from './roles';

const custom: RoleView = {
  id: 'data_steward',
  name: 'Acme data steward',
  summary: 'Keeps reference data clean.',
  notTheirJob: 'Does not change schemas.',
  holders: 'both',
  builtIn: false,
};

describe('role data mapping', () => {
  it('uses catalogue names and summaries, including developer specialties', () => {
    const role = {
      ...builtInRoles.find((entry) => entry.id === 'developer')!,
      name: 'Project developer',
      summary: 'Project summary',
    };
    expect(roleView(role, 'Frontend')).toMatchObject({
      name: 'Project developer',
      summary: 'Project summary',
      tone: 'frontend',
      icon: 'branch',
    });
    expect(aiRoleView(role.id, 'Backend', [role])).toMatchObject({ name: role.name, tone: 'backend' });
  });
  it('retains built-in visuals and gives custom roles neutral visuals', () => {
    expect(roleView(builtInRoles.find((role) => role.id === 'qa')!)).toMatchObject({
      tone: 'qa',
      icon: 'flask',
    });
    expect(roleView(custom)).toMatchObject({ ...custom, tone: 'system', icon: 'sparkle' });
    expect(humanRoleName('owner')).toBe('Tulajdonos');
  });
  it('gives the operator a quiet tone, not the filled owner one that reads as a button (PM-240)', () => {
    const operator = builtInRoles.find((role) => role.id === 'operator')!;
    expect(roleView(operator).tone).not.toBe('owner');
    expect(roleView(operator).tone).toBe('human');
  });
  it('offers AI and both holders in catalogue order, including custom roles', () => {
    expect(
      hireableRoles([...builtInRoles, custom, { ...custom, id: 'human_lead', holders: 'human' }]).map(
        (role) => role.id,
      ),
    ).toEqual([...builtInRoles.filter((role) => role.holders !== 'human').map((role) => role.id), custom.id]);
  });
});
