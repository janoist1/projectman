import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_ROLE_IDS, CustomRoleDefinition } from '@projectman/shared';
import type { AiMemberConfig, HumanMemberConfig } from '@projectman/shared';
import { aiRoleDefaults, en, hu } from '@projectman/templates';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import type { DomainHarness } from './helpers/domain-harness';

const by = { actor: OWNER_ACTOR, author: OWNER };
const sponsor = { ...by, sponsor: 'owner' };

const dataSteward = CustomRoleDefinition.parse({
  id: 'data_steward',
  name: 'Data steward',
  summary: 'Keeps the reference data clean.',
  notTheirJob: 'Does not change the schema.',
  holders: 'both',
  instructions: 'Check the reference data every morning and report duplicates.',
});

describe('role catalogue', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
  });
  afterEach(() => h.cleanup());

  async function member(handle: string) {
    const config = await h.domain.projects.config('AR');
    return config.team.members.find((m) => m.handle === handle);
  }

  it('lists the built-in roles in the project language, then the custom roles', async () => {
    await h.domain.roles.create('AR', dataSteward, by);
    const { roles } = await h.domain.roles.list('AR');

    expect(roles.map((r) => r.id)).toEqual([...BUILT_IN_ROLE_IDS, 'data_steward']);
    expect(roles[0]).toMatchObject({ id: 'operator', ...hu.roles.operator, holders: 'human', builtIn: true });
    expect(roles.find((r) => r.id === 'watchdog')).toMatchObject({ holders: 'both', builtIn: true });
    expect(roles.at(-1)).toMatchObject({
      id: 'data_steward',
      name: 'Data steward',
      summary: 'Keeps the reference data clean.',
      notTheirJob: 'Does not change the schema.',
      holders: 'both',
      builtIn: false,
    });
  });

  it('falls back to English texts for a language without a locale', async () => {
    await h.domain.projects.update('AR', by, (draft) => {
      draft.project.language = 'de';
      return 'Switch to German';
    });
    const { roles } = await h.domain.roles.list('AR');
    expect(roles.find((r) => r.id === 'code_review')).toMatchObject(en.roles.code_review);
  });

  it('stores custom roles in the customization repository as commits', async () => {
    const created = await h.domain.roles.create('AR', dataSteward, by);
    expect(created).toMatchObject({ id: 'data_steward', builtIn: false });
    const teamYaml = readFileSync(join(h.configStore.rootDir, 'projects/AR/team.yaml'), 'utf8');
    expect(teamYaml).toContain('id: data_steward');
    expect(teamYaml).toContain('holders: both');
    expect((await h.domain.projects.history('AR', 1))[0]!.message).toBe('Add role data_steward');

    const updated = await h.domain.roles.update(
      'AR',
      'data_steward',
      { ...dataSteward, summary: 'Keeps the reference and master data clean.' },
      by,
    );
    expect(updated.summary).toBe('Keeps the reference and master data clean.');
    expect((await h.domain.projects.history('AR', 1))[0]!.message).toBe('Update role data_steward');

    await h.domain.roles.remove('AR', 'data_steward', by);
    expect((await h.domain.projects.config('AR')).team.roles).toEqual([]);
    expect((await h.domain.projects.history('AR', 1))[0]!.message).toBe('Remove role data_steward');
  });

  it('refuses custom roles that clash with built-in or existing roles', async () => {
    const shadow = await rejection(h.domain.roles.create('AR', { ...dataSteward, id: 'qa' }, by));
    expect([shadow.code, shadow.status]).toEqual(['custom_role_shadows_builtin', 409]);
    await h.domain.roles.create('AR', dataSteward, by);
    const duplicate = await rejection(h.domain.roles.create('AR', dataSteward, by));
    expect([duplicate.code, duplicate.status]).toEqual(['duplicate_role', 409]);

    const mismatch = await rejection(h.domain.roles.update('AR', 'other_role', dataSteward, by));
    expect(mismatch.code).toBe('role_id_mismatch');
    const builtIn = await rejection(h.domain.roles.update('AR', 'qa', { ...dataSteward, id: 'qa' }, by));
    expect(builtIn.code).toBe('builtin_role');
    const missing = await rejection(
      h.domain.roles.update('AR', 'nobody_has', { ...dataSteward, id: 'nobody_has' }, by),
    );
    expect(missing.status).toBe(404);
    expect((await rejection(h.domain.roles.remove('AR', 'developer', by))).code).toBe('builtin_role');
    expect((await rejection(h.domain.roles.remove('AR', 'nobody_has', by))).status).toBe(404);
  });

  it('keeps a custom role while anyone holds it', async () => {
    await h.domain.roles.create('AR', dataSteward, by);
    await h.domain.members.hire('AR', { role: 'data_steward' }, sponsor);
    await h.domain.members.update('AR', 'owner', { roles: ['operator', 'data_steward'] }, by);

    const inUse = await rejection(h.domain.roles.remove('AR', 'data_steward', by));
    expect([inUse.code, inUse.status]).toEqual(['role_in_use', 409]);
    expect(inUse.details).toEqual({ members: ['owner', 'data-steward'], tempWorkers: false });

    const humansOnly = await rejection(
      h.domain.roles.update('AR', 'data_steward', { ...dataSteward, holders: 'human' }, by),
    );
    expect(humansOnly.code).toBe('role_in_use');
    expect(humansOnly.details).toEqual({ members: ['data-steward'], tempWorkers: false });

    await h.domain.members.retire('AR', 'data-steward', {}, by);
    await h.domain.members.update('AR', 'owner', { roles: ['operator'] }, by);
    await h.domain.projects.update('AR', by, (draft) => {
      draft.team.limits.tempWorkers.role = 'data_steward';
      return 'Temp workers are data stewards';
    });
    const temp = await rejection(h.domain.roles.remove('AR', 'data_steward', by));
    expect(temp.details).toEqual({ members: [], tempWorkers: true });
  });

  it('hires AI members for built-in and custom roles, never for roles only humans hold', async () => {
    const architect = await h.domain.members.hire('AR', { role: 'architect' }, sponsor);
    expect(architect).toMatchObject({
      handle: 'architect',
      displayName: hu.roles.architect.name,
      role: 'architect',
      ...aiRoleDefaults('architect'),
    });

    await h.domain.roles.create('AR', dataSteward, by);
    const schedule = { cron: '0 7 * * 1-5', prompt: 'Check the reference data.' };
    const steward = await h.domain.members.hire('AR', { role: 'data_steward', schedule }, sponsor);
    expect(steward).toMatchObject({
      handle: 'data-steward',
      displayName: 'Data steward',
      role: 'data_steward',
      instructions: '',
      model: 'opus',
      permissionMode: 'default',
      capacity: 1,
      schedule,
    });
    const second = await h.domain.members.hire('AR', { role: 'data_steward' }, sponsor);
    expect([second.handle, second.displayName]).toEqual(['data-steward-2', 'Data steward 2']);

    const human = await rejection(h.domain.members.hire('AR', { role: 'product_owner' }, sponsor));
    expect([human.code, human.status]).toEqual(['role_not_for_ai', 400]);
    const unknown = await rejection(h.domain.members.hire('AR', { role: 'scheduled' }, sponsor));
    expect(unknown.code).toBe('unknown_role');
    await h.domain.roles.create('AR', { ...dataSteward, id: 'client_lead', holders: 'human' }, by);
    expect((await rejection(h.domain.members.hire('AR', { role: 'client_lead' }, sponsor))).code).toBe(
      'role_not_for_ai',
    );
  });

  it('lets humans hold several roles, validated against who may hold them', async () => {
    const view = await h.domain.members.update(
      'AR',
      'owner',
      { roles: ['operator', 'product_owner', 'qa', 'qa'] },
      by,
    );
    expect(view).toMatchObject({ handle: 'owner', kind: 'human', role: 'owner' });
    expect(view.roles).toEqual(['operator', 'product_owner', 'qa']);
    expect(((await member('owner')) as HumanMemberConfig).roles).toEqual(['operator', 'product_owner', 'qa']);

    await h.domain.members.update('AR', 'owner', { roles: ['watchdog'] }, by);
    expect(await member('owner')).toMatchObject({ roles: ['watchdog'] });
    expect((await rejection(h.domain.members.update('AR', 'owner', { roles: ['nope'] }, by))).code).toBe(
      'unknown_role',
    );
    expect((await rejection(h.domain.members.update('AR', 'owner', { model: 'sonnet' }, by))).code).toBe(
      'not_ai_member',
    );
    expect((await rejection(h.domain.members.update('AR', 'nobody', { displayName: 'X' }, by))).status).toBe(
      404,
    );
  });

  it('changes an AI member but never its one role', async () => {
    const schedule = { cron: '30 9 * * 1', prompt: 'Weekly dependency round.' };
    const view = await h.domain.members.update(
      'AR',
      'dev-1',
      { displayName: 'Anna Dev', specialty: 'Frontend', model: 'sonnet', schedule },
      by,
    );
    expect(view).toMatchObject({ displayName: 'Anna Dev', specialty: 'Frontend', roles: ['developer'] });
    expect(await member('dev-1')).toMatchObject({ model: 'sonnet', schedule, specialty: 'Frontend' });
    expect((await h.domain.projects.history('AR', 1))[0]!.message).toBe(
      'Update dev-1: specialty, model, schedule, display name',
    );

    await h.domain.members.update('AR', 'dev-1', { specialty: ' ', schedule: null }, by);
    const cleared = (await member('dev-1')) as AiMemberConfig;
    expect(cleared.specialty).toBeUndefined();
    expect(cleared.schedule).toBeUndefined();

    const roles = await rejection(h.domain.members.update('AR', 'dev-1', { roles: ['qa'] }, by));
    expect(roles.code).toBe('not_human_member');
  });

  it('hires temp workers for the role the limits name', async () => {
    await h.domain.roles.create(
      'AR',
      { ...dataSteward, id: 'fullstack', name: 'Fullstack', holders: 'ai' },
      by,
    );
    await h.domain.projects.update('AR', by, (draft) => {
      draft.team.limits.tempWorkers = { enabled: true, max: 1, role: 'fullstack' };
      return 'Enable fullstack temp workers';
    });
    for (const title of ['One', 'Two', 'Three']) {
      await h.domain.tasks.create('AR', { title }, OWNER_ACTOR);
    }
    await h.domain.taskStarts.start('AR', 'AR-1', by);
    await h.domain.taskStarts.start('AR', 'AR-2', by);
    const started = await h.domain.taskStarts.start('AR', 'AR-3', by);

    expect(started.hired).toMatchObject({ handle: 'fullstack', role: 'fullstack', temp: true });
    expect(started.task.assignee).toBe('fullstack');
    const roster = await h.domain.members.roster('AR');
    expect(roster.find((m) => m.handle === 'fullstack')).toMatchObject({ roles: ['fullstack'], temp: true });
  });
});
