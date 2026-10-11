import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject, createMockFetch } from '../../test/mockProject';
import { TaskDrawer } from '../board/TaskDrawer';
import { ConversationThread } from './ConversationThread';
import { MessageComposer } from './MessageComposer';
import { MessagesPage } from './MessagesPage';
import { MessageList } from './MessageList';

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});
const image = () => new File(['bytes'], 'screen.png', { type: 'image/png' });
const transfer = (files: File[]) => ({ files, types: ['Files'], getData: () => '' });
const paste = (element: Element) =>
  fireEvent.paste(element, {
    clipboardData: {
      types: ['Files'],
      getData: () => '',
      files: [image()],
      items: [{ kind: 'file', type: 'image/png', getAsFile: image }],
    },
  });
const sentRequest = (p: ReturnType<typeof mockProject>) =>
  p.requests.find((r) => r.method === 'POST' && r.path === routes.teamMessages('AC'));
const uploads = (p: ReturnType<typeof mockProject>) =>
  p.requests.filter((r) => r.method === 'POST' && r.path === routes.messageAttachments('AC'));
async function sendReady() {
  const button = screen.getByRole('button', { name: t('common.send') }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

describe('message attachment destinations', () => {
  it('describes form paste without promising Enter to send and keeps Enter as a newline', () => {
    mockProject().render(<MessageComposer />);
    expect(screen.getByText(t('messageAttachments.hintForm'))).toBeTruthy();
    expect(screen.queryByText(t('messageAttachments.hint'))).toBeNull();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Draft' } });
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
    expect((input as HTMLTextAreaElement).value).toBe('Draft');
  });
  it('allows dialog paste before choosing a recipient and enables sending once chosen', async () => {
    const p = mockProject();
    p.render(<MessageComposer />);
    const input = screen.getByRole('textbox');
    paste(input);
    await waitFor(() => expect(uploads(p)).toHaveLength(1));
    const button = screen.getByRole('button', { name: t('messages.send') }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(await screen.findByRole('checkbox', { name: /fe-1/ }));
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() =>
      expect(sentRequest(p)?.body).toMatchObject({ text: '', attachmentIds: [expect.any(String)] }),
    );
  });

  it('returns focus to the conversation input when an opened image is deleted', async () => {
    const p = mockProject();
    p.render(<ConversationThread peer="fe-1" roles={[]} onCompose={() => {}} />);
    const input = await screen.findByRole('textbox');
    paste(input);
    await sendReady();
    const opener = await screen.findByRole('button', {
      name: t('attachments.previewLabel', { fileName: 'screen.png' }),
    });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'screen.png' });
    fireEvent.click(within(dialog).getByRole('button', { name: t('attachments.delete') }));
    fireEvent.click(within(dialog).getByRole('button', { name: t('attachments.deleteYes') }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'screen.png' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('sends a picked file without text in a conversation and clears the tray', async () => {
    const p = mockProject();
    p.render(<ConversationThread peer="fe-1" roles={[]} onCompose={() => {}} />);
    await screen.findByRole('textbox');
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [image()] } });
    await sendReady();
    await waitFor(() =>
      expect(sentRequest(p)?.body).toMatchObject({
        to: ['fe-1'],
        text: '',
        attachmentIds: [expect.any(String)],
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: t('messageAttachments.trayLabel') })).toBeNull(),
    );
  });

  it('retains the dialog tray on a failed send and retries with the same ids', async () => {
    const p = mockProject();
    const fetch = createMockFetch(p.backend, p.requests);
    let fail = true;
    setFetchImplementation(async (path, init) => {
      if (fail && path === routes.teamMessages('AC') && init?.method === 'POST') {
        p.requests.push({ path, method: 'POST', body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Failed' } }), {
          status: 500,
        });
      }
      return fetch(path, init);
    });
    p.render(<MessageComposer initialTo={['fe-1']} />);
    fireEvent.drop(document.querySelector('form')!, { dataTransfer: transfer([image()]) });
    const button = screen.getByRole('button', { name: t('messages.send') }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByRole('alert');
    expect(screen.getByRole('list', { name: t('messageAttachments.trayLabel') })).toBeTruthy();
    fail = false;
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        p.requests.filter((r) => r.path === routes.teamMessages('AC') && r.method === 'POST'),
      ).toHaveLength(2),
    );
    const requests = p.requests.filter((r) => r.path === routes.teamMessages('AC') && r.method === 'POST');
    expect(requests[1]!.body).toEqual(requests[0]!.body);
    expect(uploads(p)).toHaveLength(1);
  });

  it.each(['paste', 'drop'])('keeps a card thread %s out of card attachments', async (method) => {
    const p = mockProject();
    p.render(
      <Routes>
        <Route path="/p/AC/tasks/:taskKey/*" element={<TaskDrawer />} />
      </Routes>,
      '/p/AC/tasks/AC-21/thread',
    );
    const input = await screen.findByRole('textbox', {
      name: t('task.thread.composerLabel', { key: 'AC-21' }),
    });
    input.focus();
    if (method === 'paste') paste(input);
    else
      fireEvent.drop(screen.getByRole('region', { name: t('task.thread.label') }), {
        dataTransfer: transfer([image()]),
      });
    await sendReady();
    await waitFor(() =>
      expect(sentRequest(p)?.body).toMatchObject({
        taskKey: 'AC-21',
        text: '',
        attachmentIds: [expect.any(String)],
      }),
    );
    expect(uploads(p)).toHaveLength(1);
    expect(
      p.requests.some((r) => r.method === 'POST' && r.path === routes.taskAttachments('AC', 'AC-21')),
    ).toBe(false);
    expect(screen.queryByRole('status', { name: t('attachments.dropActive') })).toBeNull();
  });

  it('keeps an outside paste on the card and leaves text paste alone', async () => {
    const p = mockProject();
    p.render(
      <Routes>
        <Route path="/p/AC/tasks/:taskKey/*" element={<TaskDrawer />} />
      </Routes>,
      '/p/AC/tasks/AC-21/thread',
    );
    const input = await screen.findByRole('textbox', {
      name: t('task.thread.composerLabel', { key: 'AC-21' }),
    });
    fireEvent.paste(input, { clipboardData: { ...transfer([image()]), getData: () => 'text' } });
    expect(uploads(p)).toHaveLength(0);
    input.blur();
    paste(document.body);
    await waitFor(() =>
      expect(
        p.requests.some((r) => r.method === 'POST' && r.path === routes.taskAttachments('AC', 'AC-21')),
      ).toBe(true),
    );
    expect(uploads(p)).toHaveLength(0);
  });
});

