import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { alertPayloadOf } from '@projectman/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
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

const mergeBox = () => screen.findByTestId('merge-box');
const route = '/p/AC/tasks/AC-27';

/** AC-27 waits in the stage before the release; `merger` merges it (default: the viewer, `owner`). */
function mergeProject(merger: string | null = 'owner') {
  const project = mockProject();
  if (merger) project.backend.config.team.merger = { kind: 'member', handle: merger };
  project.backend.reconcileMerges();
  return project;
}

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

/** The merger's inbox items go: the drawer then shows the card's own merge box in their place. */
function withoutMergeItems(backend: MockBackend) {
  backend.inbox = backend.inbox.filter(
    (item) => item.kind !== 'merge_request' && alertPayloadOf(item)?.alert !== 'merge_blocked',
  );
}

describe('a human merger in the drawer (PM-453)', () => {
  it('gets the merge request as the inbox card, with one button and no second box', async () => {
    const project = mergeProject();
    project.render(drawer, route);
    const button = await screen.findByRole('button', { name: t('task.merge.button') });
    expect(screen.getAllByRole('button', { name: t('task.merge.button') })).toHaveLength(1);
    expect(screen.queryByTestId('merge-box')).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(project.backend.findTask('AC-27')!.merge?.state).toBe('queued'));
    expect(
      project.requests.some((request) => request.method === 'POST' && request.path.endsWith('/resolve')),
    ).toBe(true);
    // The queued merge is the box's business now.
    expect(await screen.findByRole('region', { name: t('task.merge.queued.title') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('task.merge.button') })).toBeNull();
  });

  it('gets the box, not the inbox card, once the merge is blocked: the steps, the base and one retry', async () => {
    const project = mergeProject();
    project.backend.setMergeOutcome('AC-27', 'blocked');
    startMerge(project.backend);
    project.backend.runMerge('AC-27');
    expect(project.backend.findTask('AC-27')!.merge?.state).toBe('blocked');
    expect(project.backend.inbox.some((item) => alertPayloadOf(item)?.alert === 'merge_blocked')).toBe(true);
    project.render(drawer, route);
    const box = within(await mergeBox());
    expect(box.getByText(t('task.merge.blocked.nowhere', { base: 'main' }))).toBeTruthy();
    expect(screen.getAllByRole('button', { name: t('task.merge.retry') })).toHaveLength(1);
    fireEvent.click(box.getByRole('button', { name: t('task.merge.retry') }));
    await waitFor(() => expect(project.backend.findTask('AC-27')!.merge?.state).toBe('queued'));
  });

  it('gets the box with "Vissza a fejlesztőnek" after a conflict, though the request item is open', async () => {
    const project = mergeProject();
    project.backend.setMergeOutcome('AC-27', 'conflict');
    startMerge(project.backend);
    project.backend.runMerge('AC-27');
    expect(project.backend.findTask('AC-27')!.merge?.state).toBe('failed');
    expect(project.backend.inbox.some((item) => item.kind === 'merge_request')).toBe(true);
    project.render(drawer, route);
    const box = within(await mergeBox());
    expect(box.getByRole('button', { name: t('task.merge.sendBack') })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: t('task.merge.again') })).toHaveLength(1);
  });
});

