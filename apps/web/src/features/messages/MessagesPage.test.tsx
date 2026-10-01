import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getLocale } from '@projectman/templates';
import { setFetchImplementation } from '../../api/client';
import { MeContext } from '../../app/contexts';
import { NavRail } from '../../app/Shell';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { MessagesPage } from './MessagesPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
describe('messages composer and receipts', () => {
  it('sends a multi-recipient message with an optional task and avatars', async () => {
    const p = mockProject();
    p.render(<MessagesPage />);
    fireEvent.click(await screen.findByRole('button', { name: t('messages.new') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: /Kata/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /fe-1/ }));
    fireEvent.change(within(dialog).getByLabelText(t('messages.text')), {
      target: { value: 'Acme delivery discussion' },
    });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('messages.task'))), {
      target: { value: 'AC-21' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t('messages.send') }));
    await waitFor(() =>
      expect(
        p.requests.some(
          (r) =>
            r.method === 'POST' &&
            r.path.endsWith('/messages') &&
            JSON.stringify(r.body).includes('Acme delivery discussion'),
        ),
      ).toBe(true),
    );
    expect(p.backend.messages.at(-1)).toMatchObject({
      to: ['kata', 'fe-1'],
      taskKey: 'AC-21',
      from: 'owner',
    });
    expect(await screen.findByText('Acme delivery discussion')).toBeTruthy();
  });
  it('says when to turn to each recipient while choosing them', async () => {
    const p = mockProject();
    p.render(<MessagesPage />);
    fireEvent.click(await screen.findByRole('button', { name: t('messages.new') }));
    const dialog = within(screen.getByRole('dialog'));
    const qa = getLocale('hu').roles.qa.whenToAsk;
    const recipient = await dialog.findByRole('checkbox', { name: new RegExp(qa.slice(0, 20)) });
    expect(recipient.closest('label')?.textContent).toContain(`${t('roleCatalogue.whenToAsk')}: ${qa}`);
  });
  it('prefills reply recipients and task and displays independent delivery states', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['owner', 'kata'], 'AC-21', 'Acme question');
    p.render(<MessagesPage />);
    fireEvent.click(await screen.findByRole('button', { name: t('messages.reply') }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByRole('checkbox', { name: /fe-1/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('checkbox', { name: /Kata/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText(new RegExp(t('messages.task'))) as HTMLSelectElement).value).toBe(
      'AC-21',
    );
  });
  it('shows unread addressed messages and updates the navigation badge after reading', async () => {
    const p = mockProject();
    p.backend.messages = [];
    const message = p.backend.sendTeamMessage('fe-1', ['owner', 'kata'], null, 'Acme unread');
    p.render(
      <MeContext.Provider value={p.context.me}>
        <NavRail inboxCount={0} />
        <MessagesPage />
      </MeContext.Provider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: t('messages.read') }));
    await waitFor(() =>
      expect(p.backend.messages[0]?.receipts?.find((r) => r.handle === 'owner')?.readAt).toBeTruthy(),
    );
    expect(message.receipts?.find((r) => r.handle === 'kata')?.readAt).toBeNull();
    await waitFor(() => expect(screen.queryByRole('button', { name: t('messages.read') })).toBeNull());
    const nav = screen.getByRole('navigation', { name: t('nav.main') });
    expect(within(nav).getByRole('link', { name: t('nav.messages') })).toBeTruthy();
  });
  it('displays queued, typed and human read delivery states per recipient', async () => {
    const p = mockProject();
    p.backend.messages = [];
    const message = p.backend.sendTeamMessage('owner', ['fe-1', 'qa', 'kata'], null, 'Acme delivery states');
    message.receipts = [
      { handle: 'fe-1', kind: 'ai', deliveredAt: null, readAt: null },
      { handle: 'qa', kind: 'ai', deliveredAt: message.createdAt, readAt: null },
      { handle: 'kata', kind: 'human', deliveredAt: message.createdAt, readAt: message.createdAt },
    ];
    p.render(<MessagesPage />);
    await screen.findByText('Acme delivery states');
    expect(screen.getByText(new RegExp(t('messages.queued')))).toBeTruthy();
    expect(screen.getByText(new RegExp(t('messages.typed')))).toBeTruthy();
    expect(screen.getByText(new RegExp(t('messages.humanRead')))).toBeTruthy();
  });
  it('offers clients an active composer', async () => {
    const p = mockProject();
    p.backend.viewerHandle = 'kata';
    const me = { ...p.context.me, projects: [{ ...p.context.me.projects[0]!, access: 'client' as const }] };
    p.render(<MessagesPage />, '/', {
      me,
      myHandle: 'kata',
      can: { createTasks: false, manageTeam: false, workInSessions: false },
    });
    fireEvent.click(await screen.findByRole('button', { name: t('messages.new') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText(t('messages.text'))).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: t('messages.send') })).toBeTruthy();
  });
  it('allows client composers and hides them for viewers', async () => {
    const p = mockProject();
    const me = { ...p.context.me, projects: [{ ...p.context.me.projects[0]!, access: 'viewer' as const }] };
    p.render(<MessagesPage />, '/', { me });
    await screen.findByRole('heading', { name: t('messages.title') });
    expect(screen.queryByRole('button', { name: t('messages.new') })).toBeNull();
  });
});
