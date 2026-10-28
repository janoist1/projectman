import { describe, expect, it } from 'vitest';
import { connectedActorOf } from '@projectman/shared';
import type { Actor, MemberView } from '@projectman/shared';
import { members as fixtureMembers } from '../mocks/fixtures';
import { t } from '../i18n/t';
import {
  actorLabel,
  actorParts,
  indexMembers,
  isOwnActor,
  memberStatusView,
  nameOf,
  renamedTo,
} from './members';

const member = (handle: string): MemberView => fixtureMembers.find((entry) => entry.handle === handle)!;

describe('memberStatusView with a pause', () => {
  const working = member('be-1');

  it('shows the plain status when no pause is open', () => {
    expect(memberStatusView(working, [], 'owner')).toEqual({
      status: 'working',
      label: t('memberStatus.working'),
    });
  });

  it('reads "paused" for an AI member once its sessions stopped, or when nothing was running', () => {
    const stopped = [{ member: 'be-1', point: 'after_tool' as const }];
    expect(memberStatusView(working, [], 'owner', stopped)).toEqual({
      status: 'paused',
      label: t('memberStatus.paused'),
    });
    expect(memberStatusView(working, [], 'owner', [])).toEqual({
      status: 'paused',
      label: t('memberStatus.paused'),
    });
  });

  it('reads "pausing" while one of its sessions has not stopped', () => {
    const rows = [
      { member: 'be-1', point: null },
      { member: 'fe-1', point: 'idle' as const },
    ];
    expect(memberStatusView(working, [], 'owner', rows).label).toBe(t('memberStatus.pausing'));
    expect(memberStatusView(member('fe-1'), [], 'owner', rows).label).toBe(t('memberStatus.paused'));
  });

  it('leaves a human member and a member on leave as they are', () => {
    expect(memberStatusView(member('owner'), [], 'owner', []).status).toBe(member('owner').status);
    const away: MemberView = { ...working, status: 'offline' };
    expect(memberStatusView(away, [], 'owner', []).status).toBe('offline');
  });
});

describe('indexMembers with former handles (PM-1026)', () => {
  const renamed = {
    ...fixtureMembers.find((m) => m.handle === 'qa')!,
    handle: 'tester',
    formerHandles: ['qa'],
  };

  it('gives the member its name under a former handle too', () => {
    expect(nameOf('qa', indexMembers([renamed]), 'owner')).toBe(renamed.displayName);
  });

  it('lets a current handle win over the same former handle of another member', () => {
    const other = { ...fixtureMembers.find((m) => m.handle === 'devops')!, handle: 'qa' };
    expect(indexMembers([renamed, other]).get('qa')).toBe(other);
    expect(indexMembers([other, renamed]).get('qa')).toBe(other);
  });

  it('points a former handle at the current one, and a current handle nowhere', () => {
    const index = indexMembers([renamed]);
    expect(renamedTo('qa', index)).toBe('tester');
    expect(renamedTo('tester', index)).toBeNull();
    expect(renamedTo('unknown', index)).toBeNull();
  });
});

describe('actorParts and actorLabel for a connected Claude (decision 66)', () => {
  const credential = { id: 'cred_secretly_internal', prefix: 'pmk_7Hq2' };
  const index = indexMembers(fixtureMembers);
  const legacySuper: Actor = {
    kind: 'ai',
    handle: 'devops',
    via: 'integrator',
    operatorMode: 'super',
    credential,
  };

  it.each([
    {
      name: 'a direct instruction',
      actor: connectedActorOf('kata', credential),
      parts: { name: 'Kata', chipHolder: null, holder: 'Kata', approver: null, approverInline: false },
      label: t('connected.label', { name: 'Kata' }),
    },
    {
      name: 'external work (MCP) names the holder',
      actor: connectedActorOf('kata', credential, { issuer: 'devops' }),
      parts: { name: 'Devops', chipHolder: 'Kata', holder: 'Kata', approver: null, approverInline: false },
      label: t('connected.labelHolder', { name: 'Devops', holder: 'Kata' }),
    },
    {
      name: 'an approval by someone else shows inline',
      actor: connectedActorOf('kata', credential, { issuer: 'devops', approvedBy: 'bence' }),
      parts: { name: 'Devops', chipHolder: 'Kata', holder: 'Kata', approver: 'Bence', approverInline: true },
      label: t('connected.labelHolder', { name: 'Devops', holder: 'Kata' }),
    },
    {
      name: 'a self-approval stays in the detail line',
      actor: connectedActorOf('kata', credential, { approvedBy: 'kata' }),
      parts: { name: 'Kata', chipHolder: null, holder: 'Kata', approver: 'Kata', approverInline: false },
      label: t('connected.label', { name: 'Kata' }),
    },
  ])('describes $name', ({ actor, parts, label }) => {
    const { connected, ...rest } = actorParts(actor, index, 'owner');
    expect(rest).toEqual({ name: parts.name, legacySuper: false });
    expect(connected).toMatchObject({
      chipHolder: parts.chipHolder,
      holder: parts.holder,
      approver: parts.approver,
      approverInline: parts.approverInline,
      prefix: credential.prefix,
    });
    expect(actorLabel(actor, index, 'owner')).toBe(label);
  });

  it('names the viewer as "Te" for the holder', () => {
    const actor = connectedActorOf('owner', credential, { issuer: 'devops' });
    expect(actorParts(actor, index, 'owner').connected?.chipHolder).toBe(t('common.you'));
  });

  it('leaves an old super row and an old integrator row as they were', () => {
    expect(actorParts(legacySuper, index, 'owner')).toMatchObject({ connected: null, legacySuper: true });
    expect(actorLabel(legacySuper, index, 'owner')).toBe(t('superMode.actor'));
    const integrator: Actor = { kind: 'human', handle: 'kata', via: 'integrator' };
    expect(actorParts(integrator, index, 'owner')).toMatchObject({ connected: null, legacySuper: false });
    expect(actorLabel(integrator, index, 'owner')).toBe(t('involvement.integrator'));
  });

  it('counts only the own connected Claude of the viewer as the viewer acting', () => {
    expect(isOwnActor({ kind: 'human', handle: 'owner' }, 'owner')).toBe(true);
    expect(isOwnActor(connectedActorOf('owner', credential), 'owner')).toBe(true);
    expect(isOwnActor(connectedActorOf('kata', credential, { issuer: 'owner' }), 'owner')).toBe(false);
    expect(isOwnActor({ kind: 'human', handle: 'owner', via: 'integrator' }, 'owner')).toBe(false);
  });
});

describe('nameOf', () => {
  it('names the sender of the messages projectman writes itself as the system (PM-421)', () => {
    expect(nameOf('system', indexMembers([]), 'owner')).toBe(t('common.system'));
    expect(nameOf(null, indexMembers([]), 'owner')).toBe(t('common.system'));
  });
});
