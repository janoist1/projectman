import { nameOf } from '../../lib/members';
import { mockIndexes } from '../../test/render';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { plainLanguageQuestion } from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { t } from '../../i18n/t';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);

/** Opens the "⋯" menu of the rare task actions. */
const openMenu = async () =>
  fireEvent.click(await screen.findByRole('button', { name: t('taskLifecycle.title') }));

describe('task drawer lifecycle', () => {
  it.each([
    'ai_limit_reached',
    'plan_usage_paused',
    'ai_disabled',
    'member_at_capacity',
    'repo_required',
    'no_free_member',
  ] as const)('shows the waiting label and owner hint for %s', async (reason) => {
    const project = mockProject();
    const task = project.backend.findTask('AC-20')!;
    task.startWaiting = {
      reason,
      member: 'be-1',
      provider: 'claude',
      threshold: 80,
      since: task.updatedAt,
    };
    project.render(drawer, '/p/AC/tasks/AC-20');
    await screen.findByText(
      t(`taskStatus.startWaiting.${reason}`, {
        provider: t('providers.claude'),
        percent: 80,
        name: nameOf('be-1', mockIndexes().members, 'owner'),
      }),
    );
    expect(screen.getByText(t(`taskStatus.startHints.${reason}`))).toBeTruthy();
  });
  it('shows the commit handed over for review (PM-183)', async () => {
    const project = mockProject();
    const task = project.backend.findTask('AC-20')!;
    task.reviewPin = { commit: 'abcdef0123456789', branch: 'AC-20-fix', pinnedAt: task.updatedAt };
    project.render(drawer, '/p/AC/tasks/AC-20');
    await screen.findByText(t('task.reviewPin.label'));
    expect(screen.getByText('abcdef01')).toBeTruthy();
    expect(screen.getByText(/AC-20-fix/)).toBeTruthy();
  });
  it('confirms cancellation with a reason, stops live sessions, and reopens unassigned', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    await openMenu();
    fireEvent.click(await screen.findByRole('button', { name: t('taskLifecycle.cancel') }));
    expect(project.backend.findTask('AC-20')?.status).toBe('active');
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('taskLifecycle.reason'))), {
      target: { value: 'Acme scope changed.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t('taskLifecycle.cancel') }));
    await openMenu();
    await screen.findByRole('button', { name: t('taskLifecycle.reopen') });
    expect(project.backend.findTask('AC-20')).toMatchObject({ status: 'cancelled', assignee: 'be-1' });
    expect(project.backend.findSession('ses_ac20_be1')?.state).toBe('exited');
    expect(
      screen.getByText(t('timeline.events.task_cancelled_reason', { reason: 'Acme scope changed.' })),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('taskLifecycle.reopen') }));
    await waitFor(() => expect(project.backend.findTask('AC-20')?.status).toBe('active'));
    expect(project.backend.findTask('AC-20')).toMatchObject({
      status: 'active',
      assignee: null,
      closedAt: null,
      stageId: 'dev',
    });
    expect(screen.getByText(t('timeline.events.task_reopened'))).toBeTruthy();
  });
  it('offers stopping a live session, then allows changing and clearing the assignee', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    // The select saves on change: there is no save button.
    const select = (await screen.findByLabelText(t('taskLifecycle.assignee'))) as HTMLSelectElement;
    expect(screen.queryByRole('button', { name: /Felelős mentése/ })).toBeNull();
    fireEvent.change(select, { target: { value: 'kata' } });
    // The live session refuses the change; the pick stays shown next to the way out.
    fireEvent.click(await screen.findByRole('button', { name: t('taskLifecycle.stop') }));
    await waitFor(() => expect(project.backend.findTask('AC-20')?.assignee).toBe('kata'));
    expect(screen.queryByRole('button', { name: t('taskLifecycle.stop') })).toBeNull();
    await screen.findByText(/Előző felelős: Backend fejlesztő/);
    fireEvent.change(screen.getByLabelText(t('taskLifecycle.assignee')), { target: { value: '' } });
    await waitFor(() => expect(project.backend.findTask('AC-20')?.assignee).toBeNull());
    expect(project.requests).toContainEqual({
      method: 'PATCH',
      path: '/api/projects/AC/tasks/AC-20',
      body: { assignee: null },
    });
  });
  it('does not offer a member on leave as the assignee, but still shows one it already has', async () => {
    const project = mockProject();
    for (const handle of ['fe-1', 'be-1'])
      project.backend.handle('PATCH', `/api/projects/AC/members/${handle}`, { onLeave: true });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const select = (await screen.findByLabelText(t('taskLifecycle.assignee'))) as HTMLSelectElement;
    const option = (handle: string) => Array.from(select.options).find((o) => o.value === handle)!;
    expect(option('fe-1').disabled).toBe(true);
    expect(option('fe-1').textContent).toContain(t('leave.onLeave'));
    // The assignee of the task stays selectable, so the select can show it.
    expect(option('be-1').disabled).toBe(false);
    expect(select.value).toBe('be-1');
    expect(option('kata').disabled).toBe(false);
  });
  it('hides lifecycle controls from non-admin members', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20', {
      can: { createTasks: true, manageTeam: false, workInSessions: false },
    });
    await screen.findByText('Napi mentés és visszaállítási próba');
    expect(screen.queryByRole('button', { name: t('taskLifecycle.title') })).toBeNull();
    expect(screen.queryByLabelText(t('taskLifecycle.assignee'))).toBeNull();
    // The assignee is still told, as plain text.
    expect(screen.getByText(t('taskLifecycle.assignee')).parentElement?.textContent).toContain(
      'Backend fejlesztő',
    );
  });
});

