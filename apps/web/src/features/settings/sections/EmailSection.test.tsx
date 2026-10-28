import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmailLogEntry } from '@projectman/shared';
import { EMAIL_LOG_PAGE } from '@projectman/shared';
import { setFetchImplementation } from '../../../api/client';
import { t } from '../../../i18n/t';
import { mockProject } from '../../../test/mockProject';
import { SettingsTestRoutes } from '../testRoutes';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

/** A project with the channel on, one AI member allowed to write and nobody asking for mail yet. */
function mailProject(options: { enabled?: boolean } = {}) {
  const p = mockProject();
  p.backend.config.project.email = { enabled: options.enabled ?? true };
  const sender = p.backend.config.team.members.find((member) => member.handle === 'fe-1');
  if (sender?.kind === 'ai') sender.email = { enabled: true };
  return p;
}

const open = async (p: ReturnType<typeof mockProject>, overrides?: Parameters<typeof p.render>[2]) => {
  p.render(<SettingsTestRoutes initialSection="email" />, '/p/AC/settings/email', overrides);
  return screen.findByRole('switch', { name: t('settings.email.channel.label') });
};
const configPatches = (p: ReturnType<typeof mockProject>) =>
  p.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/config'));

const outbound = (index: number, extra: Partial<EmailLogEntry> = {}): EmailLogEntry =>
  ({
    kind: 'outbound',
    id: `mail-${index}`,
    at: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - index * 60_000).toISOString(),
    member: 'fe-1',
    contact: 'kata',
    taskKey: null,
    subject: `Subject ${index}`,
    text: `Text ${index}`,
    status: 'sent',
    decidedBy: null,
    decidedAt: null,
    note: null,
    ...extra,
  }) as EmailLogEntry;

