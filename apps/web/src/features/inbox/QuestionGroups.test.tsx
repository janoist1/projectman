import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InboxItem, QuestionGroup } from '@projectman/shared';
import { t } from '../../i18n/t';
import { formatTime } from '../../i18n/format';
import { plainLanguageQuestion } from '../../mocks/fixtures';
import { mockIndexes, renderUi } from '../../test/render';
import { InboxCard } from './InboxCard';
import { openItemsFor } from '../../lib/inbox';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

const { members } = mockIndexes();
const group: QuestionGroup = {
  primaryItemId: 'inb_group',
  itemIds: ['inb_group', 'inb_linked', 'inb_same_card'],
  combinedQuestion: 'May both cards proceed?',
  originalQuestion: 'First original question',
  primaryTaskKey: 'AC-21',
  note: 'Both cards need the same decision.',
  sources: [
    {
      itemId: 'inb_group',
      taskKey: 'AC-21',
      taskTitle: 'First card',
      asker: 'dev-1',
      question: 'First original question',
      createdAt: '2026-10-16T08:00:00.000Z',
      state: 'live',
    },
    {
      itemId: 'inb_linked',
      taskKey: 'AC-22',
      taskTitle: 'Second card',
      asker: 'dev-2',
      question: 'Second original question',
      createdAt: '2026-10-16T08:01:00.000Z',
      state: 'live',
    },
    {
      itemId: 'inb_same_card',
      taskKey: 'AC-22',
      taskTitle: 'Second card',
      asker: 'dev-2',
      question: 'Third original question',
      createdAt: '2026-10-16T08:02:00.000Z',
      state: 'withdrawn',
    },
  ],
};
function entry(change: Partial<InboxItem> = {}, data: QuestionGroup = group): InboxItem {
  return {
    ...plainLanguageQuestion(),
    id: group.primaryItemId,
    title: group.combinedQuestion,
    payload: {
      ...plainLanguageQuestion().payload,
      group: data,
      screening: { until: '2026-10-16T08:10:00.000Z', by: 'pm' },
    },
    ...change,
  };
}
function render(entry: InboxItem) {
  const onResolve = vi.fn();
  renderUi(<InboxCard item={entry} members={members} myHandle="owner" onResolve={onResolve} />);
  return onResolve;
}