/** Opens the small move panel and returns its target select. */
const openMove = async () => {
  fireEvent.click(await screen.findByRole('button', { name: t('task.move.open') }));
  return screen.findByLabelText(t('task.move.target'));
};

describe('task drawer stage moves', () => {
  it('keeps the move panel closed until asked, and shows no gate line without conditions', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    const trigger = await screen.findByRole('button', { name: t('task.move.open') });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText(t('task.move.target'))).toBeNull();
    await openMove();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText(t('task.move.conditions'))).toBeNull();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText(t('task.move.target'))).toBeNull());
  });
  it('defaults to the next stage and moves successfully', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    const target = await openMove();
    expect((target as HTMLSelectElement).value).toBe('code_review');
    fireEvent.click(screen.getByRole('button', { name: t('task.move.submit') }));
    await waitFor(() => expect(project.backend.findTask('AC-20')?.stageId).toBe('code_review'));
    // The panel closes after the move; opened again it offers the stage after the new one.
    await waitFor(() => expect(screen.queryByLabelText(t('task.move.target'))).toBeNull());
    expect(((await openMove()) as HTMLSelectElement).value).toBe('integration');
    expect(project.requests).toContainEqual({
      method: 'PATCH',
      path: '/api/projects/AC/tasks/AC-20',
      body: { stageId: 'code_review' },
    });
  });
  it('previews gates and lists unmet conditions inline without moving', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    fireEvent.change(await openMove(), {
      target: { value: 'client_test' },
    });
    expect(screen.getByText(/Integration:/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('task.move.submit') }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      t('settings.pipeline.gateHasLabel', { label: 'Code review rendben' }),
    );
    expect(alert.textContent).toContain(t('settings.pipeline.gateHasLabel', { label: 'QA rendben' }));
    expect(project.backend.findTask('AC-20')?.stageId).toBe('dev');
  });
  it('reports requested approval as information and stays in the original stage', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-17');
    await openMove();
    fireEvent.click(screen.getByRole('button', { name: t('task.move.submit') }));
    expect(await screen.findByText(t('errors.codes.approval_requested'))).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(project.backend.findTask('AC-17')?.stageId).toBe('merge');
    expect(
      project.backend.inbox.some(
        (item) => item.taskKey === 'AC-17' && item.kind === 'decision' && item.state === 'open',
      ),
    ).toBe(true);
  });
  it('says why nobody may approve the move when the only approver authored the task', async () => {
    const project = mockProject();
    project.backend.config.team.releaseFourEyes = true;
    const task = project.backend.findTask('AC-28')!;
    task.stageId = 'merge';
    task.links[0]!.author = 'owner';
    project.render(drawer, '/p/AC/tasks/AC-28');
    await openMove();
    fireEvent.click(screen.getByRole('button', { name: t('task.move.submit') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('errors.codes.release_four_eyes'));
    expect(project.backend.findTask('AC-28')?.stageId).toBe('merge');
    expect(project.backend.inbox.some((item) => item.taskKey === 'AC-28' && item.state === 'open')).toBe(
      false,
    );
  });
  it.each(['client', 'viewer'])('hides moving from %s access', async (access) => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20', {
      myHandle: access === 'client' ? 'kata' : 'bence',
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    await screen.findByText(project.backend.findTask('AC-20')!.title);
    expect(screen.queryByRole('button', { name: t('task.move.open') })).toBeNull();
  });
  it.each(['done', 'cancelled'] as const)('hides moving for %s tasks', async (status) => {
    const project = mockProject();
    project.backend.updateTask('AC-20', { status });
    project.render(drawer, '/p/AC/tasks/AC-20');
    await screen.findByText(project.backend.findTask('AC-20')!.title);
    expect(screen.queryByRole('button', { name: t('task.move.open') })).toBeNull();
  });
});