it('previews single, multiple and deleted files and renders AI attachments in all messages', async () => {
  const p = mockProject();
  p.backend.messages = [];
  const a = p.backend.sendTeamMessage('fe-1', ['owner'], null, 'Fixture');
  a.body = '';
  a.attachments = [
    {
      id: 'msa_preview0001',
      fileName: 'gone.png',
      size: 10,
      mediaType: 'image/png',
      preview: 'image',
      goneAt: new Date().toISOString(),
    },
  ];
  const b = p.backend.sendTeamMessage('owner', ['qa'], null, 'Fixture');
  b.body = '';
  b.attachments = Array.from({ length: 3 }, (_, i) => ({
    ...a.attachments![0]!,
    id: `msa_preview000${i + 2}`,
  }));
  const view = p.render(
    <Routes>
      <Route path="/p/AC/messages/with/:handle" element={<MessagesPage />} />
    </Routes>,
    '/p/AC/messages/with/fe-1',
  );
  const list = await screen.findByRole('navigation', { name: t('messages.list.label') });
  expect(await within(list).findByText('gone.png')).toBeTruthy();
  expect(
    within(list).getByText(
      t('messages.list.you', { text: t('messageAttachments.previewMany', { count: 3 }) }),
    ),
  ).toBeTruthy();
  expect(await screen.findByText(t('messageAttachments.gone'))).toBeTruthy();
  view.unmount();
  const all = p.render(
    <Routes>
      <Route path="/p/AC/messages/all" element={<MessagesPage />} />
    </Routes>,
    '/p/AC/messages/all',
  );
  const row = await screen.findByText('gone.png');
  fireEvent.click(row.closest('button')!);
  expect(await screen.findByText(t('messageAttachments.gone'))).toBeTruthy();
  all.unmount();
  p.render(
    <MessageList
      messages={[a]}
      members={new Map()}
      myHandle="owner"
      projectKey="AC"
      taskTitles={new Map()}
    />,
  );
  expect(screen.getByText('gone.png')).toBeTruthy();
  expect(document.querySelectorAll('p')).toHaveLength(1);
});
