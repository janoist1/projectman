import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { resolutionLabel } from '../../lib/inbox';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

/** The two e-mail items of the inbox: a mail waiting for approval and a parked mail (PM-942). */

afterEach(() => vi.restoreAllMocks());

const approvalCard = () =>
  screen.getByRole('heading', { name: t('inbox.email.title') }).closest('article') as HTMLElement;
const resolves = (project: ReturnType<typeof mockProject>) =>
  project.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/resolve'));

describe('the e-mail approval card', () => {
  it('shows the recipient and the subject, and sends on approval', async () => {
    const project = mockProject();
    project.backend.proposeEmail({ subject: 'Weekly summary', contactName: 'Kata' });
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.email.title') });
    const card = approvalCard();
    expect(card.textContent).toContain('Kata');
    expect(card.textContent).toContain('Weekly summary');
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.email.send') }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: t('inbox.email.title') })).toBeNull());
    expect(resolves(project)[0]?.body).toEqual({ optionId: 'approve' });
    // The decision stays in the list of recent decisions, with the subject.
    const recent = await screen.findByText(t('inbox.recent'));
    expect(recent.closest('section')?.textContent).toContain('Weekly summary');
    expect(recent.closest('section')?.textContent).toContain(t('inbox.email.sent'));
  });

  it('rejects with the reason typed in place of the buttons', async () => {
    const project = mockProject();
    project.backend.proposeEmail();
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.email.title') });
    fireEvent.click(within(approvalCard()).getByRole('button', { name: t('inbox.email.dontSend') }));
    const field = await screen.findByRole('textbox', { name: new RegExp(t('inbox.email.rejectLabel')) });
    expect(within(approvalCard()).queryByRole('button', { name: t('inbox.email.send') })).toBeNull();
    fireEvent.change(field, { target: { value: '  Too early.  ' } });
    fireEvent.click(within(approvalCard()).getByRole('button', { name: t('inbox.email.dontSend') }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: t('inbox.email.title') })).toBeNull());
    expect(resolves(project)[0]?.body).toEqual({ optionId: 'reject', note: 'Too early.' });
    const recent = await screen.findByText(t('inbox.recent'));
    expect(recent.closest('section')?.textContent).toContain(t('inbox.email.notSent'));
    expect(recent.closest('section')?.textContent).toContain('Too early.');
  });

  it('names the system when it took the mail back', () => {
    const project = mockProject();
    const item = project.backend.proposeEmail();
    const revoked = {
      ...item,
      state: 'resolved' as const,
      resolution: {
        optionId: 'reject',
        by: 'system',
        at: item.createdAt,
        note: null,
        rule: 'email_not_allowed' as const,
      },
    };
    expect(resolutionLabel(revoked)).toBe(t('inbox.email.revoked'));
  });
});

describe('the parked mail card', () => {
  it('shows who wrote and the excerpt as plain text, with the attachments unopened', async () => {
    const project = mockProject();
    project.backend.parkEmail({ attachmentNames: ['offer.pdf'], reason: 'channel_off' });
    project.render(<InboxPage />, '/p/AC/inbox');
    const heading = await screen.findByRole('heading', { name: t('inbox.email.parkedTitle') });
    const card = heading.closest('article') as HTMLElement;
    expect(card.textContent).toContain('someone@example.org');
    expect(card.textContent).toContain('offer.pdf');
    expect(card.textContent).toContain(t('inbox.email.attachmentsNotOpened'));
    // The markup and the link in the mail are text, not elements.
    expect(card.textContent).toContain('<b>Look here</b> https://example.org/x');
    expect(card.querySelector('b')).toBeNull();
    expect(within(card).queryByRole('link', { name: /example\.org/ })).toBeNull();
  });

  it('says a sender who may not write to the member could not, and where to look', async () => {
    const project = mockProject();
    project.backend.parkEmail({ reason: 'sender_not_allowed' });
    project.render(<InboxPage />, '/p/AC/inbox');
    const heading = await screen.findByRole('heading', { name: t('inbox.email.parkedTitle') });
    const card = heading.closest('article') as HTMLElement;
    expect(card.textContent).toContain(t('inbox.email.parkReason.sender_not_allowed'));
    expect(card.textContent).toContain(t('inbox.email.parkedHintNotAllowed'));
  });

  it('is closed with one button', async () => {
    const project = mockProject();
    project.backend.parkEmail();
    project.render(<InboxPage />, '/p/AC/inbox');
    const heading = await screen.findByRole('heading', { name: t('inbox.email.parkedTitle') });
    fireEvent.click(
      within(heading.closest('article') as HTMLElement).getByRole('button', { name: 'Láttam' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: t('inbox.email.parkedTitle') })).toBeNull(),
    );
    expect(resolves(project)[0]?.body).toMatchObject({ optionId: 'seen' });
  });
});