describe('task drawer labels', () => {
  /** The label changes the drawer sent, in order. */
  const labelChanges = (project: ReturnType<typeof mockProject>) =>
    project.requests
      .filter((request) => request.method === 'POST' && request.path.endsWith('/tasks/AC-20/labels'))
      .map((request) => request.body);
  /** The labels section once it is editable (the label rules come with the configuration). */
  const labelsSection = async () => {
    const section = await screen.findByRole('region', { name: t('task.labels.title') });
    await within(section).findByRole('button', { name: t('task.labels.add') });
    return section;
  };

  it('adds and removes labels under their rules, asking for the reason where needed', async () => {
    const project = mockProject();
    project.backend.config.pipeline.labels.push({
      id: 'needs-info',
      name: 'Infó kell',
      setBy: 'anyone',
      requiresComment: true,
    });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const section = await labelsSection();
    fireEvent.click(within(section).getByRole('button', { name: t('task.labels.add') }));
    fireEvent.click(within(section).getByRole('button', { name: /Válaszra vár/ }));
    // The timeline names the label, not its id.
    await screen.findByText(t('timeline.labelsAdded', { labels: 'Válaszra vár' }));
    fireEvent.click(
      await within(section).findByRole('button', {
        name: t('task.labels.remove', { label: 'Válaszra vár' }),
      }),
    );
    await screen.findByText(t('timeline.labelsRemoved', { labels: 'Válaszra vár' }));
    expect(
      within(section).queryByRole('button', { name: t('task.labels.remove', { label: 'Válaszra vár' }) }),
    ).toBeNull();

    // A label that needs a reason asks for it and records it as a comment.
    fireEvent.click(within(section).getByRole('button', { name: /Infó kell/ }));
    const reason = within(section).getByLabelText(t('task.labels.comment', { label: 'Infó kell' }), {
      exact: false,
    });
    fireEvent.change(reason, { target: { value: 'Which Acme market?' } });
    fireEvent.click(
      within(section)
        .getAllByRole('button', { name: t('task.labels.apply') })
        .at(-1)!,
    );
    // The reason shows as a comment on the timeline.
    await screen.findByText('Which Acme market?');
    expect(labelChanges(project)).toEqual([
      { add: ['waiting-answer'] },
      { remove: ['waiting-answer'] },
      { add: ['needs-info'], comment: 'Which Acme market?' },
    ]);
  });

  it('explains why a label cannot be set and keeps viewers read-only', async () => {
    const project = mockProject();
    project.backend.config.pipeline.labels.push({
      id: 'qa-only',
      name: 'Csak QA',
      setBy: { members: ['qa'] },
    });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const section = await labelsSection();
    fireEvent.click(within(section).getByRole('button', { name: t('task.labels.add') }));
    const option = within(section).getByRole('button', { name: /Csak QA/ });
    expect((option as HTMLButtonElement).disabled).toBe(true);
    expect(option.textContent).toContain(t('task.labels.refusal.not_holder'));
  });

  it('keeps the assignee from approving the release of their own work under four eyes', async () => {
    const project = mockProject();
    project.backend.config.team.releaseFourEyes = true;
    project.backend.findTask('AC-20')!.assignee = 'owner';
    const approval = project.backend.config.pipeline.labels.find((label) => label.id === 'release-approved')!;
    project.render(drawer, '/p/AC/tasks/AC-20');
    const section = await labelsSection();
    fireEvent.click(within(section).getByRole('button', { name: t('task.labels.add') }));
    const option = within(section).getByRole('button', { name: new RegExp(approval.name) });
    expect((option as HTMLButtonElement).disabled).toBe(true);
    expect(option.textContent).toContain(t('task.labels.refusal.self_review'));
  });

  it('shows label errors from the server inline', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    const section = await labelsSection();
    fireEvent.click(within(section).getByRole('button', { name: t('task.labels.add') }));
    // The label rules change after the drawer has loaded, before the human picks.
    project.backend.config.pipeline.labels = project.backend.config.pipeline.labels.map((label) =>
      label.id === 'waiting-answer' ? { ...label, setBy: 'system' as const } : label,
    );
    fireEvent.click(within(section).getByRole('button', { name: /Válaszra vár/ }));
    expect((await within(section).findByRole('alert')).textContent).toBe(t('errors.codes.label_not_allowed'));
  });
});

describe('task drawer comments', () => {
  it('filters autocomplete by handle and name, selects with arrows and Enter, and sends', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    const input = await screen.findByLabelText(t('task.comments.label'));
    fireEvent.change(input, { target: { value: 'Hello @', selectionStart: 7 } });
    const list = screen.getByRole('listbox', { name: t('task.comments.members') });
    const options = within(list).getAllByRole('option');
    const firstHandle = options[0]!.textContent!.split('@').pop()!;
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(options.at(-1)!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((input as HTMLTextAreaElement).value).toBe(`Hello @${firstHandle} `);
    const member = project.backend.config.team.members.find((member) => member.handle === 'fe-1')!;
    fireEvent.change(input, { target: { value: `Hello @${member.displayName.slice(0, 3)}` } });
    expect(screen.getByRole('listbox').textContent).toContain(member.displayName);
    fireEvent.change(input, { target: { value: 'Hello @fe-' } });
    fireEvent.click(
      within(screen.getByRole('listbox')).getByRole('button', { name: `${member.displayName} @fe-1` }),
    );
    expect((input as HTMLTextAreaElement).value).toBe('Hello @fe-1 ');
    fireEvent.click(screen.getByRole('button', { name: t('common.send') }));
    await waitFor(() =>
      expect(project.requests).toContainEqual({
        method: 'POST',
        path: '/api/projects/AC/tasks/AC-20/comments',
        body: { text: 'Hello @fe-1' },
      }),
    );
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
    const event = project.backend.timeline.find(
      (event) => event.taskKey === 'AC-20' && event.data.text === 'Hello @fe-1',
    )!;
    expect(event.data.mentions).toEqual(['fe-1']);
    expect(project.backend.messages.some((message) => message.body === 'Hello @fe-1')).toBe(true);
  });

  it('preserves line breaks and renders imported attribution and mention chips', async () => {
    const project = mockProject();
    const at = '2024-01-02T03:04:05Z';
    project.backend.handle('POST', '/api/projects/AC/tasks/AC-20/comments', {
      text: 'History\n@FE-1 and mail@fe-1.test',
      importedAuthor: 'Morgan Example',
      importedAt: at,
    });
    const count = project.backend.messages.length;
    project.render(drawer, '/p/AC/tasks/AC-20');
    const author = await screen.findByText('Morgan Example');
    const row = author.closest('li')!;
    expect(within(row).getByText(t('task.comments.imported'), { exact: false })).toBeTruthy();
    expect(row.querySelector('time')?.getAttribute('dateTime')).toBe(at);
    const member = project.backend.config.team.members.find((member) => member.handle === 'fe-1')!;
    expect(within(row).getByText(member.displayName)).toBeTruthy();
    expect(row.textContent).toContain('History\n');
    expect(row.textContent).toContain('mail@fe-1.test');
    expect(project.backend.messages).toHaveLength(count);
  });

  it('dismisses suggestions with Escape without closing the drawer', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    const input = await screen.findByLabelText(t('task.comments.label'));
    fireEvent.change(input, { target: { value: '@' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByLabelText(t('task.comments.label'))).toBeTruthy();
  });

  it('hides the composer from viewers', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20', {
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    await screen.findByText(project.backend.findTask('AC-20')!.title);
    expect(screen.queryByLabelText(t('task.comments.label'))).toBeNull();
  });
});

