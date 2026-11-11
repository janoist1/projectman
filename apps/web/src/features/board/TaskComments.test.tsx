import type { Actor } from '@projectman/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { applyServerEvent } from '../../api/cache';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { openTab } from '../../test/cardStory';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey/*" element={<TaskDrawer />} />
  </Routes>
);

const COMMENTS = '/api/projects/AC/tasks/AC-20/comments';
type Project = ReturnType<typeof mockProject>;

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** A comment of the card as the server stores it. */
const comment = (
  project: Project,
  who: string,
  text: string,
  extra: Record<string, unknown> = {},
  minutes = 10,
) =>
  project.backend.addTimeline(
    'AC-20',
    who,
    'task_note',
    { text, comment: true, ...extra },
    null,
    ago(minutes),
  );
const comments = (project: Project) =>
  project.requests.filter((request) => request.method === 'POST' && request.path === COMMENTS);
const box = () =>
  screen.findByRole('textbox', { name: t('task.comments.label') }) as Promise<HTMLTextAreaElement>;
const column = async () => within(await screen.findByRole('list', { name: t('task.view.thread') }));

describe('the Comments view (PM-1304)', () => {
  it('lists the comments in one column, oldest first, and names the viewer "Te"', async () => {
    const project = mockProject();
    comment(project, 'be-1', 'First words', {}, 30);
    comment(project, 'owner', 'My answer', {}, 20);
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const list = await column();
    const rows = list.getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('First words'),
      expect.stringContaining('My answer'),
    ]);
    expect(within(rows[1]!).getByText(t('common.you'))).toBeTruthy();
    // The process events of the card are not comments.
    expect(list.queryByText('A mentési szkript kész, a visszaállítás próbája fut')).toBeNull();
  });

  it('puts an answer under its comment, and an answer to an answer under the same comment', async () => {
    const project = mockProject();
    const parent = comment(project, 'be-1', 'The question', {}, 30);
    const first = comment(project, 'fe-1', 'First answer', { replyTo: parent.id }, 20);
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const list = await column();
    const thread = list.getByText('The question').closest('li')!;
    expect(within(thread).getByText('First answer')).toBeTruthy();

    // A reply to the reply lands on the parent, not one level deeper.
    fireEvent.click(
      within(document.getElementById(`timeline-${first.id}`)!).getByRole('button', { name: /^Válasz/ }),
    );
    const reply = await screen.findByRole('textbox', { name: /^Válasz/ });
    fireEvent.change(reply, { target: { value: 'Second answer' } });
    fireEvent.click(within(reply.closest('form')!).getByRole('button', { name: t('common.send') }));
    await waitFor(() => expect(comments(project)).toHaveLength(1));
    expect(comments(project)[0]!.body).toMatchObject({ text: 'Second answer', replyTo: parent.id });
    await waitFor(() => expect(within(thread).getByText('Second answer')).toBeTruthy());
    const answers = thread.querySelector('ol')!;
    expect(answers.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(answers.querySelectorAll('ol')).toHaveLength(0);
  });

  it('shows the imported mark with the original author and time', async () => {
    const project = mockProject();
    const at = '2024-01-02T03:04:05Z';
    comment(project, 'owner', 'History', { importedAuthor: 'Morgan Example', importedAt: at });
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const author = await screen.findByText('Morgan Example');
    const row = author.closest('div')!;
    expect(within(row).getByText(t('task.comments.imported'))).toBeTruthy();
    expect(row.querySelector('time')?.getAttribute('dateTime')).toBe(at);
  });

  it('writes the connected Claude into the byline of an entry the integrator wrote', async () => {
    const project = mockProject();
    const actor: Actor = {
      kind: 'human',
      handle: 'kata',
      via: 'integrator',
      through: { holder: 'kata', credential: { id: 'key_mock', prefix: 'abcd' } },
    };
    project.backend.addTimeline(
      'AC-20',
      'kata',
      'task_note',
      { text: 'Via Claude', comment: true },
      null,
      ago(5),
      actor,
    );
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const row = (await screen.findByText('Via Claude')).closest('li')!;
    const via = t('connected.via', { name: '' }).trim();
    expect(within(row).getByText((content) => content.endsWith(via))).toBeTruthy();
  });

  it('says so when there is no comment yet, and has no direct message form on the card', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    expect(await screen.findByText(t('task.comments.empty'))).toBeTruthy();
    expect(screen.getAllByRole('textbox', { name: t('task.comments.label') })).toHaveLength(1);
    expect(screen.queryByLabelText(t('messages.composer.task'))).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('offers a retry when the comments cannot be loaded', async () => {
    const project = mockProject();
    comment(project, 'be-1', 'Back again');
    const answer = createMockFetch(project.backend, project.requests);
    let failing = true;
    setFetchImplementation(async (input, init) =>
      failing && String(input).startsWith(COMMENTS) && (init?.method ?? 'GET') === 'GET'
        ? new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Failed' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : answer(input, init),
    );
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const failure = await screen.findByText(t('task.comments.loadFailed'));
    failing = false;
    fireEvent.click(
      within(failure.closest('[role="alert"]') as HTMLElement).getByRole('button', {
        name: t('task.comments.retry'),
      }),
    );
    expect(await screen.findByText('Back again')).toBeTruthy();
  });

  it('keeps the text and sends the retry with the same clientRequestId, so the card gets one comment', async () => {
    const project = mockProject();
    const answer = createMockFetch(project.backend, project.requests);
    let first = true;
    setFetchImplementation(async (input, init) => {
      const response = await answer(input, init);
      // The comment was stored, but the answer never reached the reader.
      if (first && init?.method === 'POST' && input === COMMENTS) {
        first = false;
        return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Failed' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return response;
    });
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const input = await box();
    fireEvent.change(input, { target: { value: 'Only once' } });
    fireEvent.click(screen.getByRole('button', { name: t('common.send') }));
    const alert = await screen.findByRole('alert');
    expect(input.value).toBe('Only once');
    fireEvent.click(within(alert).getByRole('button', { name: t('task.comments.retry') }));
    await waitFor(() => expect(comments(project)).toHaveLength(2));
    const [one, two] = comments(project).map((request) => request.body as { clientRequestId: string });
    expect(two!.clientRequestId).toBe(one!.clientRequestId);
    const stored = project.backend.timeline.filter(
      (event) => event.taskKey === 'AC-20' && event.data.text === 'Only once',
    );
    expect(stored).toHaveLength(1);
    await waitFor(() => expect(input.value).toBe(''));
    expect(await screen.findAllByText('Only once')).toHaveLength(1);
  });

  it('keeps the draft through a change of the view and sends the text with Ctrl+Enter', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    fireEvent.change(await box(), { target: { value: 'Half a thought' } });
    await openTab('card');
    await openTab('thread');
    const input = await box();
    expect(input.value).toBe('Half a thought');
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(comments(project)).toHaveLength(1));
    expect(comments(project)[0]!.body).toMatchObject({ text: 'Half a thought' });
  });

  it('restores the draft after the card is opened again', async () => {
    const project = mockProject();
    const view = project.render(drawer, '/p/AC/tasks/AC-20/thread');
    fireEvent.change(await box(), { target: { value: 'Kept for later' } });
    view.unmount();
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    expect((await box()).value).toBe('Kept for later');
  });

  it('opens around the comment a link points at and frames it', async () => {
    const project = mockProject();
    const target = comment(project, 'be-1', 'The one in the link', {}, 50);
    comment(project, 'fe-1', 'Later words', {}, 10);
    const reached: string[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      reached.push(this.id);
    });
    project.render(drawer, `/p/AC/tasks/AC-20/thread#timeline-${target.id}`);
    await screen.findByText('The one in the link');
    await waitFor(() => expect(reached).toContain(`timeline-${target.id}`));
    expect(document.activeElement?.id).toBe(`timeline-${target.id}`);
    // The newest page joins the list after the jump: the frame stays.
    await screen.findByText('Later words');
    expect(document.getElementById(`timeline-${target.id}`)?.className).toMatch(/flash/);
  });

  it('offers no newer comments after a jump when the newest one is loaded, and keeps the count on the tab', async () => {
    const project = mockProject();
    const target = comment(project, 'be-1', 'The one in the link', {}, 50);
    comment(project, 'fe-1', 'Later words', {}, 10);
    project.render(drawer, `/p/AC/tasks/AC-20/thread#timeline-${target.id}`);
    await screen.findByText('Later words');
    const tab = within(screen.getByRole('group', { name: t('task.view.label') })).getByRole('button', {
      name: new RegExp(`^${t('task.view.thread')}`),
    });
    await waitFor(() => expect(within(tab).getByText('2')).toBeTruthy());
    expect(screen.queryByRole('button', { name: t('task.comments.newer') })).toBeNull();
  });

  it('offers the newer comments after a jump while the newest page does not meet the loaded ones', async () => {
    const project = mockProject();
    const target = comment(project, 'be-1', 'The one in the link', {}, 500);
    // The page around the first comment ends well before the newest page begins.
    for (let i = 0; i < 60; i += 1) comment(project, 'fe-1', `Later words ${i}`, {}, 400 - i);
    project.render(drawer, `/p/AC/tasks/AC-20/thread#timeline-${target.id}`);
    await screen.findByText('The one in the link');
    expect(await screen.findByRole('button', { name: t('task.comments.newer') })).toBeTruthy();
    expect(screen.queryByText('Later words 59')).toBeNull();
  });

  it('names the reply box of the viewer’s own comment without "Te"', async () => {
    const project = mockProject();
    comment(project, 'owner', 'Mine', {}, 20);
    comment(project, 'be-1', 'Theirs', {}, 10);
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const list = await column();
    fireEvent.click(within(list.getByText('Mine').closest('li')!).getByRole('button', { name: /^Válasz/ }));
    expect(await screen.findByRole('textbox', { name: t('task.comments.replyingToOwn') })).toBeTruthy();
    fireEvent.click(within(list.getByText('Theirs').closest('li')!).getByRole('button', { name: /^Válasz/ }));
    expect(
      await screen.findByRole('textbox', {
        name: t('task.comments.replyingTo', { name: 'Backend fejlesztő' }),
      }),
    ).toBeTruthy();
  });

  it('does not call the reader the author of an imported comment', async () => {
    const project = mockProject();
    comment(project, 'owner', 'History', { importedAuthor: 'Morgan Example', importedAt: ago(3000) });
    comment(project, 'owner', 'Mine', {}, 5);
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const list = await column();
    const imported = within(list.getByText('History').closest('li')!);
    // The importer is the viewer, the author is not: the button names the original author.
    fireEvent.click(
      imported.getByRole('button', { name: t('task.comments.replyAria', { name: 'Morgan Example' }) }),
    );
    expect(
      await screen.findByRole('textbox', { name: t('task.comments.replyingTo', { name: 'Morgan Example' }) }),
    ).toBeTruthy();
    expect(
      within(list.getByText('Mine').closest('li')!).getByRole('button', {
        name: t('task.comments.replyAriaOwn'),
      }),
    ).toBeTruthy();
  });

  it('scrolls a reply box the reader opened into view', async () => {
    const project = mockProject();
    comment(project, 'be-1', 'Theirs', {}, 10);
    const reached: Element[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      reached.push(this);
    });
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const list = await column();
    fireEvent.click(within(list.getByText('Theirs').closest('li')!).getByRole('button', { name: /^Válasz/ }));
    const reply = await screen.findByRole('textbox', { name: /^Válasz/ });
    await waitFor(() => expect(reached.some((element) => element.contains(reply))).toBe(true));
  });

  describe('the status line under a comment (PM-1305)', () => {
    /** The comment of the owner that mentions `be-1`, and the notice message the server sent for it. */
    const mentioning = (project: Project) => {
      const event = comment(project, 'owner', '@be-1 nézd meg', { mentions: ['be-1'] }, 30);
      const notice = project.backend.sendTeamMessage(
        'owner',
        ['be-1'],
        'AC-20',
        'nézd meg',
        undefined,
        undefined,
        undefined,
        undefined,
        { origin: { kind: 'note', eventId: event.id } },
      );
      return { event, notice };
    };

    it('says what became of the comment for each mentioned member, and nothing under a comment that mentions no one', async () => {
      const project = mockProject();
      comment(project, 'owner', 'Just a thought', {}, 40);
      mentioning(project);
      project.render(drawer, '/p/AC/tasks/AC-20/thread');
      const lines = await screen.findAllByRole('list', { name: t('processing.list') });
      expect(lines).toHaveLength(1);
      const row = within(lines[0]!).getAllByRole('listitem');
      expect(row).toHaveLength(1);
      expect(row[0]!.getAttribute('data-state')).toBe('stored');
      expect(row[0]!.textContent).toContain(project.backend.findMember('be-1')!.displayName);
    });

    it('keeps the longer explanation folded under the row until it is asked for', async () => {
      const project = mockProject();
      const { notice } = mentioning(project);
      notice.receipts![0]!.deliveredAt = ago(20);
      project.render(drawer, '/p/AC/tasks/AC-20/thread');
      const lines = await screen.findByRole('list', { name: t('processing.list') });
      const folded = lines.querySelector('details');
      expect(folded).toBeTruthy();
      expect(folded!.open).toBe(false);
      expect(within(folded!).getByText(t('processing.details'))).toBeTruthy();
    });

    it('opens the answer of the member through the comment link once they replied', async () => {
      const project = mockProject();
      const { event, notice } = mentioning(project);
      notice.receipts![0]!.deliveredAt = ago(20);
      const answer = comment(project, 'be-1', 'Kész', { replyTo: event.id }, 5);
      project.render(drawer, '/p/AC/tasks/AC-20/thread');
      const open = await screen.findByRole('link', { name: t('processing.openReply') });
      expect(open.getAttribute('href')).toContain(`#timeline-${answer.id}`);
    });

    it('reads the comments again when the processing of a message changed, with no polling', async () => {
      const project = mockProject();
      const { notice } = mentioning(project);
      let client!: QueryClient;
      const Grab = () => {
        client = useQueryClient();
        return null;
      };
      project.render(
        <>
          {drawer}
          <Grab />
        </>,
        '/p/AC/tasks/AC-20/thread',
      );
      const before = await screen.findByRole('list', { name: t('processing.list') });
      expect(within(before).getByRole('listitem').getAttribute('data-state')).toBe('stored');
      notice.receipts![0]!.deliveredAt = ago(1);
      applyServerEvent(client, {
        type: 'message_processing_changed',
        projectKey: 'AC',
        messageId: notice.id,
        taskKey: 'AC-20',
        from: 'owner',
      });
      await waitFor(() =>
        expect(
          within(screen.getByRole('list', { name: t('processing.list') }))
            .getByRole('listitem')
            .getAttribute('data-state'),
        ).toBe('delivered'),
      );
    });
  });

  describe('the first-use tip at the box (PM-1305)', () => {
    it('is dismissed once and stays away for the account', async () => {
      const project = mockProject();
      const view = project.render(drawer, '/p/AC/tasks/AC-20/thread');
      await box();
      fireEvent.click(await screen.findByRole('button', { name: t('task.comments.tipDismiss') }));
      expect(screen.queryByRole('button', { name: t('task.comments.tipDismiss') })).toBeNull();
      view.unmount();
      project.render(drawer, '/p/AC/tasks/AC-20/thread');
      await box();
      expect(screen.queryByRole('button', { name: t('task.comments.tipDismiss') })).toBeNull();
    });

    it('is not shown while the box holds text, so the box does not grow on a phone', async () => {
      // The dismissal above is remembered for the account; this reader has not dismissed it.
      window.localStorage.clear();
      const project = mockProject();
      project.render(drawer, '/p/AC/tasks/AC-20/thread');
      fireEvent.change(await box(), { target: { value: 'Már írok' } });
      expect(screen.queryByRole('button', { name: t('task.comments.tipDismiss') })).toBeNull();
      fireEvent.change(await box(), { target: { value: '' } });
      expect(await screen.findByRole('button', { name: t('task.comments.tipDismiss') })).toBeTruthy();
    });
  });

  it('lets a viewer read the comments without a form', async () => {
    const project = mockProject();
    comment(project, 'be-1', 'Read only');
    project.render(drawer, '/p/AC/tasks/AC-20/thread', {
      can: { createTasks: false, manageTeam: false, workInSessions: false, comment: false },
    });
    expect(await screen.findByText('Read only')).toBeTruthy();
    expect(screen.getByText(t('task.comments.readOnly'))).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: t('task.comments.label') })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Válasz/ })).toBeNull();
  });
});

