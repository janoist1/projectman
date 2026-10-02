import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Session, TimelineEvent, TokenUsage } from '@projectman/shared';
import { formatTokens as format } from '../../i18n/format';
import { t } from '../../i18n/t';
import type { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { TaskDrawer } from '../board/TaskDrawer';
import { Route, Routes } from 'react-router';
import { ClosedCardsComparison } from './ClosedCardsComparison';

/** A count as the queries see it: their normalizer turns the grouping (no-break) spaces into plain ones. */
const formatTokens = (count: number) => format(count).replace(/\s/g, ' ');

let events = 0;
const addEvent = (
  backend: MockBackend,
  taskKey: string,
  type: TimelineEvent['type'],
  data: Record<string, unknown>,
) => {
  events += 1;
  backend.timeline.push({
    id: `evt_measure_${events}`,
    projectKey: 'AC',
    taskKey,
    sessionId: null,
    actor: { kind: 'system', handle: null },
    type,
    data,
    createdAt: new Date().toISOString(),
  });
};
const toReview = (backend: MockBackend, taskKey: string) =>
  addEvent(backend, taskKey, 'task_stage_changed', { from: 'dev', to: 'code_review' });
const sendBack = (backend: MockBackend, taskKey: string) =>
  addEvent(backend, taskKey, 'task_stage_changed', { from: 'code_review', to: 'dev' });
const asksChanges = (backend: MockBackend, taskKey: string) =>
  addEvent(backend, taskKey, 'task_labels_changed', { added: ['code-review-changes'], removed: [] });

const usage = (model: string, input: number, cacheRead = 0): TokenUsage => ({
  model,
  scope: 'main',
  input,
  output: 0,
  cacheRead,
  cacheWrite: 0,
});
let sessions = 0;
let template: Session;
const measure = (backend: MockBackend, taskKey: string, member: string, rows: TokenUsage[]) => {
  sessions += 1;
  backend.sessions.push({
    ...structuredClone(template),
    id: `ses_measure_${sessions}`,
    member,
    workItem: { type: 'task', taskKey },
    usage: { since: '2026-01-01T00:00:00.000Z', rows },
  });
};

/**
 * Three closed cards of the fixtures: AC-15 took two reviews (one asked for changes) and a
 * send-back; AC-14 one review; AC-13 three. Their implementers used other models than their
 * setting today says.
 */
function measuredProject() {
  const project = mockProject();
  const { backend } = project;
  const measured = ['AC-15', 'AC-14', 'AC-13'];
  backend.timeline = backend.timeline.filter((e) => !measured.includes(e.taskKey ?? ''));
  // The fixtures' other sessions (some without measured usage) would count in the totals.
  template = structuredClone(backend.sessions[0]!);
  backend.sessions = [];
  toReview(backend, 'AC-15');
  asksChanges(backend, 'AC-15');
  sendBack(backend, 'AC-15');
  toReview(backend, 'AC-15');
  toReview(backend, 'AC-14');
  for (let round = 0; round < 3; round += 1) toReview(backend, 'AC-13');
  measure(backend, 'AC-15', 'dev-1', [usage('claude-opus-5-5', 1000)]);
  measure(backend, 'AC-14', 'fe-1', [usage('claude-sonnet-5-5', 5000)]);
  measure(backend, 'AC-13', 'be-1', [usage('claude-sonnet-5-5', 200, 1000)]);
  return project;
}

/** The AC-15, AC-14 and AC-13 rows' keys in the order the list shows them. */
const order = () =>
  screen
    .getAllByRole('link')
    .map((link) => /AC-1[345]/.exec(link.textContent ?? '')?.[0])
    .filter((key): key is string => key !== undefined);

describe('closed cards comparison (PM-222)', () => {
  it("lists the closed cards with the implementer's model, weighted tokens per model and rounds", async () => {
    const project = measuredProject();
    project.render(<ClosedCardsComparison />);
    const table = await screen.findByRole('table');
    const row = within(table).getByText('AC-15').closest('tr')!;
    // The model is the one the sessions used (dev-1 may be set to another model today).
    // Once as the implementer's model, once in the weighted tokens per model.
    expect(within(row).getAllByText('claude-opus-5-5')).toHaveLength(2);
    expect(within(row).getAllByText(formatTokens(1000))).toHaveLength(2);
    const cells = within(row).getAllByRole('cell');
    expect(cells[3]!.textContent).toContain('2');
    expect(cells[3]!.textContent).toContain(t('cardMeasure.changeRequestsOf', { count: 1 }));
    expect(cells[4]!.textContent).toBe('1');
    // Weighted: 200 + a tenth of 1000 cache reads.
    const sonnet = within(table).getByText('AC-13').closest('tr')!;
    expect(within(sonnet).getAllByText(formatTokens(300))).toHaveLength(2);
    expect(project.requests.some((request) => request.path.endsWith('/measure/closed-cards?days=14'))).toBe(
      true,
    );
  });

  it('says the model source in one sentence and keeps the weighted-token note behind a fold (PM-240)', async () => {
    const project = measuredProject();
    project.render(<ClosedCardsComparison />);
    await screen.findByRole('table');
    expect(screen.getByText(t('cardMeasure.hint')).closest('details')).toBeNull();
    const details = screen.getByText(t('cardMeasure.weightedHintSummary')).closest('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByText(t('cardMeasure.weightedHint'))).toBeTruthy();
    fireEvent.click(screen.getByText(t('cardMeasure.weightedHintSummary')));
    expect(details.open).toBe(true);
  });

  it('sorts by weighted tokens and by review rounds, and takes another period', async () => {
    const project = measuredProject();
    project.render(<ClosedCardsComparison />);
    await screen.findByRole('table');
    expect(order()).toEqual(['AC-15', 'AC-14', 'AC-13']);

    fireEvent.click(
      screen.getByRole('button', {
        name: t('cardMeasure.sortBy', { column: t('cardMeasure.columns.tokens') }),
      }),
    );
    expect(order()).toEqual(['AC-14', 'AC-15', 'AC-13']);
    fireEvent.click(
      screen.getByRole('button', {
        name: t('cardMeasure.sortBy', { column: t('cardMeasure.columns.reviewRounds') }),
      }),
    );
    expect(order()).toEqual(['AC-13', 'AC-15', 'AC-14']);

    fireEvent.click(screen.getByRole('button', { name: t('cardMeasure.periodDays', { days: 7 }) }));
    await waitFor(() =>
      expect(project.requests.some((request) => request.path.endsWith('/measure/closed-cards?days=7'))).toBe(
        true,
      ),
    );
  });

  it('says so when a closed card has sessions from before the measurement', async () => {
    const project = measuredProject();
    const measured = project.backend.sessions.find(
      (s) => s.id.startsWith('ses_measure_') && s.workItem.type === 'task' && s.workItem.taskKey === 'AC-15',
    )!;
    delete measured.usage;
    project.render(<ClosedCardsComparison />);
    expect(await screen.findByText(t('cardMeasure.unmeasured', { cards: 1, sessions: 1 }))).toBeTruthy();
  });

  it('is not shown to a client member, who sees no usage', async () => {
    const project = measuredProject();
    const me = {
      ...project.context.me,
      projects: project.context.me.projects.map((p) => ({ ...p, access: 'client' as const })),
    };
    project.render(<ClosedCardsComparison />, '/', { me });
    expect(screen.queryByRole('heading', { name: t('cardMeasure.title') })).toBeNull();
    expect(project.requests.some((request) => request.path.includes('/measure/'))).toBe(false);
  });
});

describe("rounds in a card's drawer (PM-222)", () => {
  it("shows the card's rounds and its weighted tokens per model next to the token usage", async () => {
    const project = measuredProject();
    project.render(
      <Routes>
        <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
      </Routes>,
      '/p/AC/tasks/AC-15',
    );
    const section = await screen.findByRole('region', { name: t('tokenUsage.roundsTitle') });
    const count = (label: string) => within(section).getByText(label).nextElementSibling!.textContent;
    expect(count(t('tokenUsage.reviewRounds'))).toBe('2');
    expect(count(t('tokenUsage.changeRequests'))).toBe('1');
    expect(count(t('tokenUsage.sendBacks'))).toBe('1');
    expect(within(section).getByText('claude-opus-5-5')).toBeTruthy();
    expect(within(section).getByText(formatTokens(1000))).toBeTruthy();
  });
});