describe('task editing and subtasks', () => {
  it('edits title and markdown through PATCH and cancels a later draft', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    // The title is edited in place through its pencil; Enter saves.
    fireEvent.click(await screen.findByRole('button', { name: t('task.editTitle') }));
    const title = screen.getByLabelText(t('newTask.fields.title'));
    fireEvent.change(title, { target: { value: 'Example updated task' } });
    fireEvent.submit(title.closest('form')!);
    await waitFor(() => expect(project.backend.findTask('AC-20')?.title).toBe('Example updated task'));
    await screen.findByRole('heading', { name: 'Example updated task' });
    expect(screen.queryByLabelText(t('newTask.fields.title'))).toBeNull();
    expect(project.requests).toContainEqual({
      method: 'PATCH',
      path: '/api/projects/AC/tasks/AC-20',
      body: { title: 'Example updated task' },
    });

    // The description has its own pencil and editor.
    fireEvent.click(screen.getByRole('button', { name: t('task.editDescription') }));
    fireEvent.change(screen.getByLabelText(t('task.description')), {
      target: { value: '**Example description**' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('task.save') }));
    await waitFor(() =>
      expect(project.backend.findTask('AC-20')?.description).toBe('**Example description**'),
    );
    expect(project.requests).toContainEqual({
      method: 'PATCH',
      path: '/api/projects/AC/tasks/AC-20',
      body: { description: '**Example description**' },
    });
    await screen.findByRole('button', { name: t('task.editDescription') });

    // A cancelled draft leaves the task alone and is not kept.
    fireEvent.click(screen.getByRole('button', { name: t('task.editTitle') }));
    fireEvent.change(screen.getByLabelText(t('newTask.fields.title')), {
      target: { value: 'Unsaved draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(project.backend.findTask('AC-20')?.title).toBe('Example updated task');
    fireEvent.click(screen.getByRole('button', { name: t('task.editTitle') }));
    expect((screen.getByLabelText(t('newTask.fields.title')) as HTMLInputElement).value).toBe(
      'Example updated task',
    );
  });

  it('cancels a title edit with Escape without closing the drawer', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    fireEvent.click(await screen.findByRole('button', { name: t('task.editTitle') }));
    fireEvent.keyDown(screen.getByLabelText(t('newTask.fields.title')), { key: 'Escape' });
    expect(screen.queryByLabelText(t('newTask.fields.title'))).toBeNull();
    expect(screen.getByRole('heading', { name: project.backend.findTask('AC-20')!.title })).toBeTruthy();
  });

  it('keeps the edited draft after a save refusal and permits retry', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    fireEvent.click(await screen.findByRole('button', { name: t('task.editTitle') }));
    fireEvent.change(screen.getByLabelText(t('newTask.fields.title')), {
      target: { value: 'Preserved draft' },
    });
    project.backend.viewerHandle = 'kata';
    fireEvent.click(screen.getByRole('button', { name: t('task.save') }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByLabelText(t('newTask.fields.title')) as HTMLInputElement).value).toBe(
      'Preserved draft',
    );
    project.backend.viewerHandle = 'owner';
    fireEvent.click(screen.getByRole('button', { name: t('task.save') }));
    await waitFor(() => expect(project.backend.findTask('AC-20')?.title).toBe('Preserved draft'));
  });

  it('shows the parts with their progress; a new subtask inherits repo, visibility and first stage', async () => {
    const project = mockProject();
    project.backend.updateTask('AC-21', { parentKey: 'AC-20', status: 'done' });
    project.backend.updateTask('AC-22', { parentKey: 'AC-20' });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const section = await screen.findByRole('region', { name: t('task.relations.title') });
    const parts = within(section).getByRole('group', { name: t('relations.kinds.has_part') });
    expect(within(parts).getByText(t('task.relations.progress', { done: 1, total: 2 }))).toBeTruthy();
    expect(within(parts).getByRole('link', { name: /AC-21/ }).getAttribute('href')).toBe('/p/AC/tasks/AC-21');
    // The dialog stays closed until the small "+" asks for it.
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: t('task.relations.add') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: t('relationDialog.newSubtask') }));
    fireEvent.change(within(dialog).getByLabelText(t('relationDialog.subtaskTitle')), {
      target: { value: 'Example child' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t('relationDialog.submitSubtask') }));
    expect(await within(section).findByRole('link', { name: /Example child/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const parent = project.backend.findTask('AC-20')!;
    expect(project.backend.tasks.find((task) => task.title === 'Example child')).toMatchObject({
      parentKey: parent.key,
      repo: parent.repo,
      visibility: parent.visibility,
      stageId: project.backend.config.pipeline.stages[0]!.id,
    });
  });

  it('shows a parent link on a subtask and prevents a nested subtask', async () => {
    const project = mockProject();
    project.backend.updateTask('AC-20', { parentKey: 'AC-21' });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const parent = project.backend.findTask('AC-21')!;
    const link = await screen.findByRole('link', {
      name: t('task.parent', { key: parent.key, title: parent.title }),
    });
    expect(link.getAttribute('href')).toBe('/p/AC/tasks/AC-21');
    fireEvent.click(await screen.findByRole('button', { name: t('task.relations.add') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: t('relationDialog.newSubtask') }));
    // The kind cannot be chosen, and says why.
    expect(within(dialog).queryByLabelText(t('relationDialog.subtaskTitle'))).toBeNull();
    expect(within(dialog).getByText(t('relationDialog.off.subtask'))).toBeTruthy();
  });

  it('hides editing and quick-add from viewers', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20', {
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    await screen.findByText(project.backend.findTask('AC-20')!.title);
    expect(screen.queryByRole('button', { name: t('task.editTitle') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('task.editDescription') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('task.relations.add') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('task.labels.add') })).toBeNull();
  });
});

