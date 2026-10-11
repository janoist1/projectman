import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { findBoardCardLinks } from '../../test/boardCards';
import { mockProject } from '../../test/mockProject';
import { BoardPage } from './BoardPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

/** What the board card of AC-27 says about the merge to the merger, to another member and to a client (PM-453). */
async function cardText(project: ReturnType<typeof mockProject>, overrides = {}): Promise<string> {
  project.render(<BoardPage />, '/', overrides);
  const links = await findBoardCardLinks(project.backend.findTask('AC-27')!.title);
  return links[0]!.closest('[data-card-key]')!.textContent ?? '';
}

describe('the merge on the board card (PM-453)', () => {
  it('tells the merger the card waits for their merge', async () => {
    const project = mockProject();
    project.backend.config.team.merger = { kind: 'member', handle: 'owner' };
    project.backend.reconcileMerges();
    expect(await cardText(project)).toContain(`Rád vár · ${t('taskStatus.next.short.mergeYou')}`);
  });

  it('tells another member that the merge is awaited from the merger', async () => {
    const project = mockProject();
    project.backend.reconcileMerges();
    const text = await cardText(project);
    // The head names the merger (the AI code reviewer), not the viewer.
    const merger = project.backend.config.team.members.find((member) => member.handle === 'code-review')!;
    expect(text).toContain(`${merger.displayName} · ${t('taskStatus.next.short.merge')}`);
    expect(text).not.toContain('Rád vár');
  });

  it('shows a queued merge as the card’s own state', async () => {
    const project = mockProject();
    project.backend.config.team.merger = { kind: 'member', handle: 'owner' };
    project.backend.reconcileMerges();
    project.backend.handle('POST', '/api/projects/AC/tasks/AC-27/merge', undefined, new URLSearchParams());
    expect(await cardText(project)).toContain(t('taskStatus.merge.steps.queued'));
  });

  it('shows a client nothing about the merge', async () => {
    const project = mockProject();
    project.backend.reconcileMerges();
    project.backend.viewerHandle = 'kata';
    const text = await cardText(project, { myHandle: 'kata', isOwner: false });
    expect(text).not.toMatch(/beolvaszt/i);
    expect(screen.queryByText(/beolvaszt/i)).toBeNull();
  });
});
