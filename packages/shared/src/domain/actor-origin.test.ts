import { describe, expect, it } from 'vitest';
import {
  coordinatorSuperActorOf,
  isConnectedOwnerActor,
  isCoordinatorSuperActor,
} from '../config/operator-member';
import {
  actorOriginMetaOf,
  actorWithOriginMeta,
  connectedActorOf,
  connectedOriginOf,
  hasBoundOrigin,
  hasConnectedOrigin,
  hasSuperOrigin,
  withApprovedBy,
} from './actor-origin';
import { Actor } from './event';
import { TeamMessage } from './message';
import { SuperAuditPage, SuperAuditQuery } from './super-audit';

const credential = { id: 'ikey_1', prefix: 'pmi_abcdefgh' };
const superActor = {
  kind: 'ai',
  handle: 'operator',
  via: 'integrator',
  operatorMode: 'super',
  credential,
} as const;
const pmSuperActor = { ...superActor, handle: 'pm' };
const config = {
  team: {
    members: [
      { kind: 'ai', handle: 'other', role: 'developer' },
      { kind: 'ai', handle: 'pm', role: 'project_manager' },
    ],
    roles: [],
  },
} as never;

const holder = {
  kind: 'human',
  handle: 'owner',
  via: 'integrator',
  through: { holder: 'owner', credential },
} as const;
const issuerStep = {
  kind: 'ai',
  handle: 'pm',
  via: 'integrator',
  through: { holder: 'owner', credential },
} as const;
const humanConfig = {
  team: {
    members: [
      { kind: 'human', handle: 'owner', access: 'owner' },
      { kind: 'human', handle: 'helper', access: 'admin' },
      { kind: 'ai', handle: 'pm', role: 'project_manager' },
    ],
    roles: [],
  },
} as never;

describe('connected Claude actor origin (decision 66)', () => {
  it('builds the holder in person or the queue item issuer, with the holder behind it', () => {
    expect(connectedActorOf('owner', credential)).toEqual(holder);
    expect(connectedActorOf('owner', credential, { issuer: 'pm' })).toEqual(issuerStep);
    expect(connectedActorOf('owner', credential, { approvedBy: 'owner' }).approvedBy).toBe('owner');
  });

  it.each([
    ['a person who is not the holder', { ...holder, handle: 'helper' }],
    ['the old pair next to through', { ...holder, operatorMode: 'super', credential }],
    ['the system', { kind: 'system', handle: null, via: 'integrator', through: holder.through }],
    ['no integrator origin', { ...holder, via: undefined }],
    [
      'approvedBy without through',
      { kind: 'human', handle: 'owner', via: 'integrator', approvedBy: 'owner' },
    ],
  ])('refuses %s', (_name, actor) => {
    expect(Actor.safeParse(actor).success).toBe(false);
  });

  it('parses the holder and the issuer step and keeps their origin apart from the old one', () => {
    expect(Actor.parse(holder)).toEqual(holder);
    expect(hasConnectedOrigin(issuerStep)).toBe(true);
    expect(hasSuperOrigin(holder)).toBe(false);
    expect(hasBoundOrigin(holder)).toBe(true);
    expect(connectedOriginOf(holder)).toEqual({ holder: 'owner', credential });
    expect(connectedOriginOf(superActor)).toEqual({ holder: null, credential });
    expect(connectedOriginOf({ kind: 'human', handle: 'owner' })).toBeNull();
  });

  it('round-trips the origin through the stored meta, with the approver, and reads an old row', () => {
    const approved = withApprovedBy(connectedActorOf('owner', credential, { issuer: 'pm' }), 'owner');
    const meta = actorOriginMetaOf(approved);
    expect(meta).toEqual({ through: issuerStep.through, approvedBy: 'owner' });
    expect(actorWithOriginMeta({ kind: 'ai', handle: 'pm', via: 'integrator' }, meta)).toEqual(approved);
    expect(
      actorWithOriginMeta({ kind: 'human', handle: 'owner', via: 'integrator' }, actorOriginMetaOf(holder)),
    ).toEqual(holder);
    // A row that disagrees with its columns (a person who is not the holder) reads as the plain actor.
    const plain = { kind: 'human', handle: 'helper', via: 'integrator' } as const;
    expect(actorWithOriginMeta(plain, actorOriginMetaOf(holder))).toEqual(plain);
    // The old shape is still read as before.
    expect(
      actorWithOriginMeta(
        { kind: 'ai', handle: 'operator', via: 'integrator' },
        { operatorMode: 'super', credential },
      ),
    ).toEqual(superActor);
  });

  it('treats only an owner holder in person as the owner, and a queue item step as no owner', () => {
    expect(isConnectedOwnerActor(humanConfig, holder)).toBe(true);
    expect(isConnectedOwnerActor(humanConfig, connectedActorOf('helper', credential))).toBe(false);
    expect(isConnectedOwnerActor(humanConfig, issuerStep)).toBe(false);
    // An old super actor keeps its own rule: the selected coordinator, not the retired Operator.
    expect(isConnectedOwnerActor(config, pmSuperActor)).toBe(true);
    expect(isConnectedOwnerActor(config, superActor)).toBe(false);
  });
});