describe('task drawer layout', () => {
  it('puts the open decision first, the session buttons near the head and the properties in tight rows', async () => {
    const project = mockProject();
    const question = plainLanguageQuestion();
    project.backend.inbox.push(question);
    project.render(drawer, '/p/AC/tasks/AC-22');

    const decision = (await screen.findByRole('heading', { name: question.title, level: 3 })).closest(
      'article',
    )!;
    const properties = screen.getByRole('region', { name: t('task.labels.title') });
    const timeline = screen.getByRole('heading', { name: t('task.timeline') });
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(decision, properties)).toBe(true);
    const open = await screen.findByRole('link', { name: t('task.openSession') });
    expect(follows(decision, open)).toBe(true);
    expect(follows(open, properties)).toBe(true);
    expect(follows(properties, timeline)).toBe(true);
    // The move panel opens inside the row of the session buttons (the row it is positioned by), so
    // it stays within the drawer wherever the button wraps to.
    fireEvent.click(screen.getByRole('button', { name: t('task.move.open') }));
    expect(open.parentElement!.contains(await screen.findByLabelText(t('task.move.target')))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('task.move.open') }));
    // No full-width action buttons: the rare ones hide in the menu, the move in its small panel.
    expect(screen.getByRole('button', { name: t('taskLifecycle.title') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('task.move.submit') })).toBeNull();
  });
});

describe('who works on the card (PM-237)', () => {
  const developer = 'Backend fejlesztő';

  it('names the worker with the time, keeps the command out and opens their session', async () => {
    const project = mockProject();
    const command = project.backend.sessions.find((session) => session.id === 'ses_ac20_be1')!.activity!;
    project.render(drawer, '/p/AC/tasks/AC-20');
    const line = await screen.findAllByText(t('taskStatus.worker.working', { name: developer }));
    expect(line.length).toBeGreaterThan(0);
    // The command is not on the page: not in the head, nor in the list of sessions.
    expect(document.body.textContent).not.toContain(command);
    expect(document.body.textContent).not.toContain('restore-drill');
    const open = await screen.findByRole('link', { name: t('task.openSession') });
    expect(open.getAttribute('href')).toBe('/p/AC/sessions/ses_ac20_be1');
    const sessions = screen.getByRole('heading', { name: t('task.sessions') }).parentElement!;
    expect(within(sessions).getByText(t('sessionState.working'))).toBeTruthy();
  });

  it('gives each worker a row of their own, with their own verb, and opens the first one’s session', async () => {
    const project = mockProject();
    const first = project.backend.sessions.find((session) => session.id === 'ses_ac20_be1')!;
    project.backend.sessions.push({
      ...first,
      id: 'ses_ac20_qa',
      member: 'qa',
      activity: 'Bash: npm test',
      startedAt: first.startedAt,
    });
    const qa = project.backend.findMember('qa')!.displayName;
    project.render(drawer, '/p/AC/tasks/AC-20');
    const list = await screen.findByRole('list', {
      name: t('taskStatus.workersTwo', { names: `${developer}${t('common.and')}${qa}` }),
    });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining(t('taskStatus.worker.working', { name: developer })),
      expect.stringContaining(t('taskStatus.worker.testing', { name: qa })),
    ]);
    expect(document.body.textContent).not.toContain('npm test');
    const open = await screen.findByRole('link', { name: t('task.openSession') });
    expect(open.getAttribute('href')).toBe('/p/AC/sessions/ses_ac20_be1');
  });

  it('shows no one as working on a card nobody works on', async () => {
    const project = mockProject();
    project.backend.sessions = project.backend.sessions.filter((session) => session.id !== 'ses_ac20_be1');
    project.render(drawer, '/p/AC/tasks/AC-20');
    await screen.findByRole('heading', { name: project.backend.findTask('AC-20')!.title });
    expect(screen.queryByText(t('taskStatus.worker.working', { name: developer }))).toBeNull();
  });
});

