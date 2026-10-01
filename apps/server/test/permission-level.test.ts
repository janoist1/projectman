import { afterEach, describe, expect, it } from 'vitest';
import type { AiMemberConfig, ProjectConfig } from '@projectman/shared';
import { humanActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

const ADMIN = { name: 'Admin', email: 'admin@example.com' };
const ADMIN_ACTOR = humanActor('adm');

/** Delegation on, and the reviewer `cr` holds the boundary authorization duty. */
function withDecider(config: ProjectConfig) {
  config.team.boundary = { enabled: true, leadTimeoutSeconds: 120 };
  config.team.roles.push({
    id: 'custom_lead',
    name: 'Custom lead',
    summary: 'Authorize external operations',
    duties: ['boundary_authorization', 'code_review'],
    holders: 'both',
    instructions: '',
    notTheirJob: '',
  });
  const cr = config.team.members.find((m) => m.handle === 'cr')!;
  if (cr.kind === 'ai') cr.role = 'custom_lead';
}

function withAdmin(config: ProjectConfig) {
  config.team.members.push({
    kind: 'human',
    handle: 'adm',
    displayName: 'Admin',
    access: 'admin',
    email: ADMIN.email,
    roles: [],
  });
}

function aiMember(config: ProjectConfig, handle: string): AiMemberConfig {
  const member = config.team.members.find((m) => m.handle === handle);
  if (member?.kind !== 'ai') throw new Error(`no AI member ${handle}`);
  return member;
}

describe('the permission level of an AI member (PM-164)', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const owner = () => ({ actor: OWNER_ACTOR, author: OWNER });
  const admin = () => ({ actor: ADMIN_ACTOR, author: ADMIN });
  const view = async (handle: string) =>
    (await h.domain.members.roster('AR')).find((m) => m.handle === handle)!;
  const stored = async (handle: string) => aiMember(await h.domain.projects.config('AR'), handle);

  describe('on hiring', () => {
    it('is Auto for every role, and for a Codex member too', async () => {
      h = await createDomainHarness();
      const sponsor = { ...owner(), sponsor: 'owner' };
      for (const role of ['developer', 'architect', 'code_review', 'qa'] as const) {
        const hired = await h.domain.members.hire('AR', { role }, sponsor);
        expect(hired, role).toMatchObject({ permissionLevel: 'auto', permissionMode: 'auto' });
      }
      const codex = await h.domain.members.hire('AR', { role: 'developer', provider: 'codex' }, sponsor);
      expect(codex).toMatchObject({ permissionLevel: 'auto', permissionMode: 'auto' });
      expect(await view(codex.handle)).toMatchObject({ permissionLevel: 'auto' });
    });

    it('may be hired by an admin, who then cannot change the level', async () => {
      h = await createDomainHarness({ adjust: withAdmin });
      const hired = await h.domain.members.hire(
        'AR',
        { role: 'developer' },
        { ...admin(), sponsor: 'owner' },
      );
      expect(hired.permissionLevel).toBe('auto');
      await expect(
        h.domain.members.update('AR', hired.handle, { permissionLevel: 'plan' }, admin()),
      ).rejects.toMatchObject({ code: 'owner_only', status: 403 });
    });
  });

  describe('for members from before the level existed', () => {
    it('is derived from the historical mode, and never gives a freer mode', async () => {
      h = await createDomainHarness({
        adjust: (config) => {
          aiMember(config, 'dev-1').permissionMode = 'auto';
          aiMember(config, 'dev-2').permissionMode = 'plan';
          aiMember(config, 'cr').permissionMode = 'acceptEdits';
        },
      });
      expect(await view('dev-1')).toMatchObject({ permissionLevel: 'auto', permissionMode: 'auto' });
      expect(await view('dev-2')).toMatchObject({ permissionLevel: 'plan' });
      expect(await view('cr')).toMatchObject({ permissionLevel: 'ask_human' });
      // Nothing was written: the configuration still loads as it was.
      expect(await stored('dev-1')).not.toHaveProperty('permissionLevel');
    });

    it('shows a bypassPermissions member as a legacy setting that asks, until an owner sets a level', async () => {
      h = await createDomainHarness({
        adjust: (config) => void (aiMember(config, 'dev-1').permissionMode = 'bypassPermissions'),
      });
      const before = await view('dev-1');
      expect(before).toMatchObject({
        permissionLevel: 'ask_human',
        permissionMode: 'bypassPermissions',
        permissionLegacy: true,
      });
      const after = await h.domain.members.update('AR', 'dev-1', { permissionLevel: 'auto' }, owner());
      expect(after).toMatchObject({ permissionLevel: 'auto' });
      expect(after).not.toHaveProperty('permissionLegacy');
    });

    it('starts sessions in the historical mode until a level is set, then in the level', async () => {
      h = await createDomainHarness({
        adjust: (config) => void (aiMember(config, 'dev-1').permissionMode = 'acceptEdits'),
      });
      await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      expect(h.runner.lastStarted().permissionMode).toBe('acceptEdits');
      await h.domain.members.update('AR', 'dev-2', { permissionLevel: 'ask_human' }, owner());
      await h.domain.sessions.ensureSession('AR', 'dev-2', { type: 'general' });
      expect(h.runner.lastStarted().permissionMode).toBe('acceptEdits');
    });
  });

  describe('setting it', () => {
    it('is saved on the member by an owner, shown in the roster and used by the next session', async () => {
      h = await createDomainHarness();
      const updated = await h.domain.members.update('AR', 'dev-1', { permissionLevel: 'plan' }, owner());
      expect(updated).toMatchObject({ permissionLevel: 'plan' });
      expect(await stored('dev-1')).toMatchObject({ permissionLevel: 'plan' });
      await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      expect(h.runner.lastStarted().permissionMode).toBe('plan');
      await h.domain.members.update('AR', 'dev-1', { permissionLevel: 'ask_human' }, owner());
      expect(
        (await h.domain.projects.config('AR')).team.members.find((m) => m.handle === 'dev-1'),
      ).toMatchObject({
        permissionLevel: 'ask_human',
      });
    });

    it('is refused for an admin, and for changing it through the configuration', async () => {
      h = await createDomainHarness({ adjust: withAdmin });
      await expect(
        h.domain.members.update('AR', 'dev-1', { permissionLevel: 'plan' }, admin()),
      ).rejects.toMatchObject({ code: 'owner_only', status: 403 });
      await expect(
        h.domain.projects.update('AR', admin(), (draft) => {
          aiMember(draft, 'dev-1').permissionLevel = 'plan';
          return 'Change a level';
        }),
      ).rejects.toMatchObject({ code: 'owner_only', status: 403 });
      // The test template's members have no level: derived from their mode, and left as it was.
      expect(await view('dev-1')).toMatchObject({ permissionLevel: 'ask_human' });
      expect(await stored('dev-1')).not.toHaveProperty('permissionLevel');
    });

    it('lets an admin change what is not the level', async () => {
      h = await createDomainHarness({ adjust: withAdmin });
      await h.domain.members.update('AR', 'dev-1', { specialty: 'API' }, admin());
      expect(await stored('dev-1')).toMatchObject({ specialty: 'API' });
    });

    it('applies to AI members only', async () => {
      h = await createDomainHarness();
      await expect(
        h.domain.members.update('AR', 'owner', { permissionLevel: 'plan' }, owner()),
      ).rejects.toMatchObject({ code: 'not_ai_member' });
    });
  });

  describe('"ask, AI decides"', () => {
    it('cannot be chosen while delegation is off, and the roster says why', async () => {
      h = await createDomainHarness();
      expect(await view('dev-1')).toMatchObject({ askAiBlocker: 'delegation_off' });
      await expect(
        h.domain.members.update('AR', 'dev-1', { permissionLevel: 'ask_ai' }, owner()),
      ).rejects.toMatchObject({
        code: 'permission_level_unavailable',
        status: 400,
        details: { blocker: 'delegation_off' },
      });
      expect(await stored('dev-1')).not.toMatchObject({ permissionLevel: 'ask_ai' });
    });

    it('cannot be chosen while no AI member holds the authorization duty', async () => {
      h = await createDomainHarness({
        adjust: (config) => void (config.team.boundary = { enabled: true, leadTimeoutSeconds: 120 }),
      });
      expect(await view('dev-1')).toMatchObject({ askAiBlocker: 'no_ai_decider' });
      await expect(
        h.domain.members.update('AR', 'dev-1', { permissionLevel: 'ask_ai' }, owner()),
      ).rejects.toMatchObject({
        code: 'permission_level_unavailable',
        details: { blocker: 'no_ai_decider' },
      });
    });

    it('can be chosen with delegation on and an AI decider, which cannot decide for itself', async () => {
      h = await createDomainHarness({ adjust: withDecider });
      expect(await view('dev-1')).not.toHaveProperty('askAiBlocker');
      expect(await view('cr')).toMatchObject({ askAiBlocker: 'no_ai_decider' });
      expect(
        await h.domain.members.update('AR', 'dev-1', { permissionLevel: 'ask_ai' }, owner()),
      ).toMatchObject({
        permissionLevel: 'ask_ai',
      });
      await expect(
        h.domain.members.update('AR', 'cr', { permissionLevel: 'ask_ai' }, owner()),
      ).rejects.toMatchObject({ code: 'permission_level_unavailable' });
    });

    it('stays on the member when the decider drops out, and the roster then warns', async () => {
      h = await createDomainHarness({ adjust: withDecider });
      await h.domain.members.update('AR', 'dev-1', { permissionLevel: 'ask_ai' }, owner());
      await h.domain.members.update('AR', 'cr', { onLeave: true }, owner());
      expect(await view('dev-1')).toMatchObject({ permissionLevel: 'ask_ai', askAiBlocker: 'no_ai_decider' });
      await h.domain.members.update('AR', 'cr', { onLeave: false }, owner());
      expect(await view('dev-1')).not.toHaveProperty('askAiBlocker');
    });

    it('tells the clients when the blocker of another member changes', async () => {
      h = await createDomainHarness({ adjust: withDecider });
      const seen: Array<{ handle: string; blocker: string | undefined }> = [];
      h.domain.bus.subscribe((event) => {
        if (event.type === 'member_changed' && event.member)
          seen.push({ handle: event.handle, blocker: event.member.askAiBlocker });
      });
      await h.domain.members.update('AR', 'cr', { onLeave: true }, owner());
      expect(seen).toContainEqual({ handle: 'dev-1', blocker: 'no_ai_decider' });
    });
  });
});