describe('the e-mail settings section', () => {
  it('is there for an owner or admin only', async () => {
    const owner = mailProject();
    const { unmount } = owner.render(<SettingsTestRoutes />, '/p/AC/settings');
    const entry = await screen.findByRole('link', { name: new RegExp(t('settings.nav.email')) });
    // The phone menu says how the channel stands.
    await waitFor(() =>
      expect(entry.textContent).toContain(t('settings.summary.emailOn', { ai: 1, humans: 0 })),
    );
    unmount();

    const member = mailProject();
    member.render(<SettingsTestRoutes initialSection="email" />, '/p/AC/settings/email', {
      can: { manageTeam: false },
    });
    await screen.findAllByRole('link');
    expect(screen.queryByRole('switch', { name: t('settings.email.channel.label') })).toBeNull();
    expect(screen.queryByRole('link', { name: new RegExp(t('settings.nav.email')) })).toBeNull();
  });

  it('asks before switching the channel on, then saves it and shows the sender address', async () => {
    const p = mailProject({ enabled: false });
    const channel = await open(p);
    expect(screen.queryByText(/projectman@mail\.example\.com/)).toBeNull();
    fireEvent.click(channel);
    const dialog = await screen.findByRole('dialog', { name: t('settings.email.channel.confirmTitle') });
    expect(configPatches(p)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.email.channel.confirm') }));
    await waitFor(() => expect(configPatches(p)).toHaveLength(1));
    expect(configPatches(p)[0]!.body).toMatchObject({ email: { enabled: true } });
    expect(await screen.findByText(/projectman@mail\.example\.com/)).toBeTruthy();
  });

  it('switches the channel off without asking', async () => {
    const p = mailProject();
    fireEvent.click(await open(p));
    await waitFor(() => expect(configPatches(p)).toHaveLength(1));
    expect(configPatches(p)[0]!.body).toMatchObject({ email: { enabled: false } });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts the switch back and offers another try when saving fails', async () => {
    const p = mailProject({ enabled: false });
    const channel = await open(p);
    const handle = p.backend.handle.bind(p.backend);
    vi.spyOn(p.backend, 'handle').mockImplementation((method, path, body, query) =>
      method === 'PATCH' && path.endsWith('/config')
        ? { status: 500, body: { error: { code: 'internal', message: 'broken' } } }
        : handle(method, path, body, query),
    );
    fireEvent.click(channel);
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: t('settings.email.channel.confirm'),
      }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain(t('settings.email.saveFailed'));
    expect(
      (screen.getByRole('switch', { name: t('settings.email.channel.label') }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.getByRole('button', { name: t('app.retry') })).toBeTruthy();
  });

  it('cannot switch on where no mail sender is set up', async () => {
    const p = mailProject({ enabled: false });
    p.backend.email.configured = false;
    const channel = await open(p);
    expect(screen.getByText(t('settings.email.channel.notConfigured'))).toBeTruthy();
    expect((channel as HTMLInputElement).disabled).toBe(true);
  });

  it('reloads the channel after saving a contact and keeps the settings visible', async () => {
    const p = mailProject();
    await open(p);
    const kata = await screen.findByRole('switch', {
      name: t('settings.email.contacts.wantsOf', { name: 'Kata' }),
    });
    expect((kata as HTMLInputElement).checked).toBe(false);
    fireEvent.click(kata);
    await waitFor(() =>
      expect(
        p.requests.find(
          (request) => request.method === 'PUT' && request.path.endsWith('/email/contacts/kata'),
        )?.body,
      ).toEqual({ wants: true }),
    );
    const row = kata.closest('tr') as HTMLElement;
    const own = t('settings.email.contacts.bySelf', { state: t('settings.email.contacts.on'), time: '@' });
    await waitFor(() => expect(row.textContent).toContain(own.slice(0, own.indexOf('@') - 3)));
    expect((kata as HTMLInputElement).checked).toBe(true);
    expect(
      p.requests.filter((request) => request.method === 'GET' && request.path.endsWith('/email')),
    ).toHaveLength(2);
    expect(screen.getByRole('switch', { name: t('settings.email.channel.label') })).toBeTruthy();
    expect(screen.getByText('fe-1@mail.example.com')).toBeTruthy();
    expect(screen.queryByText(t('settings.email.contacts.nobody'))).toBeNull();
  });

  it('shows the channel card and the future addresses, not the contacts or the log, while the channel is off', async () => {
    const p = mailProject({ enabled: false });
    await open(p);
    expect(screen.getByText(t('settings.email.senders.title'))).toBeTruthy();
    expect(
      screen.getByText(
        t('settings.email.senders.addressWhenOn', { handle: 'fe-1', domain: 'mail.example.com' }),
      ),
    ).toBeTruthy();
    expect(screen.queryByText(t('settings.email.contacts.title'))).toBeNull();
    expect(screen.queryByText(t('settings.email.log.title'))).toBeNull();
  });

  describe('the address of a member (PM-989)', () => {
    it('shows the address and copies it', async () => {
      const p = mailProject();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await open(p);
      expect(await screen.findByText('fe-1@mail.example.com')).toBeTruthy();
      fireEvent.click(await screen.findByRole('button', { name: /címének másolása/ }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('fe-1@mail.example.com'));
      expect(await screen.findByText(t('settings.email.senders.copied'))).toBeTruthy();
    });

    it('puts the copy button back after a moment', async () => {
      const p = mailProject();
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
      await open(p);
      fireEvent.click(await screen.findByRole('button', { name: /címének másolása/ }));
      await screen.findByText(t('settings.email.senders.copied'));
      await waitFor(() => expect(screen.queryByText(t('settings.email.senders.copied'))).toBeNull(), {
        timeout: 3500,
      });
      expect(screen.getByText(t('settings.email.senders.copy'))).toBeTruthy();
    });

    it('says to copy by hand when the clipboard is refused', async () => {
      const p = mailProject();
      const writeText = vi.fn().mockRejectedValue(new Error('denied'));
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await open(p);
      fireEvent.click(await screen.findByRole('button', { name: /címének másolása/ }));
      expect((await screen.findByRole('alert')).textContent).toContain(
        t('settings.email.senders.copyFailed'),
      );
    });

    it('has no mailbox editor: the address is the handle (PM-1039)', async () => {
      const p = mailProject();
      await open(p);
      expect(await screen.findByText('fe-1@mail.example.com')).toBeTruthy();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('button', { name: /Átírás|postafiókjának átírása/ })).toBeNull();
    });

    it('says why a member has no address when another project uses the same handle', async () => {
      const p = mailProject();
      const other = structuredClone(p.backend.config);
      other.project.key = 'ZZ';
      const twin = other.team.members.find((member) => member.handle === 'fe-1');
      if (twin?.kind === 'ai') twin.email = { enabled: true };
      p.backend.email.otherProjects = [other];
      await open(p);
      expect(
        await screen.findByText(t('settings.email.senders.addressConflict', { handle: 'fe-1' })),
      ).toBeTruthy();
      expect(screen.queryByText('fe-1@mail.example.com')).toBeNull();
    });
  });

  it('lists every human including the owner with their access and consent switch', async () => {
    const p = mailProject();
    await open(p);
    const humans = p.backend.config.team.members.filter((member) => member.kind === 'human');
    for (const human of humans) {
      const toggle = await screen.findByRole('switch', {
        name: t('settings.email.contacts.wantsOf', { name: human.displayName }),
      });
      expect(toggle.closest('tr')!.textContent).toContain(t(`roles.human.${human.access}`));
    }
    const owner = humans.find((member) => member.access === 'owner')!;
    fireEvent.click(
      screen.getByRole('switch', {
        name: t('settings.email.contacts.wantsOf', { name: owner.displayName }),
      }),
    );
    await waitFor(() =>
      expect(
        p.requests.find(
          (request) => request.method === 'PUT' && request.path.endsWith(`/email/contacts/${owner.handle}`),
        )?.body,
      ).toEqual({ wants: true }),
    );
  });

  it('credits a change to the member by name, also one who does not write mail', async () => {
    const p = mailProject();
    p.backend.email.records.set('kata', {
      wants: true,
      changedBy: 'be-1',
      changedAt: new Date().toISOString(),
      requestedBy: 'be-1',
      source: 'settings',
    });
    await open(p);
    const kata = await screen.findByRole('switch', {
      name: t('settings.email.contacts.wantsOf', { name: 'Kata' }),
    });
    const row = kata.closest('tr')!;
    expect(row.textContent).toContain(p.backend.findMember('be-1')!.displayName);
    expect(row.textContent).not.toContain(
      t('settings.email.contacts.bySystem', { state: '', time: '' }).slice(0, 12),
    );
  });

  it('names a member in the log who no longer writes mail', async () => {
    const p = mailProject();
    p.backend.email.log = [outbound(0, { member: 'be-1' })];
    await open(p);
    const head = (await screen.findByText('Subject 0')).closest('button') as HTMLElement;
    expect(head.textContent).toContain(p.backend.findMember('be-1')!.displayName);
    expect(head.textContent).not.toContain('be-1');
  });

  it('says that no mail goes out while nobody asks for it', async () => {
    const p = mailProject();
    await open(p);
    expect((await screen.findByRole('status')).textContent).toContain(t('settings.email.contacts.nobody'));
  });

  it('invites a person without an address and then shows the invitation as pending', async () => {
    const p = mailProject();
    const kata = p.backend.config.team.members.find((member) => member.handle === 'kata');
    if (kata?.kind === 'human') delete kata.email;
    await open(p);
    const button = await screen.findByRole('button', {
      name: t('settings.email.contacts.inviteOf', { name: 'Kata' }),
    });
    expect(
      (
        screen.getByRole('switch', {
          name: t('settings.email.contacts.wantsOf', { name: 'Kata' }),
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    // A real click focuses the button, and the dialog hands the focus back to where it was.
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t('settings.email.contacts.inviteIntro', { name: 'Kata' }))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(t('invites.email')), {
      target: { value: 'kata@example.com' },
    });
    await waitFor(() =>
      expect(
        (within(dialog).getByRole('button', { name: t('invites.create') }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: t('invites.create') }));
    fireEvent.click(await within(dialog).findByRole('button', { name: t('common.close') }));
    expect(await screen.findByText(t('settings.email.contacts.invited'))).toBeTruthy();
    const link = screen.getByRole('link', { name: t('settings.email.contacts.pendingLink') });
    // The button that opened the dialog is gone; focus goes to the link that took its place.
    expect(document.activeElement).toBe(link);
    expect(
      screen.queryByRole('button', { name: t('settings.email.contacts.inviteOf', { name: 'Kata' }) }),
    ).toBeNull();
    const invites = p.requests.filter(
      (request) => request.method === 'POST' && request.path.endsWith('/invites'),
    );
    expect(invites).toHaveLength(1);
    expect(invites[0]!.body).toMatchObject({ memberHandle: 'kata' });
  });

  it('lists the log a page at a time and loads the earlier rows on request', async () => {
    const p = mailProject();
    p.backend.email.log = Array.from({ length: EMAIL_LOG_PAGE + 5 }, (_, index) => outbound(index));
    await open(p);
    await screen.findByText('Subject 0');
    expect(screen.queryByText(`Subject ${EMAIL_LOG_PAGE}`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('settings.email.log.loadMore') }));
    expect(await screen.findByText(`Subject ${EMAIL_LOG_PAGE + 4}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('settings.email.log.loadMore') })).toBeNull();
    const logRequests = p.requests.filter((request) => request.path.includes('/email/log'));
    expect(logRequests[1]!.path).toContain('before=');
  });

  it('opens a log row to show the mail and what became of it', async () => {
    const p = mailProject();
    p.backend.email.log = [outbound(0, { status: 'bounced', text: 'The whole text' })];
    await open(p);
    const head = (await screen.findByText('Subject 0')).closest('button') as HTMLElement;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('The whole text')).toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('The whole text')).toBeTruthy();
    expect(screen.getByText(t('settings.email.log.detail.bounced'))).toBeTruthy();
    // The chip says the mail did not arrive.
    expect(within(head).getByText(t('settings.email.log.status.undeliverable'))).toBeTruthy();
  });

  it('shows a parked inbound mail with the reason', async () => {
    const p = mailProject();
    p.backend.email.log = [
      {
        kind: 'inbound',
        id: 'in-1',
        at: new Date().toISOString(),
        member: null,
        contact: null,
        fromAddress: 'someone@example.org',
        taskKey: null,
        subject: 'Re: offer',
        text: 'Hello',
        status: 'parked',
        parkReason: 'unknown_sender',
        attachmentNames: [],
      },
    ];
    await open(p);
    const head = (await screen.findByText('Re: offer')).closest('button') as HTMLElement;
    expect(within(head).getByText(t('settings.email.log.status.parked'))).toBeTruthy();
    fireEvent.click(head);
    expect(screen.getByText(t('inbox.email.parkReason.unknown_sender'))).toBeTruthy();
  });

  it('opens the member editing from an AI sender', async () => {
    const p = mailProject();
    await open(p);
    fireEvent.click(
      await screen.findByRole('button', {
        name: t('settings.email.senders.editOf', { name: p.backend.findMember('fe-1')!.displayName }),
      }),
    );
    expect(await screen.findByRole('checkbox', { name: t('memberEdit.emailEnabled') })).toBeTruthy();
  });
});
