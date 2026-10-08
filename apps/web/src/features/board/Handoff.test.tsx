import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Task, TaskHandoff, TaskHandoffRecord } from '@projectman/shared';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { otherProviderSuffix } from '../../lib/handoff';
import { nameOf } from '../../lib/members';
import { deriveTaskState, groupOpenInboxByTask } from '../../lib/taskState';
import type { TaskStateContext } from '../../lib/taskState';
import { buildConfig, inbox, tasks } from '../../mocks/fixtures';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { mockIndexes, renderUi } from '../../test/render';
import { TaskCard } from './TaskCard';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const drawer = (
  <ToastProvider>
    <Routes>
      <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
    </Routes>
  </ToastProvider>
);

const { pipeline, members } = mockIndexes();
const nameFe = nameOf('fe-1', members, 'owner');
const nameBe = nameOf('be-1', members, 'owner');

/** An open handoff of AC-20 from be-1 (Codex) to fe-1 (Claude), `minutes` minutes before its deadline. */
function openHandoff(
  step: TaskHandoff['step'],
  extra: Partial<TaskHandoff> = {},
  minutes = 7.5,
): TaskHandoff {
  return {
    id: 'hnd_test',
    from: 'be-1',
    to: 'fe-1',
    fromProvider: 'codex',
    toProvider: 'claude',
    reason: 'manual',
    step,
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    ...extra,
  };
}

describe('the assignee select (PM-342)', () => {
  it('marks the members of another provider while the old assignee has a conversation', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    const select = (await screen.findByLabelText(t('taskLifecycle.assignee'))) as HTMLSelectElement;
    const option = (handle: string) => Array.from(select.options).find((o) => o.value === handle)!;
    // be-1 runs on Codex: fe-1 (Claude) cannot continue its conversation.
    expect(option('fe-1').textContent).toContain(otherProviderSuffix());
    expect(option('be-1').textContent).not.toContain(otherProviderSuffix());
    expect(option('kata').textContent).not.toContain(otherProviderSuffix());
  });

  it('says in a toast that the old assignee hands the work over', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    fireEvent.change(await screen.findByLabelText(t('taskLifecycle.assignee')), {
      target: { value: 'fe-1' },
    });
    await screen.findByText(t('handoff.toast.live', { from: nameBe }));
    // The card carries the handoff, and the box tells so.
    await screen.findByRole('heading', { name: t('handoff.box.title') });
  });

  it('says in a toast why the new assignee starts without a note', async () => {
    const project = mockProject();
    project.backend.handle('PATCH', '/api/projects/AC/members/be-1', { onLeave: true });
    project.render(drawer, '/p/AC/tasks/AC-20');
    fireEvent.change(await screen.findByLabelText(t('taskLifecycle.assignee')), {
      target: { value: 'fe-1' },
    });
    await screen.findByText(
      t('handoff.toast.fallback', { reason: t('handoff.fallbackReason.on_leave', { from: nameBe }) }),
    );
    // No box, but the button of the note that was not.
    expect(screen.queryByRole('heading', { name: t('handoff.box.title') })).toBeNull();
    await screen.findByRole('button', { name: t('handoff.note.fallbackButton') });
  });

  it('keeps the plain toast when there is nothing to hand over', async () => {
    const project = mockProject();
    project.backend.findTask('AC-20')!.assignee = 'kata';
    project.render(drawer, '/p/AC/tasks/AC-20');
    fireEvent.change(await screen.findByLabelText(t('taskLifecycle.assignee')), {
      target: { value: 'fe-1' },
    });
    await screen.findByText(t('taskLifecycle.assigned'));
    expect(project.backend.findTask('AC-20')?.handoff).toBeUndefined();
  });
});

