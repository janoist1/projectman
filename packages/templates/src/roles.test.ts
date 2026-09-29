import { describe, expect, it } from 'vitest';
import {
  AI_BUILT_IN_ROLE_IDS,
  DUTY_IDS,
  DUTIES,
  AiMemberConfig,
  BUILT_IN_ROLE_IDS,
  CustomRoleDefinition,
  MemberHandle,
} from '@projectman/shared';
import {
  aiMemberDefaults,
  aiRoleDefaults,
  CUSTOM_ROLE_DEFAULTS,
  defaultMemberHandle,
  defaultMemberName,
  en,
  getLocale,
  hu,
  roleHandleStem,
  roleName,
  uniqueHandle,
  type TemplateLocale,
} from './index';

/** Accented letters of Hungarian text (role instructions must be English). Code points keep this file ASCII. */
const HUNGARIAN_LETTERS = new RegExp(
  `[${[0xe1, 0xe9, 0xed, 0xf3, 0xf6, 0x151, 0xfa, 0xfc, 0x171].map((c) => String.fromCodePoint(c)).join('')}]`,
  'i',
);

/** Roles whose members change files in a task's own worktree (see the server's session policy). */
const WORKTREE_ROLES = ['designer', 'developer', 'maintainer', 'content', 'translator', 'docs'];

const dataSteward = CustomRoleDefinition.parse({
  id: 'data_steward',
  name: 'Data steward',
  summary: 'Keeps the reference data clean.',
  holders: 'both',
  instructions: 'You keep the reference data clean. Write in the project language.',
});

describe('aiRoleDefaults', () => {
  it.each(AI_BUILT_IN_ROLE_IDS)('gives %s valid defaults without copied role prompts', (role) => {
    const defaults = aiRoleDefaults(role);
    expect(
      AiMemberConfig.parse({
        kind: 'ai',
        handle: 'member',
        displayName: 'Member',
        role,
        sponsor: 'owner',
        ...defaults,
      }),
    ).toMatchObject(defaults);
    expect(defaults.instructions).toBe('');
  });
  it('keeps editing defaults limited to delivery duties', () => {
    expect(
      AI_BUILT_IN_ROLE_IDS.filter((role) => aiRoleDefaults(role).permissionMode === 'acceptEdits').sort(),
    ).toEqual(WORKTREE_ROLES.sort());
  });
  it('returns a fresh copy', () => {
    const value = aiRoleDefaults('qa');
    value.capacity = 5;
    expect(aiRoleDefaults('qa').capacity).toBe(1);
  });
});

describe('aiMemberDefaults', () => {
  it('gives no AI defaults for roles only humans hold', () => {
    expect(BUILT_IN_ROLE_IDS.filter((role) => aiMemberDefaults(role) === null)).toEqual([
      'operator',
      'product_owner',
    ]);
    expect(aiMemberDefaults('qa')).toEqual(aiRoleDefaults('qa'));
  });

  it('gives members of a custom role the generic defaults and leaves the instructions to the role', () => {
    expect(aiMemberDefaults('data_steward', [dataSteward])).toEqual({
      instructions: '',
      model: 'opus',
      permissionMode: 'default',
      capacity: 1,
    });
    expect(aiMemberDefaults('data_steward', [dataSteward])).not.toBe(CUSTOM_ROLE_DEFAULTS);
    expect(aiMemberDefaults('data_steward')).toBeNull();
    expect(aiMemberDefaults('data_steward', [{ ...dataSteward, holders: 'human' }])).toBeNull();
    // A custom role cannot replace a built-in one.
    expect(aiMemberDefaults('operator', [{ ...dataSteward, id: 'operator' }])).toBeNull();
    expect(aiMemberDefaults('qa', [{ ...dataSteward, id: 'qa' }])).toEqual(aiRoleDefaults('qa'));
  });
});

