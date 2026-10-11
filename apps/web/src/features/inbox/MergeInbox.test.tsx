import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

/** The request to the merger and the alert of a stopped merge in "Rád vár" (PM-453). */

/** AC-27 waits in the stage before the release, and `owner` (the viewer) is its merger. */
function humanMerger() {
  const project = mockProject();
  project.backend.config.team.merger = { kind: 'member', handle: 'owner' };
  project.backend.reconcileMerges();
  return project;
}

const cardOf = (heading: string) => screen.getByRole('heading', { name: heading }).closest('article')!;

describe('the merge request in the inbox (PM-453)', () => {
  it('asks the human merger with one button, which starts the merge and clears the item', async () => {
    const project = humanMerger();
    project.render(<InboxPage />, '/p/AC/inbox');
    const heading = t('inbox.mergeRequest.title', { key: 'AC-27' });
    await screen.findByRole('heading', { name: heading });
    const card = cardOf(heading);
    expect(card.textContent).toContain('main');
    expect(within(card).getByRole('link', { name: t('inbox.mergeRequest.open') })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: t('task.merge.button') }));
    await waitFor(() => expect(project.backend.findTask('AC-27')!.merge?.state).toBe('queued'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: heading })).toBeNull());
  });

  it('asks again after a conflict, with the files and the new button text', async () => {
    const project = humanMerger();
    project.backend.setMergeOutcome('AC-27', 'conflict');
    project.backend.handle('POST', '/api/projects/AC/tasks/AC-27/merge', undefined, new URLSearchParams());
    project.backend.runMerge('AC-27');
    project.render(<InboxPage />, '/p/AC/inbox');
    const heading = t('inbox.mergeRequest.failedTitle', { key: 'AC-27' });
    await screen.findByRole('heading', { name: heading });
    const card = cardOf(heading);
    expect(card.textContent).toContain(t('task.merge.failed.unchanged', { base: 'main' }));
    expect(card.textContent).toContain(t('task.merge.failed.guidance'));
    expect(within(card).getByRole('button', { name: t('task.merge.again') })).toBeTruthy();
  });

  it('offers no button while the merger fixes the conflict, only the way to the card', async () => {
    const project = humanMerger();
    project.backend.setMergeOutcome('AC-27', 'conflict');
    project.backend.handle('POST', '/api/projects/AC/tasks/AC-27/merge', undefined, new URLSearchParams());
    project.backend.runMerge('AC-27');
    const merge = project.backend.findTask('AC-27')!.merge!;
    merge.state = 'fixing';
    merge.fix = {
      by: 'owner',
      base: 'b'.repeat(40),
      branch: 'merge-fix/AC-27',
      startedAt: merge.requestedAt,
    };
    project.render(<InboxPage />, '/p/AC/inbox');
    const heading = t('inbox.mergeRequest.failedTitle', { key: 'AC-27' });
    await screen.findByRole('heading', { name: heading });
    const card = cardOf(heading);
    expect(card.textContent).toContain(t('task.merge.fixing.you', { base: 'main' }));
    expect(within(card).queryByRole('button', { name: t('task.merge.again') })).toBeNull();
    expect(within(card).getByRole('link', { name: t('inbox.mergeRequest.open') })).toBeTruthy();
  });

  it('shows the blocked merge as an alert with a retry that starts it again', async () => {
    const project = humanMerger();
    project.backend.setMergeOutcome('AC-27', 'blocked');
    project.backend.handle('POST', '/api/projects/AC/tasks/AC-27/merge', undefined, new URLSearchParams());
    project.backend.runMerge('AC-27');
    expect(project.backend.findTask('AC-27')!.merge?.state).toBe('blocked');
    project.render(<InboxPage />, '/p/AC/inbox');
    const heading = t('inbox.mergeBlocked.title', { key: 'AC-27' });
    await screen.findByRole('heading', { name: heading });
    const card = cardOf(heading);
    // Under the reason, where the branch stands.
    expect(within(card).getByText(t('task.merge.blocked.nowhere', { base: 'main' }))).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: t('task.merge.retry') }));
    await waitFor(() => expect(project.backend.findTask('AC-27')!.merge?.state).toBe('queued'));
  });

  it('shows nothing to a viewer who is not the merger', async () => {
    // The AI code reviewer merges; the owner has no merge item.
    const project = mockProject();
    project.backend.reconcileMerges();
    expect(project.backend.findTask('AC-27')!.merge?.merger).toBe('code-review');
    project.render(<InboxPage />, '/p/AC/inbox');
    await waitFor(() =>
      expect(project.requests.some((request) => request.path.includes('/inbox'))).toBe(true),
    );
    expect(screen.queryByRole('button', { name: t('task.merge.button') })).toBeNull();
    expect(
      screen.queryByRole('heading', { name: t('inbox.mergeRequest.title', { key: 'AC-27' }) }),
    ).toBeNull();
  });
});

describe('a "Vidd tovább" refused for want of the merge (PM-453)', () => {
  it('names who merges under the button, and the card stays', async () => {
    const project = mockProject();
    project.backend.config.team.cardMover = { kind: 'human', handle: 'owner' };
    const task = project.backend.findTask('AC-27')!;
    task.labels.push('pr-merged', 'release-approved');
    // The work was merged when the member finished the step; it no longer is when the mover answers.
    task.merged = {
      via: 'tool',
      mergeCommit: 'c'.repeat(40),
      commit: 'a'.repeat(40),
      repo: 'webshop',
      base: 'main',
      at: new Date().toISOString(),
    };
    expect(project.backend.moveAs('AC-27', 'release', 'be-1').status).toBe(200);
    expect(task.stageId).toBe('merge');
    delete task.merged;
    project.render(<InboxPage />, '/p/AC/inbox');
    const move = await screen.findByRole('button', { name: t('inbox.handOn.move', { stage: 'Élesítés' }) });
    fireEvent.click(move);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('main');
    expect(project.backend.findTask('AC-27')!.stageId).toBe('merge');
  });
});
