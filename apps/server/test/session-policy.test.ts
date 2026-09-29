import { describe, expect, it } from 'vitest';
import { AI_BUILT_IN_ROLE_IDS, BUILT_IN_ROLE_IDS } from '@projectman/shared';
import { aiRoleDefaults } from '@projectman/templates';
import {
  allowedToolsFor,
  READ_ONLY_REVIEW_TOOLS,
  ROLE_SESSION_POLICIES,
  TEAM_TOOLS_ALLOWED,
  usesWorktree,
  WORKTREE_ROLES,
} from '../src/domain';

describe('role session policy', () => {
  it('pre-approves list_tasks alongside get_task for every AI role', () => {
    for (const role of [...AI_BUILT_IN_ROLE_IDS, 'data_steward']) {
      expect(allowedToolsFor(role)).toContain('mcp__team__*');
    }
  });

  it('covers every built-in role', () => {
    expect(Object.keys(ROLE_SESSION_POLICIES).sort()).toEqual([...BUILT_IN_ROLE_IDS].sort());
  });

  it('pre-approves the read-only tools for review and research roles', () => {
    const readers = BUILT_IN_ROLE_IDS.filter((role) => ROLE_SESSION_POLICIES[role].readOnlyTools);
    expect(readers).toContain('code_review');
    expect(readers).toContain('devops');
    expect(allowedToolsFor('architect')).toEqual([...TEAM_TOOLS_ALLOWED, ...READ_ONLY_REVIEW_TOOLS]);
    expect(allowedToolsFor('developer')).toEqual(TEAM_TOOLS_ALLOWED);
  });

  it('runs the roles that change files in the task worktree, with edits accepted', () => {
    expect([...WORKTREE_ROLES].sort()).toEqual(
      ['content', 'designer', 'developer', 'docs', 'maintainer', 'translator'].sort(),
    );
    for (const role of AI_BUILT_IN_ROLE_IDS) {
      expect(aiRoleDefaults(role).permissionMode === 'acceptEdits', role).toBe(WORKTREE_ROLES.has(role));
      // Nobody both changes files and gets the review tools pre-approved.
      expect(ROLE_SESSION_POLICIES[role].readOnlyTools && usesWorktree(role), role).toBe(false);
    }
  });

  it('gives custom roles the team tools only, in the workspace', () => {
    expect(allowedToolsFor('data_steward')).toEqual(TEAM_TOOLS_ALLOWED);
    expect(usesWorktree('data_steward')).toBe(false);
  });
});
