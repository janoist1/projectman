import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTACHMENT_BYTES, routes } from '@projectman/shared';
import type { MessageAttachment, TeamMessage } from '@projectman/shared';
import { applyServerEvent } from '../../api/cache';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { TaskDrawer } from '../board/TaskDrawer';
import { OperatorPanel } from './OperatorPanel';

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

const file = (name = 'screen.png', type = 'image/png') => new File(['bytes'], name, { type });
const input = () => screen.getByRole('textbox', { name: t('operator.composer.label') });
const send = () => screen.getByRole('button', { name: t('common.send') }) as HTMLButtonElement;
const tray = () => screen.getByRole('list', { name: t('messageAttachments.trayLabel') });
const choose = (files: File[]) =>
  fireEvent.change(document.querySelector('#operator-panel input[type=file]')!, { target: { files } });
const data = (files: File[]) => ({ files, types: ['Files'], getData: () => '' });
function setup(drawer = false) {
  const project = mockProject();
  const result = project.render(
    drawer ? (
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
      </Routes>
    ) : (
      <OperatorPanel returnFocusTo={{ current: null }} />
    ),
    drawer ? '/p/AC/tasks/AC-20/attachments' : '/',
  );
  return { ...project, ...result };
}
async function ready() {
  await waitFor(() => expect(send().disabled).toBe(false));
}
function seed(project: ReturnType<typeof mockProject>, name: string, type = 'image/png') {
  const response = project.backend.handle(
    'POST',
    routes.messageAttachments('AC'),
    (() => {
      const form = new FormData();
      form.append('file', file(name, type));
      return form;
    })(),
  );
  return (response.body as { attachment: MessageAttachment }).attachment;
}
function sentMessage(project: ReturnType<typeof mockProject>, attachments: MessageAttachment[], text = '') {
  return project.backend.handle('POST', routes.sendTeamMessage('AC'), {
    to: ['pm'],
    text,
    attachmentIds: attachments.map((item) => item.id),
  }).body as TeamMessage;
}

