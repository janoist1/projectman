import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import type { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);

/** The merge route called as the viewer, the way the button does. */
function startMerge(backend: MockBackend) {
  const response = backend.handle(
    'POST',
    '/api/projects/AC/tasks/AC-27/merge',
    undefined,
    new URLSearchParams(),
  );
  expect(response.status).toBe(200);
}

/** AC-27: asked of `owner`, it fails on a conflict, is tried again and merges. */
function mergedAfterConflict() {
  const project = mockProject();
  project.backend.config.team.merger = { kind: 'member', handle: 'owner' };
  project.backend.reconcileMerges();
  project.backend.setMergeOutcome('AC-27', 'conflict');
  startMerge(project.backend);
  project.backend.runMerge('AC-27');
  project.backend.setMergeOutcome('AC-27', 'merged');
  startMerge(project.backend);
  project.backend.runMerge('AC-27');
  expect(project.backend.findTask('AC-27')!.merged).toBeTruthy();
  return project;
}

describe('the merge in the card’s history and properties (PM-453)', () => {
  it('tells the request, the conflict and the merge in the timeline, and the result in the properties', async () => {
    const project = mergedAfterConflict();
    project.render(drawer, '/p/AC/tasks/AC-27');
    await screen.findByText(new RegExp(t('timeline.events.task_merge_requested', { merger: '.*' })));
    expect(
      screen.getByText(
        t('timeline.events.task_merge_failed', {
          what: t('timeline.events.merge_failed_conflict', { count: 2 }),
        }),
      ),
    ).toBeTruthy();
    expect(screen.getByText(new RegExp('^Beolvasztotta a main ágba'))).toBeTruthy();
    // The properties tell where the work went; no merge box is left.
    expect(screen.getByText(t('task.merge.merged.label'))).toBeTruthy();
    expect(screen.queryByTestId('merge-box')).toBeNull();
  });

  it('tells a blocked merge in the timeline', async () => {
    const project = mockProject();
    project.backend.config.team.merger = { kind: 'member', handle: 'owner' };
    project.backend.reconcileMerges();
    project.backend.setMergeOutcome('AC-27', 'blocked');
    startMerge(project.backend);
    project.backend.runMerge('AC-27');
    project.render(drawer, '/p/AC/tasks/AC-27');
    expect((await screen.findAllByText(new RegExp('^A beolvasztás elakadt: '))).length).toBeGreaterThan(0);
  });
});

describe('a client reads the merge like any member (PM-79)', () => {
  it('shows the merge in the timeline and the result in the properties, with no way to merge', async () => {
    const project = mergedAfterConflict();
    project.backend.viewerHandle = 'kata';
    project.render(drawer, '/p/AC/tasks/AC-27', { myHandle: 'kata', isOwner: false });
    expect(await screen.findByText(t('task.merge.merged.label'))).toBeTruthy();
    expect(screen.getByText(new RegExp('^Beolvasztotta a main ágba'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('task.merge.button') })).toBeNull();
  });
});
