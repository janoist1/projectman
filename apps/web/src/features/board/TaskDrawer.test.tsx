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

  it('shows child progress and quick-add inherits repo, visibility and first stage', async () => {
    const project = mockProject();
    project.backend.updateTask('AC-21', { parentKey: 'AC-20', status: 'done' });
    project.backend.updateTask('AC-22', { parentKey: 'AC-20' });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const section = await screen.findByRole('region', { name: t('task.subtasks') });
    expect(within(section).getByText(t('task.subtaskProgress', { done: 1, total: 2 }))).toBeTruthy();
    expect(within(section).getByRole('link', { name: /AC-21/ }).getAttribute('href')).toBe(
      '/p/AC/tasks/AC-21',
    );
    // The quick-add form stays folded until the small "+" asks for it.
    expect(within(section).queryByLabelText(t('task.subtaskTitle'))).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: t('task.subtaskNew') }));
    fireEvent.change(within(section).getByLabelText(t('task.subtaskTitle')), {
      target: { value: 'Example child' },
    });
    fireEvent.click(within(section).getByRole('button', { name: t('task.addSubtask') }));
    expect(await within(section).findByRole('link', { name: /Example child/ })).toBeTruthy();
    const parent = project.backend.findTask('AC-20')!;
    expect(project.backend.tasks.find((task) => task.title === 'Example child')).toMatchObject({
      parentKey: parent.key,
      repo: parent.repo,
      visibility: parent.visibility,
      stageId: project.backend.config.pipeline.stages[0]!.id,
    });
    expect((within(section).getByLabelText(t('task.subtaskTitle')) as HTMLInputElement).value).toBe('');
  });

  it('shows a parent link on a subtask and prevents a nested quick-add', async () => {
    const project = mockProject();
    project.backend.updateTask('AC-20', { parentKey: 'AC-21' });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const parent = project.backend.findTask('AC-21')!;
    const link = await screen.findByRole('link', {
      name: t('task.parent', { key: parent.key, title: parent.title }),
    });
    expect(link.getAttribute('href')).toBe('/p/AC/tasks/AC-21');
    expect(screen.queryByLabelText(t('task.subtaskTitle'))).toBeNull();
  });

  it('hides editing and quick-add from viewers', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20', {
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    await screen.findByText(project.backend.findTask('AC-20')!.title);
    expect(screen.queryByRole('button', { name: t('task.editTitle') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('task.editDescription') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('task.subtaskNew') })).toBeNull();
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
