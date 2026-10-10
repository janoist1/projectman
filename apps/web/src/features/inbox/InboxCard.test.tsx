import { fireEvent, screen, within } from '@testing-library/react';
import type { InboxItem } from '@projectman/shared';
import { BoundaryRequest } from '@projectman/shared';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { inbox, plainLanguageQuestion } from '../../mocks/fixtures';
import { mockIndexes, renderUi } from '../../test/render';
import { InboxCard } from './InboxCard';
import { boundaryInboxFixture } from '../../mocks/boundary-fixture';

const { members, pipeline } = mockIndexes();

function item(id: string): InboxItem {
  const found = inbox.find((entry) => entry.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
}

function renderCard(
  entry: InboxItem,
  props: { mobile?: boolean; myHandle?: string; taskTitle?: string } = {},
) {
  const onResolve = vi.fn();
  renderUi(
    <InboxCard
      item={entry}
      taskTitle={props.taskTitle}
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
  it('shows the exact boundary target, scope, category, deadline and structured decision reason', () => {
    const entry = boundaryInboxFixture();
    const request = BoundaryRequest.parse(entry.payload.boundary);
    request.target.branch = 'task-21';
    entry.payload.boundary = request;
    const { card, onResolve } = renderCard(entry);
    expect(within(card).getByText('https://example.test/docs')).toBeTruthy();
    expect(within(card).getByText(t('boundary.scope'))).toBeTruthy();
    expect(within(card).getByText(t('boundary.branch', { branch: 'task-21' }))).toBeTruthy();
    expect(
      within(card).getByText(
        t('boundary.environment', { environment: t('boundary.environments.development') }),
      ),
    ).toBeTruthy();
    expect(within(card).getByText(new RegExp(t('boundary.categories.delegable')))).toBeTruthy();
    fireEvent.change(within(card).getByLabelText(t('boundary.reason')), {
      target: { value: 'insufficient_context' },
    });
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.deny') }));
    expect(onResolve).toHaveBeenCalledWith(entry, { optionId: 'deny', note: 'insufficient_context' });
  });
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

  it('puts the refusal and the permission in one row and the rarer option below, as a small button', () => {
    const { card } = renderCard(item('inb_perm_push'));
    const deny = within(card).getByRole('button', { name: t('inbox.options.deny') });
    const allow = within(card).getByRole('button', { name: t('inbox.options.allow') });
    const always = within(card).getByRole('button', { name: t('inbox.options.allow_session') });
    expect(deny.parentElement).toBe(allow.parentElement);
    expect(always.parentElement).not.toBe(allow.parentElement);
    expect(deny.compareDocumentPosition(allow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts the task title under the header row and folds a command that does not fit four lines', () => {
    const entry = item('inb_perm_push');
    const onResolve = vi.fn();
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(200);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(80);
    try {
      renderUi(
        <InboxCard
          item={entry}
          members={members}
          myHandle="owner"
          pipeline={pipeline}
          taskTitle="Rendelés-visszaigazoló oldal"
          onResolve={onResolve}
        />,
      );
      const card = screen.getByRole('article');
      expect(within(card).getByText('Rendelés-visszaigazoló oldal').tagName).toBe('P');
      const code = within(card).getByText('git push origin 21-order-confirmation');
      const toggle = within(card).getByRole('button', { name: t('inbox.commandFull') });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(code.className).toMatch(/clamped/);
      fireEvent.click(toggle);
      expect(code.className).not.toMatch(/clamped/);
      expect(within(card).getByRole('button', { name: t('inbox.commandLess') })).toBeTruthy();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('shows no "full command" button for a command that fits', () => {
    const { card } = renderCard(item('inb_perm_push'));
    expect(within(card).queryByRole('button', { name: t('inbox.commandFull') })).toBeNull();
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
    expect(within(card).getByText('Kártyás fizetés átvételkor')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.approve') }));
    expect(onResolve).toHaveBeenCalledWith(entry, { optionId: 'approve' });
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.reject') }));
    expect(onResolve).toHaveBeenLastCalledWith(entry, { optionId: 'reject' });
  });

  it('names the approval a gate decision asks for when the request carries its label (PM-445)', () => {
    const entry = item('inb_dec_release');
    const labelled: InboxItem = {
      ...entry,
      payload: { gate: { ...(entry.payload.gate as object), label: 'release-approved' } },
    };
    renderUi(
      <InboxCard
        item={labelled}
        members={members}
        myHandle="owner"
        pipeline={pipeline}
        labels={[{ id: 'release-approved', name: 'Élesítés jóváhagyva', holders: [] } as never]}
        onResolve={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Jóváhagyás: „Élesítés jóváhagyva” · Merge → Élesítés' }),
    ).toBeTruthy();
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
    const why = within(recommended).getByText(`${t('inbox.question.reasonLabel')} ${reason}`);
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
        `${t('inbox.question.reasonLabel')} ${reason}`,
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
    expect(within(recommended).getByText(`${t('inbox.question.reasonLabel')} ${reason}`)).toBeTruthy();
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

  describe('a permission question the AI decider has or had (PM-169)', () => {
    const withPayload = (extra: Record<string, unknown>): InboxItem => {
      const base = item('inb_perm_push');
      return { ...base, payload: { ...base.payload, ...extra } };
    };
    const delegation = {
      state: 'pending_lead',
      leads: ['code-review'],
      leadDeadline: '2026-10-01T11:02:00.000Z',
    };

    it('says that the decider has it, until when', () => {
      const { card } = renderCard(withPayload({ delegation }));
      expect(within(card).getByText(/Az AI-döntnök dönt róla/)).toBeTruthy();
      expect(within(card).getByText(/határidő/)).toBeTruthy();
    });

    const handed = (escalation: Record<string, unknown>) =>
      withPayload({ delegation: { ...delegation, state: 'pending_owner', escalation } });

    it('gives the decider’s reason when it passed the question on', () => {
      const { card } = renderCard(handed({ cause: 'lead', by: 'code-review', reason: 'I cannot tell.' }));
      expect(within(card).getByText(/továbbküldte neked: I cannot tell\./)).toBeTruthy();
    });

    it('says when the decider did not answer in time', () => {
      const { card } = renderCard(handed({ cause: 'timeout', by: 'system' }));
      expect(within(card).getByText(t('inbox.delegation.escalatedTimeout'))).toBeTruthy();
    });

    it('names the category an AI never decides', () => {
      const { card } = renderCard(withPayload({ ownerCategory: 'production' }));
      expect(
        within(card).getByText(
          t('inbox.delegation.ownerCategory', { category: t('boundary.categories.production') }),
        ),
      ).toBeTruthy();
    });

    it('says nothing for an ordinary question', () => {
      const { card } = renderCard(item('inb_perm_push'));
      expect(within(card).queryByText(/döntnök/)).toBeNull();
    });
  });

  describe('a long question written in markdown', () => {
    const question =
      'Kidolgozás alatt mi legyen a fiókban az Indítás gombbal? **Mi alapján van ott ma az Indítás?** Minden kártyán megjelenik.\n\n' +
      '**Az új szabály:**\n' +
      '- A kártya tetején ez áll: „Kidolgozás alatt”.\n' +
      '- Az Indítás csak akkor látszik, ha a kapu teljesül.\n\n' +
      'A gomb a `can.createTasks` joghoz kötött.';
    const long = plainLanguageQuestion({
      title: question,
      payload: {
        question,
        options: ['Elrejtjük', 'Marad'],
        recommended: 'option_1',
        recommendationReason: 'Ez a **legkevesebb zaj**.',
      },
      options: [
        {
          id: 'option_1',
          label: 'Elrejtjük',
          style: 'primary',
          consequence: 'Kidolgozás alatt **nem látszik**.',
        },
        { id: 'option_2', label: 'Marad', style: 'secondary', consequence: 'Semmi nem változik.' },
      ],
    });

    it('shows a short plain heading and the rest as formatted text, with no raw marks', () => {
      const { card } = renderCard(long);
      expect(
        within(card).getByRole('heading', {
          name: 'Kidolgozás alatt mi legyen a fiókban az Indítás gombbal?',
        }),
      ).toBeTruthy();
      expect(card.textContent).not.toContain('**');
      expect(card.textContent).not.toMatch(/(^|\n)\s*- /);
      expect(within(card).getByText('Mi alapján van ott ma az Indítás?').tagName).toBe('STRONG');
      expect(within(card).getByText('can.createTasks').tagName).toBe('CODE');
      expect(within(card).getAllByRole('listitem').length).toBeGreaterThanOrEqual(2);
      expect(within(card).getByText(/A kártya tetején ez áll/).tagName).toBe('LI');
    });

    it('formats the consequence and the reason of an option inline', () => {
      const { card } = renderCard(long);
      expect(within(card).getByText('nem látszik').tagName).toBe('STRONG');
      expect(within(card).getByText('legkevesebb zaj').tagName).toBe('STRONG');
      expect(card.textContent).toContain(`${t('inbox.question.reasonLabel')} Ez a legkevesebb zaj.`);
    });

    it('has no body and no button for a short one-line question', () => {
      const { card } = renderCard(plainLanguageQuestion());
      expect(within(card).queryByRole('button', { name: t('inbox.question.more') })).toBeNull();
      expect(card.querySelector('[aria-controls]')).toBeNull();
    });

    it('folds a body taller than ten lines behind a button that opens and closes it', () => {
      vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(500);
      try {
        const { card } = renderCard(long);
        const toggle = within(card).getByRole('button', { name: t('inbox.question.more') });
        const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(body.className).toMatch(/clamped/);
        expect(body.style.maxHeight).toMatch(/px$/);
        fireEvent.click(toggle);
        expect(body.style.maxHeight).toBe('');
        expect(body.className).not.toMatch(/clamped/);
        const less = within(card).getByRole('button', { name: t('inbox.question.less') });
        expect(less.getAttribute('aria-expanded')).toBe('true');
        fireEvent.click(less);
        expect(body.className).toMatch(/clamped/);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('opens the folded body when focus moves into it', () => {
      vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(500);
      try {
        const { card } = renderCard(
          plainLanguageQuestion({ title: `${question}\n\nLásd [a kártyát](https://example.test/c).` }),
        );
        const body = document.getElementById(
          within(card)
            .getByRole('button', { name: t('inbox.question.more') })
            .getAttribute('aria-controls')!,
        )!;
        fireEvent.focus(within(card).getByRole('link', { name: 'a kártyát' }));
        expect(body.className).not.toMatch(/clamped/);
        expect(within(card).getByRole('button', { name: t('inbox.question.less') })).toBeTruthy();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('titles a question that starts with a list "waiting for an answer", the list in the body', () => {
      const { card } = renderCard(
        plainLanguageQuestion({
          title: '- Az alsó sáv 64 px magas.\n- A számláló az ikonon ül.\n\nMaradhat így?',
        }),
      );
      expect(within(card).getByRole('heading', { name: t('inbox.question.untitled') })).toBeTruthy();
      expect(within(card).getByText('Az alsó sáv 64 px magas.').tagName).toBe('LI');
      expect(card.textContent).not.toContain('- ');
    });
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

describe('InboxCard "Vidd tovább" (PM-461)', () => {
  const handOn: InboxItem = {
    id: 'inb_hand_on',
    projectKey: 'AC',
    kind: 'hand_on',
    assignees: ['owner'],
    source: 'be-1',
    sessionId: null,
    taskKey: 'AC-24',
    title: 'Hibariasztás a fizetési hibákról',
    body: null,
    payload: {
      handOn: { taskKey: 'AC-24', fromStageId: 'dev', toStageId: 'code_review', requestedBy: 'be-1' },
    },
    options: [{ id: 'move', label: 'move', style: 'primary' }],
    state: 'open',
    resolution: null,
    createdAt: '2026-10-01T10:00:00.000Z',
  };
  const next = pipeline.stageById.get('code_review')!.name;
  const from = pipeline.stageById.get('dev')!.name;

  it('says who finished, which step and the next column, and offers "Tovább" and "Megnyitom"', () => {
    const { card, onResolve } = renderCard(handOn);
    expect(within(card).getByText(t('inbox.kinds.hand_on'))).toBeTruthy();
    expect(card.textContent).toContain(`végzett ebben a lépésben: ${from}. A következő oszlop: ${next}.`);
    expect(within(card).getByText(next).tagName).toBe('STRONG');
    const buttons = within(card).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([t('inbox.handOn.move', { stage: next })]);
    expect(within(card).getByRole('link', { name: t('inbox.handOn.open') })).toBeTruthy();
    fireEvent.click(buttons[0]!);
    expect(onResolve).toHaveBeenCalledWith(handOn, { optionId: 'move' });
  });

  it('leaves out the small card title line: the heading already names the card', () => {
    const { card } = renderCard(handOn, { taskTitle: 'A kártya saját címe' });
    expect(within(card).queryByText('A kártya saját címe')).toBeNull();
  });

  it('keeps that line on the other kinds of items', () => {
    const { card } = renderCard(item('inb_q_ga4'), { taskTitle: 'A kártya saját címe' });
    expect(within(card).getByText('A kártya saját címe')).toBeTruthy();
  });

  it('does not offer the details link twice on the phone', () => {
    const { card } = renderCard(handOn, { mobile: true });
    expect(within(card).getAllByRole('link')).toHaveLength(1);
  });

  it('shows why the move was refused on the card, as an alert', () => {
    const onResolve = vi.fn();
    renderUi(
      <InboxCard
        item={handOn}
        members={members}
        myHandle="owner"
        pipeline={pipeline}
        onResolve={onResolve}
        error="A kártya még nem léphet tovább: hiányzik a Code review rendben."
        detailsHref="/p/AC/tasks/AC-24"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('A kártya még nem léphet tovább: hiányzik a Code review rendben.');
    // The item stays and the button works again.
    expect(screen.getByRole('button', { name: t('inbox.handOn.move', { stage: next }) })).toHaveProperty(
      'disabled',
      false,
    );
  });
});
