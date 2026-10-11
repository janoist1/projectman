import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineEvent } from '@projectman/shared';
import { Timeline } from '../../components/Timeline';
import { t, tDynamic } from '../../i18n/t';
import { releaseFailedWords, releaseStepName } from '../../lib/release';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

/** The release approval, the release alert and the release rows of the timeline (PM-492). */

const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const BASE = '1234567890abcdef1234567890abcdef12345678';
const SUMMARY = '## Highlights\n\n- Faster board loading\n- Fixes the login redirect';

function proposed(
  input: Partial<Parameters<ReturnType<typeof mockProject>['backend']['proposeRelease']>[0]> = {},
) {
  const project = mockProject();
  const item = project.backend.proposeRelease({
    commit: COMMIT,
    baseCommit: BASE,
    summary: SUMMARY,
    taskKeys: ['AC-27', 'AC-28'],
    ...input,
  });
  return { project, item };
}

const releaseCard = () =>
  screen.getByRole('heading', { name: t('inbox.release.title') }).closest('article') as HTMLElement;
const releaseEvents = (project: ReturnType<typeof mockProject>, taskKey: string) =>
  project.backend.timeline.filter((event) => event.taskKey === taskKey && event.type === 'release_changed');

afterEach(() => vi.restoreAllMocks());

