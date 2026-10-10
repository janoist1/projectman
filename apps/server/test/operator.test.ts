import { afterEach, describe, expect, it } from 'vitest';
import { isOperator, operatorOf } from '@projectman/shared';
import type { AiMemberConfig, HumanMemberConfig, ProjectConfig } from '@projectman/shared';
import { aiActor, SYSTEM_ACTOR, SYSTEM_AUTHOR } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

let h: DomainHarness;
afterEach(() => h?.cleanup());
const by = { actor: OWNER_ACTOR, author: OWNER };
const viaIntegrator = {
  actor: { ...OWNER_ACTOR, via: 'integrator' as const },
  author: { ...OWNER, via: 'integrator' as const },
};
const asSystem = { actor: SYSTEM_ACTOR, author: SYSTEM_AUTHOR };

async function handles(): Promise<string[]> {
  return (await h.domain.projects.config('AR')).team.members.map((m) => m.handle);
}

async function operator(): Promise<AiMemberConfig> {
  return operatorOf(await h.domain.projects.config('AR'))!;
}

const secondOperator = (): AiMemberConfig => ({
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

const member = (draft: ProjectConfig, handle: string) => draft.team.members.find((m) => m.handle === handle)!;

describe('the required Operator (PM-447)', () => {
  it('is in every project the test template builds, at work', async () => {
    h = await createDomainHarness();
    const config = await h.domain.projects.config('AR');
    expect(operatorOf(config)).toMatchObject({ handle: 'operator', role: 'ai_operator' });
    expect(operatorOf(config)?.onLeave).toBeUndefined();
  });

  it('refuses to retire the only Operator and changes nothing', async () => {
    h = await createDomainHarness();
    const before = await handles();
    await expect(h.domain.members.retire('AR', 'operator', {}, by)).rejects.toMatchObject({
      code: 'operator_required',
      message: 'the Operator cannot be retired',
      status: 409,
    });
    expect(await handles()).toEqual(before);
  });

  it('retires one of two Operators from an older configuration, then refuses the last', async () => {
    h = await createDomainHarness({ persistent: true });
    const { config } = await h.configStore.load('AR');
    config.team.members.push(secondOperator());
    await h.configStore.save('AR', config, { author: OWNER, message: 'An older configuration with two' });
    h = await restartDomainHarness(h, { persistent: true });

    await h.domain.members.retire('AR', 'operator', {}, by);
    const after = await h.domain.projects.config('AR');
    expect(after.team.members.filter((m) => isOperator(m)).map((m) => m.handle)).toEqual(['operator-2']);
    await expect(h.domain.members.retire('AR', 'operator-2', {}, by)).rejects.toMatchObject({
      code: 'operator_required',
    });
  });
});

describe('the Operator is fixed (PM-473)', () => {
  const actors = [
    ['the owner', by],
    ['the integrator key', viaIntegrator],
    ['the system', asSystem],
  ] as const;

  const refused: Array<[string, (draft: ProjectConfig) => void, string | null, string | null]> = [
    ['leave', (d) => ((member(d, 'operator') as AiMemberConfig).onLeave = true), 'leave', 'onLeave'],
    ['a capacity of 2', (d) => ((member(d, 'operator') as AiMemberConfig).capacity = 2), 'field', 'capacity'],
    [
      'a schedule',
      (d) => ((member(d, 'operator') as AiMemberConfig).schedule = { cron: '0 9 * * *', prompt: 'Look.' }),
      'field',
      'schedule',
    ],
    [
      'instructions',
      (d) => ((member(d, 'operator') as AiMemberConfig).instructions = 'Do more.'),
      'field',
      'instructions',
    ],
    ['another name', (d) => (member(d, 'operator').displayName = 'Boss'), 'field', 'displayName'],
    ['a second Operator', (d) => d.team.members.push(secondOperator()), 'second', null],
    [
      'temp workers hired as Operators',
      (d) => (d.team.limits.tempWorkers.role = 'ai_operator'),
      'second',
      'limits.tempWorkers.role',
    ],
  ];

  describe.each(actors)('%s', (_who, meta) => {
    it.each(refused)('is refused %s with 409 operator_fixed', async (_what, change, kind, field) => {
      // The system may not hire an AI member at all (403 owner_only, before the Operator rule).
      if (meta === asSystem && kind === 'second' && field === null) return;
      h = await createDomainHarness();
      const before = await h.domain.projects.config('AR');
      await expect(
        h.domain.projects.update('AR', meta, (draft) => {
          change(draft);
          return 'Change the Operator';
        }),
      ).rejects.toMatchObject({
        code: 'operator_fixed',
        status: 409,
        details: expect.objectContaining({ kind, field }),
      });
      expect(await h.domain.projects.config('AR')).toEqual(before);
    });
  });

  it('refuses the member update that sends it on leave, sets its instructions or renames it', async () => {
    h = await createDomainHarness();
    for (const req of [
      { onLeave: true },
      { instructions: 'Do more.' },
      { displayName: 'Boss' },
      { schedule: { cron: '0 9 * * *', prompt: 'Look.' } },
    ]) {
      await expect(h.domain.members.update('AR', 'operator', req, by)).rejects.toMatchObject({
        code: 'operator_fixed',
        status: 409,
      });
      await expect(h.domain.members.update('AR', 'operator', req, viaIntegrator)).rejects.toMatchObject({
        code: 'operator_fixed',
      });
    }
    expect(await operator()).toMatchObject({ displayName: 'Operator', instructions: '', capacity: 1 });
  });

  it('lets the model, the provider and the effort change', async () => {
    h = await createDomainHarness();
    await h.domain.members.update('AR', 'operator', { model: 'sonnet', effort: 'high' }, by);
    expect(await operator()).toMatchObject({ model: 'sonnet', effort: 'high' });
    await h.domain.members.update('AR', 'operator', { provider: 'codex' }, by);
    expect(await operator()).toMatchObject({ provider: 'codex' });
    await h.domain.members.update('AR', 'operator', { effort: null }, by);
    expect((await operator()).effort).toBeUndefined();
    await h.domain.projects.update('AR', by, (draft) => {
      (member(draft, 'operator') as AiMemberConfig).model = 'opus';
      return 'Set the model';
    });
    expect((await operator()).model).toBe('opus');
  });

  it('does not count a restated default as a change', async () => {
    h = await createDomainHarness();
    await h.domain.projects.update('AR', by, (draft) => {
      const op = member(draft, 'operator') as AiMemberConfig;
      op.onLeave = false;
      op.outboundNetwork = true;
      return 'Restate defaults';
    });
    expect(await operator()).toMatchObject({ handle: 'operator', displayName: 'Operator' });
  });

  it('hands the Operator’s sponsorship to the first other owner when its sponsor is removed', async () => {
    // The sponsor can be set only outside the rules (an older configuration), as it is fixed.
    h = await createDomainHarness({ persistent: true });
    const { config } = await h.configStore.load('AR');
    const other = {
      kind: 'human',
      handle: 'bob',
      displayName: 'Bob',
      access: 'owner',
      roles: [],
    } as unknown as HumanMemberConfig;
    config.team.members.push(other);
    (member(config, 'operator') as AiMemberConfig).sponsor = 'bob';
    await h.configStore.save('AR', config, { author: OWNER, message: 'Sponsored by bob' });
    h = await restartDomainHarness(h, { persistent: true });
    expect((await operator()).sponsor).toBe('bob');
    await h.domain.members.removeHuman('AR', 'bob', by);
    expect((await operator()).sponsor).toBe('owner');
    const history = await h.configStore.history('AR', 1);
    expect(history[0]?.message).toBe('Remove human member bob; the Operator is now sponsored by owner');
  });

  it('does not bring the leave back by reverting to a version that had it', async () => {
    h = await createDomainHarness({ persistent: true });
    // An older version, written before the Operator was fixed: on leave.
    const { config } = await h.configStore.load('AR');
    (member(config, 'operator') as AiMemberConfig).onLeave = true;
    const { version } = await h.configStore.save('AR', config, { author: OWNER, message: 'Old: on leave' });
    h = await restartDomainHarness(h, { persistent: true });
    // Read through the migration: already fixed.
    expect((await operator()).onLeave).toBeUndefined();
    await h.domain.projects.update('AR', by, (draft) => {
      member(draft, 'dev-1').displayName = 'Renamed';
      return 'Rename';
    });
    await h.domain.projects.revert('AR', version, by);
    expect((await operator()).onLeave).toBeUndefined();
    expect(
      (await h.domain.projects.config('AR')).team.members.find((m) => m.handle === 'dev-1'),
    ).toMatchObject({ displayName: 'Dev One' });
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
    h = await createDomainHarness();
    expect(await noWake('owner')).toEqual([{ handle: 'operator', delivery: 'wake' }]);
    expect(h.runner.started.length).toBeGreaterThan(0);
  });

  it('does not start it for a message from another AI member, and says why', async () => {
    h = await createDomainHarness();
    const before = h.runner.started.length;
    expect(await noWake('dev-1')).toEqual([
      { handle: 'operator', delivery: 'next_input', noWake: 'operator_owner_only' },
    ]);
    expect(h.runner.started).toHaveLength(before);
    // Not lost: it waits for the next time the owner talks to the Operator.
    expect(h.repos.messages.pending('AR', 'operator')).toHaveLength(1);
  });

  it('refuses the owner’s integrator key (PM-463)', async () => {
    h = await createDomainHarness();
    await expect(noWake('owner', 'integrator')).rejects.toMatchObject({
      code: 'operator_owner_only',
      status: 403,
    });
    expect(h.runner.started).toHaveLength(0);
  });
});
