import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { plainLanguageQuestion } from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

/** A permission the system decided itself, as the server stores it now or stored it before. */
function automaticDecision(
  id: string,
  command: string,
  resolution: Pick<NonNullable<InboxItem['resolution']>, 'note' | 'rule'>,
  minutesAgo: number,
): InboxItem {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id,
    projectKey: 'AC',
    kind: 'permission',
    assignees: ['owner'],
    source: 'fe-1',
    sessionId: null,
    taskKey: null,
    title: `Bash: ${command}`,
    body: null,
    payload: { toolName: 'Bash', toolInput: { command }, summary: command },
    options: [],
    state: 'resolved',
    resolution: { optionId: 'deny', by: 'system', at, ...resolution },
    createdAt: at,
  };
}

describe('inbox history', () => {
  it('names the rule of an automatic decision and shows an older decision note as a note', async () => {
    const project = mockProject();
    project.backend.inbox.push(
      automaticDecision('inb_rule', 'npm publish', { note: null, rule: 'command_policy' }, 1),
      automaticDecision('inb_note', 'git push', { note: 'Fictional note from before rules' }, 2),
    );
    project.render(<InboxPage />, '/p/AC/inbox');
    const history = await screen.findByRole('complementary');
    const [byRule, byNote] = await within(history).findAllByRole('listitem');
    expect(byRule!.textContent).toContain(t('inbox.resolutions.automatic_deny'));
    expect(byRule!.textContent).toContain(t('inbox.resolutionRules.command_policy'));
    expect(byRule!.textContent).not.toContain(t('common.system'));
    expect(within(byNote!).getByText('Fictional note from before rules')).toBeTruthy();
    expect(byNote!.textContent).toContain(t('common.system'));
  });
});

describe('plain-language questions in the inbox', () => {
  const question = plainLanguageQuestion();

  /** The card of the open item with this heading. */
  const cardOf = async (title: string) =>
    (await screen.findByRole('heading', { name: title })).closest('article')!;

  it('shows the question with its recommendation, consequences and folded details, and answers it', async () => {
    const project = mockProject();
    project.backend.inbox.push(question);
    project.render(<InboxPage />, '/p/AC/inbox');

    const card = await cardOf(question.title);
    const recommended = within(card).getByRole('button', { name: 'Az űrlap alatt' }).closest('li')!;
    expect(within(recommended).getByText(t('inbox.question.recommended'))).toBeTruthy();
    expect(
      within(recommended).getByText(
        t('inbox.question.reason', { reason: 'Telefonon is jól olvasható, és nem tűnik el magától.' }),
      ),
    ).toBeTruthy();
    expect(within(card).getByText('A hibaüzenet addig látszik, amíg ki nem javítod a címet.')).toBeTruthy();
    expect(within(card).getByText('Pár másodperc múlva eltűnik, ezért könnyű lemaradni róla.')).toBeTruthy();
    const fold = card.querySelector('details')!;
    expect(fold.open).toBe(false);
    fireEvent.click(fold.querySelector('summary')!);
    expect(fold.open).toBe(true);
    expect(within(fold).getByText(/ToastProvider/)).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'Az űrlap alatt' }));
    await waitFor(() =>
      expect(project.requests).toContainEqual({
        method: 'POST',
        path: `/api/projects/AC/inbox/${question.id}/resolve`,
        body: { optionId: 'option_1' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('heading', { name: question.title })).toBeNull());
    expect(project.backend.inbox.find((item) => item.id === question.id)).toMatchObject({
      state: 'resolved',
      resolution: { optionId: 'option_1', by: 'owner' },
    });
    // The history names the answer like any other.
    expect(
      within(await screen.findByRole('complementary')).getByText(new RegExp(question.title)),
    ).toBeTruthy();
  });

  it('leaves the questions that do not use the new fields as they were, next to one that does', async () => {
    const project = mockProject();
    project.backend.inbox.push(question);
    project.render(<InboxPage />, '/p/AC/inbox');

    await cardOf(question.title);
    const old = project.backend.inbox.find((item) => item.id === 'inb_q_ga4')!;
    const card = await cardOf(old.title);
    expect(
      within(card)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Elég a süti nélküli', 'Kell GA4 is', t('inbox.options.answer')]);
    expect(within(card).queryByRole('list')).toBeNull();
    expect(within(card).queryByText(t('inbox.question.recommended'))).toBeNull();
    expect(card.querySelector('details')).toBeNull();
    // One badge on the page: the new question's.
    expect(screen.getAllByText(t('inbox.question.recommended'))).toHaveLength(1);
  });

  it('lists the options on a phone too', async () => {
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
    const project = mockProject();
    project.backend.inbox.push(question);
    project.render(<InboxPage />, '/p/AC/inbox');

    const card = await cardOf(question.title);
    expect(card.className).toMatch(/mobile/);
    expect(within(card).getByRole('list').className).toMatch(/mobile/);
    expect(within(card).getByText(t('inbox.question.recommended'))).toBeTruthy();
    expect(card.querySelector('details')!.open).toBe(false);
  });
});
