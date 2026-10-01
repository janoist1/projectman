import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import type { EgressSession } from '../src/domain';
import { createDomainHarness, restartDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

const settings = { base: [{ host: 'registry.npmjs.org', port: 443 }], grantHours: 2 };
const docs = { host: 'docs.example.org', port: 443 };
const allow = { decision: 'allow', reason: 'scope_verified' } as const;

function withLead(config: ProjectConfig) {
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

describe('the network gate (egress)', () => {
  let h: DomainHarness;
  let now: Date;
  let session: EgressSession;

  async function setUp(adjust?: (config: ProjectConfig) => void) {
    now = new Date('2026-10-01T11:00:00.000Z');
    h = await createDomainHarness({ persistent: true, now: () => now, egress: settings, adjust });
    await h.domain.tasks.create('AR', { title: 'Fetch the docs' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    session = { projectKey: 'AR', member: 'dev-1', sessionId: started.session!.id, taskKey: 'AR-1' };
  }
  afterEach(() => h.cleanup());

  const as = (s: EgressSession | null, member = 'dev-1') => ({ member, session: s });

  describe('without a lead', () => {
    beforeEach(() => setUp());

    it('lets every worker reach a base destination, with or without a session', async () => {
      await expect(
        h.domain.egress.authorize(as(null), { host: 'registry.npmjs.org', port: 443 }),
      ).resolves.toEqual({
        allowed: true,
        via: 'base',
      });
      // The same host on another port is not the base destination.
      await expect(
        h.domain.egress.authorize(as(null), { host: 'registry.npmjs.org', port: 80 }),
      ).resolves.toMatchObject({ allowed: false, denial: 'no_session' });
    });

    it('refuses a connection whose account is not the session member', async () => {
      await expect(h.domain.egress.authorize(as(session, 'dev-2'), docs)).resolves.toEqual({
        allowed: false,
        denial: 'identity_mismatch',
        operationId: null,
      });
    });

    it('registers a refused destination once per session, asks nobody, and lists it for the session', async () => {
      const first = await h.domain.egress.authorize(as(session), docs);
      const again = await h.domain.egress.authorize(as(session), docs);
      expect(first).toMatchObject({ allowed: false, denial: 'not_allowed' });
      const operationId = (first as { operationId: string }).operationId;
      expect(operationId).toMatch(/^egr_/);
      expect(again).toMatchObject({ operationId });
      expect(h.repos.boundary.list()).toEqual([]);
      expect(h.repos.inbox.list('AR', { state: 'open' }).filter((i) => i.kind === 'boundary')).toEqual([]);
      const denials = await h.domain.teamTools.listNetworkDenials(session);
      expect(denials).toEqual([
        {
          operationId,
          destination: 'docs.example.org:443',
          refusedAt: '2026-10-01T11:00:00.000Z',
          expiresAt: '2026-10-01T13:00:00.000Z',
        },
      ]);
    });

    it('opens exactly the allowed destination for the member and project once an owner allows it', async () => {
      const refused = (await h.domain.egress.authorize(as(session), docs)) as { operationId: string };
      const request = await h.domain.teamTools.submitBoundaryRequest(session, {
        operationId: refused.operationId,
        deduplicationKey: 'docs-1',
      });
      expect(request).toMatchObject({
        state: 'pending_owner',
        category: 'delegable',
        target: {
          operation: 'read_external',
          resource: 'egress:docs.example.org:443',
          environment: 'development',
        },
      });
      // Pending is not allowed.
      await expect(h.domain.egress.authorize(as(session), docs)).resolves.toMatchObject({ allowed: false });
      await h.domain.boundary.decide('AR', request.id, 'owner', allow);

      const opened = await h.domain.egress.authorize(as(session), docs);
      expect(opened).toMatchObject({ allowed: true, via: 'allowance' });
      expect(h.repos.boundary.get(request.id)!.consumedAt).toBe('2026-10-01T11:00:00.000Z');
      expect(h.repos.boundary.grant(request.id)!.state).toBe('consumed');
      // The allowance covers later sessions of the member in the project, not other destinations or members.
      const later = { ...session, sessionId: 'ses_later' };
      await expect(h.domain.egress.authorize(as(later), docs)).resolves.toMatchObject({ allowed: true });
      await expect(h.domain.egress.authorize(as(session), { ...docs, port: 8443 })).resolves.toMatchObject({
        allowed: false,
      });
      const other = { ...session, member: 'dev-2' };
      await expect(h.domain.egress.authorize(as(other, 'dev-2'), docs)).resolves.toMatchObject({
        allowed: false,
      });
      expect(await h.domain.egress.listAllowances('AR', 'owner')).toEqual([
        expect.objectContaining({
          member: 'dev-1',
          host: 'docs.example.org',
          port: 443,
          requestId: request.id,
        }),
      ]);
    });

    it('closes an allowance when an owner revokes it, and only an owner may', async () => {
      const refused = (await h.domain.egress.authorize(as(session), docs)) as { operationId: string };
      const request = await h.domain.teamTools.submitBoundaryRequest(session, {
        operationId: refused.operationId,
        deduplicationKey: 'docs-1',
      });
      await h.domain.boundary.decide('AR', request.id, 'owner', allow);
      await h.domain.egress.authorize(as(session), docs);
      const [allowance] = await h.domain.egress.listAllowances('AR', 'owner');
      await expect(h.domain.egress.revokeAllowance('AR', allowance!.id, 'dev-1')).rejects.toMatchObject({
        code: 'owner_only',
      });
      const revoked = await h.domain.egress.revokeAllowance('AR', allowance!.id, 'owner');
      expect(revoked).toMatchObject({ revokedBy: 'owner', revokedAt: '2026-10-01T11:00:00.000Z' });
      await expect(h.domain.egress.authorize(as(session), docs)).resolves.toMatchObject({
        allowed: false,
        operationId: refused.operationId,
      });
      await expect(h.domain.egress.revokeAllowance('AR', allowance!.id, 'owner')).rejects.toMatchObject({
        code: 'inbox_item_closed',
      });
      expect(
        h.domain.timeline
          .list('AR')
          .filter((e) => e.type === 'boundary_changed')
          .at(-1),
      ).toMatchObject({
        actor: { kind: 'human', handle: 'owner' },
        data: {
          requestId: request.id,
          state: 'revoked',
          reason: 'owner_revoked',
          resource: 'egress:docs.example.org:443',
        },
      });
    });

    it('lets an allowance and an unused operation expire', async () => {
      const refused = (await h.domain.egress.authorize(as(session), docs)) as { operationId: string };
      const request = await h.domain.teamTools.submitBoundaryRequest(session, {
        operationId: refused.operationId,
        deduplicationKey: 'docs-1',
      });
      await h.domain.boundary.decide('AR', request.id, 'owner', allow);
      await h.domain.egress.authorize(as(session), docs);
      now = new Date('2026-10-01T13:00:01.000Z');
      const after = await h.domain.egress.authorize(as(session), docs);
      expect(after).toMatchObject({ allowed: false, denial: 'not_allowed' });
      expect((after as { operationId: string }).operationId).not.toBe(refused.operationId);
      expect(await h.domain.egress.listAllowances('AR', 'owner')).toEqual([]);
    });

    it('refuses a member on leave even with an allowance', async () => {
      const refused = (await h.domain.egress.authorize(as(session), docs)) as { operationId: string };
      const request = await h.domain.teamTools.submitBoundaryRequest(session, {
        operationId: refused.operationId,
        deduplicationKey: 'docs-1',
      });
      await h.domain.boundary.decide('AR', request.id, 'owner', allow);
      await h.domain.egress.authorize(as(session), docs);
      await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
        const dev = draft.team.members.find((m) => m.handle === 'dev-1')!;
        if (dev.kind === 'ai') dev.onLeave = true;
        return 'Send dev-1 on leave';
      });
      await expect(h.domain.egress.authorize(as(session), docs)).resolves.toMatchObject({
        allowed: false,
        denial: 'member_inactive',
      });
    });

    it('binds the operation to the refused session: another session cannot ask for it', async () => {
      const refused = (await h.domain.egress.authorize(as(session), docs)) as { operationId: string };
      await h.domain.tasks.create('AR', { title: 'Other' }, OWNER_ACTOR);
      const other = await h.domain.taskStarts.start('AR', 'AR-2', { actor: OWNER_ACTOR, author: OWNER });
      const otherSession = {
        ...session,
        sessionId: other.session!.id,
        member: other.session!.member,
        taskKey: 'AR-2',
      };
      await expect(
        h.domain.teamTools.submitBoundaryRequest(otherSession, {
          operationId: refused.operationId,
          deduplicationKey: 'steal-1',
        }),
      ).rejects.toThrow();
      expect(h.domain.egress.resolve(otherSession, refused.operationId)).toBeNull();
      expect(h.domain.egress.resolve(session, refused.operationId)).toMatchObject({
        resource: 'egress:docs.example.org:443',
        scope: 'single_operation',
      });
    });

    it('keeps an allowance across a restart', async () => {
      const refused = (await h.domain.egress.authorize(as(session), docs)) as { operationId: string };
      const request = await h.domain.teamTools.submitBoundaryRequest(session, {
        operationId: refused.operationId,
        deduplicationKey: 'docs-1',
      });
      await h.domain.boundary.decide('AR', request.id, 'owner', allow);
      await h.domain.egress.authorize(as(session), docs);
      h = await restartDomainHarness(h, { now: () => now, egress: settings });
      await expect(h.domain.egress.authorize(as(session), docs)).resolves.toMatchObject({
        allowed: true,
        via: 'allowance',
      });
    });

    it('stops registering operations for a session that asks for too many', async () => {
      for (let i = 0; i < 200; i++)
        await h.domain.egress.authorize(as(session), { host: `host${i}.example.org`, port: 443 });
      await expect(
        h.domain.egress.authorize(as(session), { host: 'one-more.example.org', port: 443 }),
      ).resolves.toEqual({ allowed: false, denial: 'too_many_requests', operationId: null });
    });
  });

  describe('with a lead', () => {
    beforeEach(() => setUp(withLead));

    it('lets the lead allow a destination, which the proxy then opens', async () => {
      const refused = (await h.domain.egress.authorize(as(session), docs)) as { operationId: string };
      const request = await h.domain.teamTools.submitBoundaryRequest(session, {
        operationId: refused.operationId,
        deduplicationKey: 'docs-1',
      });
      expect(request).toMatchObject({ state: 'pending_lead', assignees: ['cr'] });
      await h.domain.teamTools.decideBoundaryRequest(
        { ...session, member: 'cr', sessionId: 'ses_lead' },
        { requestId: request.id, ...allow },
      );
      await expect(h.domain.egress.authorize(as(session), docs)).resolves.toMatchObject({
        allowed: true,
        via: 'allowance',
      });
    });
  });
});
