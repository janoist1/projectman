import { OWNER_ACTOR } from './domain-harness';
import type { DomainHarness } from './domain-harness';

/** A commit id as the repository would print it. */
export const sha = (n: number) => n.toString(16).padStart(40, '0');

/**
 * Cards merged one after the other on a repository's default branch (PM-1201), each landing as the commit and at the
 * time given; the repository needs `github` set in the config. Returns the card keys in the same order.
 */
export async function mergeCards(
  h: DomainHarness,
  repo: string,
  merges: readonly { commit: string; at: string }[],
): Promise<string[]> {
  const keys: string[] = [];
  for (const [index, { commit, at }] of merges.entries()) {
    const card = await h.domain.tasks.create('AR', { title: 'Card', repo }, OWNER_ACTOR);
    h.repos.taskMerges.save({
      id: `mrg_${repo}_${index}`,
      projectKey: 'AR',
      taskKey: card.key,
      repo,
      base: 'main',
      commit: `branch-${card.key}`,
      branch: `pm/${card.key}`,
      fromStageId: 'code_review',
      toStageId: 'done',
      merger: 'dev-1',
      requestedAt: at,
      startedBy: 'dev-1',
      startedAt: at,
      mergeCommit: commit,
      landed: 'nowhere',
      state: 'merged',
      step: 'finishing',
      createdAt: at,
      updatedAt: at,
      finishedAt: at,
    });
    keys.push(card.key);
  }
  return keys;
}

/** What `publish_release` records: the release of the repository up to `commit`, which becomes the new base. */
export function publishRelease(h: DomainHarness, repo: string, commit: string, at: string): void {
  h.repos.releasePublications.insert({
    id: `pub_${repo}_${commit.slice(-4)}`,
    projectKey: 'AR',
    repo,
    commit,
    baseCommit: null,
    tag: `v${at.slice(0, 10)}-${commit.slice(-2)}`,
    tasks: [],
    summary: '- Things changed',
    publishedBy: 'devops',
    taggedAt: at,
    url: `https://github.com/acme/${repo}/releases/tag/${commit.slice(-4)}`,
    publishedAt: at,
  });
}