describe('the merge box in the drawer (PM-453)', () => {
  it('asks the merger to merge, with the base and the button', async () => {
    const project = mergeProject();
    withoutMergeItems(project.backend);
    project.render(drawer, route);
    const box = await mergeBox();
    expect(box.getAttribute('data-merge-state')).toBe('requested');
    expect(screen.getByRole('region', { name: t('task.merge.requested.title') })).toBe(box);
    expect(box.textContent).toContain('main');
    expect(within(box).getByRole('button', { name: t('task.merge.button') })).toBeTruthy();
  });

  it('starts the merge on a click and follows it to the merged result', async () => {
    const project = mergeProject();
    withoutMergeItems(project.backend);
    const view = project.render(drawer, route);
    const box = await mergeBox();
    fireEvent.click(within(box).getByRole('button', { name: t('task.merge.button') }));
    await waitFor(() => expect(project.backend.findTask('AC-27')!.merge?.state).toBe('queued'));
    expect(
      project.requests.some(
        (request) => request.method === 'POST' && request.path.endsWith('/tasks/AC-27/merge'),
      ),
    ).toBe(true);
    expect(await screen.findByRole('region', { name: t('task.merge.queued.title') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('task.merge.button') })).toBeNull();

    project.backend.advanceMerge('AC-27');
    view.unmount();
    project.render(drawer, route);
    const running = await screen.findByRole('region', {
      name: t('task.merge.running.title', { base: 'main' }),
    });
    expect(running.getAttribute('data-merge-state')).toBe('running');
    expect(running.getAttribute('aria-live')).toBe('polite');
    expect(
      within(running).getByRole('heading', { name: t('task.merge.running.title', { base: 'main' }) }),
    ).toBeTruthy();
    expect(within(running).getAllByRole('listitem').length).toBeGreaterThan(0);

    project.backend.runMerge('AC-27');
    expect(project.backend.findTask('AC-27')!.merged?.base).toBe('main');
    expect(project.backend.findTask('AC-27')!.merge).toBeUndefined();
  });

  it('shows the wait for the machine’s test queue in the check’s row, then the check running', async () => {
    const project = mergeProject();
    project.backend.config.project.repos.forEach((repo) => {
      repo.reviewTest = { command: 'npm test', maxWorkers: 2, timeoutMinutes: 15 };
    });
    withoutMergeItems(project.backend);
    startMerge(project.backend);
    project.backend.advanceMerge('AC-27');
    project.backend.advanceMerge('AC-27');
    expect(project.backend.findTask('AC-27')!.merge?.step).toBe('check_waiting');
    const view = project.render(drawer, route);
    const waiting = await mergeBox();
    expect(
      within(waiting).getByText(t('task.merge.running.checkWaiting', { check: 'npm test' })),
    ).toBeTruthy();
    expect(within(waiting).queryByText(t('task.merge.running.check', { check: 'npm test' }))).toBeNull();
    expect(waiting.textContent).toContain(t('task.merge.running.active'));

    project.backend.advanceMerge('AC-27');
    expect(project.backend.findTask('AC-27')!.merge?.step).toBe('checking');
    view.unmount();
    project.render(drawer, route);
    const checking = await mergeBox();
    expect(within(checking).getByText(t('task.merge.running.check', { check: 'npm test' }))).toBeTruthy();
    expect(
      within(checking).queryByText(t('task.merge.running.checkWaiting', { check: 'npm test' })),
    ).toBeNull();
  });

  it('shows a conflict with the files and offers to merge again or send the card back', async () => {
    const project = mergeProject();
    project.backend.setMergeOutcome('AC-27', 'conflict');
    startMerge(project.backend);
    project.backend.runMerge('AC-27');
    withoutMergeItems(project.backend);
    project.render(drawer, route);
    const failed = await mergeBox();
    expect(failed.getAttribute('data-merge-state')).toBe('failed');
    expect(within(failed).getByRole('heading', { name: t('task.merge.failed.conflictTitle') })).toBeTruthy();
    expect(failed.textContent).toContain(t('task.merge.failed.unchanged', { base: 'main' }));
    expect(within(failed).getByRole('button', { name: t('task.merge.again') })).toBeTruthy();
    expect(within(failed).getByRole('button', { name: t('task.merge.sendBack') })).toBeTruthy();
  });

  it('shows a failed check with its own title', async () => {
    const project = mergeProject();
    project.backend.setMergeOutcome('AC-27', 'check_failed');
    startMerge(project.backend);
    project.backend.runMerge('AC-27');
    withoutMergeItems(project.backend);
    project.render(drawer, route);
    await mergeBox();
    expect(screen.getByRole('heading', { name: t('task.merge.failed.checkTitle') })).toBeTruthy();
  });

  it('shows a blocked merge with a retry for the merger', async () => {
    const project = mergeProject();
    project.backend.setMergeOutcome('AC-27', 'blocked');
    startMerge(project.backend);
    project.backend.runMerge('AC-27');
    withoutMergeItems(project.backend);
    project.render(drawer, route);
    const blocked = await mergeBox();
    expect(blocked.getAttribute('data-merge-state')).toBe('blocked');
    expect(within(blocked).getByRole('heading', { name: t('task.merge.blocked.title') })).toBeTruthy();
    fireEvent.click(within(blocked).getByRole('button', { name: t('task.merge.retry') }));
    await waitFor(() => expect(project.backend.findTask('AC-27')!.merge?.state).toBe('queued'));
  });
});