describe('combined questions in the inbox', () => {
  it('does not show a delivery receipt for a withdrawn group with stale answer data', async () => {
    const project = mockProject();
    const at = new Date().toISOString();
    project.backend.inbox = [
      entry({
        state: 'cancelled',
        resolution: { optionId: 'closed', by: 'system', at, note: null, rule: 'group_withdrawn' },
        payload: { ...entry().payload, answerDelivery: { state: 'delivered', at } },
      }),
    ];
    project.render(<InboxPage />, '/p/AC/inbox');
    const history = await screen.findByRole('complementary');
    expect(history.textContent).toContain(t('inbox.closedBySystem'));
    expect(history.textContent).not.toContain(t('inbox.awaitsStart.delivered', { time: formatTime(at) }));
  });
  it('uses the durable answered count in history even when a source was deleted', async () => {
    const project = mockProject();
    const data: QuestionGroup = {
      ...group,
      answeredCount: 2,
      sources: group.sources!.map((source, index) =>
        index === 1
          ? { ...source, state: 'deleted', taskKey: null, taskTitle: null, question: null }
          : source,
      ),
    };
    project.backend.inbox = [
      entry(
        {
          state: 'resolved',
          resolution: {
            optionId: 'option_1',
            by: 'owner',
            at: new Date().toISOString(),
            note: null,
          },
        },
        data,
      ),
    ];
    project.render(<InboxPage />, '/p/AC/inbox');
    expect(await screen.findByText(/2 kérdésre ment el/)).toBeTruthy();
    expect(screen.queryByText(/1 kérdésre ment el/)).toBeNull();
  });
  it('shows one combined question, distinct source cards, a folded source list and the live fanout count', () => {
    const item = entry();
    const onResolve = render(item);
    expect(screen.getByRole('heading', { name: group.combinedQuestion })).toBeTruthy();
    expect(screen.getByText(t('inbox.group.line', { count: 2 }))).toBeTruthy();
    const line = screen.getByText(t('inbox.group.line', { count: 2 })).closest('p')!;
    expect(
      within(line).getAllByRole('link', { name: t('inbox.group.openKey', { key: 'AC-22' }) }),
    ).toHaveLength(1);
    const fold = screen.getByText(t('inbox.group.sources', { count: 3 })).closest('summary')!;
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(t('inbox.group.fanout', { count: 2 }))).toBeTruthy();
    fireEvent.click(fold);
    expect(screen.getByRole('link', { name: 'AC-21 First card' })).toBeTruthy();
    expect(screen.getByText('First original question')).toBeTruthy();
    expect(screen.getByText('Second original question')).toBeTruthy();
    expect(screen.getByText(t('inbox.group.withdrawn'))).toBeTruthy();
    const options = screen.getAllByRole('list').find((list) => list.hasAttribute('aria-describedby'))!;
    expect(document.getElementById(options.getAttribute('aria-describedby')!)?.textContent).toBe(
      t('inbox.group.fanout', { count: 2 }),
    );
    const choice = within(options).getAllByRole('button')[0]!;
    fireEvent.click(choice);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('never shows a key or original question for hidden or deleted sources', () => {
    const data: QuestionGroup = {
      ...group,
      sources: group.sources!.map((source, index) =>
        index === 0
          ? source
          : {
              ...source,
              taskKey: null,
              taskTitle: null,
              question: null,
              state: index === 1 ? 'live' : 'deleted',
            },
      ),
    };
    render(entry({}, data));
    fireEvent.click(screen.getByText(t('inbox.group.sources', { count: 3 })).closest('summary')!);
    expect(screen.getByText(t('inbox.group.sourceHidden'))).toBeTruthy();
    expect(screen.getByText(t('inbox.group.sourceDeleted'))).toBeTruthy();
    expect(screen.queryByText('Second original question')).toBeNull();
    expect(screen.queryByText('AC-22')).toBeNull();
    expect(screen.queryByText(t('inbox.group.sourceGeneral'))).toBeNull();
  });

  it.each([false, true])('describes general sources without card links (all general: %s)', (allGeneral) => {
    const data: QuestionGroup = {
      ...group,
      sources: group.sources!.map((source, index) =>
        allGeneral || index === 0 ? { ...source, taskKey: null, taskTitle: null } : source,
      ),
    };
    render(entry({}, data));
    const line = screen.getByText(t('inbox.group.lineMixed', { count: allGeneral ? 3 : 2 })).closest('p')!;
    expect(within(line).getByText(t('inbox.group.generalCount', { count: allGeneral ? 3 : 1 }))).toBeTruthy();
    expect(within(line).queryAllByRole('link')).toHaveLength(allGeneral ? 0 : 1);
    expect(screen.getByText(t('inbox.group.fanoutMixed', { count: 2 }))).toBeTruthy();
    fireEvent.click(screen.getByText(t('inbox.group.sources', { count: 3 })).closest('summary')!);
    expect(screen.getAllByText(t('inbox.group.sourceGeneral'))).toHaveLength(allGeneral ? 3 : 1);
    expect(screen.getByText('First original question')).toBeTruthy();
  });

  it('uses the card-only fanout text after the general source withdraws', () => {
    const data: QuestionGroup = {
      ...group,
      sources: group.sources!.map((source, index) =>
        index === 0
          ? { ...source, taskKey: null, taskTitle: null, state: 'withdrawn' }
          : { ...source, state: 'live' },
      ),
    };
    render(entry({}, data));
    expect(screen.getByText(t('inbox.group.fanout', { count: 2 }))).toBeTruthy();
    expect(screen.queryByText(t('inbox.group.fanoutMixed', { count: 2 }))).toBeNull();
  });

  it('renders a linked pointer with no answer controls, and excludes it from the inbox count', () => {
    const linked = entry(
      { id: 'inb_linked', taskKey: 'AC-22' },
      { ...group, sources: undefined, itemIds: [], combinedQuestion: '' },
    );
    render(linked);
    expect(
      screen.getByRole('link', { name: t('inbox.group.pointerJump', { key: 'AC-21' }) }).getAttribute('href'),
    ).toContain('/p/AC/tasks/AC-21#');
    expect(screen.queryByRole('button')).toBeNull();
    expect(openItemsFor([entry(), linked], 'owner')).toHaveLength(1);
    expect(openItemsFor([entry(), linked], 'owner', true)).toHaveLength(2);
  });

  it('renders a plain pointer without the primary card key when it is unavailable', () => {
    render(entry({ id: 'inb_linked' }, { ...group, sources: undefined, primaryTaskKey: null }));
    expect(screen.getByText(t('inbox.group.pointerPlain'))).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
