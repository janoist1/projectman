import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FixLimitDecisionPayload } from '@projectman/shared';
import { fixLimitDecisionOf, routes } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { fixRoundParts, fixLimitStatus } from '../../lib/fixLimit';
import { InboxCard } from './InboxCard';
import { InboxPage } from './InboxPage';
import { SignalBox } from '../board/SignalBox';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function fixture() {
  const project = mockProject();
  project.backend.config.team.limits.maxFixRounds = 2;
  for (let i = 0; i < 2; i++)
    project.backend.addTimeline('AC-21', 'code-review', 'task_labels_changed', {
      added: ['code-review-changes'],
      removed: [],
    });
  const item = project.backend.inbox.find((item) => fixLimitDecisionOf(item))!;
  const limit = fixLimitDecisionOf(item)!;
  project.backend.inbox = [item];
  const members = new Map(project.backend.members.map((member) => [member.handle, member]));
  return { project, item, limit, members };
}

function showCard(
  f: ReturnType<typeof fixture>,
  patch: Partial<FixLimitDecisionPayload> = {},
  pending = false,
  error?: string,
) {
  f.item.payload = { fixLimit: { ...f.limit, ...patch } };
  const resolve = vi.fn();
  f.project.render(
    <InboxCard
      item={f.item}
      members={f.members}
      myHandle="owner"
      onResolve={resolve}
      pending={pending}
      error={error}
    />,
  );
  return resolve;
}