describe('defaultMemberName', () => {
  it('names members after their role in the project language', () => {
    expect(defaultMemberName('developer', 'en', 1)).toBe('Developer');
    expect(defaultMemberName('developer', 'en', 2)).toBe('Developer 2');
    expect(defaultMemberName('code_review', 'en', 1)).toBe('Code reviewer');
    expect(defaultMemberName('business_analyst', 'en', 1)).toBe('Business analyst');
    expect(defaultMemberName('developer', 'hu', 1)).toBe(hu.roles.developer.name);
    expect(defaultMemberName('devops', 'hu-HU', 3)).toBe(`${hu.roles.devops.name} 3`);
    expect(defaultMemberName('qa', 'de', 1)).toBe(en.roles.qa.name);
  });

  it('puts the specialty in front of the role', () => {
    expect(defaultMemberName('developer', 'en', 1, { specialty: 'Frontend' })).toBe('Frontend developer');
    expect(defaultMemberName('developer', 'en', 2, { specialty: 'Backend' })).toBe('Backend developer 2');
    expect(defaultMemberName('qa', 'en', 1, { specialty: 'Mobile' })).toBe('Mobile QA');
    expect(defaultMemberName('devops', 'en', 1, { specialty: 'Cloud' })).toBe('Cloud DevOps');
    expect(defaultMemberName('developer', 'hu', 1, { specialty: hu.specialties.frontend })).toBe(
      hu.specialist(hu.specialties.frontend, hu.roles.developer.name),
    );
    expect(defaultMemberName('developer', 'en', 1, { specialty: '  ' })).toBe('Developer');
  });

  it('names members of a custom role after the role', () => {
    const customRoles = [dataSteward];
    expect(defaultMemberName('data_steward', 'hu', 1, { customRoles })).toBe('Data steward');
    expect(defaultMemberName('data_steward', 'en', 2, { customRoles })).toBe('Data steward 2');
    expect(roleName('data_steward', 'en')).toBe('data_steward');
    expect(roleName('watchdog', 'hu', customRoles)).toBe(hu.roles.watchdog.name);
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
    expect(defaultMemberHandle('project_manager', [])).toBe('pm');
    expect(defaultMemberHandle('business_analyst', [])).toBe('analyst');
    expect(defaultMemberHandle('qa', ['qa'])).toBe('qa-2');
    expect(defaultMemberHandle('qa', ['qa', 'qa-2'])).toBe('qa-3');
    const stems = BUILT_IN_ROLE_IDS.map((role) => defaultMemberHandle(role, []));
    for (const handle of stems) expect(MemberHandle.safeParse(handle).success, handle).toBe(true);
    expect(new Set(stems).size).toBe(stems.length);
  });

  it('derives the handle of a custom role from its id', () => {
    expect(defaultMemberHandle('data_steward', [])).toBe('data-steward');
    expect(defaultMemberHandle('data_steward', ['data-steward'])).toBe('data-steward-2');
    const long = `a${'_b'.repeat(19)}`;
    const handle = defaultMemberHandle(long, []);
    expect(roleHandleStem(long).length).toBeLessThanOrEqual(28);
    expect(handle.endsWith('-')).toBe(false);
    expect(MemberHandle.safeParse(uniqueHandle(handle, new Set([handle]))).success).toBe(true);
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
  ] as const)('%s has a text for every key and every built-in role', (_language, locale: TemplateLocale) => {
    const texts = [
      ...Object.values(locale.columns).flatMap((c) => [c.name, c.hint]),
      ...Object.values(locale.stages),
      ...Object.values(locale.roles).flatMap((r) => [r.name, r.summary, r.notTheirJob]),
      ...Object.values(locale.members),
      ...Object.values(locale.specialties),
      ...Object.values(locale.templates).flatMap((t) => [t.name, t.description]),
    ];
    for (const text of texts) expect(text.trim()).not.toBe('');
    expect(Object.keys(locale.roles)).toEqual([...BUILT_IN_ROLE_IDS]);
    for (const role of Object.values(locale.roles)) {
      expect(role.summary).toMatch(/\.$/);
      expect(role.notTheirJob).toMatch(/\.$/);
    }
    const names = Object.values(locale.roles).map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(() => new Intl.DateTimeFormat('en', { timeZone: locale.timezone })).not.toThrow();
  });

  it('writes the English role texts in English', () => {
    for (const role of Object.values(en.roles)) {
      expect(`${role.name} ${role.summary} ${role.notTheirJob}`).not.toMatch(HUNGARIAN_LETTERS);
    }
  });

  it('starts Hungarian projects in the Budapest time zone', () => {
    expect(hu.timezone).toBe('Europe/Budapest');
    expect(en.timezone).toBe('UTC');
  });

  it('has the same keys in every locale', () => {
    const keys = (locale: TemplateLocale) => ({
      columns: Object.keys(locale.columns).sort(),
      stages: Object.keys(locale.stages).sort(),
      roles: Object.keys(locale.roles).sort(),
      members: Object.keys(locale.members).sort(),
      specialties: Object.keys(locale.specialties).sort(),
      templates: Object.keys(locale.templates).sort(),
    });
    expect(keys(hu)).toEqual(keys(en));
  });
});

describe('duty catalogue texts', () => {
  it.each(DUTY_IDS)('localizes %s and keeps AI fragments in English', (id) => {
    for (const locale of [en, hu]) {
      expect(locale.duties[id].name).toBeTruthy();
      expect(locale.duties[id].description.split(/(?<=\.) /).length).toBeLessThanOrEqual(2);
    }
    if (DUTIES[id].holders !== 'human') expect(DUTIES[id].prompt.length).toBeGreaterThan(30);
    expect(DUTIES[id].prompt).not.toMatch(HUNGARIAN_LETTERS);
  });
});
