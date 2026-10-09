import { AiMemberConfig, DEFAULT_PROVIDER_MODELS, isProjectManager } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { projectManagerMember } from './index';

describe('projectManagerMember', () => {
  it('is a valid AI project manager with the starting values of a new member', () => {
    const member = projectManagerMember({ language: 'en', sponsor: 'owner', taken: ['owner'] });
    expect(AiMemberConfig.safeParse(member).success).toBe(true);
    expect(isProjectManager(member)).toBe(true);
    expect(member).toMatchObject({
      kind: 'ai',
      handle: 'pm',
      displayName: 'Project manager',
      role: 'project_manager',
      model: DEFAULT_PROVIDER_MODELS.claude,
      capacity: 1,
      sponsor: 'owner',
      temp: false,
    });
    expect(member.onLeave).toBeUndefined();
  });

  it('is named in the project language', () => {
    expect(projectManagerMember({ language: 'hu', sponsor: 'owner', taken: [] }).displayName).toBe(
      'Projektmenedzser',
    );
  });

  it('takes the first free handle when pm is taken', () => {
    const handle = (taken: string[]) => projectManagerMember({ language: 'en', sponsor: 'o', taken }).handle;
    expect(handle(['pm'])).toBe('pm-2');
    expect(handle(['pm', 'pm-2'])).toBe('pm-3');
    expect(handle(['pm-2'])).toBe('pm');
  });
});
