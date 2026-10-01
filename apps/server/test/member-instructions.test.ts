import { afterEach, describe, expect, it } from 'vitest';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

describe("a member's own instructions", () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const by = () => ({ actor: OWNER_ACTOR, author: OWNER });
  const stored = async (handle: string) => {
    const member = (await h.domain.projects.config('AR')).team.members.find((m) => m.handle === handle);
    if (member?.kind !== 'ai') throw new Error('Expected an AI member');
    return member;
  };

  it('changes as a new configuration version, trims, and an empty text clears them', async () => {
    h = await createDomainHarness();
    const before = (await h.domain.projects.history('AR')).length;
    await h.domain.members.update('AR', 'dev-1', { instructions: '  Always add tests.  ' }, by());
    expect((await stored('dev-1')).instructions).toBe('Always add tests.');
    const history = await h.domain.projects.history('AR');
    expect(history).toHaveLength(before + 1);
    expect(history[0]?.message).toContain('instructions');
    await h.domain.members.update('AR', 'dev-1', { instructions: '' }, by());
    expect((await stored('dev-1')).instructions).toBe('');
  });

  it('leaves them alone when the field is omitted', async () => {
    h = await createDomainHarness();
    await h.domain.members.update('AR', 'dev-1', { instructions: 'Keep me.' }, by());
    await h.domain.members.update('AR', 'dev-1', { displayName: 'Renamed' }, by());
    expect((await stored('dev-1')).instructions).toBe('Keep me.');
  });

  it('applies to AI members only', async () => {
    h = await createDomainHarness();
    await expect(
      h.domain.members.update('AR', 'owner', { instructions: 'Nope.' }, by()),
    ).rejects.toMatchObject({ code: 'not_ai_member' });
  });

  it('reaches the next session of the member', async () => {
    h = await createDomainHarness();
    await h.domain.members.update('AR', 'dev-1', { instructions: 'Prefer small commits.' }, by());
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    expect(h.contextBuilder.inputs.at(-1)?.member.instructions).toBe('Prefer small commits.');
  });
});