describe('a conflict the merger fixes (PM-471)', () => {
  function fixingProject(viewerIsMerger: boolean) {
    const project = mergeProject(viewerIsMerger ? 'owner' : 'code-review');
    project.backend.setMergeOutcome('AC-27', 'conflict');
    if (!viewerIsMerger) project.backend.viewerHandle = 'code-review';
    startMerge(project.backend);
    project.backend.runMerge('AC-27');
    project.backend.viewerHandle = 'owner';
    const merge = project.backend.findTask('AC-27')!.merge!;
    merge.state = 'fixing';
    merge.fix = {
      by: merge.merger,
      base: 'b'.repeat(40),
      branch: 'merge-fix/AC-27',
      startedAt: merge.requestedAt,
    };
    return project;
  }

  it('says who fixes it and offers no button', async () => {
    const project = fixingProject(false);
    project.render(drawer, route);
    const box = await mergeBox();
    expect(box.getAttribute('data-merge-state')).toBe('fixing');
    expect(box.getAttribute('aria-live')).toBe('polite');
    expect(within(box).getByRole('heading', { name: t('task.merge.fixing.title') })).toBeTruthy();
    expect(box.textContent).toContain('main');
    expect(within(box).queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText(t('task.merge.fixNote.label'))).toBeNull();
  });

  it('gives the human fixer a note field and submit button in place of the request item', async () => {
    const project = fixingProject(true);
    expect(project.backend.inbox.some((item) => item.kind === 'merge_request')).toBe(true);
    project.render(drawer, route);
    const box = await mergeBox();
    expect(box.textContent).toContain(t('task.merge.fixing.you', { base: 'main' }));
    expect(box.getAttribute('aria-live')).toBeNull();
    expect(screen.queryByRole('button', { name: t('task.merge.again') })).toBeNull();
    expect(screen.getByRole('button', { name: t('task.merge.button') })).toBeTruthy();
    expect(screen.getByLabelText(t('task.merge.fixNote.label'))).toBeTruthy();
  });

  it('preserves the draft on refresh, counts long notes, and clears it for a new fix round', async () => {
    const project = fixingProject(true);
    const { client } = project.render(drawer, route);
    const field = await screen.findByLabelText(t('task.merge.fixNote.label'));
    expect(field.getAttribute('maxlength')).toBe('2000');
    fireEvent.change(field, { target: { value: 'a'.repeat(1800) } });
    expect(screen.queryByText(t('task.merge.fixNote.count', { count: 1800 }))).toBeNull();
    fireEvent.change(field, { target: { value: 'a'.repeat(1801) } });
    expect(screen.getByText(t('task.merge.fixNote.count', { count: 1801 }))).toBeTruthy();
    await act(() => client.invalidateQueries({ queryKey: queryKeys.task('AC', 'AC-27') }));
    expect((field as HTMLTextAreaElement).value).toHaveLength(1801);
    project.backend.findTask('AC-27')!.merge!.fix!.startedAt = '2026-10-12T00:00:00.000Z';
    await act(() => client.invalidateQueries({ queryKey: queryKeys.task('AC', 'AC-27') }));
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe(''));
    project.backend.findTask('AC-27')!.merge = undefined;
    await act(() => client.invalidateQueries({ queryKey: queryKeys.task('AC', 'AC-27') }));
    await waitFor(() => expect(screen.queryByLabelText(t('task.merge.fixNote.label'))).toBeNull());
  });

  it('requires a note, preserves it after a server error, and submits it to the timeline', async () => {
    const project = mergeProject();
    project.backend.setMergeOutcome('AC-27', 'conflict');
    startMerge(project.backend);
    project.backend.runMerge('AC-27');
    const { client } = project.render(drawer, route);
    fireEvent.click(await screen.findByRole('button', { name: t('task.merge.fix.start') }));
    const field = await screen.findByLabelText(t('task.merge.fixNote.label'));
    expect(project.requests.find((request) => request.path.endsWith('/merge'))?.body).toEqual({
      fixConflict: true,
    });
    expect(screen.getByText('git merge ' + project.backend.findTask('AC-27')!.merge!.fix!.base)).toBeTruthy();
    const count = project.requests.filter((request) => request.path.endsWith('/merge')).length;
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: t('task.merge.button') }));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field);
    expect(project.requests.filter((request) => request.path.endsWith('/merge'))).toHaveLength(count);
    fireEvent.change(field, { target: { value: '  Resolve adjacent imports  ' } });
    expect(field.getAttribute('aria-invalid')).toBeNull();
    project.backend.setMergeFixError('AC-27', 'uncommitted');
    fireEvent.click(screen.getByRole('button', { name: t('task.merge.button') }));
    await screen.findByRole('alert');
    expect((field as HTMLTextAreaElement).value).toBe('  Resolve adjacent imports  ');
    project.backend.setMergeFixError('AC-27');
    project.backend.setMergeOutcome('AC-27', 'merged');
    fireEvent.click(screen.getByRole('button', { name: t('task.merge.button') }));
    await waitFor(() => expect(project.backend.findTask('AC-27')!.merge?.state).toBe('queued'));
    expect(project.requests.filter((request) => request.path.endsWith('/merge')).at(-1)?.body).toEqual({
      resolution: 'Resolve adjacent imports',
    });
    project.backend.runMerge('AC-27');
    expect(project.backend.findTask('AC-27')!.merged?.resolution?.note).toBe('Resolve adjacent imports');
    await act(() => client.invalidateQueries({ queryKey: queryKeys.task('AC', 'AC-27') }));
    fireEvent.click(await screen.findByText(t('timeline.events.merged_resolution')));
    expect(screen.getAllByText('Resolve adjacent imports', { selector: 'p' }).length).toBeGreaterThan(0);
  });

  it('is refused by the merge route while the fix is under way', async () => {
    const project = fixingProject(true);
    const response = project.backend.handle(
      'POST',
      '/api/projects/AC/tasks/AC-27/merge',
      undefined,
      new URLSearchParams(),
    );
    expect(response.status).toBe(409);
    expect(project.backend.findTask('AC-27')!.merge?.state).toBe('fixing');
  });
});

