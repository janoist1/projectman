import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TaskPullRequest } from '@projectman/shared';
import { sessions, tasks } from '../../mocks/fixtures';
import { t } from '../../i18n/t';
import { PrPanel, UsagePanel } from './SessionPanels';

describe('NanoGPT session usage', () => {
  it('shows the Codex subagent limitation even without measured tokens', () => {
    render(
      <UsagePanel session={{ ...sessions[0]!, provider: 'nanogpt', usage: undefined }} provider="nanogpt" />,
    );
    expect(screen.getByText(t('tokenUsage.codexSubagents'))).toBeTruthy();
  });
});

const pr: TaskPullRequest = {
  repo: 'acme/web',
  number: 7,
  url: 'https://github.com/acme/web/pull/7',
  title: 'Fictional login form',
  state: 'open',
  checks: 'failing',
  reviewDecision: 'changes_requested',
  additions: 42,
  deletions: 8,
};

describe('PrPanel', () => {
  it('renders all pull requests and their GitHub fields', () => {
    render(
      <PrPanel
        task={tasks[0]!}
        session={sessions[0]!}
        pullRequests={[
          pr,
          {
            ...pr,
            number: 8,
            title: 'Fictional second PR',
            checks: null,
            reviewDecision: null,
            additions: null,
            deletions: null,
            state: null,
            url: null,
          },
        ]}
      />,
    );
    expect(screen.getByText('PR #7')).toBeTruthy();
    expect(screen.getByText('PR #8')).toBeTruthy();
    expect(screen.getByText(pr.title!)).toBeTruthy();
    expect(screen.getByText(t('session.pr.checkStates.failing'))).toBeTruthy();
    expect(screen.getByText(t('session.pr.reviewStates.changes_requested'))).toBeTruthy();
    expect(screen.getByText('+42 / −8')).toBeTruthy();
    expect(screen.getAllByText(t('session.pr.unknown')).length).toBeGreaterThan(1);
    expect(screen.getByRole('link', { name: t('session.pr.openOnGithub') }).getAttribute('href')).toBe(
      pr.url,
    );
  });

  it('draws no box without a pull request', () => {
    const { container } = render(
      <PrPanel task={{ ...tasks[0]!, labels: [] }} session={sessions[0]!} pullRequests={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows only the labels, not a pull request heading, when the task has labels but no pull request', () => {
    render(<PrPanel task={{ ...tasks[0]!, labels: ['qa-ok'] }} session={sessions[0]!} pullRequests={[]} />);
    expect(screen.queryByText(t('session.pr.title'))).toBeNull();
    expect(screen.getByRole('heading', { name: t('task.labels.title') })).toBeTruthy();
  });
});
