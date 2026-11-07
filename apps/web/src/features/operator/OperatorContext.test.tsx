import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { openStory, openTab } from '../../test/cardStory';
import { mockProject } from '../../test/mockProject';
import { resetCommentDrafts } from '../board/useCardCommentDraft';
import { TaskDrawer } from '../board/TaskDrawer';
import { OperatorPanel } from './OperatorPanel';

/**
 * The project manager's panel next to a card (PM-1305): the context chip, writing the unsent message on the card,
 * and what survives closing the panel on a phone. Against the fake backend, with the card drawer beside the panel.
 */
beforeEach(() => {
  resetCommentDrafts();
  window.sessionStorage.clear();
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

const file = (name: string) => new File(['bytes'], name, { type: 'text/plain' });
const panelBox = () =>
  screen.findByRole('textbox', {
    name: t('operator.composer.label' as const),
  }) as Promise<HTMLTextAreaElement>;
const cardBox = () =>
  screen.findByRole('textbox', { name: t('task.comments.label') }) as Promise<HTMLTextAreaElement>;
const choose = (files: File[]) =>
  fireEvent.change(document.querySelector('#operator-panel input[type=file]')!, { target: { files } });
const writeOnCard = () => screen.findByRole('button', { name: t('operator.writeOnCard.action') });
const posted = (project: ReturnType<typeof mockProject>, path: string) =>
  project.requests.filter((request) => request.method === 'POST' && request.path === path);

function setup(route = '/p/AC/tasks/AC-20') {
  const project = mockProject();
  const view = project.render(
    <Routes>
      <Route
        path="/p/AC/tasks/:taskKey/*"
        element={
          <>
            <TaskDrawer />
            <OperatorPanel returnFocusTo={{ current: null }} />
          </>
        }
      />
    </Routes>,
    route,
  );
  return { ...project, view };
}

describe('writing the unsent message on the card (PM-1305)', () => {
  it('moves the text and the files into the card’s comment box, sends nothing and empties the panel', async () => {
    const project = setup('/p/AC/tasks/AC-20/attachments');
    fireEvent.change(await panelBox(), { target: { value: 'Ezt a kártyára írom' } });
    choose([file('log.txt')]);
    await waitFor(() =>
      expect((screen.getByRole('button', { name: t('common.send') }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(await writeOnCard());

    // The Comments tab is open with the text in its box and the file named beside it.
    const box = await cardBox();
    await waitFor(() => expect(box.value).toBe('Ezt a kártyára írom'));
    expect((await screen.findAllByText('log.txt')).length).toBeGreaterThan(0);
    expect(screen.getByText(t('task.comments.draftMoved'))).toBeTruthy();
    // Nothing was sent: not as a message, not as a comment.
    expect(posted(project, routes.sendTeamMessage('AC'))).toHaveLength(0);
    expect(posted(project, '/api/projects/AC/tasks/AC-20/comments')).toHaveLength(0);
    // The panel starts over, and its own copy of the file is gone from the server.
    expect((await panelBox()).value).toBe('');
    expect(screen.queryByRole('list', { name: t('messageAttachments.trayLabel') })).toBeNull();
    expect(project.backend.messageAttachments).toHaveLength(0);
  });

  it('appends to a draft the card already has, and says so', async () => {
    setup();
    fireEvent.change(await panelBox(), { target: { value: 'Első' } });
    fireEvent.click(await writeOnCard());
    await waitFor(async () => expect((await cardBox()).value).toBe('Első'));

    fireEvent.change(await panelBox(), { target: { value: 'Második' } });
    fireEvent.click(await writeOnCard());
    await waitFor(async () => expect((await cardBox()).value).toBe('Első\n\nMásodik'));
    expect(screen.getByText(t('task.comments.draftMerged'))).toBeTruthy();
  });

  it('keeps everything in the panel and says so when a file cannot be moved', async () => {
    const project = setup();
    fireEvent.change(await panelBox(), { target: { value: 'Marad' } });
    choose([file('big.txt')]);
    await waitFor(() => expect(project.backend.messageAttachments).toHaveLength(1));
    const original = globalThis.fetch;
    setFetchImplementation((path, init) =>
      path === routes.taskAttachments('AC', 'AC-20') && init?.method === 'POST'
        ? Promise.resolve(
            new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Failed' } }), {
              status: 500,
            }),
          )
        : original(path, init),
    );
    fireEvent.click(await writeOnCard());
    expect((await screen.findByRole('alert')).textContent).toBe(t('operator.writeOnCard.failed'));
    expect((await panelBox()).value).toBe('Marad');
    expect(screen.getByRole('list', { name: t('messageAttachments.trayLabel') })).toBeTruthy();
  });

  it('offers the move only when there is something to move', async () => {
    setup();
    await panelBox();
    expect(screen.queryByRole('button', { name: t('operator.writeOnCard.action') })).toBeNull();
  });
});

describe('a message sent from the panel is not a comment of the card (PM-1305)', () => {
  it('shows in neither the Comments tab nor the Process tab', async () => {
    const project = setup();
    fireEvent.change(await panelBox(), { target: { value: 'Csak a pm-nek szól' } });
    fireEvent.keyDown(await panelBox(), { key: 'Enter' });
    await waitFor(() => expect(posted(project, routes.sendTeamMessage('AC'))).toHaveLength(1));
    expect(project.backend.messages.at(-1)!.taskKey).toBe('AC-20');

    // The panel itself shows the message; the card beside it must not.
    const drawer = await screen.findByRole('complementary', { name: t('task.drawerLabel') });
    expect(within(screen.getByRole('dialog')).getByText('Csak a pm-nek szól')).toBeTruthy();
    await openTab('thread');
    await cardBox();
    expect(within(drawer).queryByText('Csak a pm-nek szól')).toBeNull();
    await openStory(screen, true);
    expect(within(drawer).queryByText('Csak a pm-nek szól')).toBeNull();
  });
});

describe('the panel on a phone (PM-1305)', () => {
  function Toggle() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(!open)}>
          toggle
        </button>
        {open ? <OperatorPanel returnFocusTo={{ current: null }} /> : null}
      </>
    );
  }

  it('finds the draft, the files and the scroll position again after the sheet was closed', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    // jsdom has no layout: the thread is 1000 tall in a 200 tall box, and its scroll position is remembered.
    const tops = new WeakMap<object, number>();
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: object) {
        return tops.get(this) ?? 0;
      },
      set(this: object, value: number) {
        tops.set(this, value);
      },
    });
    try {
      const project = mockProject();
      project.render(<Toggle />, '/p/AC');
      fireEvent.change(await panelBox(), { target: { value: 'Félig kész gondolat' } });
      choose([file('kep.txt')]);
      await waitFor(() => expect(project.backend.messageAttachments).toHaveLength(1));
      const log = screen.getByRole('log');
      log.scrollTop = 300;
      fireEvent.scroll(log);

      fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'toggle' }));

      expect((await panelBox()).value).toBe('Félig kész gondolat');
      expect(
        within(screen.getByRole('list', { name: t('messageAttachments.trayLabel') })).getAllByRole(
          'listitem',
        ),
      ).toHaveLength(1);
      expect(project.backend.messageAttachments).toHaveLength(1);
      await waitFor(() => expect(screen.getByRole('log').scrollTop).toBe(300));
    } finally {
      delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
    }
  });
});