describe('the release approval card (PM-492)', () => {
  it('shows the versions, the summary, the cards and the two decisions', async () => {
    const { project, item } = proposed();
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.release.title') });
    const card = releaseCard();
    expect(card.textContent).toContain(t('inbox.release.lead'));
    expect(within(card).getByText(COMMIT.slice(0, 8))).toBeTruthy();
    expect(within(card).getByText(BASE.slice(0, 8))).toBeTruthy();
    expect(within(card).getByText('Faster board loading')).toBeTruthy();
    const first = project.backend.findTask('AC-27')!;
    const link = within(card).getByRole('link', { name: `AC-27${first.title}` });
    expect(link.getAttribute('href')).toBe('/p/AC/tasks/AC-27');
    expect(card.textContent).toContain(t('inbox.release.cards', { count: 2 }));
    // The release card itself is linked under the header.
    expect(
      within(card)
        .getAllByRole('link')
        .some((a) => a.getAttribute('href') === `/p/AC/tasks/${item.taskKey}`),
    ).toBe(true);
    expect(within(card).getByRole('button', { name: t('inbox.options.approve') })).toBeTruthy();
    expect(within(card).getByRole('button', { name: t('inbox.options.reject') })).toBeTruthy();
  });

  it('names the commit alone when the previous live version is unknown', async () => {
    const { project } = proposed({ baseCommit: null });
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.release.title') });
    expect(releaseCard().textContent).toContain(t('inbox.release.firstVersion'));
  });

  it('links the changes on GitHub when the repository is clear', async () => {
    const { project } = proposed();
    project.backend.config.project.repos = [project.backend.config.project.repos[0]!];
    const github = project.backend.config.project.repos[0]!.github!;
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.release.title') });
    const compare = within(releaseCard()).getByRole('link', {
      name: new RegExp(t('inbox.release.compare')),
    });
    expect(compare.getAttribute('href')).toBe(`https://github.com/${github}/compare/${BASE}...${COMMIT}`);
    expect(compare.getAttribute('target')).toBe('_blank');
    expect(compare.getAttribute('rel')).toContain('noopener');
  });

  it('offers the whole summary only when it is cut', async () => {
    const { project } = proposed();
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.release.title') });
    // jsdom has no layout: nothing is cut, so no toggle.
    expect(
      within(releaseCard()).queryByRole('button', { name: new RegExp(t('inbox.release.summaryMore')) }),
    ).toBeNull();
  });

  it('opens and closes a cut summary', async () => {
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(100);
    const { project } = proposed();
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.release.title') });
    const toggle = within(releaseCard()).getByRole('button', {
      name: new RegExp(t('inbox.release.summaryMore')),
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const open = within(releaseCard()).getByRole('button', { name: new RegExp(t('inbox.release.less')) });
    expect(open.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(open);
    expect(
      within(releaseCard()).getByRole('button', { name: new RegExp(t('inbox.release.summaryMore')) }),
    ).toBeTruthy();
  });

  it('lists the first cards and the rest behind a toggle', async () => {
    const keys = Array.from({ length: 9 }, (_, index) => `AC-${index + 1}`);
    const { project } = proposed({ taskKeys: keys });
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.release.title') });
    const card = releaseCard();
    const list = within(card).getByRole('list', { name: t('inbox.release.cards', { count: 9 }) });
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    fireEvent.click(
      within(card).getByRole('button', { name: new RegExp(t('inbox.release.cardsMore', { count: 3 })) }),
    );
    expect(within(list).getAllByRole('listitem')).toHaveLength(9);
    fireEvent.click(within(card).getByRole('button', { name: new RegExp(t('inbox.release.less')) }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
  });

  it('approves with one click: the request, the cleared item and the approved row', async () => {
    const { project, item } = proposed();
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.release.title') });
    fireEvent.click(within(releaseCard()).getByRole('button', { name: t('inbox.options.approve') }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: t('inbox.release.title') })).toBeNull());
    const request = project.requests.find(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/resolve'),
    );
    expect(request?.path).toContain(item.id);
    expect(request?.body).toEqual({ optionId: 'approve' });
    const rows = releaseEvents(project, item.taskKey!);
    expect(rows.map((row) => row.data.state)).toEqual(['proposed', 'approved']);
    // The decided release stays in the list of decisions, with a way to the card.
    await screen.findByText(t('inbox.recent'));
    expect(
      screen.getAllByRole('link').some((a) => a.getAttribute('href') === `/p/AC/tasks/${item.taskKey}`),
    ).toBe(true);
  });

  it('rejects with a reason typed in place of the buttons', async () => {
    const { project, item } = proposed();
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.release.title') });
    fireEvent.click(within(releaseCard()).getByRole('button', { name: t('inbox.options.reject') }));
    const field = await screen.findByRole('textbox', { name: new RegExp(t('inbox.release.rejectLabel')) });
    expect(document.activeElement).toBe(field);
    // The approve button is out of the way while the reason is typed.
    expect(within(releaseCard()).queryByRole('button', { name: t('inbox.options.approve') })).toBeNull();
    fireEvent.change(field, { target: { value: '  Várjuk meg a PM-490-et.  ' } });
    fireEvent.click(within(releaseCard()).getByRole('button', { name: t('inbox.options.reject') }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: t('inbox.release.title') })).toBeNull());
    const request = project.requests.find(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/resolve'),
    );
    expect(request?.body).toEqual({ optionId: 'reject', note: 'Várjuk meg a PM-490-et.' });
    const rejected = releaseEvents(project, item.taskKey!).at(-1)!;
    expect(rejected.data).toMatchObject({
      state: 'rejected',
      previousState: 'proposed',
      note: 'Várjuk meg a PM-490-et.',
    });
  });

  it('rejects without a reason: no note in the request or on the row', async () => {
    const { project, item } = proposed();
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.release.title') });
    fireEvent.click(within(releaseCard()).getByRole('button', { name: t('inbox.options.reject') }));
    fireEvent.click(await within(releaseCard()).findByRole('button', { name: t('inbox.options.reject') }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: t('inbox.release.title') })).toBeNull());
    const request = project.requests.find(
      (entry) => entry.method === 'POST' && entry.path.endsWith('/resolve'),
    );
    expect(request?.body).toEqual({ optionId: 'reject' });
    expect(releaseEvents(project, item.taskKey!).at(-1)!.data).not.toHaveProperty('note');
  });

  it('sends the rejection with the command-enter shortcut', async () => {
    const { project } = proposed();
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.release.title') });
    fireEvent.click(within(releaseCard()).getByRole('button', { name: t('inbox.options.reject') }));
    const field = await screen.findByRole('textbox', { name: new RegExp(t('inbox.release.rejectLabel')) });
    fireEvent.change(field, { target: { value: 'Később.' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(
        project.requests.some(
          (entry) => JSON.stringify(entry.body) === '{"optionId":"reject","note":"Később."}',
        ),
      ).toBe(true),
    );
  });

  it('closes the reason box with Escape and gives the focus back to the reject button', async () => {
    const { project } = proposed();
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.release.title') });
    fireEvent.click(within(releaseCard()).getByRole('button', { name: t('inbox.options.reject') }));
    const field = await screen.findByRole('textbox', { name: new RegExp(t('inbox.release.rejectLabel')) });
    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: new RegExp(t('inbox.release.rejectLabel')) })).toBeNull(),
    );
    const reject = within(releaseCard()).getByRole('button', { name: t('inbox.options.reject') });
    await waitFor(() => expect(document.activeElement).toBe(reject));
    expect(project.requests.some((entry) => entry.path.endsWith('/resolve'))).toBe(false);
  });

  it('says on the card why an integrator key may not decide, and keeps the item', async () => {
    const { project } = proposed();
    project.backend.refuseReleaseApproval = true;
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', { name: t('inbox.release.title') });
    fireEvent.click(within(releaseCard()).getByRole('button', { name: t('inbox.options.approve') }));
    const reason = tDynamic('errors.codes.owner_approval_required', '');
    expect(reason).not.toBe('');
    await waitFor(() => expect(releaseCard().textContent).toContain(reason));
    // The reason is on the card, not in a toast.
    expect(screen.queryByText(t('inbox.resolveFailed'))).toBeNull();
    expect(within(releaseCard()).getByRole('button', { name: t('inbox.options.approve') })).toBeTruthy();
  });
});