describe('starting a card whose prerequisite is open (PM-204)', () => {
  const startButton = async () => screen.findByRole('button', { name: t('task.start') });
  const startRequests = (project: ReturnType<typeof mockProject>) =>
    project.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/start'));

  it('warns first, naming the open prerequisite, and starts nothing until it is accepted', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-23');

    fireEvent.click(await startButton());

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t('prerequisiteWarning.title'))).toBeTruthy();
    expect(dialog.textContent).toContain('AC-17');
    expect(startRequests(project)).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(startRequests(project)).toEqual([]);
    expect(project.backend.findTask('AC-23')).toMatchObject({ assignee: null, stageId: 'ready' });
  });

  it('starts with the warning accepted, and says so in the request', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-23');

    fireEvent.click(await startButton());
    fireEvent.click(await screen.findByRole('button', { name: t('prerequisiteWarning.confirm') }));

    await waitFor(() => expect(project.backend.findTask('AC-23')!.assignee).not.toBeNull());
    expect(startRequests(project).map((request) => request.body)).toEqual([{ despitePrerequisites: true }]);
  });

  it('asks nothing of a card without an open prerequisite', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-24');

    fireEvent.click(await startButton());

    await waitFor(() => expect(project.backend.findTask('AC-24')!.assignee).not.toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(startRequests(project).map((request) => request.body)).toEqual([{}]);
  });

  it('shows the same warning when the server refuses a start the board did not see coming', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    const button = await startButton();
    // The prerequisite was added after the board loaded.
    project.backend.findTask('AC-24')!.links.push({ kind: 'prerequisite', ref: 'AC-17' });

    fireEvent.click(button);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('AC-17');
    expect(project.backend.findTask('AC-24')!.assignee).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: t('prerequisiteWarning.confirm') }));
    await waitFor(() => expect(project.backend.findTask('AC-24')!.assignee).not.toBeNull());
  });

  it('warns before the move panel moves the card into the work stage, then sends the flag', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-23');
    fireEvent.change(await openMove(), { target: { value: 'dev' } });

    fireEvent.click(screen.getByRole('button', { name: t('task.move.submit') }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('AC-17');
    expect(project.requests.filter((request) => request.method === 'PATCH')).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: t('prerequisiteWarning.confirm') }));
    await waitFor(() => expect(project.backend.findTask('AC-23')?.stageId).toBe('dev'));
    expect(project.requests.filter((request) => request.method === 'PATCH').map((r) => r.body)).toEqual([
      { stageId: 'dev', despitePrerequisites: true },
    ]);
  });

  it('offers the Start button on a card that waits for its prerequisites in the work stage', async () => {
    const project = mockProject();
    const task = project.backend.findTask('AC-20')!;
    task.assignee = null;
    task.links = [{ kind: 'prerequisite', ref: 'AC-17' }];
    task.startWaiting = { reason: 'prerequisite_open', prerequisites: ['AC-17'], since: task.updatedAt };
    project.render(drawer, '/p/AC/tasks/AC-20');

    fireEvent.click(await startButton());

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('AC-17');
    expect(startRequests(project)).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: t('prerequisiteWarning.confirm') }));
    await waitFor(() => expect(project.backend.findTask('AC-20')!.assignee).not.toBeNull());
    expect(startRequests(project).map((request) => request.body)).toEqual([{ despitePrerequisites: true }]);
  });

  it('moves a card without starting it when the person picks "move, let it wait"', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-23');
    fireEvent.change(await openMove(), { target: { value: 'dev' } });

    fireEvent.click(screen.getByRole('button', { name: t('task.move.submit') }));
    fireEvent.click(await screen.findByRole('button', { name: t('prerequisiteWarning.moveAndWait') }));

    await waitFor(() => expect(project.backend.findTask('AC-23')?.stageId).toBe('dev'));
    expect(project.requests.filter((request) => request.method === 'PATCH').map((r) => r.body)).toEqual([
      { stageId: 'dev' },
    ]);
  });

  it('shows the card waiting for its prerequisites, by key', async () => {
    const project = mockProject();
    const task = project.backend.findTask('AC-20')!;
    task.startWaiting = {
      reason: 'prerequisite_open',
      prerequisites: ['AC-17', 'AC-19'],
      since: task.updatedAt,
    };
    project.render(drawer, '/p/AC/tasks/AC-20');

    await screen.findByText(t('taskStatus.prerequisiteOnMore', { key: 'AC-17', more: 1 }));
    expect(screen.getByText(t('taskStatus.startHints.prerequisite_open'))).toBeTruthy();
  });
});

describe('starting a card that waits for a label an AI member sets (PM-236)', () => {
  /** AC-23 is a `ui` card in the queue; the work stage's gate asks for `design-ok` on `ui` cards. */
  const uiProject = () => {
    const project = mockProject();
    project.backend.config.team.members.push({
      kind: 'ai',
      handle: 'des',
      displayName: 'Tervező',
      role: 'designer',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      capacity: 1,
      instructions: 'Plans the screens.',
      sponsor: 'owner',
      temp: false,
    });
    project.backend.members.push({
      handle: 'des',
      displayName: 'Tervező',
      kind: 'ai',
      role: 'designer',
      roles: ['designer'],
      specialty: null,
      status: 'idle',
      activity: null,
      currentTaskKeys: [],
      sponsor: 'owner',
      temp: false,
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });
    project.backend.config.pipeline.labels.push(
      { id: 'ui', name: 'Felület', setBy: 'anyone' },
      { id: 'design-ok', name: 'Terv kész', setBy: { duties: ['ux_design'] } },
    );
    project.backend.config.pipeline.stages.find((stage) => stage.id === 'dev')!.gate = {
      conditions: [{ type: 'has_label', label: 'design-ok', when: 'ui' }],
    };
    const task = project.backend.findTask('AC-23')!;
    task.links = [];
    task.labels = ['ui'];
    return { project, task };
  };
  const startButton = async () => screen.findByRole('button', { name: t('task.start') });

  it('shows the designer working and the developer waiting for the label after the Start', async () => {
    const { project } = uiProject();
    project.render(drawer, '/p/AC/tasks/AC-23');

    fireEvent.click(await startButton());

    await screen.findByText(
      t('taskStatus.startWaiting.label_missing', { name: 'Tervező', labels: 'Terv kész' }),
    );
    expect(screen.getByText(t('taskStatus.startHints.label_missing'))).toBeTruthy();
    const task = project.backend.findTask('AC-23')!;
    expect(task).toMatchObject({ stageId: 'ready', assignee: null });
    expect(task.startWaiting).toMatchObject({
      reason: 'label_missing',
      labels: ['design-ok'],
      member: 'des',
    });
    expect(project.backend.sessions.map((session) => session.member)).toContain('des');
  });

  it('starts the developer by itself once the gate lets the card through', async () => {
    const { project } = uiProject();
    project.render(drawer, '/p/AC/tasks/AC-23');
    fireEvent.click(await startButton());
    await screen.findByText(t('taskStatus.startHints.label_missing'));

    // A person takes the card out of the label's scope; the designer's own label change works the same way.
    const changed = project.backend.handle('POST', '/api/projects/AC/tasks/AC-23/labels', {
      remove: ['ui'],
    });
    expect(changed.status).toBe(200);

    await waitFor(() => expect(project.backend.findTask('AC-23')!.stageId).toBe('dev'));
    const task = project.backend.findTask('AC-23')!;
    expect(task.assignee).not.toBeNull();
    expect(task.startWaiting).toBeUndefined();
  });
});

