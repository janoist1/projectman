import { fireEvent, screen, within } from '@testing-library/react';
import type { InboxItem } from '@projectman/shared';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { inbox, plainLanguageQuestion } from '../../mocks/fixtures';
import { mockIndexes, renderUi } from '../../test/render';
import { InboxCard } from './InboxCard';

const { members, pipeline } = mockIndexes();

function item(id: string): InboxItem {
  const found = inbox.find((entry) => entry.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
}

function renderCard(entry: InboxItem, props: { mobile?: boolean; myHandle?: string } = {}) {
  const onResolve = vi.fn();
  renderUi(
    <InboxCard
      item={entry}
      members={members}
      myHandle={props.myHandle ?? 'owner'}
      pipeline={pipeline}
      onResolve={onResolve}
      mobile={props.mobile}
      detailsHref="/p/AC/sessions/ses_ac21_fe1"
    />,
  );
  return { onResolve, card: screen.getByRole('article') };
}

describe('InboxCard', () => {
  it('shows a permission request with the command and resolves it with the built-in options', () => {
    const entry = item('inb_perm_push');
    const { onResolve, card } = renderCard(entry);
    expect(within(card).getByText(t('inbox.kinds.permission'))).toBeTruthy();
    expect(
      within(card).getByRole('heading', {
        name: t('inbox.permissionHeading', { tool: t('session.tools.git') }),
      }),
    ).toBeTruthy();
    expect(within(card).getByText('git push origin 21-order-confirmation').tagName).toBe('CODE');
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.allow') }));
    expect(onResolve).toHaveBeenCalledWith(entry, { optionId: 'allow' });
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.allow_session') }));
    expect(onResolve).toHaveBeenLastCalledWith(entry, { optionId: 'allow_session' });
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.deny') }));
    expect(onResolve).toHaveBeenLastCalledWith(entry, { optionId: 'deny' });
    expect(
      within(card)
        .getByRole('link', { name: new RegExp(t('inbox.details')) })
        .getAttribute('href'),
    ).toBe('/p/AC/sessions/ses_ac21_fe1');
  });

  it('answers a question with an agent option or a free-text answer', () => {
    const entry = item('inb_q_ga4');
    const { onResolve, card } = renderCard(entry);
    expect(within(card).queryByRole('button', { name: 'answer' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Kell GA4 is' }));
    expect(onResolve).toHaveBeenCalledWith(entry, { optionId: 'option_2' });

    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.answer') }));
    const field = within(card).getByLabelText(t('inbox.answerLabel'));
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.answerSubmit') }));
    expect(within(card).getByRole('alert').textContent).toBe(t('inbox.answerRequired'));
    expect(onResolve).toHaveBeenCalledTimes(1);

    fireEvent.change(field, { target: { value: '  Elég a süti nélküli, GA4 most nem kell.  ' } });
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.answerSubmit') }));
    expect(onResolve).toHaveBeenLastCalledWith(entry, {
      optionId: 'answer',
      note: 'Elég a süti nélküli, GA4 most nem kell.',
    });
  });

  it('names the stage move of a gate decision and approves or rejects it', () => {
    const entry = item('inb_dec_release');
    const { onResolve, card } = renderCard(entry);
    expect(within(card).getByRole('heading', { name: 'Továbblépés: Merge → Élesítés' })).toBeTruthy();
    expect(within(card).getByText('· Kártyás fizetés átvételkor')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.approve') }));
    expect(onResolve).toHaveBeenCalledWith(entry, { optionId: 'approve' });
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.reject') }));
    expect(onResolve).toHaveBeenLastCalledWith(entry, { optionId: 'reject' });
  });

  it('shows items meant for someone else without actions', () => {
    const { card } = renderCard(item('inb_q_variant'));
    expect(within(card).getByText(t('inbox.assignedTo', { names: 'Kata' }))).toBeTruthy();
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
  });

  it('uses full-width buttons on phones', () => {
    const { card } = renderCard(item('inb_appr_email'), { mobile: true });
    expect(card.className).toMatch(/mobile/);
    expect(within(card).getByText(/a tesztszerver havi költségéről/).tagName).toBe('BLOCKQUOTE');
    expect(
      within(card)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([t('inbox.options.approve'), t('inbox.options.reject')]);
  });
});

describe('InboxCard: a question that explains itself', () => {
  const entry = plainLanguageQuestion();
  const reason = 'Telefonon is jól olvasható, és nem tűnik el magától.';
  const beneathField = 'Az űrlap alatt';
  const popup = 'Felugró ablakban';

  /** The list entry of one option: its button, and the badge, consequence and reason around it. */
  function choice(card: HTMLElement, label: string): HTMLElement {
    return within(card).getByRole('button', { name: label }).closest('li')!;
  }

  it('shows the plain question as the heading and describes each option by what happens', () => {
    const { card } = renderCard(entry);
    expect(within(card).getByRole('heading', { name: entry.title })).toBeTruthy();
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    expect(
      within(choice(card, beneathField)).getByText(
        'A hibaüzenet addig látszik, amíg ki nem javítod a címet.',
      ),
    ).toBeTruthy();
    expect(
      within(choice(card, popup)).getByText('Pár másodperc múlva eltűnik, ezért könnyű lemaradni róla.'),
    ).toBeTruthy();
    // The free-text answer stays available below the options.
    expect(within(card).getByRole('button', { name: t('inbox.options.answer') })).toBeTruthy();
  });

  it('marks the recommended option with a badge and gives the reason below it', () => {
    const { card } = renderCard(entry);
    const recommended = choice(card, beneathField);
    const other = choice(card, popup);

    expect(within(recommended).getByText(t('inbox.question.recommended'))).toBeTruthy();
    const consequence = within(recommended).getByText(/addig látszik/);
    const why = within(recommended).getByText(t('inbox.question.reason', { reason }));
    expect(consequence.compareDocumentPosition(why) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(other).queryByText(t('inbox.question.recommended'))).toBeNull();
    expect(within(other).queryByText(/Miért:/)).toBeNull();
    expect(within(card).getAllByText(t('inbox.question.recommended'))).toHaveLength(1);
  });

  it('names each button by its label and describes it by the badge, the consequence and the reason', () => {
    const { card } = renderCard(entry);
    const describedBy = (label: string) =>
      within(card)
        .getByRole('button', { name: label })
        .getAttribute('aria-describedby')!
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent)
        .join(' | ');

    expect(describedBy(beneathField)).toBe(
      `${t('inbox.question.recommended')} | A hibaüzenet addig látszik, amíg ki nem javítod a címet. | ` +
        t('inbox.question.reason', { reason }),
    );
    expect(describedBy(popup)).toBe('Pár másodperc múlva eltűnik, ezért könnyű lemaradni róla.');
  });

  it('resolves with the option that was clicked, recommended or not', () => {
    const { onResolve, card } = renderCard(entry);
    fireEvent.click(within(card).getByRole('button', { name: popup }));
    expect(onResolve).toHaveBeenLastCalledWith(entry, { optionId: 'option_2' });
    fireEvent.click(within(card).getByRole('button', { name: beneathField }));
    expect(onResolve).toHaveBeenLastCalledWith(entry, { optionId: 'option_1' });
  });

  it('folds the technical details behind a closed toggle that opens', () => {
    const { card } = renderCard(entry);
    const fold = card.querySelector('details')!;
    const summary = fold.querySelector('summary')!;
    expect(summary.textContent).toBe(t('inbox.question.details'));
    expect(fold.open).toBe(false);
    // The text is in the fold, markdown rendered, and reachable only once it is open.
    expect(within(fold).getByText('EmailField').tagName).toBe('CODE');
    expect(within(fold).getByText(/ToastProvider/)).toBeTruthy();

    fireEvent.click(summary);
    expect(fold.open).toBe(true);
    fireEvent.click(summary);
    expect(fold.open).toBe(false);
    // The link to the session that asked is a separate thing and stays.
    expect(
      within(card)
        .getByRole('link', { name: new RegExp(t('inbox.details')) })
        .getAttribute('href'),
    ).toBe('/p/AC/sessions/ses_ac21_fe1');
  });

  it('shows the details of a question that recommends nothing and describes no option', () => {
    const { card } = renderCard(
      plainLanguageQuestion({
        payload: { question: 'Melyik?', options: ['A', 'B'], details: 'Háttér: `migrate.ts` fut le.' },
        options: [
          { id: 'option_1', label: 'A', style: 'primary' },
          { id: 'option_2', label: 'B', style: 'secondary' },
        ],
      }),
    );
    expect(card.querySelector('details')!.open).toBe(false);
    expect(within(card).getByText('migrate.ts').tagName).toBe('CODE');
    // Nothing to describe: the options stay in a row of buttons.
    expect(within(card).queryByRole('list')).toBeNull();
    expect(within(card).queryByText(t('inbox.question.recommended'))).toBeNull();
  });

  it('marks a recommendation on options that describe nothing', () => {
    const { card } = renderCard(
      plainLanguageQuestion({
        options: entry.options.map(({ consequence: _consequence, ...option }) => option),
      }),
    );
    const recommended = choice(card, beneathField);
    expect(within(recommended).getByText(t('inbox.question.recommended'))).toBeTruthy();
    expect(within(recommended).getByText(t('inbox.question.reason', { reason }))).toBeTruthy();
    expect(within(choice(card, popup)).queryByText(t('inbox.question.recommended'))).toBeNull();
    expect(within(card).queryByText(/addig látszik/)).toBeNull();
  });

  it('lists options that have consequences even when nothing is recommended', () => {
    const { payload } = entry;
    const { card } = renderCard(
      plainLanguageQuestion({
        payload: { question: payload.question, options: payload.options },
      }),
    );
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    expect(within(card).queryByText(t('inbox.question.recommended'))).toBeNull();
    expect(within(card).queryByText(/Miért:/)).toBeNull();
    expect(card.querySelector('details')).toBeNull();
  });

  it('ignores a recommendation that names no option of the question', () => {
    const { card } = renderCard(
      plainLanguageQuestion({ payload: { ...entry.payload, recommended: 'option_9' } }),
    );
    expect(within(card).queryByText(t('inbox.question.recommended'))).toBeNull();
    expect(within(card).queryByText(/Miért:/)).toBeNull();
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps the options while the member writes an answer of their own', () => {
    const { onResolve, card } = renderCard(entry);
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.answer') }));
    fireEvent.change(within(card).getByLabelText(t('inbox.answerLabel')), {
      target: { value: 'Mindkettő.' },
    });
    expect(within(card).getByText(t('inbox.question.recommended'))).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.answerSubmit') }));
    expect(onResolve).toHaveBeenLastCalledWith(entry, { optionId: 'answer', note: 'Mindkettő.' });
  });

  it('shows a question meant for someone else without its options, but with its details', () => {
    const { card } = renderCard(plainLanguageQuestion({ assignees: ['kata'] }));
    expect(within(card).getByText(t('inbox.assignedTo', { names: 'Kata' }))).toBeTruthy();
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
    expect(card.querySelector('details')).toBeTruthy();
  });

  it('lists the options full width on phones', () => {
    const { card } = renderCard(entry, { mobile: true });
    expect(within(card).getByRole('list').className).toMatch(/mobile/);
    expect(within(card).getAllByRole('button').length).toBeGreaterThanOrEqual(3);
  });

  it('renders an old-style question as a row of buttons, without badge, list or fold', () => {
    const old = item('inb_q_ga4');
    const { card } = renderCard(old);
    expect(within(card).getByRole('heading', { name: old.title })).toBeTruthy();
    expect(within(card).queryByText(t('inbox.question.recommended'))).toBeNull();
    expect(within(card).queryByText(/Miért:/)).toBeNull();
    expect(within(card).queryByRole('list')).toBeNull();
    expect(card.querySelector('details')).toBeNull();
    const buttons = within(card).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Elég a süti nélküli',
      'Kell GA4 is',
      t('inbox.options.answer'),
    ]);
    // One row, as before: the options sit beside each other, not in separate list entries.
    expect(new Set(buttons.map((button) => button.parentElement)).size).toBe(1);
    expect(buttons.every((button) => !button.hasAttribute('aria-describedby'))).toBe(true);
  });
});