describe('the alert of a failed release (PM-492)', () => {
  function failed(
    step: Parameters<ReturnType<typeof mockProject>['backend']['failRelease']>[0]['step'],
    rolledBack: boolean,
  ) {
    const project = mockProject();
    const item = project.backend.proposeRelease({ commit: COMMIT, summary: SUMMARY, taskKeys: ['AC-27'] });
    const alert = project.backend.failRelease({
      taskKey: item.taskKey!,
      commit: COMMIT,
      step,
      message: 'npm ERR! boom',
      rolledBack,
    });
    return { project, item, alert };
  }

  it('says where an early step stopped and that the live system did not change', async () => {
    const { project, item } = failed('build', false);
    project.render(<InboxPage />, '/p/AC/inbox');
    const words = releaseFailedWords('build', false, item.taskKey!);
    const heading = await screen.findByRole('heading', { name: words.title });
    const card = heading.closest('article') as HTMLElement;
    expect(card.textContent).toContain(
      t('inbox.alerts.release_failed.early', { step: releaseStepName('build') }),
    );
    expect(card.textContent).toContain(t('inbox.alerts.release_failed.nextNew'));
    expect(card.getAttribute('data-severity')).toBeNull();
  });

  it('says the old version runs again after a rollback, without the orange stripe', async () => {
    const { project, item } = failed('verify', true);
    project.render(<InboxPage />, '/p/AC/inbox');
    const words = releaseFailedWords('verify', true, item.taskKey!);
    const card = (await screen.findByRole('heading', { name: words.title })).closest(
      'article',
    ) as HTMLElement;
    expect(card.textContent).toContain(
      t('inbox.alerts.release_failed.rolledBack', { step: releaseStepName('verify') }),
    );
    expect(card.getAttribute('data-severity')).toBeNull();
  });

  it('marks the case where the old version does not run either', async () => {
    const { project, item } = failed('switch', false);
    project.render(<InboxPage />, '/p/AC/inbox');
    const words = releaseFailedWords('switch', false, item.taskKey!);
    const card = (await screen.findByRole('heading', { name: words.title })).closest(
      'article',
    ) as HTMLElement;
    expect(card.textContent).toContain(
      t('inbox.alerts.release_failed.down', { step: releaseStepName('switch') }),
    );
    expect(card.textContent).toContain(t('inbox.alerts.release_failed.nextDown'));
    expect(card.getAttribute('data-alert')).toBe('release_failed');
    expect(card.getAttribute('data-severity')).toBe('down');
  });

  it('tells a publish failure apart: the new version runs, only the GitHub release is missing', async () => {
    const { project, item } = failed('publish', false);
    project.render(<InboxPage />, '/p/AC/inbox');
    const words = releaseFailedWords('publish', false, item.taskKey!);
    const card = (await screen.findByRole('heading', { name: words.title })).closest(
      'article',
    ) as HTMLElement;
    expect(card.textContent).toContain(t('inbox.alerts.release_failed.publish'));
    expect(card.textContent).toContain(t('inbox.alerts.release_failed.nextPublish'));
    expect(card.getAttribute('data-severity')).toBeNull();
  });

  it('keeps the tool output behind a fold', async () => {
    const { project, item } = failed('test', false);
    project.render(<InboxPage />, '/p/AC/inbox');
    const words = releaseFailedWords('test', false, item.taskKey!);
    const card = (await screen.findByRole('heading', { name: words.title })).closest(
      'article',
    ) as HTMLElement;
    expect(within(card).getByText(t('inbox.alerts.release_failed.details'))).toBeTruthy();
  });
});

describe('the release rows in the Timeline component (PM-492)', () => {
  const ctx = { pipeline: null, members: new Map(), myHandle: 'owner', openInboxIds: new Set<string>() };
  const row = (id: string, data: Record<string, unknown>): TimelineEvent => ({
    id,
    projectKey: 'AC',
    taskKey: 'AC-1',
    sessionId: null,
    actor: { kind: 'human', handle: 'owner' },
    type: 'release_changed',
    data: { releaseId: 'rel_1', previousState: null, commit: COMMIT, ...data },
    createdAt: '2026-10-11T09:00:00.000Z',
  });

  it('renders the rejection reason as a quote and the GitHub release as an external link', () => {
    const project = mockProject();
    project.render(
      <Timeline
        ctx={ctx}
        events={[
          row('a', { state: 'rejected', note: 'Várjuk meg a PM-490-et.' }),
          row('b', {
            state: 'published',
            tag: 'v1.4.0',
            url: 'https://github.com/acme/webshop/releases/tag/v1.4.0',
          }),
        ]}
      />,
    );
    expect(screen.getByText('Várjuk meg a PM-490-et.')).toBeTruthy();
    const link = screen.getByRole('link', {
      name: new RegExp(t('timeline.events.release_changed.githubRelease').replace('↗', '').trim()),
    });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/webshop/releases/tag/v1.4.0');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('renders no link for an address that is not https', () => {
    const project = mockProject();
    project.render(
      <Timeline
        ctx={ctx}
        events={[row('c', { state: 'published', tag: 'v1', url: 'javascript:alert(1)' })]}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
  });
});