describe('super-mode actor origin (PM-757)', () => {
  it('parses an old actor unchanged and a new one with its origin', () => {
    expect(Actor.parse({ kind: 'human', handle: 'owner', via: 'integrator' })).toEqual({
      kind: 'human',
      handle: 'owner',
      via: 'integrator',
    });
    expect(Actor.parse({ kind: 'system', handle: null })).toEqual({ kind: 'system', handle: null });
    expect(Actor.parse(superActor)).toEqual(superActor);
  });

  it.each([
    ['a mode without a credential', { ...superActor, credential: undefined }],
    ['a credential without a mode', { ...superActor, operatorMode: undefined }],
    ['a human', { ...superActor, kind: 'human' }],
    ['no integrator origin', { ...superActor, via: undefined }],
    ['the system', { kind: 'system', handle: null, operatorMode: 'super', credential }],
    ['another mode', { ...superActor, operatorMode: 'direct' }],
  ])('refuses %s', (_name, actor) => {
    expect(Actor.safeParse(actor).success).toBe(false);
  });

  it('keeps the origin only of a consistent super actor', () => {
    expect(hasSuperOrigin(superActor)).toBe(true);
    expect(hasSuperOrigin({ kind: 'ai', handle: 'operator' })).toBe(false);
    expect(hasSuperOrigin(null)).toBe(false);
    expect(actorOriginMetaOf(superActor)).toEqual({ operatorMode: 'super', credential });
    expect(actorOriginMetaOf({ kind: 'human', handle: 'owner', via: 'integrator' })).toBeNull();
  });

  it('reads a stored row back with its origin only when the old columns agree', () => {
    const plain = { kind: 'ai', handle: 'operator', via: 'integrator' } as const;
    expect(actorWithOriginMeta(plain, { operatorMode: 'super', credential })).toEqual(superActor);
    // An old row has no meta; an unreadable or disagreeing one reads as the old actor.
    expect(actorWithOriginMeta(plain, null)).toEqual(plain);
    expect(actorWithOriginMeta(plain, { operatorMode: 'super' })).toEqual(plain);
    const human = { kind: 'human', handle: 'owner', via: 'integrator' } as const;
    expect(actorWithOriginMeta(human, { operatorMode: 'super', credential })).toEqual(human);
    const direct = { kind: 'ai', handle: 'operator' } as const;
    expect(actorWithOriginMeta(direct, { operatorMode: 'super', credential })).toEqual(direct);
  });

  it('computes the super actor from the configuration, with the selected coordinator as handle', () => {
    expect(coordinatorSuperActorOf(config, credential, 'pm')).toEqual(pmSuperActor);
    expect(
      coordinatorSuperActorOf({ team: { members: [], roles: [] } } as never, credential, 'pm'),
    ).toBeNull();
  });

  it('binds the app super actor to the selected coordinator only', () => {
    expect(coordinatorSuperActorOf(config, credential, 'pm')).toEqual(pmSuperActor);
    expect(coordinatorSuperActorOf(config, credential, 'other')).toBeNull();
    expect(coordinatorSuperActorOf(config, credential, undefined)).toBeNull();
    expect(coordinatorSuperActorOf(config, credential, 'operator')).toBeNull();
    expect(isCoordinatorSuperActor(config, pmSuperActor)).toBe(true);
  });

  it('recognises the super origin of the coordinator and grants nothing by itself', () => {
    expect(isCoordinatorSuperActor(config, { kind: 'ai', handle: 'pm' })).toBe(false);
    expect(isCoordinatorSuperActor(config, { ...pmSuperActor, handle: 'other' })).toBe(false);
    // An old super row of the retired Operator names no member any more.
    expect(isCoordinatorSuperActor(config, superActor)).toBe(false);
  });

  it('parses old and new messages', () => {
    const base = {
      id: 'msg_1',
      projectKey: 'AR',
      from: 'operator',
      to: ['dev-1'],
      taskKey: null,
      body: 'x',
      createdAt: '2026-10-17T08:00:00.000Z',
      deliveredAt: null,
      kind: 'info',
      receipts: [],
    };
    expect(TeamMessage.parse(base).actor).toBeUndefined();
    expect(TeamMessage.parse({ ...base, actor: superActor }).actor).toEqual(superActor);
  });

  it('keeps the audit query and page closed', () => {
    expect(SuperAuditQuery.parse({})).toEqual({ limit: 50 });
    expect(SuperAuditQuery.parse({ prefix: 'pmi_abcdefgh', limit: '10' })).toMatchObject({ limit: 10 });
    expect(SuperAuditQuery.safeParse({ limit: 1000 }).success).toBe(false);
    expect(SuperAuditQuery.safeParse({ other: 'x' }).success).toBe(false);
    const entry = {
      id: 'saud_1',
      projectKey: 'AR',
      taskKey: null,
      prefix: 'pmi_abcdefgh',
      operatorMode: 'super',
      requestId: 'req-1',
      handoffId: null,
      operation: 'config_commit',
      outcome: 'succeeded',
      errorCode: null,
      createdAt: '2026-10-17T08:00:00.000Z',
    };
    expect(SuperAuditPage.parse({ entries: [entry], nextBefore: null }).entries).toHaveLength(1);
    expect(
      SuperAuditPage.safeParse({ entries: [{ ...entry, operation: 'Free text here' }], nextBefore: null })
        .success,
    ).toBe(false);
    expect(
      SuperAuditPage.safeParse({ entries: [{ ...entry, outcome: 'maybe' }], nextBefore: null }).success,
    ).toBe(false);
  });
});
