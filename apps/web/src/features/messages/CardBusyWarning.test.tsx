import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { TaskDrawer } from '../board/TaskDrawer';
import { ConversationThread } from './ConversationThread';
import { MessageComposer } from './MessageComposer';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

const posts = (p: ReturnType<typeof mockProject>) =>
  p.requests.filter((r) => r.method === 'POST' && r.path === routes.teamMessages('AC'));
const warning = () => screen.findByRole('dialog', { name: t('cardBusyWarning.titleWorking') });

/** The new-message form with Backend fejlesztő (be-1) and a text, ready to send about `taskKey`. */
function fillForm(taskKey: string, handles: string[] = ['be-1']) {
  for (const handle of handles) fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(handle) }));
  fireEvent.change(screen.getByLabelText(new RegExp(t('messages.task'))), { target: { value: taskKey } });
  fireEvent.change(screen.getByLabelText(t('messages.text')), { target: { value: 'Nézd meg ezt' } });
  fireEvent.click(screen.getByRole('button', { name: t('messages.send') }));
}

describe('the busy-card warning in the message form (PM-663)', () => {
  it('names who already works there and who the message would bring, and sends nothing yet', async () => {
    const p = mockProject();
    p.render(<MessageComposer />);
    await screen.findByRole('checkbox', { name: /be-1/ });
    fillForm('AC-22');
    const dialog = await warning();
    expect(within(dialog).getByText(t('cardBusyWarning.description', { taskKey: 'AC-22' }))).toBeTruthy();
    const group = within(dialog).getByRole('region', { name: 'Fejlesztő' });
    expect(within(group).getByText(t('cardBusyWarning.working'))).toBeTruthy();
    expect(within(group).getByText('Általános fejlesztő')).toBeTruthy();
    expect(within(group).getByText(t('sessionState.idle'))).toBeTruthy();
    expect(within(group).getByText(t('cardBusyWarning.joining'))).toBeTruthy();
    expect(within(group).getByText('Backend fejlesztő')).toBeTruthy();
    expect(within(group).getByText(t('cardBusyWarning.joiningMark'))).toBeTruthy();
    expect(posts(p)).toHaveLength(1);
    expect(posts(p)[0]!.body).not.toHaveProperty('despiteWorkers');
    expect(p.backend.messages.some((message) => message.body === 'Nézd meg ezt')).toBe(false);
    // The first focus is on the harmless way out, so a second Enter cannot send.
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: t('cardBusyWarning.back') }),
    );
  });

  it('sends the same request again with despiteWorkers when the sender sends anyway', async () => {
    const p = mockProject();
    const onSent = vi.fn();
    p.render(<MessageComposer onSent={onSent} />);
    await screen.findByRole('checkbox', { name: /be-1/ });
    fillForm('AC-22');
    const dialog = await warning();
    fireEvent.click(within(dialog).getByRole('button', { name: t('cardBusyWarning.confirm') }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(posts(p)).toHaveLength(2);
    expect(posts(p)[1]!.body).toEqual({ ...(posts(p)[0]!.body as object), despiteWorkers: true });
    expect(p.backend.messages.some((message) => message.body === 'Nézd meg ezt')).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText(t('messages.text')) as HTMLTextAreaElement).value).toBe('');
  });

  it('sends nothing when the sender steps back, keeps the text and the recipients, and focuses the text', async () => {
    const p = mockProject();
    p.render(<MessageComposer />);
    await screen.findByRole('checkbox', { name: /be-1/ });
    fillForm('AC-22');
    const dialog = await warning();
    fireEvent.click(within(dialog).getByRole('button', { name: t('cardBusyWarning.back') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(p)).toHaveLength(1);
    const text = screen.getByLabelText(t('messages.text')) as HTMLTextAreaElement;
    expect(text.value).toBe('Nézd meg ezt');
    expect((screen.getByRole('checkbox', { name: /be-1/ }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(text));
    // The warning is not an error: nothing is said under the form.
    expect(screen.queryByText(t('errors.codes.card_busy'))).toBeNull();
  });

  it('warns about two same-role recipients on a card nobody works on, without a "working" list', async () => {
    const p = mockProject();
    p.render(<MessageComposer />);
    await screen.findByRole('checkbox', { name: /be-1/ });
    fillForm('AC-24', ['be-1', 'fe-1']);
    const dialog = await screen.findByRole('dialog', { name: t('cardBusyWarning.titleJoining') });
    expect(within(dialog).queryByText(t('cardBusyWarning.working'))).toBeNull();
    expect(within(dialog).getAllByText(t('cardBusyWarning.joiningMark'))).toHaveLength(2);
  });

  it('shows the usual error, and no warning, for any other failure', async () => {
    const p = mockProject();
    const answer = createMockFetch(p.backend, p.requests);
    setFetchImplementation(async (input, init) =>
      init?.method === 'POST' && input === routes.teamMessages('AC')
        ? new Response(JSON.stringify({ error: { code: 'insufficient_access', message: 'No' } }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          })
        : answer(input, init),
    );
    p.render(<MessageComposer />);
    await screen.findByRole('checkbox', { name: /be-1/ });
    fillForm('AC-22');
    expect(await screen.findByText(t('errors.codes.insufficient_access'))).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the usual error, and no warning, when the details cannot be read', async () => {
    const p = mockProject();
    const answer = createMockFetch(p.backend, p.requests);
    setFetchImplementation(async (input, init) =>
      init?.method === 'POST' && input === routes.teamMessages('AC')
        ? new Response(
            JSON.stringify({ error: { code: 'card_busy', message: 'Busy', details: { nope: 1 } } }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          )
        : answer(input, init),
    );
    p.render(<MessageComposer />);
    await screen.findByRole('checkbox', { name: /be-1/ });
    fillForm('AC-22');
    expect(await screen.findByText(t('errors.codes.card_busy'))).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the warning and shows the usual error when the resend fails', async () => {
    const p = mockProject();
    const answer = createMockFetch(p.backend, p.requests);
    setFetchImplementation(async (input, init) => {
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as { despiteWorkers?: boolean }) : {};
      return init?.method === 'POST' && input === routes.teamMessages('AC') && body.despiteWorkers
        ? new Response(JSON.stringify({ error: { code: 'insufficient_access', message: 'No' } }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          })
        : answer(input, init);
    });
    p.render(<MessageComposer />);
    await screen.findByRole('checkbox', { name: /be-1/ });
    fillForm('AC-22');
    fireEvent.click(within(await warning()).getByRole('button', { name: t('cardBusyWarning.confirm') }));
    expect(await screen.findByText(t('errors.codes.insufficient_access'))).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText(t('messages.text')) as HTMLTextAreaElement).value).toBe('Nézd meg ezt');
  });
});

