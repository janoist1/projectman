import { describe, expect, it } from 'vitest';
import type { InboxItem } from '@projectman/shared';
import { t } from '../i18n/t';
import { questionExtras, resolutionLabel, shortCommand } from './inbox';

const item: InboxItem = {
  id: 'fictional-inbox',
  projectKey: 'AR',
  kind: 'permission',
  assignees: ['owner'],
  source: 'dev-1',
  sessionId: 'fictional-session',
  taskKey: 'AR-1',
  title: 'Bash: npm ci',
  body: null,
  payload: {},
  options: [],
  state: 'resolved',
  createdAt: '2026-09-30T10:00:00.000Z',
  resolution: { optionId: 'allow', by: 'system', at: '2026-09-30T10:00:00.000Z', note: null },
};

describe('shortCommand', () => {
  it.each([
    ['git push origin HEAD', 'git push'],
    ['cd /x/y && grep -rn example . | head', 'grep'],
    ['cd /x && git commit -m "Example"', 'git commit'],
    ["cd '/x/y with spaces' && npm ci", 'npm ci'],
    ['cd "/x/y with spaces" && git status', 'git status'],
    ['cd /x && cd "y z" && npx vitest run', 'npx'],
    ['  cd /x&& git diff  ', 'git diff'],
    ['cd /x/y', 'cd'],
    ['cd /x; git push', 'cd'],
    ['cd /x || git push', 'cd'],
    ['grep -rn example .', 'grep'],
    ['npm --version', 'npm'],
  ])('summarizes %s as %s', (command, expected) => {
    expect(shortCommand(command)).toBe(expected);
  });
  it('handles empty and long commands', () => {
    expect(shortCommand(null)).toBeNull();
    expect(shortCommand('')).toBeNull();
    expect(shortCommand('a'.repeat(40))).toBe(`${'a'.repeat(31)}…`);
  });
});

describe('automatic permission resolution labels', () => {
  it.each(['allow', 'deny'] as const)('labels automatic %s decisions', (optionId) => {
    expect(resolutionLabel({ ...item, resolution: { ...item.resolution!, optionId } })).toBe(
      t(`inbox.resolutions.automatic_${optionId}`),
    );
    expect(resolutionLabel({ ...item, resolution: { ...item.resolution!, optionId, by: 'owner' } })).toBe(
      t(`inbox.resolutions.${optionId}`),
    );
  });
});

describe('questionExtras', () => {
  const question: InboxItem = {
    ...item,
    kind: 'question',
    title: 'Inline or toast?',
    payload: {
      question: 'Inline or toast?',
      options: ['Inline', 'Toast'],
      recommended: 'option_2',
      recommendationReason: ' It stays visible. ',
      details: ' The `EmailField` already shows inline errors. ',
    },
    options: [
      { id: 'option_1', label: 'Inline', style: 'secondary' },
      { id: 'option_2', label: 'Toast', style: 'primary' },
      { id: 'answer', label: 'answer', style: 'secondary' },
    ],
    state: 'open',
    resolution: null,
  };

  it('reads the recommended option, its reason and the details', () => {
    expect(questionExtras(question)).toEqual({
      recommendedOptionId: 'option_2',
      recommendationReason: 'It stays visible.',
      details: 'The `EmailField` already shows inline errors.',
    });
  });

  it('has nothing for a question from before these fields existed', () => {
    const old = { ...question, payload: { question: 'Inline or toast?', options: ['Inline', 'Toast'] } };
    expect(questionExtras(old)).toEqual({
      recommendedOptionId: null,
      recommendationReason: null,
      details: null,
    });
  });

  it('leaves out a recommendation of an option the item does not have, and its reason', () => {
    const dangling = { ...question, payload: { ...question.payload, recommended: 'option_9' } };
    expect(questionExtras(dangling)).toMatchObject({ recommendedOptionId: null, recommendationReason: null });
    expect(questionExtras(dangling).details).toBe('The `EmailField` already shows inline errors.');
  });

  it('leaves out blank text and an unreadable payload', () => {
    const blank = {
      ...question,
      payload: { ...question.payload, recommendationReason: '  ', details: '\n' },
    };
    expect(questionExtras(blank)).toEqual({
      recommendedOptionId: 'option_2',
      recommendationReason: null,
      details: null,
    });
    const unreadable = { ...question, payload: { question: 'Inline or toast?', details: 42 } };
    expect(questionExtras(unreadable).details).toBeNull();
  });

  it('has nothing on other kinds of items', () => {
    expect(questionExtras({ ...item, payload: { ...question.payload } })).toEqual({
      recommendedOptionId: null,
      recommendationReason: null,
      details: null,
    });
  });
});
