import { afterEach, describe, expect, it } from 'vitest';
import { createDomainHarness, OWNER, OWNER_ACTOR, type DomainHarness } from './helpers/domain-harness';
import { pullRequest } from './helpers/fakes';

let h: DomainHarness;
afterEach(() => h?.cleanup());

describe('GitHub member authorship', () => {
  it.each(['code_review', 'security_review', 'qa'] as const)(
    'attributes a polled PR by login, persists the author, and forbids their %s',
    async (check) => {
      h = await createDomainHarness({
        adjust: (config) => {
          config.team.members.find((member) => member.handle === 'cr')!.githubLogin = 'acme-reviewer';
        },
      });
      const { domain } = h;
      const task = await domain.tasks.create('AR', { title: 'Fictional identity check' }, OWNER_ACTOR);
      domain.tasks.assign('AR', task.key, 'dev-1', OWNER_ACTOR);
      domain.tasks.addLink('AR', task.key, { kind: 'pull_request', repo: 'acme/web', ref: '7' }, OWNER_ACTOR);
      const published: unknown[] = [];
      domain.bus.subscribe((event) => published.push(event));
      await domain.githubSync.handleChange(pullRequest({ authorLogin: 'ACME-Reviewer' }));
      domain.tasks.assign('AR', task.key, 'dev-2', OWNER_ACTOR);
      expect(domain.tasks.get('AR', task.key).links[0]!.author).toBe('cr');
      expect((await domain.members.roster('AR')).find((member) => member.handle === 'cr')!.githubLogin).toBe(
        'acme-reviewer',
      );
      expect(published).toContainEqual(expect.objectContaining({ type: 'task_upserted' }));
      await domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
        delete config.team.members.find((member) => member.handle === 'cr')!.githubLogin;
        return 'Remove fictional login mapping';
      });
      await domain.githubSync.handleChange(pullRequest({ authorLogin: 'acme-reviewer' }));
      expect(() =>
        domain.tasks.setCheck('AR', task.key, check, 'passed', { kind: 'ai', handle: 'cr' }),
      ).toThrow(expect.objectContaining({ code: 'self_review_forbidden' }));
      expect(
        domain.tasks.setCheck('AR', task.key, check, 'passed', { kind: 'human', handle: 'owner' }).checks[
          check
        ],
      ).toBe('passed');
    },
  );

  it('matches a PR fetched before linking and retains fallback for unknown GitHub logins', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        config.team.members[0]!.githubLogin = 'acme-owner';
      },
    });
    const { domain } = h;
    const task = await domain.tasks.create('AR', { title: 'Fictional cached PR' }, OWNER_ACTOR);
    domain.tasks.assign('AR', task.key, 'dev-1', OWNER_ACTOR);
    domain.tasks.recordPullRequest(pullRequest({ authorLogin: 'acme-owner' }));
    domain.tasks.addLink('AR', task.key, { kind: 'pull_request', repo: 'acme/web', ref: '7' }, OWNER_ACTOR);
    expect(domain.tasks.get('AR', task.key).links[0]!.author).toBe('owner');
    domain.tasks.recordPullRequest(pullRequest({ number: 8, authorLogin: 'acme-external' }));
    domain.tasks.addLink('AR', task.key, { kind: 'pull_request', repo: 'acme/web', ref: '8' }, OWNER_ACTOR);
    expect(domain.tasks.get('AR', task.key).links[1]!.author).toBe('dev-1');
  });
});