describe('Operator message attachments', () => {
  it('uploads from browse, paste and panel drop, then sends only files and clears the tray', async () => {
    const project = setup();
    await screen.findByRole('textbox');
    choose([file()]);
    fireEvent.paste(input(), { clipboardData: data([file('image.png')]) });
    fireEvent.dragEnter(document.querySelector('#operator-panel')!, {
      dataTransfer: data([file('report.pdf', 'application/pdf')]),
    });
    expect(screen.getByText(t('attachments.dropActive'))).toBeTruthy();
    fireEvent.drop(document.querySelector('#operator-panel')!, {
      dataTransfer: data([file('report.pdf', 'application/pdf')]),
    });
    await ready();
    expect(within(tray()).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(send());
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: t('messageAttachments.trayLabel') })).toBeNull(),
    );
    const message = project.backend.messages.at(-1)!;
    expect(message.body).toBe('');
    expect(message.attachments).toHaveLength(3);
    expect(message.attachments![1]!.fileName).toMatch(/^kepernyokep-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/);
    expect(
      await screen.findByRole('button', { name: t('attachments.previewLabel', { fileName: 'screen.png' }) }),
    ).toBeTruthy();
    expect(
      project.requests.filter(
        (request) => request.method === 'POST' && request.path === routes.messageAttachments('AC'),
      ),
    ).toHaveLength(3);
  });

  it('blocks sending while uploading or failed, then retries the upload', async () => {
    const project = setup();
    const original = createMockFetch(project.backend, project.requests);
    let finish: ((response: Response) => void) | undefined;
    setFetchImplementation((path, init) =>
      path === routes.messageAttachments('AC') && init?.method === 'POST'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(path, init),
    );
    await screen.findByRole('textbox');
    choose([file()]);
    expect(send().disabled).toBe(true);
    expect(screen.getByText(t('messageAttachments.waitUpload'))).toBeTruthy();
    finish!(
      new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Upload failed' } }), {
        status: 500,
      }),
    );
    expect(await screen.findByText(t('messageAttachments.fixFailed'))).toBeTruthy();
    expect(send().disabled).toBe(true);
    setFetchImplementation(original);
    const failure = screen.getByRole('alert');
    expect(tray().contains(failure)).toBe(false);
    fireEvent.click(within(failure).getByRole('button', { name: t('attachments.retry') }));
    await ready();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rejects oversized and eleventh files before upload and restores focus after removal', async () => {
    const project = setup();
    await screen.findByRole('textbox');
    const oversized = file('huge.png');
    Object.defineProperty(oversized, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
    choose([oversized]);
    expect(screen.getByRole('alert').textContent).toContain('huge.png');
    expect(screen.getByRole('alert').textContent).toContain('25,000001');
    expect(project.requests.some((request) => request.path === routes.messageAttachments('AC'))).toBe(false);
    choose(Array.from({ length: 11 }, (_, index) => file(`screen-${index}.png`)));
    await ready();
    expect(screen.getByRole('alert').textContent).toBe(t('messageAttachments.tooMany', { max: 10 }));
    expect(within(tray()).getAllByRole('listitem')).toHaveLength(10);
    fireEvent.click(
      within(tray()).getByRole('button', {
        name: t('messageAttachments.remove', { fileName: 'screen-0.png' }),
      }),
    );
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        t('messageAttachments.remove', { fileName: 'screen-1.png' }),
      ),
    );
    expect(project.backend.messageAttachments).toHaveLength(9);
  });

  it('retains the same attachment ids in a failed send bubble and retries without another upload', async () => {
    const project = setup();
    await screen.findByRole('textbox');
    choose([file()]);
    await ready();
    const original = createMockFetch(project.backend, project.requests);
    setFetchImplementation((path, init) =>
      path === routes.sendTeamMessage('AC') && init?.method === 'POST'
        ? Promise.resolve(
            new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Send failed' } }), {
              status: 500,
            }),
          )
        : original(path, init),
    );
    fireEvent.click(send());
    expect(await screen.findByText(t('operator.sent.failed'))).toBeTruthy();
    expect(
      screen.getByRole('button', { name: t('attachments.previewLabel', { fileName: 'screen.png' }) }),
    ).toBeTruthy();
    setFetchImplementation(original);
    fireEvent.click(screen.getByRole('button', { name: t('operator.sent.retry') }));
    await waitFor(() => expect(screen.queryByText(t('operator.sent.failed'))).toBeNull());
    expect(project.backend.messages.at(-1)!.attachments![0]!.id).toBe(
      project.backend.messageAttachments[0]!.id,
    );
    expect(
      project.requests.filter(
        (request) => request.method === 'POST' && request.path === routes.messageAttachments('AC'),
      ),
    ).toHaveLength(1);
  });

  it('renders five images with +2, file links and tombstones; navigates, deletes and restores focus', async () => {
    const project = mockProject();
    const images = Array.from({ length: 5 }, (_, index) => seed(project, `image-${index}.png`));
    const pdf = seed(project, 'report.pdf', 'application/pdf');
    const other = seed(project, 'data.csv', 'text/csv');
    sentMessage(project, [...images, pdf, other]);
    project.render(<OperatorPanel returnFocusTo={{ current: null }} />);
    const more = await screen.findByRole('button', {
      name: t('messageAttachments.moreLabel', { count: 2, fileName: 'image-3.png' }),
    });
    expect(more.textContent).toBe('+2');
    expect(
      screen
        .getByRole('link', { name: t('attachments.openPdfLabel', { fileName: 'report.pdf' }) })
        .getAttribute('href'),
    ).toBe(routes.messageAttachmentContent('AC', pdf.id));
    expect(
      screen
        .getByRole('link', { name: t('attachments.downloadLabel', { fileName: 'data.csv' }) })
        .getAttribute('download'),
    ).toBe('');
    const opener = screen.getByRole('button', {
      name: t('attachments.previewLabel', { fileName: 'image-0.png' }),
    });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'image-0.png' });
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(await screen.findByText('2 / 5')).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'image-1.png' })).getByRole('button', {
        name: t('common.close'),
      }),
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: t('attachments.delete') }));
    expect(screen.getByText(t('messageAttachments.deleteConfirm', { fileName: 'image-0.png' }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('attachments.deleteYes') }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'image-0.png' })).toBeNull());
    expect(
      await screen.findByText(t('messageAttachments.goneLabel', { fileName: 'image-0.png' })),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input()));
  });

  it('closes the large view when a websocket update marks its image deleted', async () => {
    const project = mockProject();
    const attachment = seed(project, 'screen.png');
    const message = sentMessage(project, [attachment]);
    const { client } = project.render(<OperatorPanel returnFocusTo={{ current: null }} />);
    fireEvent.click(
      await screen.findByRole('button', { name: t('attachments.previewLabel', { fileName: 'screen.png' }) }),
    );
    project.backend.handle('DELETE', routes.messageAttachment('AC', attachment.id), undefined);
    applyServerEvent(client, { type: 'team_message_updated', projectKey: 'AC', message });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'screen.png' })).toBeNull());
    expect(
      await screen.findByText(t('messageAttachments.goneLabel', { fileName: 'screen.png' })),
    ).toBeTruthy();
  });

  it('keeps operator paste and drop away from an open card while outside paste still attaches to the card', async () => {
    const project = setup(true);
    await screen.findByLabelText(t('attachments.inputLabel'));
    await screen.findByRole('textbox', { name: t('operator.composer.label') });
    fireEvent.paste(input(), { clipboardData: data([file('operator.png')]) });
    fireEvent.drop(document.querySelector('#operator-panel')!, { dataTransfer: data([file('drop.png')]) });
    await ready();
    expect(
      project.requests.filter(
        (request) => request.method === 'POST' && request.path.includes('/tasks/AC-20/attachments'),
      ),
    ).toHaveLength(0);
    fireEvent.paste(document.body, { clipboardData: data([file('card.png')]) });
    await waitFor(() =>
      expect(
        project.requests.filter(
          (request) => request.method === 'POST' && request.path.includes('/tasks/AC-20/attachments'),
        ),
      ).toHaveLength(1),
    );
  });

  it('leaves text pastes and text drags alone', async () => {
    setup();
    await screen.findByRole('textbox');
    fireEvent.paste(input(), { clipboardData: { ...data([file()]), getData: () => 'text with an image' } });
    fireEvent.drop(document.querySelector('#operator-panel')!, {
      dataTransfer: { types: ['text/plain'], files: [] },
    });
    expect(screen.queryByRole('list', { name: t('messageAttachments.trayLabel') })).toBeNull();
  });

  it('consumes an operator image paste during a pending send without attaching it to the card', async () => {
    const project = setup(true);
    await screen.findByLabelText(t('attachments.inputLabel'));
    await screen.findByRole('textbox', { name: t('operator.composer.label') });
    choose([file()]);
    await ready();
    const original = createMockFetch(project.backend, project.requests);
    let finish: (() => Promise<void>) | undefined;
    setFetchImplementation((path, init) =>
      path === routes.sendTeamMessage('AC') && init?.method === 'POST'
        ? new Promise((resolve) => {
            finish = async () => {
              resolve(await original(path, init));
            };
          })
        : original(path, init),
    );
    fireEvent.click(send());
    await waitFor(() => expect(send().disabled).toBe(true));
    fireEvent.paste(input(), { clipboardData: data([file('during-send.png')]) });
    expect(
      project.requests.filter(
        (request) => request.method === 'POST' && request.path.includes('/tasks/AC-20/attachments'),
      ),
    ).toHaveLength(0);
    await finish!();
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: t('messageAttachments.trayLabel') })).toBeNull(),
    );
    expect(project.backend.messages.at(-1)!.attachments).toHaveLength(1);
  });

  it('lets a guest attach files and delete their own upload, but hides deletion on received files', async () => {
    const project = mockProject();
    const attachment = seed(project, 'received.png');
    project.backend.sendTeamMessage(
      'pm',
      ['kata'],
      null,
      'A shared message',
      undefined,
      undefined,
      undefined,
      [attachment],
    );
    project.backend.viewerHandle = 'kata';
    project.backend.config.team.contacts = ['pm'];
    project.render(<OperatorPanel returnFocusTo={{ current: null }} />, '/', {
      myHandle: 'kata',
      isOwner: false,
      me: {
        ...project.context.me,
        handles: { AC: 'kata' },
        projects: [{ ...project.context.me.projects[0]!, access: 'client', roles: [] }],
      },
    });
    const opener = await screen.findByRole('button', {
      name: t('attachments.previewLabel', { fileName: 'received.png' }),
    });
    fireEvent.error(opener.querySelector('img')!);
    expect(within(opener).getByText(t('attachments.imageFailed'))).toBeTruthy();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'received.png' });
    expect(within(dialog).queryByRole('button', { name: t('attachments.delete') })).toBeNull();
    fireEvent.error(within(dialog).getByRole('img'));
    expect(within(dialog).getByText(t('messageAttachments.imageFailedHint'))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.close') }));
    choose([file('guest.png')]);
    await ready();
    fireEvent.click(send());
    await waitFor(() => expect(project.backend.messages.at(-1)!.from).toBe('kata'));
    expect(project.backend.messages.at(-1)!.attachments![0]!.fileName).toBe('guest.png');
    fireEvent.click(
      await screen.findByRole('button', { name: t('attachments.previewLabel', { fileName: 'guest.png' }) }),
    );
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'guest.png' })).getByRole('button', {
        name: t('attachments.delete'),
      }),
    );
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'guest.png' })).getByRole('button', {
        name: t('attachments.deleteYes'),
      }),
    );
    expect(
      await screen.findByText(t('messageAttachments.goneLabel', { fileName: 'guest.png' })),
    ).toBeTruthy();
  });

  it('preserves a draft on delete failure and focuses the field after removing the last file', async () => {
    const project = setup();
    await screen.findByRole('textbox');
    choose([file()]);
    await ready();
    const original = createMockFetch(project.backend, project.requests);
    setFetchImplementation((path, init) =>
      init?.method === 'DELETE' ? Promise.resolve(new Response('{}', { status: 500 })) : original(path, init),
    );
    const remove = () =>
      within(tray()).getByRole('button', {
        name: t('messageAttachments.remove', { fileName: 'screen.png' }),
      });
    fireEvent.click(remove());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(within(tray()).getAllByRole('listitem')).toHaveLength(1);
    setFetchImplementation(original);
    fireEvent.click(remove());
    await waitFor(() => expect(document.activeElement).toBe(input()));
    expect(screen.queryByRole('list', { name: t('messageAttachments.trayLabel') })).toBeNull();
  });

  it('discards drafts and aborts pending uploads when the panel unmounts', async () => {
    const project = setup();
    const original = createMockFetch(project.backend, project.requests);
    let signal: AbortSignal | undefined;
    setFetchImplementation((path, init) =>
      path === routes.messageAttachments('AC')
        ? new Promise((_resolve, reject) => {
            signal = init?.signal ?? undefined;
            signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          })
        : original(path, init),
    );
    await screen.findByRole('textbox');
    choose([file()]);
    project.unmount();
    expect(signal?.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });
});
