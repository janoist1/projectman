import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { plainLanguageQuestion as questionFixture } from '../../mocks/fixtures';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { mockIndexes } from '../../test/render';
import { InboxCard } from './InboxCard';

const plainLanguageQuestion = questionFixture();

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

const file = () => new File(['image'], 'screen.png', { type: 'image/png' });
function setup(entries: InboxItem[] = [plainLanguageQuestion]) {
  const project = mockProject();
  const onResolve = vi.fn();
  const { members } = mockIndexes();
  project.render(
    <>
      {entries.map((item) => (
        <InboxCard key={item.id} item={item} members={members} myHandle="owner" onResolve={onResolve} />
      ))}
    </>,
  );
  return { ...project, onResolve };
}
const openAnswer = () => fireEvent.click(screen.getByRole('button', { name: t('inbox.answerOwn') }));
const send = () => screen.getByRole('button', { name: t('inbox.answerSubmit') }) as HTMLButtonElement;
const choose = () =>
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file()] } });
const ready = () => waitFor(() => expect(send().disabled).toBe(false));

describe('question answer attachments', () => {
  it('resolves a question in the fake backend with its files and rejects an invalid attachment without closing it', async () => {
    const project = setup();
    project.backend.inbox.push(plainLanguageQuestion);
    openAnswer();
    choose();
    await ready();
    const fileId = project.backend.messageAttachments[0]!.id;
    const resolve = (attachmentIds: string[]) =>
      project.backend.handle('POST', routes.resolveInbox('AC', plainLanguageQuestion.id), {
        optionId: 'answer',
        attachmentIds,
      });
    expect(resolve(['msa_unknown000000']).status).toBe(409);
    expect(project.backend.inbox.find((entry) => entry.id === plainLanguageQuestion.id)?.state).toBe('open');
    expect(resolve([fileId]).status).toBe(200);
    expect(project.backend.messages.at(-1)?.attachments?.[0]?.id).toBe(fileId);
    expect(project.backend.messageAttachments[0]!.messageId).toBe(project.backend.messages.at(-1)?.id);
  });

  it('removes a draft whose uploaded file disappeared after a refused send', async () => {
    const project = setup();
    openAnswer();
    choose();
    await ready();
    project.backend.messageAttachments.splice(0);
    fireEvent.click(
      screen.getByRole('button', { name: t('messageAttachments.remove', { fileName: 'screen.png' }) }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: t('messageAttachments.trayLabel') })).toBeNull(),
    );
  });
  it('shows attachments only after opening the answer and sends a file-only answer', async () => {
    const project = setup();
    expect(screen.queryByRole('button', { name: t('messageAttachments.add') })).toBeNull();
    openAnswer();
    choose();
    await ready();
    fireEvent.click(send());
    const uploaded = project.requests.find((request) => request.method === 'POST')!;
    expect(uploaded.path).toBe(routes.messageAttachments('AC'));
    expect(project.onResolve).toHaveBeenCalledWith(plainLanguageQuestion, {
      optionId: 'answer',
      note: '',
      attachmentIds: [project.backend.messageAttachments[0]!.id],
    });
  });

  it('blocks options, submit and the keyboard while uploading, then includes files with an option', async () => {
    const project = setup();
    const fetch = createMockFetch(project.backend, project.requests);
    let complete!: () => void;
    setFetchImplementation(async (path, init) => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return fetch(path, init);
    });
    openAnswer();
    choose();
    expect(send().disabled).toBe(true);
    expect(screen.getByText(t('messageAttachments.waitUpload'))).toBeTruthy();
    const choice = screen.getByRole('button', {
      name: plainLanguageQuestion.options[0]!.label,
    }) as HTMLButtonElement;
    expect(choice.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    expect(project.onResolve).not.toHaveBeenCalled();
    complete();
    await ready();
    fireEvent.click(choice);
    expect(project.onResolve).toHaveBeenCalledWith(plainLanguageQuestion, {
      optionId: plainLanguageQuestion.options[0]!.id,
      attachmentIds: [project.backend.messageAttachments[0]!.id],
    });
  });

  it('keeps failed uploads blocked until retried and preserves drafts after a send refusal', async () => {
    const project = setup();
    const fetch = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async () => new Response('{}', { status: 500 }));
    openAnswer();
    choose();
    await screen.findByText(t('messageAttachments.fixFailed'));
    expect(send().disabled).toBe(true);
    setFetchImplementation(fetch);
    fireEvent.click(screen.getByRole('button', { name: t('attachments.retry') }));
    await ready();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'See the picture' } });
    fireEvent.click(send());
    fireEvent.click(send());
    expect(project.onResolve.mock.calls[0]).toEqual(project.onResolve.mock.calls[1]);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('See the picture');
  });

  it('isolates image paste and drop on the answer and keeps separate trays for each card', async () => {
    const second = {
      ...plainLanguageQuestion,
      id: 'inb_second',
      options: [{ id: 'answer', label: 'answer', style: 'secondary' as const }],
    };
    const project = setup([second, { ...second, id: 'inb_third' }]);
    const inputs = screen.getAllByRole('textbox');
    const data = { files: [file()], types: ['Files'], getData: () => '' };
    fireEvent.paste(inputs[0]!, { clipboardData: data });
    await waitFor(() => expect(project.backend.messageAttachments).toHaveLength(1));
    const cards = screen.getAllByRole('article');
    expect(within(cards[1]!).queryByRole('list')).toBeNull();
    fireEvent.dragEnter(inputs[1]!.parentElement!, { dataTransfer: data });
    expect(screen.getByText(t('attachments.dropActive'))).toBeTruthy();
    fireEvent.drop(inputs[1]!.parentElement!, { dataTransfer: data });
    await waitFor(() => expect(project.backend.messageAttachments).toHaveLength(2));
    fireEvent.paste(inputs[0]!, { clipboardData: { ...data, getData: () => 'pasted text' } });
    expect(project.backend.messageAttachments).toHaveLength(2);
    fireEvent.click(
      within(cards[0]!).getByRole('button', {
        name: t('messageAttachments.remove', { fileName: 'screen.png' }),
      }),
    );
    await waitFor(() => expect(document.activeElement).toBe(inputs[0]));
  });
});
