import { describe, expect, it } from 'vitest';
import { ProjectConfig } from './schema';
import { storedTeamDefaults, TEAM_SETTING_KEYS, TEAM_SETTING_POLICY } from './team-settings';

describe('TEAM_SETTING_POLICY', () => {
  it('classifies every team setting of the schema', () => {
    expect([...TEAM_SETTING_KEYS].sort()).toEqual(Object.keys(ProjectConfig.shape.team.shape).sort());
  });

  it('parses every default as its setting', () => {
    for (const key of TEAM_SETTING_KEYS) {
      const policy = TEAM_SETTING_POLICY[key];
      if (!('default' in policy)) continue;
      expect(ProjectConfig.shape.team.shape[key].safeParse(policy.default).success, key).toBe(true);
    }
  });

  it('hands out fresh copies of the stored defaults', () => {
    const first = storedTeamDefaults();
    first.prioritySetters?.push('prioritization_duty');
    expect(storedTeamDefaults().prioritySetters).toEqual(TEAM_SETTING_POLICY.prioritySetters.default);
  });
});
