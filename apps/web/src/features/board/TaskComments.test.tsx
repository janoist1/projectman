import type { Actor } from '@projectman/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