describe('the files of a comment (PM-1310)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = vi.fn(() => 'blob:preview');
        static override revokeObjectURL = vi.fn();
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const FILE_UPLOADS = '/api/projects/AC/tasks/AC-20/comment-attachments';
  const file = (name = 'notes.txt', type = 'text/plain') => new File(['bytes'], name, { type });
  const pick = (form: HTMLElement, ...files: File[]) =>
    fireEvent.change(within(form).getByLabelText(t('task.comments.inputLabel')), { target: { files } });
  const send = (form: HTMLElement) =>
    within(form).getByRole('button', { name: t('common.send') }) as HTMLButtonElement;
  const mainForm = async () => (await box()).closest('form')!;
  const fileUploads = (project: Project) =>
    project.requests.filter((request) => request.method === 'POST' && request.path === FILE_UPLOADS);
  /** A comment of the viewer that carries an uploaded file, as the server stores it. */
  const commentWithFile = (project: Project, name = 'notes.txt', who = 'owner') => {
    const actor = { kind: 'human', handle: who } as const;
    const stored = project.backend.addAttachment('AC-20', { name, size: 5, type: 'text/plain' }, actor, true);
    const previous = project.backend.viewerHandle;
    project.backend.viewerHandle = who;
    project.backend.addTaskComment('AC-20', { text: '', attachmentIds: [stored.id] });
    project.backend.viewerHandle = previous;
    return stored;
  };

  it('sends a comment that has only files and shows them under it', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const form = await mainForm();
    pick(form, file());
    await waitFor(() => expect(send(form).disabled).toBe(false));
    fireEvent.click(send(form));
    await waitFor(() => expect(comments(project)).toHaveLength(1));
    const stored = project.backend.attachments.find((entry) => entry.fileName === 'notes.txt')!;
    expect(comments(project)[0]!.body).toMatchObject({ attachmentIds: [stored.id] });
    const group = await screen.findByRole('group', { name: t('messageAttachments.groupLabel') });
    expect(within(group).getByText('notes.txt')).toBeTruthy();
    expect(stored.comment?.eventId).toEqual(expect.any(String));
  });

  it('names the paperclip for the comment and states why Send waits between the buttons', async () => {
    const project = mockProject();
    const answer = createMockFetch(project.backend, project.requests);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    setFetchImplementation(async (input, init) => {
      if (init?.method === 'POST' && input === FILE_UPLOADS) await held;
      return answer(input, init);
    });
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const form = await mainForm();
    pick(form, file());
    const clip = await within(form).findByRole('button', { name: t('task.comments.attachLabel') });
    // While the file uploads, the reason sits in the actions row, next to the buttons.
    const reason = within(form).getByText(t('messageAttachments.waitUpload'));
    expect(reason.parentElement).toBe(clip.parentElement);
    release();
    await waitFor(() => expect(send(form).disabled).toBe(false));
  });

  it('takes at most ten files into one comment', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const form = await mainForm();
    pick(form, ...Array.from({ length: 11 }, (_, index) => file(`file-${index}.txt`)));
    expect(await screen.findByText(t('task.comments.tooManyFiles', { max: 10 }))).toBeTruthy();
    expect(within(form).getAllByRole('listitem')).toHaveLength(10);
  });

  it('marks a file that did not upload and sends it again on retry', async () => {
    const project = mockProject();
    const answer = createMockFetch(project.backend, project.requests);
    let first = true;
    setFetchImplementation(async (input, init) => {
      if (first && init?.method === 'POST' && input === FILE_UPLOADS) {
        first = false;
        return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Failed' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return answer(input, init);
    });
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const form = await mainForm();
    pick(form, file());
    const alert = await within(form).findByRole('alert');
    expect(send(form).disabled).toBe(true);
    fireEvent.click(within(alert).getByRole('button', { name: t('attachments.retry') }));
    await waitFor(() => expect(send(form).disabled).toBe(false));
    // The refused try never reached the backend, so the one request it records is the retry.
    expect(fileUploads(project)).toHaveLength(1);
  });

  it('marks a file the server no longer has, keeps the text and offers no retry for it', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const input = await box();
    const form = input.closest('form')!;
    fireEvent.change(input, { target: { value: 'With a file' } });
    pick(form, file());
    await waitFor(() => expect(send(form).disabled).toBe(false));
    // The file vanished after the upload (deleted elsewhere).
    project.backend.removeAttachment(project.backend.attachments[0]!.id);
    fireEvent.click(send(form));
    // One message only: the tray row says it; no error bar above and no repeat in the block reason.
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toBe(t('messageAttachments.unavailable', { fileName: 'notes.txt' }));
    expect(within(form).getAllByRole('alert')).toHaveLength(1);
    expect(within(form).getByText(t('messageAttachments.removeGone'))).toBeTruthy();
    expect(within(form).queryByRole('button', { name: t('attachments.retry') })).toBeNull();
    expect(within(form).queryByRole('button', { name: t('task.comments.retry') })).toBeNull();
    expect(send(form).disabled).toBe(true);
    expect(input.value).toBe('With a file');
  });

  it('keeps the files of an answer that is cancelled, with the rest of the draft', async () => {
    const project = mockProject();
    comment(project, 'be-1', 'The question');
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const openReply = async () => {
      fireEvent.click(await screen.findByRole('button', { name: /^Válasz/ }));
      return (await screen.findByRole('textbox', { name: /^Válasz/ })).closest('form')!;
    };
    const reply = await openReply();
    pick(reply, file());
    await waitFor(() => expect(send(reply).disabled).toBe(false));
    fireEvent.click(within(reply).getByRole('button', { name: t('common.cancel') }));
    const again = await openReply();
    expect(within(again).getByRole('list', { name: t('task.comments.trayLabel') })).toBeTruthy();
    expect(send(again).disabled).toBe(false);
  });

  it('puts a pasted screenshot into the comment, not into the card', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const input = await box();
    const image = file('shot.png', 'image/png');
    fireEvent.paste(input, {
      clipboardData: { types: ['Files'], files: [image], items: [], getData: () => '' },
    });
    await waitFor(() => expect(fileUploads(project)).toHaveLength(1));
    expect(
      project.requests.filter(
        (request) => request.method === 'POST' && request.path.endsWith('/attachments'),
      ),
    ).toHaveLength(0);
  });

  it('shows a deleted file as a tile that stays, and lets only its owner confirm the deletion', async () => {
    const project = mockProject();
    const kept = commentWithFile(project, 'kept.txt');
    commentWithFile(project, 'removed.txt');
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    fireEvent.click(
      await screen.findByRole('button', { name: t('attachments.deleteLabel', { fileName: 'removed.txt' }) }),
    );
    expect(
      screen.getByText(t('messageAttachments.commentDeleteConfirm', { fileName: 'removed.txt' })),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('attachments.deleteYes') }));
    expect(
      await screen.findByText(t('messageAttachments.goneLabel', { fileName: 'removed.txt' })),
    ).toBeTruthy();
    expect(project.backend.attachments.map((entry) => entry.id)).toEqual([kept.id]);
    // The other file is untouched: it can still be deleted.
    expect(
      screen.getByRole('button', { name: t('attachments.deleteLabel', { fileName: 'kept.txt' }) }),
    ).toBeTruthy();
  });
});