describe('the busy-card warning in the conversation (PM-663)', () => {
  it('asks before the message goes, sends it anyway on confirmation and clears the box', async () => {
    const p = mockProject();
    p.render(<ConversationThread peer="be-1" roles={[]} onCompose={() => {}} />);
    const box = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    await screen.findByRole('option', { name: /AC-22/ });
    fireEvent.change(screen.getByLabelText(t('messages.composer.task')), { target: { value: 'AC-22' } });
    fireEvent.change(box, { target: { value: 'Ez neked szól' } });
    fireEvent.click(screen.getByRole('button', { name: t('common.send') }));
    const dialog = await warning();
    expect(within(dialog).getByText('Általános fejlesztő')).toBeTruthy();
    expect(posts(p)).toHaveLength(1);
    expect(box.value).toBe('Ez neked szól');
    fireEvent.click(within(dialog).getByRole('button', { name: t('cardBusyWarning.confirm') }));
    await waitFor(() => expect(box.value).toBe(''));
    expect(posts(p)[1]!.body).toMatchObject({ to: ['be-1'], taskKey: 'AC-22', despiteWorkers: true });
  });

  it('keeps the text, and says nothing, when the sender steps back', async () => {
    const p = mockProject();
    p.render(<ConversationThread peer="be-1" roles={[]} onCompose={() => {}} />);
    const box = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    await screen.findByRole('option', { name: /AC-22/ });
    fireEvent.change(screen.getByLabelText(t('messages.composer.task')), { target: { value: 'AC-22' } });
    fireEvent.change(box, { target: { value: 'Ez neked szól' } });
    fireEvent.click(screen.getByRole('button', { name: t('common.send') }));
    fireEvent.click(within(await warning()).getByRole('button', { name: t('cardBusyWarning.back') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(box.value).toBe('Ez neked szól');
    expect(posts(p)).toHaveLength(1);
    expect(screen.queryByText(t('errors.codes.card_busy'), { exact: false })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(box));
  });
});

describe('the busy-card warning on the card thread (PM-663)', () => {
  const card = (
    <Routes>
      <Route path="/p/:key/tasks/:taskKey/*" element={<TaskDrawer />} />
    </Routes>
  );

  it('asks, then sends the card message again with despiteWorkers on confirmation', async () => {
    const p = mockProject();
    p.render(card, '/p/AC/tasks/AC-22/thread');
    await screen.findByRole('region', { name: t('task.thread.label') });
    fireEvent.click(
      screen.getByRole('button', { name: t('task.thread.remove', { name: 'Általános fejlesztő' }) }),
    );
    fireEvent.click(screen.getByRole('button', { name: t('task.thread.addTo') }));
    fireEvent.click(
      within(screen.getByRole('group', { name: t('task.thread.addTo') })).getByRole('checkbox', {
        name: /Backend/,
      }),
    );
    const box = screen.getByLabelText(
      t('task.thread.composerLabel', { key: 'AC-22' }),
    ) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Vedd át' } });
    fireEvent.click(screen.getByRole('button', { name: t('common.send') }));
    const dialog = await warning();
    expect(posts(p)).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: t('cardBusyWarning.confirm') }));
    await waitFor(() => expect(box.value).toBe(''));
    expect(posts(p)[1]!.body).toMatchObject({
      to: ['be-1'],
      taskKey: 'AC-22',
      text: 'Vedd át',
      despiteWorkers: true,
    });
  });
});
