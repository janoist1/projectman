import { describe, expect, it } from 'vitest';
import { AiMemberConfig, AiRole, MemberHandle } from '@projectman/shared';
import {
  aiRoleDefaults,
  defaultMemberHandle,
  defaultMemberName,
  en,
  getLocale,
  hu,
  uniqueHandle,
  type TemplateLocale,
} from './index';

/** Letters that only appear in Hungarian text (role instructions must be English). */
const HUNGARIAN_LETTERS = /[áéíóöőúüű]/i;

describe('aiRoleDefaults', () => {
  it.each(AiRole.options)('gives %s valid defaults and English instructions', (role) => {
    const defaults = aiRoleDefaults(role);
    const member = AiMemberConfig.parse({
      kind: 'ai',
      handle: 'member',
      displayName: 'Member',
      role,
      sponsor: 'owner',
      ...defaults,
    });
    expect(member).toMatchObject(defaults);
    expect(defaults.instructions.length).toBeGreaterThan(300);
    expect(defaults.instructions).not.toMatch(HUNGARIAN_LETTERS);
    expect(defaults.instructions).toContain("in the project's language");
    expect(defaults.instructions).toContain('save_memory');
    expect(defaults.instructions).toMatch(/secret/i);
    expect(defaults.instructions).not.toMatch(/\s$/);
  });

  it('tells developers how to hand over with the team tools', () => {
    const { instructions } = aiRoleDefaults('developer');
    for (const tool of ['link_pull_request', 'update_task', 'send_message', 'ask_human']) {
      expect(instructions).toContain(tool);
    }
    expect(instructions).toContain('Never merge your own pull request');
  });

  it.each(['code_review', 'security_review'] as const)('keeps %s read-only and records its check', (role) => {
    const { instructions, permissionMode } = aiRoleDefaults(role);
    expect(instructions).toContain('You never edit code, commit or push');
    expect(instructions).toContain(`Record the ${role} check with update_task`);
    expect(instructions).toContain('"Blocking" or "Not blocking", with file:line');
    expect(permissionMode).toBe('default');
  });

  it('releases to production only after an approved human decision', () => {
    const { instructions } = aiRoleDefaults('devops');
    expect(instructions).toContain('Release only a task that is in your release stage');
    expect(instructions).toContain('needs an explicit human decision');
  });

  it('keeps communication to drafts that a human sends', () => {
    const { instructions } = aiRoleDefaults('communication');
    expect(instructions).toContain('drafts until a human approves them');
    expect(instructions).toContain('record the client_test check');
  });

  it('lets only members who edit their own worktree accept edits', () => {
    const acceptEdits = AiRole.options.filter(
      (role) => aiRoleDefaults(role).permissionMode === 'acceptEdits',
    );
    expect(acceptEdits).toEqual(['developer', 'docs']);
  });

  it('returns a fresh copy', () => {
    const defaults = aiRoleDefaults('qa');
    defaults.capacity = 5;
    expect(aiRoleDefaults('qa').capacity).toBe(1);
  });
});

describe('defaultMemberName', () => {
  it('names members after their role in the project language', () => {
    expect(defaultMemberName('developer', 'en', 1)).toBe('Developer');
    expect(defaultMemberName('developer', 'en', 2)).toBe('Developer 2');
    expect(defaultMemberName('code_review', 'en', 1)).toBe('Code reviewer');
    expect(defaultMemberName('developer', 'hu', 1)).toBe(hu.roles.developer);
    expect(defaultMemberName('devops', 'hu-HU', 3)).toBe(`${hu.roles.devops} 3`);
    expect(defaultMemberName('qa', 'de', 1)).toBe(en.roles.qa);
  });

  it('puts the specialty in front of the role', () => {
    expect(defaultMemberName('developer', 'en', 1, 'Frontend')).toBe('Frontend developer');
    expect(defaultMemberName('developer', 'en', 2, 'Backend')).toBe('Backend developer 2');
    expect(defaultMemberName('qa', 'en', 1, 'Mobile')).toBe('Mobile QA');
    expect(defaultMemberName('devops', 'en', 1, 'Cloud')).toBe('Cloud DevOps');
    expect(defaultMemberName('developer', 'hu', 1, hu.specialties.frontend)).toBe(
      hu.specialist(hu.specialties.frontend, hu.roles.developer),
    );
    expect(defaultMemberName('developer', 'en', 1, '  ')).toBe('Developer');
  });
});

describe('defaultMemberHandle', () => {
  it('numbers developers by specialty', () => {
    expect(defaultMemberHandle('developer', [])).toBe('dev-1');
    expect(defaultMemberHandle('developer', ['dev-1', 'dev-3'])).toBe('dev-2');
    expect(defaultMemberHandle('developer', [], 'frontend')).toBe('fe-1');
    expect(defaultMemberHandle('developer', ['fe-1'], 'Frontend')).toBe('fe-2');
    expect(defaultMemberHandle('developer', [], 'backend')).toBe('be-1');
    expect(defaultMemberHandle('developer', [], 'Mobile')).toBe('dev-1');
  });

  it('gives standing roles a readable handle and suffixes it when taken', () => {
    expect(defaultMemberHandle('code_review', [])).toBe('code-review');
    expect(defaultMemberHandle('qa', ['qa'])).toBe('qa-2');
    expect(defaultMemberHandle('qa', ['qa', 'qa-2'])).toBe('qa-3');
    for (const role of AiRole.options) {
      expect(MemberHandle.safeParse(defaultMemberHandle(role, [])).success).toBe(true);
    }
  });

  it('keeps free handles as they are', () => {
    expect(uniqueHandle('devops', new Set(['owner']))).toBe('devops');
  });
});

describe('locales', () => {
  it('picks the locale by primary language subtag and falls back to English', () => {
    expect(getLocale('hu')).toBe(hu);
    expect(getLocale('HU_hu')).toBe(hu);
    expect(getLocale('en-GB')).toBe(en);
    expect(getLocale('fr')).toBe(en);
    expect(getLocale('')).toBe(en);
  });

  it.each([
    ['en', en],
    ['hu', hu],
  ] as const)('%s has a non-empty name for every key', (_language, locale: TemplateLocale) => {
    const texts = [
      ...Object.values(locale.columns).flatMap((c) => [c.name, c.hint]),
      ...Object.values(locale.stages),
      ...Object.values(locale.roles),
      ...Object.values(locale.specialties),
      ...Object.values(locale.templates).flatMap((t) => [t.name, t.description]),
    ];
    for (const text of texts) expect(text.trim()).not.toBe('');
    expect(Object.keys(locale.roles).sort()).toEqual([...AiRole.options].sort());
  });

  it('has the same keys in every locale', () => {
    const keys = (locale: TemplateLocale) => ({
      columns: Object.keys(locale.columns).sort(),
      stages: Object.keys(locale.stages).sort(),
      specialties: Object.keys(locale.specialties).sort(),
      templates: Object.keys(locale.templates).sort(),
    });
    expect(keys(hu)).toEqual(keys(en));
  });
});