describe('editing your own comment (PM-1277)', () => {
  const editButtons = () => screen.queryAllByRole('button', { name: t('task.comments.editAria') });
  const editBox = () =>
    screen.findByRole('textbox', { name: t('task.comments.editLabel') }) as Promise<HTMLTextAreaElement>;
  const saveButton = (form: HTMLElement) =>
    within(form).getByRole('button', { name: t('task.comments.save') }) as HTMLButtonElement;
  const patches = (project: Project) =>
    project.requests.filter((request) => request.method === 'PATCH' && request.path.startsWith(COMMENTS));
  /** Opens the edit box of the viewer's only comment. */
  const openEdit = async () => {
    fireEvent.click(await screen.findByRole('button', { name: t('task.comments.editAria') }));
    const input = await editBox();
    return { input, form: input.closest('form')! };
  };
  /** The edit another member made meanwhile, as the server stores it. */
  const editedElsewhere = (project: Project, note: { id: string }, text: string, who = 'owner') =>
    project.backend.addTimeline('AC-20', who, 'task_note_edited', {
      noteId: note.id,
      text,
      mentions: [],
      base: note.id,
      added: [],
    });

  it('offers the button on the own comment and, to the owner, on an imported one, never on another one', async () => {
    const project = mockProject();
    comment(project, 'be-1', 'Their words', {}, 30);
    comment(project, 'owner', 'My words', {}, 20);
    comment(project, 'owner', 'History', { importedAuthor: 'Morgan Example' }, 10);
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    await column();
    const row = (text: string) =>
      document.getElementById(`timeline-${project.backend.timeline.find((e) => e.data.text === text)!.id}`)!;
    expect(within(row('My words')).getByRole('button', { name: t('task.comments.editAria') })).toBeTruthy();
    expect(within(row('Their words')).queryByRole('button', { name: /szerkeszt/i })).toBeNull();
    // The owner's right over an imported comment: the author's name goes into the label.
    expect(
      within(row('History')).getByRole('button', {
        name: t('task.comments.editAriaOther', { name: 'Morgan Example' }),
      }),
    ).toBeTruthy();
  });

  it('hides the button from a member who may not edit', async () => {
    const project = mockProject();
    comment(project, 'be-1', 'Their words');
    project.backend.viewerHandle = 'fe-1';
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    await column();
    const row = (await screen.findByText('Their words')).closest('li')!;
    expect(within(row).queryByRole('button', { name: /szerkeszt/i })).toBeNull();
  });

  it('opens the box in place with the current text, saves the new one and returns to the button', async () => {
    const project = mockProject();
    const note = comment(project, 'owner', 'First text');
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const { input, form } = await openEdit();
    expect(input.value).toBe('First text');
    // Nothing changed yet: nothing to save, and the other buttons wait.
    expect(saveButton(form).disabled).toBe(true);
    expect(editButtons()).toHaveLength(0);

    fireEvent.change(input, { target: { value: 'Second text' } });
    fireEvent.click(saveButton(form));
    await waitFor(() => expect(patches(project)).toHaveLength(1));
    expect(patches(project)[0]!.body).toEqual({ text: 'Second text', baseRevision: note.id });
    const row = document.getElementById(`timeline-${note.id}`)!;
    await waitFor(() => expect(within(row).getByText('Second text')).toBeTruthy());
    expect(within(row).getByText(t('task.comments.saved'))).toBeTruthy();
    expect(within(row).getByText(t('task.comments.edited'))).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: t('task.comments.editLabel') })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(row).getByRole('button', { name: t('task.comments.editAria') }),
      ),
    );
  });

  it.each([
    ['Escape', (input: HTMLElement) => fireEvent.keyDown(input, { key: 'Escape' })],
    [
      'Cancel',
      (input: HTMLElement) =>
        fireEvent.click(within(input.closest('form')!).getByRole('button', { name: t('common.cancel') })),
    ],
  ])('drops the edit and its draft on %s', async (_name, leave) => {
    const project = mockProject();
    comment(project, 'owner', 'Untouched');
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const { input } = await openEdit();
    fireEvent.change(input, { target: { value: 'Half done' } });
    leave(input);
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: t('task.comments.editLabel') })).toBeNull(),
    );
    expect(screen.getByText('Untouched')).toBeTruthy();
    expect(patches(project)).toHaveLength(0);
    // The draft is gone: the next edit starts from the saved text.
    fireEvent.click(await screen.findByRole('button', { name: t('task.comments.editAria') }));
    expect((await editBox()).value).toBe('Untouched');
  });

  it('keeps an unsent edit across a reload and opens it again', async () => {
    const project = mockProject();
    comment(project, 'owner', 'Saved text');
    const first = project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const { input } = await openEdit();
    fireEvent.change(input, { target: { value: 'Unsent edit' } });
    first.unmount();
    cleanup();
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    expect((await editBox()).value).toBe('Unsent edit');
  });

  it('says whom the edit newly mentions, and nobody already mentioned before or in an imported comment', async () => {
    const project = mockProject();
    comment(project, 'owner', 'Look @be-1', { mentions: ['be-1'] });
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const { input } = await openEdit();
    fireEvent.change(input, { target: { value: 'Look @be-1 and @fe-1' } });
    const line = await screen.findByRole('status');
    expect(line.textContent).toBe(t('task.comments.editMentions', { handles: '@fe-1' }));
    fireEvent.change(input, { target: { value: 'Look @be-1 again' } });
    await waitFor(() => expect(screen.queryByText(/@fe-1/)).toBeNull());
  });

  it('shows no mention line for an imported comment', async () => {
    const project = mockProject();
    comment(project, 'owner', 'Old', { importedAuthor: 'Morgan Example' });
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    fireEvent.click(
      await screen.findByRole('button', {
        name: t('task.comments.editAriaOther', { name: 'Morgan Example' }),
      }),
    );
    const input = (await screen.findByRole('textbox', {
      name: t('task.comments.editLabelOther'),
    })) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Old, now @be-1' } });
    expect(input.value).toBe('Old, now @be-1');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the text on a conflict and saves it on the current revision at the second try', async () => {
    const project = mockProject();
    const note = comment(project, 'owner', 'Original');
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const { input, form } = await openEdit();
    const meanwhile = editedElsewhere(project, note, 'Changed in the other window');
    fireEvent.change(input, { target: { value: 'My version' } });
    fireEvent.click(saveButton(form));
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toBe(t('task.comments.editConflict'));
    expect(input.value).toBe('My version');
    fireEvent.click(saveButton(form));
    await waitFor(() => expect(patches(project)).toHaveLength(2));
    expect(patches(project)[1]!.body).toEqual({ text: 'My version', baseRevision: meanwhile.id });
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: t('task.comments.editLabel') })).toBeNull(),
    );
    expect(screen.getByText('My version')).toBeTruthy();
  });

  it('turns the box read-only when the right to edit is gone', async () => {
    const project = mockProject();
    comment(project, 'owner', 'Mine');
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const { input, form } = await openEdit();
    project.backend.viewerHandle = 'fe-1';
    fireEvent.change(input, { target: { value: 'Mine, changed' } });
    fireEvent.click(saveButton(form));
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toBe(t('task.comments.editForbidden'));
    expect(input.readOnly).toBe(true);
    expect(within(form).queryByRole('button', { name: t('task.comments.save') })).toBeNull();
  });

  it('keeps the text and offers another try when saving fails', async () => {
    const project = mockProject();
    comment(project, 'owner', 'Mine');
    const answer = createMockFetch(project.backend, project.requests);
    let failing = true;
    setFetchImplementation(async (input, init) =>
      failing && (init?.method ?? 'GET') === 'PATCH'
        ? new Response(JSON.stringify({ error: { code: 'internal_error', message: 'x' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : answer(input, init),
    );
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const { input, form } = await openEdit();
    fireEvent.change(input, { target: { value: 'Mine, changed' } });
    fireEvent.click(saveButton(form));
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toBe(t('task.comments.saveFailed'));
    expect(input.value).toBe('Mine, changed');
    failing = false;
    fireEvent.click(saveButton(form));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: t('task.comments.editLabel') })).toBeNull(),
    );
    expect(screen.getByText('Mine, changed')).toBeTruthy();
  });

  it('opens the earlier versions from the mark, the original last', async () => {
    const project = mockProject();
    const note = comment(project, 'owner', 'First text');
    editedElsewhere(project, note, 'Second text');
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    const mark = await screen.findByRole('button', {
      name: t('task.comments.editedAria', { label: t('task.comments.edited') }),
    });
    expect(mark.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(mark);
    expect(mark.getAttribute('aria-expanded')).toBe('true');
    const box = (await screen.findByText(t('task.comments.history'))).parentElement!;
    const rows = within(box).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain(t('task.comments.original'));
    expect(rows[0]!.textContent).toContain('First text');
    expect(screen.getByText('Second text')).toBeTruthy();
  });

  it('shows a plain mark, no button, to a reader who may not open the earlier versions', async () => {
    const project = mockProject();
    const note = comment(project, 'be-1', 'First text');
    editedElsewhere(project, note, 'Second text', 'be-1');
    project.backend.viewerHandle = 'fe-1';
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    expect(await screen.findByText('Second text')).toBeTruthy();
    expect(screen.getByText(t('task.comments.edited'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: /korábbi változatok/ })).toBeNull();
    expect(screen.queryByText('First text')).toBeNull();
  });

  it('shows an edit that arrives from another window without a reload', async () => {
    const project = mockProject();
    const note = comment(project, 'owner', 'First text');
    let client!: QueryClient;
    const Grab = () => {
      client = useQueryClient();
      return null;
    };
    project.render(
      <>
        {drawer}
        <Grab />
      </>,
      '/p/AC/tasks/AC-20/thread',
    );
    expect(await screen.findByText('First text')).toBeTruthy();
    const edit = editedElsewhere(project, note, 'Second text');
    applyServerEvent(client, {
      type: 'timeline_appended',
      projectKey: 'AC',
      event: edit,
    });
    expect(await screen.findByText('Second text')).toBeTruthy();
    expect(screen.getByText(t('task.comments.edited'))).toBeTruthy();
  });

  it('names the editor of an imported comment the owner edited', async () => {
    const project = mockProject();
    const note = comment(project, 'owner', 'Old', { importedAuthor: 'Morgan Example' });
    editedElsewhere(project, note, 'Corrected');
    project.render(drawer, '/p/AC/tasks/AC-20/thread');
    expect(await screen.findByText('Corrected')).toBeTruthy();
    // The button's name starts with the visible words, so a screen reader hears who edited.
    expect(
      screen.getByRole('button', {
        name: t('task.comments.editedAria', { label: t('task.comments.editedByMe') }),
      }),
    ).toBeTruthy();
  });
});