describe('the handoff box (PM-342)', () => {
  const renderBox = async (handoff: TaskHandoff) => {
    const project = mockProject();
    // The card is already with the receiver while the old session hands over.
    Object.assign(project.backend.findTask('AC-20')!, { assignee: handoff.to, handoff });
    project.render(drawer, '/p/AC/tasks/AC-20');
    await screen.findByRole('region', { name: /Átadás/ });
    return project;
  };

  it('waits for a safe point: the pair, the minutes, the provider shift and the way back', async () => {
    await renderBox(openHandoff('waiting_point'));
    const box = screen.getByRole('region', { name: t('handoff.box.title') });
    expect(within(box).getByText(`${nameBe} → ${nameFe}`)).toBeTruthy();
    expect(within(box).getByText(t('handoff.box.step.waiting_point', { from: nameBe }))).toBeTruthy();
    expect(within(box).getByText(/^még \d+ p$/)).toBeTruthy();
    expect(within(box).getByText(t('handoff.box.providerSentence'), { exact: false })).toBeTruthy();
    expect(within(box).getByRole('link', { name: t('handoff.box.session') })).toBeTruthy();
    expect(within(box).getByRole('button', { name: t('handoff.box.undo') })).toBeTruthy();
    // The step line is the live region; the countdown is not.
    expect(
      within(box)
        .getByText(t('handoff.box.step.waiting_point', { from: nameBe }))
        .getAttribute('aria-live'),
    ).toBe('polite');
    expect(
      within(box)
        .getByText(/^még \d+ p$/)
        .closest('[aria-live]'),
    ).toBeNull();
  });

  it('shows the writing step', async () => {
    await renderBox(openHandoff('writing'));
    expect(screen.getByText(t('handoff.box.step.writing', { from: nameBe }))).toBeTruthy();
  });

  it('is grey and stops the clock while the team is paused', async () => {
    await renderBox(openHandoff('paused', { deadlineAt: null }));
    const box = screen.getByRole('region', { name: t('handoff.box.pausedTitle') });
    expect(within(box).getByText(t('handoff.box.pausedLeft'))).toBeTruthy();
    expect(within(box).getByText(t('handoff.box.pausedText'))).toBeTruthy();
    expect(within(box).queryByText(/^még \d+ p$/)).toBeNull();
  });

  it('closes without a note when the time ran out, with no minutes left to show', async () => {
    await renderBox(openHandoff('writing', {}, -1));
    const box = screen.getByRole('region', { name: t('handoff.box.title') });
    expect(within(box).getByText(t('handoff.box.step.closing_timeout', { to: nameFe }))).toBeTruthy();
    expect(within(box).queryByText(/^még /)).toBeNull();
  });

  it('closes with the reason of the fallback, and with the note once it came', async () => {
    await renderBox(openHandoff('closing', { deadlineAt: null, fallbackReason: 'provider_limited' }));
    expect(
      screen.getByText(
        t('handoff.box.step.closing_reason', {
          to: nameFe,
          reason: t('handoff.fallbackReason.provider_limited', { from: nameBe }),
        }),
      ),
    ).toBeTruthy();
    cleanup();
    await renderBox(openHandoff('closing', { deadlineAt: null }));
    expect(screen.getByText(t('handoff.box.step.closing_note', { to: nameFe }))).toBeTruthy();
  });

  it('gives the card back to the old assignee with one request', async () => {
    const project = await renderBox(openHandoff('waiting_point'));
    fireEvent.click(screen.getByRole('button', { name: t('handoff.box.undo') }));
    await waitFor(() =>
      expect(project.requests).toContainEqual({
        method: 'PATCH',
        path: '/api/projects/AC/tasks/AC-20',
        body: { assignee: 'be-1' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('region', { name: t('handoff.box.title') })).toBeNull());
    expect(project.backend.timeline.at(-1)).toMatchObject({
      type: 'task_handoff',
      data: { phase: 'cancelled' },
    });
  });

  it('keeps the box and says why when the server refuses the way back', async () => {
    const project = mockProject();
    const handoff = openHandoff('waiting_point');
    Object.assign(project.backend.findTask('AC-20')!, { assignee: handoff.to, handoff });
    const inner = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (path, init) =>
      init?.method === 'PATCH'
        ? new Response(JSON.stringify({ error: { code: 'undo_refused', message: 'The card moved on.' } }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          })
        : inner(String(path), init),
    );
    project.render(drawer, '/p/AC/tasks/AC-20');
    await screen.findByRole('region', { name: /Átadás/ });
    fireEvent.click(screen.getByRole('button', { name: t('handoff.box.undo') }));
    const alert = await screen.findByRole('alert');
    // A 409 reads as the shared "someone else changed it" text of the client.
    expect(alert.textContent).toMatch(/módosította/);
    expect(screen.getByRole('region', { name: /Átadás/ })).toBeTruthy();
    expect(project.backend.findTask('AC-20')?.handoff).toBeTruthy();
    // The button comes back: the person can try again.
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: t('handoff.box.undo') }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it('says in the status line that the old assignee hands the work over', async () => {
    const task: Task = { ...tasks.find((entry) => entry.key === 'AC-20')!, handoff: openHandoff('writing') };
    const ctx: TaskStateContext = {
      pipeline,
      members,
      openInboxByTask: groupOpenInboxByTask(inbox),
      tasksByKey: new Map(tasks.map((entry) => [entry.key, entry])),
      myHandle: 'owner',
    };
    expect(deriveTaskState(task, ctx).phase).toBe('working');
    renderUi(
      <TaskCard
        task={task}
        state={deriveTaskState(task, ctx)}
        pipeline={pipeline}
        to="/p/AC/tasks/AC-20"
        members={members}
        myHandle="owner"
      />,
    );
    expect(screen.getByText(t('taskStatus.worker.handingOff', { name: nameBe }))).toBeTruthy();
  });
});

describe('the board mark of a handoff (PM-342)', () => {
  const markOf = (handoff: TaskHandoff | undefined) => {
    const base = tasks.find((entry) => entry.key === 'AC-20')!;
    const task: Task = { ...base, handoff };
    const ctx: TaskStateContext = {
      pipeline,
      members,
      openInboxByTask: groupOpenInboxByTask(inbox),
      tasksByKey: new Map(tasks.map((entry) => [entry.key, entry])),
      myHandle: 'owner',
    };
    renderUi(
      <TaskCard
        task={task}
        state={deriveTaskState(task, ctx)}
        pipeline={pipeline}
        to="/p/AC/tasks/AC-20"
        labels={buildConfig().pipeline.labels.map((label) => ({ ...label, holders: [] }))}
        members={members}
        myHandle="owner"
      />,
    );
  };

  it('names both ends and the minutes in text, not only in colour', () => {
    markOf(openHandoff('waiting_point'));
    const mark = screen.getByText(/^Átadás · \d+ p$/).closest('[title]')!;
    expect(mark.getAttribute('title')).toMatch(new RegExp(`^Átadás: ${nameBe} → ${nameFe}, még \\d+ p$`));
    expect(mark.getAttribute('aria-label')).toBe(mark.getAttribute('title'));
  });

  it('says it is paused, and leaves out the minutes once the time is over', () => {
    markOf(openHandoff('paused', { deadlineAt: null }));
    const paused = screen.getByText(t('handoff.markPaused')).closest('[title]')!;
    expect(paused.getAttribute('title')).toBe(
      t('handoff.markLabelPaused', { pair: `${nameBe} → ${nameFe}` }),
    );
    cleanup();
    markOf(openHandoff('writing', {}, -2));
    const over = screen.getByText(t('handoff.markNoTime')).closest('[title]')!;
    expect(over.getAttribute('title')).toBe(t('handoff.markLabelNoTime', { pair: `${nameBe} → ${nameFe}` }));
  });

  it('is not on a card without a handoff', () => {
    markOf(undefined);
    expect(screen.queryByText(/^Átadás/)).toBeNull();
  });
});

describe('the handoff note window (PM-342)', () => {
  const record = (extra: Partial<TaskHandoffRecord> = {}): TaskHandoffRecord => ({
    id: 'hnd_closed',
    from: 'be-1',
    to: 'fe-1',
    fromProvider: 'codex',
    toProvider: 'claude',
    outcome: 'note',
    endedAt: new Date().toISOString(),
    reason: 'manual',
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    note: 'The **restore drill** is half done.',
    branch: 'AC-20-work',
    lastCommit: 'abcdef0123456789',
    uncommitted: true,
    summary: null,
    ...extra,
  });
  const withRecord = (value: TaskHandoffRecord) => {
    const project = mockProject();
    project.backend.handoffRecords.set(value.id, { ...value, taskKey: 'AC-20' });
    project.backend.findTask('AC-20')!.lastHandoff = {
      id: value.id,
      from: value.from,
      to: value.to,
      fromProvider: value.fromProvider,
      toProvider: value.toProvider,
      outcome: value.outcome,
      ...(value.fallbackReason ? { fallbackReason: value.fallbackReason } : {}),
      endedAt: value.endedAt,
    };
    project.render(drawer, '/p/AC/tasks/AC-20');
    return project;
  };
  const openWindow = async (name: string) => {
    const button = await screen.findByRole('button', { name });
    fireEvent.click(button);
    return { button, dialog: await screen.findByRole('dialog') };
  };

  it('shows the note as Markdown with the commit and the loose changes', async () => {
    withRecord(record());
    const { dialog } = await openWindow(t('handoff.note.button'));
    await within(dialog).findByText('restore drill');
    expect(within(dialog).getByText('restore drill').tagName).toBe('STRONG');
    expect(within(dialog).getByText(t('handoff.note.lastCommit', { commit: 'abcdef01' }))).toBeTruthy();
    expect(within(dialog).getByText(t('handoff.note.uncommitted'))).toBeTruthy();
  });

  it('returns the focus to its button when it closes', async () => {
    withRecord(record());
    const { button, dialog } = await openWindow(t('handoff.note.button'));
    await within(dialog).findByText('restore drill');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it('tells why there was no note, with the summary kept as plain text', async () => {
    withRecord(
      record({
        outcome: 'fallback',
        fallbackReason: 'timeout',
        note: null,
        branch: null,
        lastCommit: null,
        uncommitted: null,
        summary: { source: 'compact', text: '# not a heading\nWhere it stood.', at: null },
      }),
    );
    const { dialog } = await openWindow(t('handoff.note.fallbackButton'));
    await within(dialog).findByText(t('handoff.note.summary'));
    expect(within(dialog).getByText(/Nem volt leadás: lejárt a 10 perc\./)).toBeTruthy();
    expect(within(dialog).getByText(/gépi összefoglalójával indult/)).toBeTruthy();
    const summary = within(dialog).getByText(/not a heading/);
    expect(summary.tagName).toBe('PRE');
    expect(summary.textContent).toBe('# not a heading\nWhere it stood.');
  });

  it('names the last replies when there was no compaction, and says when there was no summary', async () => {
    withRecord(
      record({
        outcome: 'fallback',
        fallbackReason: 'provider_changed',
        note: null,
        summary: { source: 'last_replies', text: 'Last reply.', at: null },
      }),
    );
    const { dialog } = await openWindow(t('handoff.note.fallbackButton'));
    await within(dialog).findByText(t('handoff.note.lastReplies'));
    cleanup();
    withRecord(
      record({ id: 'hnd_none', outcome: 'fallback', fallbackReason: 'no_conversation', note: null }),
    );
    const second = await openWindow(t('handoff.note.fallbackButton'));
    await within(second.dialog).findByText(/Összefoglaló sem volt/);
  });

  it('shows a loading state while the record is on its way', async () => {
    const project = mockProject();
    project.backend.handoffRecords.set('hnd_closed', { ...record(), taskKey: 'AC-20' });
    project.backend.findTask('AC-20')!.lastHandoff = {
      id: 'hnd_closed',
      from: 'be-1',
      to: 'fe-1',
      fromProvider: 'codex',
      toProvider: 'claude',
      outcome: 'note',
      endedAt: new Date().toISOString(),
    };
    const inner = createMockFetch(project.backend, project.requests);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    setFetchImplementation(async (path, init) => {
      if (String(path).includes('/handoffs/')) await held;
      return inner(String(path), init);
    });
    project.render(drawer, '/p/AC/tasks/AC-20');
    const { dialog } = await openWindow(t('handoff.note.button'));
    expect(within(dialog).getByRole('status').textContent).toContain(t('app.loading'));
    expect(within(dialog).queryByText(t('handoff.note.loadFailed'))).toBeNull();
    release();
    await within(dialog).findByText('restore drill');
    expect(within(dialog).queryByRole('status')).toBeNull();
  });

  it('shows an error with a retry', async () => {
    const project = mockProject();
    project.backend.handoffRecords.set('hnd_closed', { ...record(), taskKey: 'AC-20' });
    project.backend.findTask('AC-20')!.lastHandoff = {
      id: 'hnd_closed',
      from: 'be-1',
      to: 'fe-1',
      fromProvider: 'codex',
      toProvider: 'claude',
      outcome: 'note',
      endedAt: new Date().toISOString(),
    };
    const inner = createMockFetch(project.backend, project.requests);
    let failing = true;
    setFetchImplementation(async (path, init) =>
      failing && String(path).includes('/handoffs/')
        ? new Response(JSON.stringify({ error: { code: 'internal_error', message: 'boom' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : inner(String(path), init),
    );
    project.render(drawer, '/p/AC/tasks/AC-20');
    const { dialog } = await openWindow(t('handoff.note.button'));
    await within(dialog).findByText(t('handoff.note.loadFailed'));
    failing = false;
    fireEvent.click(within(dialog).getByRole('button', { name: t('app.retry') }));
    await within(dialog).findByText('restore drill');
  });

  it('says the handoff is gone, without a retry, when the server no longer has it', async () => {
    const project = withRecord(record());
    project.backend.handoffRecords.clear();
    const { dialog } = await openWindow(t('handoff.note.button'));
    await within(dialog).findByText(t('handoff.note.gone'));
    expect(within(dialog).queryByRole('button', { name: t('app.retry') })).toBeNull();
  });
});

describe('the handoff in the mock backend (PM-342)', () => {
  it('walks the steps and ends with the note, the record and the last handoff', async () => {
    const project = mockProject();
    const backend = project.backend;
    expect(backend.handle('PATCH', '/api/projects/AC/tasks/AC-20', { assignee: 'fe-1' }).body).toMatchObject({
      handoffStart: { mode: 'live', from: 'be-1' },
    });
    expect(backend.findTask('AC-20')?.handoff).toMatchObject({ step: 'waiting_point', to: 'fe-1' });
    backend.advanceHandoff('AC-20', 'writing');
    expect(backend.findTask('AC-20')?.handoff?.step).toBe('writing');
    backend.advanceHandoff('AC-20', 'closing', { note: 'Done so far.' });
    expect(backend.findTask('AC-20')?.handoff).toMatchObject({ step: 'closing', deadlineAt: null });
    backend.advanceHandoff('AC-20', 'done');
    const task = backend.findTask('AC-20')!;
    expect(task.handoff).toBeUndefined();
    expect(task.lastHandoff).toMatchObject({ from: 'be-1', to: 'fe-1', outcome: 'note' });
    const read = backend.handle(
      'GET',
      `/api/projects/AC/tasks/AC-20/handoffs/${task.lastHandoff!.id}`,
      undefined,
    );
    expect(read.body).toMatchObject({ note: 'Done so far.', outcome: 'note' });
    expect(backend.handle('GET', '/api/projects/AC/tasks/AC-20/handoffs/none', undefined).status).toBe(404);
    expect(
      backend.timeline.filter((event) => event.type === 'task_handoff').map((event) => event.data.phase),
    ).toEqual(['started', 'note', 'taken_over']);
  });

  it('retargets an open handoff, and cancels it when the card goes back', () => {
    const backend = mockProject().backend;
    backend.handle('PATCH', '/api/projects/AC/tasks/AC-20', { assignee: 'fe-1' });
    backend.handle('PATCH', '/api/projects/AC/tasks/AC-20', { assignee: 'qa' });
    expect(backend.findTask('AC-20')?.handoff).toMatchObject({ from: 'be-1', to: 'qa' });
    backend.handle('PATCH', '/api/projects/AC/tasks/AC-20', { assignee: 'be-1' });
    expect(backend.findTask('AC-20')?.handoff).toBeUndefined();
    expect(
      backend.timeline.filter((event) => event.type === 'task_handoff').map((event) => event.data.phase),
    ).toEqual(['started', 'retargeted', 'cancelled']);
  });
});
