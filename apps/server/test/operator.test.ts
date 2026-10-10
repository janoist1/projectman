import { afterEach, describe, expect, it } from 'vitest';
import { isOperator, operatorOf } from '@projectman/shared';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

let h: DomainHarness;
afterEach(() => h?.cleanup());
const by = { actor: OWNER_ACTOR, author: OWNER };

async function handles(): Promise<string[]> {
  return (await h.domain.projects.config('AR')).team.members.map((m) => m.handle);
}

/** The Operator at work (the test template sends it on leave, so it starts no sessions). */
const atWork = (config: {
  team: { members: Array<{ handle: string; kind: string; onLeave?: boolean }> };
}) => {
  const operator = config.team.members.find((m) => m.handle === 'operator')!;
  operator.onLeave = false;
};

describe('the required Operator (PM-447)', () => {
  it('is in every project the test template builds', async () => {
    h = await createDomainHarness();
    const config = await h.domain.projects.config('AR');
    expect(operatorOf(config)).toMatchObject({ handle: 'operator', role: 'ai_operator', onLeave: true });
  });

  it('refuses to retire the only Operator and changes nothing', async () => {
    h = await createDomainHarness();
    const before = await handles();
    await expect(h.domain.members.retire('AR', 'operator', {}, by)).rejects.toMatchObject({
      code: 'operator_required',
      status: 409,
    });
    expect(await handles()).toEqual(before);
  });

  it('retires one of two Operators, then refuses the last', async () => {
    h = await createDomainHarness({
      adjust: (c) => {
        c.team.members.push({
          kind: 'ai',
          handle: 'operator-2',
          displayName: 'Operator 2',
          role: 'ai_operator',
          model: 'opus',
          permissionMode: 'default',
          capacity: 1,
          instructions: '',
          sponsor: 'owner',
          temp: false,
        });
      },
    });
    await h.domain.members.retire('AR', 'operator', {}, by);
    const config = await h.domain.projects.config('AR');
    expect(config.team.members.filter((m) => isOperator(m)).map((m) => m.handle)).toEqual(['operator-2']);
    await expect(h.domain.members.retire('AR', 'operator-2', {}, by)).rejects.toMatchObject({
      code: 'operator_required',
    });
  });
});

describe('the Operator works only on the owner’s request (PM-447)', () => {
  const noWake = async (from: string, via?: 'integrator') => {
    const result = await h.domain.messaging.sendReporting(
      'AR',
      from,
      { to: ['operator'], text: 'Please change something.' },
      via ? { actor: { ...OWNER_ACTOR, via } } : from === 'owner' ? undefined : { actor: aiActor(from) },
    );
    await flush();
    return result.recipients;
  };

  it('starts it for the owner’s own message', async () => {
    h = await createDomainHarness({ adjust: atWork });
    expect(await noWake('owner')).toEqual([{ handle: 'operator', delivery: 'wake' }]);
    expect(h.runner.started.length).toBeGreaterThan(0);
  });

  it.each([
    ['another AI member', 'dev-1', undefined],
    ['the owner through the integrator key', 'owner', 'integrator' as const],
  ])('does not start it for a message from %s, and says why', async (_who, from, via) => {
    h = await createDomainHarness({ adjust: atWork });
    const before = h.runner.started.length;
    expect(await noWake(from, via)).toEqual([
      { handle: 'operator', delivery: 'next_input', noWake: 'operator_owner_only' },
    ]);
    expect(h.runner.started).toHaveLength(before);
    // Not lost: it waits for the next time the owner talks to the Operator.
    expect(h.repos.messages.pending('AR', 'operator')).toHaveLength(1);
  });
});
