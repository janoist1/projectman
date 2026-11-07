import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mentionPayloadOf } from '@projectman/shared';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { server } from '../../test/msw/server';
import { resetCommentDrafts } from '../board/useCardCommentDraft';
import { InboxPage } from './InboxPage';

/** The mention of the viewer (`kata`) by `owner` in a comment, a reply or a process note in "Rád vár" (PM-1276). */

const MENTION = '@kata can you look at this?';

/** `owner` writes a comment mentioning `kata`, who is the viewer of the page from then on. */
function mentionedProject(text = MENTION) {
  const project = mockProject();
  const { backend } = project;
  backend.inbox = [];
  const taskKey = backend.tasks[0]!.key;
  backend.viewerHandle = 'owner';
  expect(backend.addTaskComment(taskKey, { text })).toBeNull();
  const eventId = backend.timeline.filter((event) => event.type === 'task_note').at(-1)!.id;
  backend.viewerHandle = 'kata';
  const item = backend.inbox.find((entry) => entry.kind === 'mention')!;
  const render = project.render;
  project.render = (ui, route) => render(ui, route, { myHandle: 'kata', isOwner: false });
  return { project, backend, taskKey, eventId, item };
}

const title = () => t('inbox.mention.title.comment');
const cardOf = (heading: string) =>
  screen.findByRole('heading', { name: heading }).then((h) => h.closest('article')!);
const draftBox = () => screen.findByRole('textbox', { name: t('inbox.mention.replyLabel') });

beforeEach(() => {
  window.sessionStorage.clear();
  resetCommentDrafts();
});
afterEach(() => {
  window.sessionStorage.clear();
  resetCommentDrafts();
});

describe('the mention card', () => {
  it('shows who mentioned the viewer, where, the excerpt and the three actions', async () => {
    const { project, taskKey, eventId } = mentionedProject();
    project.render(<InboxPage />, '/p/AC/inbox');
    const card = await cardOf(title());
    expect(card.textContent).toContain(MENTION);
    expect(card.textContent).toContain(taskKey);
    expect(within(card).getByText(t('inbox.kinds.mention'))).toBeTruthy();
    expect(within(card).getByRole('button', { name: t('inbox.mention.seen') })).toBeTruthy();
    expect(within(card).getByRole('button', { name: t('inbox.mention.reply') })).toBeTruthy();
    expect(
      within(card)
        .getByRole('link', { name: t('inbox.mention.jump') })
        .getAttribute('href'),
    ).toBe(`/p/AC/tasks/${taskKey}#timeline-${eventId}`);
  });

  it('folds a long excerpt behind a toggle', async () => {
    const { project } = mentionedProject(`@kata ${'long text '.repeat(60)}`);
    project.render(<InboxPage />, '/p/AC/inbox');
    const card = await cardOf(title());
    const before = card.textContent!.length;
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.mention.expand') }));
    expect(card.textContent!.length).toBeGreaterThan(before);
    expect(within(card).getByRole('button', { name: t('inbox.mention.collapse') })).toBeTruthy();
  });

  it('is counted by the Említés filter and the all view; the emptied filter says what it holds', async () => {
    const { project } = mentionedProject();
    project.render(<InboxPage />, '/p/AC/inbox');
    await cardOf(title());
    const group = screen.getByRole('group', { name: t('inbox.filtersLabel') });
    const pill = within(group).getByRole('button', { name: new RegExp(t('inbox.kinds.mention')) });
    expect(pill.textContent).toContain('1');
    expect(
      within(group).getByRole('button', { name: new RegExp(t('inbox.filters.all')) }).textContent,
    ).toContain('1');
    fireEvent.click(pill);
    fireEvent.click(within(await cardOf(title())).getByRole('button', { name: t('inbox.mention.seen') }));
    const empty = await screen.findByText(t('inbox.mention.emptyFilter'));
    expect(screen.getByText(t('inbox.mention.emptyFilterBody'))).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(empty));
  });
});

