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

describe('the permission mode and the approver of an AI member (PM-164)', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const owner = () => ({ actor: OWNER_ACTOR, author: OWNER });
  const admin = () => ({ actor: ADMIN_ACTOR, author: ADMIN });
  const view = async (handle: string) =>
    (await h.domain.members.roster('AR')).find((m) => m.handle === handle)!;
  const stored = async (handle: string) => aiMember(await h.domain.projects.config('AR'), handle);
  const set = (handle: string, body: Parameters<DomainHarness['domain']['members']['update']>[2]) =>
    h.domain.members.update('AR', handle, body, owner());

  describe('on hiring', () => {
    it('is Auto for every role, and for a Codex member too, with no approver written', async () => {
      h = await createDomainHarness();
      const sponsor = { ...owner(), sponsor: 'owner' };
      for (const role of ['developer', 'architect', 'code_review', 'qa'] as const) {
        const hired = await h.domain.members.hire('AR', { role }, sponsor);
        expect(hired, role).toMatchObject({ permissionMode: 'auto' });
        expect(hired, role).not.toHaveProperty('approver');
      }
      const codex = await h.domain.members.hire('AR', { role: 'developer', provider: 'codex' }, sponsor);
      expect(codex).toMatchObject({ permissionMode: 'auto' });
      expect(await view(codex.handle)).toMatchObject({ permissionMode: 'auto', approver: 'human' });
    });

    it('may be done by an admin, who then cannot change the mode', async () => {
      h = await createDomainHarness({ adjust: withAdmin });
      const hired = await h.domain.members.hire(
        'AR',
        { role: 'developer' },
        { ...admin(), sponsor: 'owner' },
      );
      expect(hired.permissionMode).toBe('auto');
      await expect(
        h.domain.members.update('AR', hired.handle, { permissionMode: 'plan' }, admin()),
      ).rejects.toMatchObject({ code: 'owner_only', status: 403 });
    });
  });

  describe('for members from before the approver existed', () => {
    it('keep their mode, are asked like a person, and nothing is written', async () => {
      h = await createDomainHarness({
        adjust: (config) => {
          aiMember(config, 'dev-1').permissionMode = 'auto';
          aiMember(config, 'dev-2').permissionMode = 'plan';
        },
      });
      expect(await view('dev-1')).toMatchObject({ permissionMode: 'auto', approver: 'human' });
      expect(await view('dev-2')).toMatchObject({ permissionMode: 'plan', approver: 'human' });
      expect(await view('cr')).toMatchObject({ permissionMode: 'default', approver: 'human' });
      expect(await stored('dev-1')).not.toHaveProperty('approver');
    });

    it('shows a bypassPermissions member as a legacy setting until an owner picks a mode', async () => {
      h = await createDomainHarness({
        adjust: (config) => void (aiMember(config, 'dev-1').permissionMode = 'bypassPermissions'),
      });
      expect(await view('dev-1')).toMatchObject({
        permissionMode: 'bypassPermissions',
        permissionLegacy: true,
      });
      const after = await set('dev-1', { permissionMode: 'auto' });
      expect(after).toMatchObject({ permissionMode: 'auto' });
      expect(after).not.toHaveProperty('permissionLegacy');
    });

    it('starts sessions in the stored mode, and in a new one after it is set', async () => {
      h = await createDomainHarness({
        adjust: (config) => void (aiMember(config, 'dev-1').permissionMode = 'acceptEdits'),
      });
      await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      expect(h.runner.lastStarted().permissionMode).toBe('acceptEdits');
      await set('dev-2', { permissionMode: 'plan' });
      await h.domain.sessions.ensureSession('AR', 'dev-2', { type: 'general' });
      expect(h.runner.lastStarted().permissionMode).toBe('plan');
    });
  });

  describe('setting them', () => {
    it('is saved on the member by an owner, shown in the roster and used by the next session', async () => {
      h = await createDomainHarness();
      const updated = await set('dev-1', { permissionMode: 'plan', approver: 'none' });
      expect(updated).toMatchObject({ permissionMode: 'plan', approver: 'none' });
      expect(await stored('dev-1')).toMatchObject({ permissionMode: 'plan', approver: 'none' });
      await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      expect(h.runner.lastStarted().permissionMode).toBe('plan');
    });

    it.each([
      ['mode', { permissionMode: 'plan' }],
      ['approver', { approver: 'none' }],
    ] as const)('refuses an admin to change the %s, also through the configuration', async (_what, body) => {
      h = await createDomainHarness({ adjust: withAdmin });
      await expect(h.domain.members.update('AR', 'dev-1', body, admin())).rejects.toMatchObject({
        code: 'owner_only',
        status: 403,
      });
      await expect(
        h.domain.projects.update('AR', admin(), (draft) => {
          Object.assign(aiMember(draft, 'dev-1'), body);
          return 'Change a permission';
        }),
      ).rejects.toMatchObject({ code: 'owner_only', status: 403 });
      expect(await stored('dev-1')).toMatchObject({ permissionMode: 'default' });
      expect(await stored('dev-1')).not.toHaveProperty('approver');
    });

    it.each(['bypassPermissions', 'acceptEdits', 'auto'] as const)(
      'refuses an admin who writes the mode %s into the configuration',
      async (mode) => {
        h = await createDomainHarness({ adjust: withAdmin });
        await expect(
          h.domain.projects.update('AR', admin(), (draft) => {
            aiMember(draft, 'dev-1').permissionMode = mode;
            return 'Free a mode';
          }),
        ).rejects.toMatchObject({ code: 'owner_only', status: 403 });
      },
    );

    it('refuses an AI member', async () => {
      h = await createDomainHarness();
      await expect(
        h.domain.members.update(
          'AR',
          'dev-2',
          { permissionMode: 'plan' },
          { actor: { kind: 'ai', handle: 'dev-1' }, author: OWNER },
        ),
      ).rejects.toMatchObject({ code: 'insufficient_access', status: 403 });
    });

    it('lets an admin change what is not the mode or the approver', async () => {
      h = await createDomainHarness({ adjust: withAdmin });
      await h.domain.members.update('AR', 'dev-1', { specialty: 'API' }, admin());
      expect(await stored('dev-1')).toMatchObject({ specialty: 'API' });
    });

    it('cannot pick bypassPermissions, and applies to AI members only', async () => {
      h = await createDomainHarness();
      // Not in the request schema: the route refuses it before the service.
      const { UpdateMemberRequest } = await import('@projectman/shared');
      expect(UpdateMemberRequest.safeParse({ permissionMode: 'bypassPermissions' }).success).toBe(false);
      await expect(set('owner', { permissionMode: 'plan' })).rejects.toMatchObject({
        code: 'not_ai_member',
      });
      await expect(set('owner', { approver: 'none' })).rejects.toMatchObject({ code: 'not_ai_member' });
    });
  });

  describe('the AI approver', () => {
    it('cannot be chosen while delegation is off, and the roster says why', async () => {
      h = await createDomainHarness();
      expect(await view('dev-1')).toMatchObject({ aiApproverBlocker: 'delegation_off' });
      await expect(set('dev-1', { approver: 'ai' })).rejects.toMatchObject({
        code: 'approver_unavailable',
        status: 422,
        details: { blocker: 'delegation_off' },
      });
      expect(await stored('dev-1')).not.toHaveProperty('approver');
    });

    it('cannot be chosen while no AI member holds the authorization duty', async () => {
      h = await createDomainHarness({
        adjust: (config) => void (config.team.boundary = { enabled: true, leadTimeoutSeconds: 120 }),
      });
      expect(await view('dev-1')).toMatchObject({ aiApproverBlocker: 'no_ai_decider' });
      await expect(set('dev-1', { approver: 'ai' })).rejects.toMatchObject({
        code: 'approver_unavailable',
        details: { blocker: 'no_ai_decider' },
      });
    });

    it('can be chosen with delegation on and an AI decider, which cannot decide for itself', async () => {
      h = await createDomainHarness({ adjust: withDecider });
      expect(await view('dev-1')).not.toHaveProperty('aiApproverBlocker');
      expect(await view('cr')).toMatchObject({ aiApproverBlocker: 'no_ai_decider' });
      expect(await set('dev-1', { approver: 'ai' })).toMatchObject({ approver: 'ai' });
      await expect(set('cr', { approver: 'ai' })).rejects.toMatchObject({
        code: 'approver_unavailable',
      });
    });

    it('stays on the member when the decider drops out, and the roster then warns', async () => {
      h = await createDomainHarness({ adjust: withDecider });
      await set('dev-1', { approver: 'ai' });
      await set('cr', { onLeave: true });
      expect(await view('dev-1')).toMatchObject({ approver: 'ai', aiApproverBlocker: 'no_ai_decider' });
      await set('cr', { onLeave: false });
      expect(await view('dev-1')).not.toHaveProperty('aiApproverBlocker');
    });

    it('tells the clients when the blocker of another member changes', async () => {
      h = await createDomainHarness({ adjust: withDecider });
      const seen: Array<{ handle: string; blocker: string | undefined }> = [];
      h.domain.bus.subscribe((event) => {
        if (event.type === 'member_changed' && event.member)
          seen.push({ handle: event.handle, blocker: event.member.aiApproverBlocker });
      });
      await set('cr', { onLeave: true });
      expect(seen).toContainEqual({ handle: 'dev-1', blocker: 'no_ai_decider' });
    });
  });
});
