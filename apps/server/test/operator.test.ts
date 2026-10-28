import { afterEach, describe, expect, it } from 'vitest';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

let h: DomainHarness;
afterEach(() => h?.cleanup());
const by = { actor: OWNER_ACTOR, author: OWNER };

describe('a project has no Operator member (decision 66)', () => {
  it('has neither the operator handle nor the retired role', async () => {
    h = await createDomainHarness();
    const { members } = (await h.domain.projects.config('AR')).team;
    expect(members.some((m) => m.handle === 'operator')).toBe(false);
    expect(members.some((m) => m.kind === 'ai' && m.role === 'ai_operator')).toBe(false);
  });

  it('refuses to hire the retired role', async () => {
    h = await createDomainHarness();
    await expect(
      h.domain.members.hire('AR', { role: 'ai_operator', handle: 'another' }, { ...by, sponsor: 'owner' }),
    ).rejects.toMatchObject({ code: 'unknown_role' });
  });

  it('keeps the old handle reserved, so the old events keep their name', async () => {
    h = await createDomainHarness();
    await expect(
      h.domain.members.hire('AR', { role: 'developer', handle: 'operator' }, { ...by, sponsor: 'owner' }),
    ).rejects.toMatchObject({ code: 'handle_taken', status: 409 });
    expect(h.domain.members.takenHandles('AR', await h.domain.projects.config('AR')).has('operator')).toBe(
      true,
    );
  });
});