describe('the Kidolgozás button and the refused Start (decision 31)', () => {
  const refineButton = (name = t('task.refine.button')) => screen.findByRole('button', { name });
  /** AC-24 stands in the queue stage, before the work stage; the project knows the `refine` label. */
  const refiningProject = (setBy: 'anyone' | { members: string[] } = 'anyone') => {
    const project = mockProject();
    project.backend.config.pipeline.labels.push({ id: 'refine', name: 'Kidolgozásra vár', setBy });
    return project;
  };
  /** Waits for the configuration, which the button's rule needs: the label picker shows it has come. */
  const configLoaded = async () => {
    const section = await screen.findByRole('region', { name: t('task.labels.title') });
    await within(section).findByRole('button', { name: t('task.labels.add') });
  };
  const labelRequests = (project: ReturnType<typeof mockProject>) =>
    project.requests
      .filter((request) => request.method === 'POST' && request.path.endsWith('/labels'))
      .map((request) => request.body);

  it('puts the label on the card with the existing label endpoint', async () => {
    const project = refiningProject();
    project.render(drawer, '/p/AC/tasks/AC-24');

    fireEvent.click(await refineButton());

    await waitFor(() => expect(project.backend.findTask('AC-24')!.labels).toContain('refine'));
    expect(labelRequests(project)).toEqual([{ add: ['refine'] }]);
    // The card is being refined now: the button is gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: t('task.refine.button') })).toBeNull());
  });

  it('shows the refusal of the server inline', async () => {
    const project = refiningProject();
    project.render(drawer, '/p/AC/tasks/AC-24');
    const button = await refineButton();
    // The label rules change after the drawer has loaded.
    project.backend.config.pipeline.labels = project.backend.config.pipeline.labels.map((label) =>
      label.id === 'refine' ? { ...label, setBy: 'system' as const } : label,
    );

    fireEvent.click(button);

    await screen.findByRole('alert');
    expect(project.backend.findTask('AC-24')!.labels).not.toContain('refine');
  });

  it.each([
    [
      'the project does not know the label',
      (project: ReturnType<typeof mockProject>) => {
        project.backend.config.pipeline.labels = project.backend.config.pipeline.labels.filter(
          (label) => label.id !== 'refine',
        );
      },
    ],
    [
      'the card carries the label already',
      (project: ReturnType<typeof mockProject>) => {
        project.backend.findTask('AC-24')!.labels = ['refine'];
      },
    ],
    [
      'the card stands in the work stage',
      (project: ReturnType<typeof mockProject>) => {
        project.backend.findTask('AC-24')!.stageId = 'dev';
      },
    ],
    [
      'the card is closed',
      (project: ReturnType<typeof mockProject>) => {
        project.backend.findTask('AC-24')!.status = 'cancelled';
      },
    ],
    [
      'the viewer may not set the label',
      (project: ReturnType<typeof mockProject>) => {
        const label = project.backend.config.pipeline.labels.find((entry) => entry.id === 'refine')!;
        label.setBy = { members: ['qa'] };
      },
    ],
  ])('does not offer the button when %s', async (_reason, change) => {
    const project = refiningProject();
    change(project);
    project.render(drawer, '/p/AC/tasks/AC-24');

    await configLoaded();

    expect(screen.queryByRole('button', { name: t('task.refine.button') })).toBeNull();
  });

  /** The gate of the work stage asks for a label only a person (the owner) sets: no AI member can open it. */
  const gatedProject = (refines: boolean) => {
    const project = refines ? refiningProject() : mockProject();
    project.backend.config.pipeline.labels.push({
      id: 'scope-ok',
      name: 'Követelmény kész',
      setBy: { members: ['owner'] },
    });
    project.backend.config.pipeline.stages.find((stage) => stage.id === 'dev')!.gate = {
      conditions: [{ type: 'has_label', label: 'scope-ok' }],
    };
    return project;
  };

  it('suggests the Kidolgozás button next to the refused Start in a project with refinement', async () => {
    const project = gatedProject(true);
    project.render(drawer, '/p/AC/tasks/AC-24');
    await configLoaded();

    fireEvent.click(await screen.findByRole('button', { name: t('task.start') }));

    const message = await screen.findByRole('alert');
    expect(message.textContent).toContain(t('errors.codes.gate_blocked'));
    expect(message.textContent).toContain(t('task.refine.suggestion'));
    expect(project.backend.findTask('AC-24')!.assignee).toBeNull();
  });

  it('points at no button that is not there: the card is already being refined', async () => {
    const project = gatedProject(true);
    project.backend.findTask('AC-24')!.labels = ['refine'];
    project.render(drawer, '/p/AC/tasks/AC-24');
    await configLoaded();

    fireEvent.click(await screen.findByRole('button', { name: t('task.start') }));

    const message = await screen.findByRole('alert');
    expect(message.textContent).toContain(t('errors.codes.gate_blocked'));
    expect(message.textContent).not.toContain(t('task.refine.suggestion'));
    expect(screen.queryByRole('button', { name: t('task.refine.button') })).toBeNull();
  });

  it('points at no button that is not there: the viewer may not put the label on', async () => {
    const project = gatedProject(true);
    project.backend.config.pipeline.labels = project.backend.config.pipeline.labels.map((label) =>
      label.id === 'refine' ? { ...label, setBy: 'system' as const } : label,
    );
    project.render(drawer, '/p/AC/tasks/AC-24');
    await configLoaded();

    fireEvent.click(await screen.findByRole('button', { name: t('task.start') }));

    const message = await screen.findByRole('alert');
    expect(message.textContent).toContain(t('errors.codes.gate_blocked'));
    expect(message.textContent).not.toContain(t('task.refine.suggestion'));
    expect(screen.queryByRole('button', { name: t('task.refine.button') })).toBeNull();
  });

  it('adds no suggestion where the project has no refinement', async () => {
    const project = gatedProject(false);
    project.render(drawer, '/p/AC/tasks/AC-24');
    await configLoaded();

    fireEvent.click(await screen.findByRole('button', { name: t('task.start') }));

    const message = await screen.findByRole('alert');
    expect(message.textContent).toContain(t('errors.codes.gate_blocked'));
    expect(message.textContent).not.toContain(t('task.refine.suggestion'));
  });
});