describe('an AI merger, seen by another member (PM-453)', () => {
  it('shows no button while the request waits, and "Miért áll?" names the merger', async () => {
    // The default merger is the AI code reviewer; the viewer (`owner`) is not them.
    const project = mergeProject(null);
    project.render(drawer, route);
    const why = await screen.findByRole('region', { name: t('task.whyBox.title') });
    expect(screen.queryByTestId('merge-box')).toBeNull();
    expect(screen.queryByRole('button', { name: t('task.merge.button') })).toBeNull();
    const merger = project.backend.findTask('AC-27')!.merge!.merger;
    const name = project.backend.config.team.members.find((member) => member.handle === merger)!.displayName;
    expect(merger).not.toBe('owner');
    expect(why.textContent).toContain(name);
  });

  it('shows a failed merge as it is, without the merger’s buttons', async () => {
    const project = mergeProject('code-review');
    project.backend.setMergeOutcome('AC-27', 'conflict');
    project.backend.viewerHandle = 'code-review';
    startMerge(project.backend);
    project.backend.runMerge('AC-27');
    project.backend.viewerHandle = 'owner';
    project.render(drawer, route);
    const box = await mergeBox();
    expect(box.getAttribute('data-merge-state')).toBe('failed');
    expect(within(box).queryByRole('button', { name: t('task.merge.again') })).toBeNull();
    expect(box.textContent).toContain('main');
  });
});