describe('fix limit decision details', () => {
  it('names the integrator and the actual fourth extra round in the drawer signal', () => {
    const f = fixture();
    const task = f.project.backend.findTask('AC-21')!;
    task.fixLimit = { ...task.fixLimit!, recipient: 'integrator', extraRounds: 4, reason: 'extra_exhausted' };
    f.project.render(<SignalBox task={task} members={f.members} myHandle="owner" />);
    expect(screen.getByText(t('fixLimit.box.extrasOver', { used: 4 }))).toBeTruthy();
    expect(
      screen.getByText(t('fixLimit.box.people.extra_exhausted', { decides: t('fixLimit.box.integrator') })),
    ).toBeTruthy();
  });
  it('shows the actual fourth extra round, technical rows and the last twelve entries', () => {
    const f = fixture();
    const at = '2026-10-18T12:00:00Z';
    const actor = { kind: 'ai' as const, handle: 'code-review' };
    showCard(f, {
      extraRounds: 4,
      history: [
        {
          eventId: 'technical',
          at,
          actor,
          kind: 'branch_moved',
          round: null,
          note: null,
          pinned: 'aaaaaaa',
          head: 'bbbbbbb',
        },
        ...Array.from({ length: 12 }, (_, i) => ({
          eventId: `review-${i}`,
          at,
          actor,
          kind: 'code_review' as const,
          round: i + 1,
          note: `Review ${i + 1}`,
        })),
        { eventId: 'grant', at, actor, kind: 'extra_round', extraRound: 4, round: null, note: 'Small fix.' },
      ],
    });
    expect(screen.getByText(t('inbox.fixLimit.extrasOver', { used: 4 }))).toBeTruthy();
    expect(document.querySelectorAll('[data-used="true"]')).toHaveLength(3);
    expect(screen.getByText(t('inbox.fixLimit.consequence.another_round_over'))).toBeTruthy();
    const list = screen.getByRole('list', { name: t('inbox.fixLimit.rounds.label') });
    expect(within(list).getAllByRole('listitem')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: t('inbox.fixLimit.rounds.earlier', { count: 2 }) }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(14);
    expect(screen.getByText('+4')).toBeTruthy();
    expect(screen.getByText(t('inbox.fixLimit.rounds.notCounted'))).toBeTruthy();
    expect(list.closest('details')?.open).toBe(true);
  });

  it('keeps an unavailable recommendation authentic, disabled and described', () => {
    const f = fixture();
    const resolve = showCard(f, {
      assessment: {
        recurrence: 'Same fault.',
        currentState: 'Almost ready.',
        recommendation: { optionId: 'replan', reason: 'Clarify scope.' },
      },
    });
    const button = screen.getByRole('button', { name: t('inbox.options.replan') });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(
      button
        .getAttribute('aria-describedby')
        ?.split(' ')
        .map((id) => document.getElementById(id)?.textContent)
        .join(' '),
    ).toContain(t('inbox.fixLimit.unavailable.replan'));
    expect(screen.getByText(/Clarify scope\./)).toBeTruthy();
    expect(
      screen.getByRole('list', { name: t('inbox.fixLimit.rounds.label'), hidden: true }).closest('details')
        ?.open,
    ).toBe(false);
    fireEvent.click(button);
    expect(resolve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('inbox.options.another_round') }));
    expect(resolve).toHaveBeenCalledWith(f.item, { optionId: 'another_round' });
  });

  it('keeps legacy items free of invented extras and history', () => {
    const f = fixture();
    showCard(f, {
      history: undefined,
      extraRounds: undefined,
      assessment: undefined,
      testsFailed: undefined,
      reason: 'again',
    });
    expect(screen.queryByRole('list', { name: t('inbox.fixLimit.rounds.label') })).toBeNull();
    expect(screen.queryByText(/Extra kör:/)).toBeNull();
    expect(
      screen.getByText(
        t('inbox.fixLimit.body', {
          key: 'AC-21',
          rounds: 2,
          parts: fixRoundParts(f.limit),
          reason: t('inbox.fixLimit.reasons.again'),
        }),
      ),
    ).toBeTruthy();
  });

  it('disables all choices while pending and exposes a retryable error', () => {
    const f = fixture();
    showCard(f, {}, true, 'Retry decision.');
    for (const id of ['replan', 'reassign', 'another_round'] as const)
      expect(screen.getByRole('button', { name: t(`inbox.options.${id}`) }).hasAttribute('disabled')).toBe(
        true,
      );
    expect(screen.getByRole('alert').textContent).toBe('Retry decision.');
  });

  it('explains when all choices are unavailable', () => {
    const f = fixture();
    f.item.options = [];
    const resolve = showCard(f);
    expect(screen.getByText(t('inbox.fixLimit.unavailable.none'))).toBeTruthy();
    for (const button of screen.getAllByRole('button')) fireEvent.click(button);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('counts failed tests inside send-backs without claiming legacy send-backs were manual', () => {
    expect(fixRoundParts({ changeRequests: 0, designChangeRequests: 0, sendBacks: 3, testsFailed: 2 })).toBe(
      `${t('fixLimit.part.testsFailed', { count: 2 })} és ${t('fixLimit.part.manual', { count: 1 })}`,
    );
    expect(fixRoundParts({ changeRequests: 0, designChangeRequests: 0, sendBacks: 3 })).toBe(
      t('fixLimit.part.sendBacks', { count: 3 }),
    );
  });

  it('keeps Operator queue decisions outside the owner inbox', async () => {
    const f = fixture();
    f.item.payload = {
      ...f.item.payload,
      recipient: 'integrator',
      integratorOpenedAt: new Date().toISOString(),
    };
    const held = f.project.backend.findTask('AC-21')!.fixLimit!;
    held.recipient = 'integrator';
    expect(fixLimitStatus(held, f.members, 'owner')).toContain(t('involvement.integrator'));
    f.project.render(<InboxPage />, '/p/AC/inbox');
    expect(await screen.findByText(t('inbox.allDoneEverywhere'))).toBeTruthy();
    expect(document.querySelector('article[data-recipient="integrator"]')).toBeNull();
    const board = f.project.backend.handle('GET', routes.board('AC'), undefined).body as {
      openInboxCount: number;
    };
    expect(board.openInboxCount).toBe(0);
    f.project.backend.config.team.limits.aiEnabled = false;
    f.project.backend.sweepIntegratorTodos(new Date().toISOString());
    expect(f.item.taskKey).toBe('AC-21');
    expect(f.project.backend.inbox[0]!.payload.recipient).toBe('integrator');
    expect(f.project.backend.findTask('AC-21')!.fixLimit?.recipient).toBe('integrator');
  });

  it('keeps an Operator resolution outside the owner decisions', async () => {
    const f = fixture();
    const at = new Date().toISOString();
    f.item.payload = { ...f.item.payload, recipient: 'integrator', integratorOpenedAt: at };
    f.item.state = 'resolved';
    f.item.resolution = {
      optionId: 'another_round',
      by: 'owner',
      via: 'integrator',
      integratorFixLimit: true,
      at,
      note: null,
    };
    f.project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByText(t('inbox.allDoneEverywhere'));
    expect(screen.queryByText(t('inbox.recent'))).toBeNull();
  });
});