describe('Láttam', () => {
  it('closes the item after the server answered, and the history says it was seen', async () => {
    const { project, backend, item } = mentionedProject();
    project.render(<InboxPage />, '/p/AC/inbox');
    const card = await cardOf(title());
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.mention.seen') }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: title() })).toBeNull());
    expect(backend.inbox.find((entry) => entry.id === item.id)).toMatchObject({
      state: 'resolved',
      resolution: { optionId: 'seen' },
    });
    expect(
      project.requests.some(
        (request) => request.path.endsWith(`/inbox/${item.id}/resolve`) && request.method === 'POST',
      ),
    ).toBe(true);
    expect(await screen.findByText(new RegExp(t('inbox.mention.historySeen')))).toBeTruthy();
  });

  it('waits for the server: the item stays, busy and with its actions disabled, until it answers', async () => {
    const { project } = mentionedProject();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post('http://localhost/api/projects/AC/inbox/:id/resolve', async () => {
        await gate;
      }),
    );
    project.render(<InboxPage />, '/p/AC/inbox');
    const card = await cardOf(title());
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.mention.seen') }));
    const busy = await within(card).findByRole('button', { name: t('inbox.mention.closing') });
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(
      within(card)
        .getByRole('button', { name: t('inbox.mention.reply') })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByRole('heading', { name: title() })).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole('heading', { name: title() })).toBeNull());
  });

  it('keeps the item open and says so when the server refuses', async () => {
    const { project } = mentionedProject();
    server.use(
      http.post('http://localhost/api/projects/AC/inbox/:id/resolve', () =>
        HttpResponse.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 }),
      ),
    );
    project.render(<InboxPage />, '/p/AC/inbox');
    const card = await cardOf(title());
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.mention.seen') }));
    const alert = await within(card).findByRole('alert');
    expect(alert.textContent).toBe(t('inbox.mention.closeFailed'));
    expect(
      within(card)
        .getByRole('button', { name: t('inbox.mention.seen') })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
});

describe('Válasz', () => {
  it('sends the reply under the comment, closes the mention and says so in the history', async () => {
    const { project, backend, taskKey, eventId, item } = mentionedProject();
    project.render(<InboxPage />, '/p/AC/inbox');
    const card = await cardOf(title());
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.mention.reply') }));
    const box = await draftBox();
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'On it.' } });
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.mention.replySend') }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: title() })).toBeNull());
    const sent = project.requests.find(
      (request) => request.method === 'POST' && request.path.endsWith(`/tasks/${taskKey}/comments`),
    );
    expect(sent?.body).toMatchObject({ text: 'On it.', replyTo: eventId });
    expect((sent?.body as { clientRequestId?: string }).clientRequestId).toBeTruthy();
    expect(backend.inbox.find((entry) => entry.id === item.id)?.resolution?.rule).toBe('mention_replied');
    expect(await screen.findByText(new RegExp(t('inbox.mention.historyReplied')))).toBeTruthy();
  });

  it('moves the focus to the next card after a reply, which leaves no draft behind', async () => {
    const { project, backend, taskKey } = mentionedProject();
    backend.viewerHandle = 'owner';
    expect(backend.addTaskComment(taskKey, { text: '@kata and one more thing' })).toBeNull();
    backend.viewerHandle = 'kata';
    project.render(<InboxPage />, '/p/AC/inbox');
    const [first] = await screen.findAllByRole('heading', { name: title() });
    const card = first!.closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.mention.reply') }));
    fireEvent.change(await draftBox(), { target: { value: 'On it.' } });
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.mention.replySend') }));
    await waitFor(() => expect(screen.getAllByRole('heading', { name: title() })).toHaveLength(1));
    expect(screen.queryByText(t('inbox.mention.goneReplied'))).toBeNull();
    expect(screen.queryByRole('textbox', { name: t('inbox.mention.replyLabel') })).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: title() })));
  });

  it('moves the focus to the next card after Láttam', async () => {
    const { project, backend, taskKey } = mentionedProject();
    backend.viewerHandle = 'owner';
    expect(backend.addTaskComment(taskKey, { text: '@kata and one more thing' })).toBeNull();
    backend.viewerHandle = 'kata';
    project.render(<InboxPage />, '/p/AC/inbox');
    const [first] = await screen.findAllByRole('heading', { name: title() });
    fireEvent.click(
      within(first!.closest('article')!).getByRole('button', { name: t('inbox.mention.seen') }),
    );
    await waitFor(() => expect(screen.getAllByRole('heading', { name: title() })).toHaveLength(1));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: title() })));
  });

  it('keeps the text and the item when the send fails', async () => {
    const { project } = mentionedProject();
    server.use(
      http.post('http://localhost/api/projects/AC/tasks/:key/comments', () =>
        HttpResponse.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 }),
      ),
    );
    project.render(<InboxPage />, '/p/AC/inbox');
    const card = await cardOf(title());
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.mention.reply') }));
    const box = await draftBox();
    fireEvent.change(box, { target: { value: 'On it.' } });
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.mention.replySend') }));
    const alert = await within(card).findByRole('alert');
    expect(alert.textContent).toContain(t('inbox.mention.replyFailed'));
    expect(((await draftBox()) as HTMLTextAreaElement).value).toBe('On it.');
    expect(screen.getByRole('heading', { name: title() })).toBeTruthy();
  });

  it('keeps the draft after Mégse, gives the focus back to Válasz and restores the text on reopening', async () => {
    const { project } = mentionedProject();
    project.render(<InboxPage />, '/p/AC/inbox');
    const card = await cardOf(title());
    const reply = () => within(card).getByRole('button', { name: t('inbox.mention.reply') });
    fireEvent.click(reply());
    fireEvent.change(await draftBox(), { target: { value: 'half a thought' } });
    fireEvent.click(within(card).getByRole('button', { name: t('common.cancel') }));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: t('inbox.mention.replyLabel') })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(reply()));
    fireEvent.click(reply());
    expect(((await draftBox()) as HTMLTextAreaElement).value).toBe('half a thought');
  });

  it('opens one reply box at a time', async () => {
    const { project, backend, taskKey } = mentionedProject();
    backend.viewerHandle = 'owner';
    backend.addTaskComment(taskKey, { text: '@kata and another one' });
    backend.viewerHandle = 'kata';
    project.render(<InboxPage />, '/p/AC/inbox');
    await waitFor(() => expect(screen.getAllByRole('heading', { name: title() })).toHaveLength(2));
    const [first, second] = screen.getAllByRole('button', { name: t('inbox.mention.reply') });
    fireEvent.click(first!);
    await draftBox();
    fireEvent.click(second!);
    await waitFor(() =>
      expect(screen.getAllByRole('textbox', { name: t('inbox.mention.replyLabel') })).toHaveLength(1),
    );
  });

  it('offers no reply for a process note, which has no thread', async () => {
    const { project, item } = mentionedProject();
    item.payload = { ...mentionPayloadOf(item)!, place: 'note', threadId: null };
    project.render(<InboxPage />, '/p/AC/inbox');
    const card = await cardOf(t('inbox.mention.title.note'));
    expect(within(card).queryByRole('button', { name: t('inbox.mention.reply') })).toBeNull();
    expect(within(card).getByRole('button', { name: t('inbox.mention.seen') })).toBeTruthy();
  });
});

