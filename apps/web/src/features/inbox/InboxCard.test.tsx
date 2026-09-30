import { fireEvent, screen, within } from '@testing-library/react';
import type { InboxItem } from '@projectman/shared';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { inbox } from '../../mocks/fixtures';
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
