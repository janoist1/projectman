import { describe, expect, it } from 'vitest';
import { isOperatorActor, isSuperOperatorActor, superActorOf } from '../config/operator-member';
import { actorOriginMetaOf, actorWithOriginMeta, hasSuperOrigin } from './actor-origin';
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
const config = {
  team: {
    members: [
      { kind: 'ai', handle: 'operator', role: 'ai_operator' },
      { kind: 'ai', handle: 'other', role: 'developer' },
    ],
    roles: [],
  },
} as never;

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

  it('computes the super actor from the configuration, with the Operator as handle', () => {
    expect(superActorOf(config, credential)).toEqual(superActor);
    expect(superActorOf({ team: { members: [], roles: [] } } as never, credential)).toBeNull();
  });

  it('recognises the super origin apart from the direct mode and grants nothing by itself', () => {
    expect(isSuperOperatorActor(config, superActor)).toBe(true);
    expect(isSuperOperatorActor(config, { kind: 'ai', handle: 'operator' })).toBe(false);
    expect(isSuperOperatorActor(config, { ...superActor, handle: 'other' })).toBe(false);
    // The direct base mode stays what it was; the super origin (it has `via`) is not mistaken for it.
    expect(isOperatorActor(config, { kind: 'ai', handle: 'operator' })).toBe(true);
    expect(isOperatorActor(config, superActor)).toBe(false);
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