describe('a comment that is no longer there', () => {
  it('says so and leaves only Láttam', async () => {
    const { project } = mentionedProject();
    server.use(
      http.get('http://localhost/api/projects/AC/tasks/:key/comments', () =>
        HttpResponse.json({ error: { code: 'not_found', message: 'gone' } }, { status: 404 }),
      ),
    );
    project.render(<InboxPage />, '/p/AC/inbox');
    const card = await cardOf(title());
    await within(card).findByText(t('inbox.mention.missing'));
    expect(within(card).queryByRole('button', { name: t('inbox.mention.reply') })).toBeNull();
    expect(within(card).queryByRole('link', { name: t('inbox.mention.jump') })).toBeNull();
    expect(within(card).getByRole('button', { name: t('inbox.mention.seen') })).toBeTruthy();
  });
});

describe('an item closed in another window', () => {
  it('stays in place with the reply text and the draft while a draft is open', async () => {
    const { project, backend, taskKey, eventId } = mentionedProject();
    const { client } = project.render(<InboxPage />, '/p/AC/inbox');
    const card = await cardOf(title());
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.mention.reply') }));
    fireEvent.change(await draftBox(), { target: { value: 'my draft' } });
    // The reply goes out from another window: the server closes the item by its rule.
    backend.addTaskComment(taskKey, { text: 'answered elsewhere', replyTo: eventId });
    await client.invalidateQueries();
    const notice = await screen.findByText(t('inbox.mention.goneReplied'));
    expect(notice.getAttribute('role')).toBe('status');
    expect(((await draftBox()) as HTMLTextAreaElement).value).toBe('my draft');
    // The card is built again when the item leaves the open list: look it up anew.
    const kept = await cardOf(title());
    expect(within(kept).queryByRole('button', { name: t('inbox.mention.seen') })).toBeNull();
    fireEvent.click(within(kept).getByRole('button', { name: t('inbox.closedWhileOpen.dismiss') }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: title() })).toBeNull());
  });

  it('leaves the list at once when there is no draft', async () => {
    const { project, backend, taskKey, eventId } = mentionedProject();
    const { client } = project.render(<InboxPage />, '/p/AC/inbox');
    await cardOf(title());
    backend.addTaskComment(taskKey, { text: 'answered elsewhere', replyTo: eventId });
    await client.invalidateQueries();
    await waitFor(() => expect(screen.queryByRole('heading', { name: title() })).toBeNull());
  });
});