describe('task drawer loop box (PM-261)', () => {
  /** Three messages between two AI members of the fake team start a loop on the card. */
  function startLoop(project: ReturnType<typeof mockProject>) {
    project.backend.config.team.limits.loopWatch = { enabled: true, count: 3, minutes: 30 };
    for (let i = 0; i < 3; i++) {
      const [from, to] = i % 2 === 0 ? ['fe-1', 'code-review'] : ['code-review', 'fe-1'];
      project.backend.addTimeline('AC-21', from!, 'team_message', { messageId: `m${i}`, from, to: [to] });
    }
  }

  it('shows the decision, not the box, to the person who is asked to decide', async () => {
    const project = mockProject();
    startLoop(project);
    // The fake team has nobody on the scheduling duty: the owner decides, so the drawer shows
    // the decision itself and no box next to it.
    project.render(drawer, '/p/AC/tasks/AC-21');
    await screen.findByRole('heading', { name: t('inbox.loop.heading'), level: 3 });
    expect(screen.queryByRole('heading', { name: t('loop.box.title') })).toBeNull();
  });

  it('shows the box when someone else holds the loop, and drops it when the loop is over', async () => {
    const project = mockProject();
    const devops = project.backend.config.team.members.find((member) => member.handle === 'devops');
    if (devops?.kind === 'ai') devops.role = 'project_manager';
    startLoop(project);
    expect(project.backend.findTask('AC-21')?.loop).toMatchObject({ phase: 'notified', notified: 'devops' });
    project.render(drawer, '/p/AC/tasks/AC-21');

    const box = (await screen.findByRole('heading', { name: t('loop.box.title') })).closest('section')!;
    expect(box.textContent).toContain('3');
    expect(box.textContent).toContain(t('loop.who.notified', { name: 'Devops' }));
    expect(
      within(box)
        .getByRole('link', { name: t('loop.box.messages') })
        .getAttribute('href'),
    ).toBe('/p/AC/tasks/AC-21/thread');
    expect(screen.queryByRole('heading', { name: t('inbox.loop.heading') })).toBeNull();
  });

  it('shows no box once the loop is over', async () => {
    const project = mockProject();
    const devops = project.backend.config.team.members.find((member) => member.handle === 'devops');
    if (devops?.kind === 'ai') devops.role = 'project_manager';
    startLoop(project);
    project.backend.addTimeline('AC-21', 'owner', 'task_labels_changed', { added: ['qa-ok'], removed: [] });
    project.render(drawer, '/p/AC/tasks/AC-21');
    await screen.findByText('Rendelés-visszaigazoló e-mail');
    expect(screen.queryByRole('heading', { name: t('loop.box.title') })).toBeNull();
  });
});

describe('task drawer questions', () => {
  it('shows a plain-language question of the task with its recommendation and folded details', async () => {
    const project = mockProject();
    const question = plainLanguageQuestion();
    project.backend.inbox.push(question);
    project.render(drawer, '/p/AC/tasks/AC-22');

    const card = (await screen.findByRole('heading', { name: question.title, level: 3 })).closest('article')!;
    expect(within(card).getByText(t('inbox.question.recommended'))).toBeTruthy();
    expect(within(card).getByText('Pár másodperc múlva eltűnik, ezért könnyű lemaradni róla.')).toBeTruthy();
    expect(card.querySelector('details')!.open).toBe(false);

    fireEvent.click(within(card).getByRole('button', { name: 'Az űrlap alatt' }));
    await waitFor(() =>
      expect(project.backend.inbox.find((item) => item.id === question.id)?.resolution).toMatchObject({
        optionId: 'option_1',
      }),
    );
  });
});
