import { describe, expect, it } from 'vitest';
import type { InboxItem } from '@projectman/shared';
import { t } from '../i18n/t';
import { resolutionLabel, shortCommand } from './inbox';

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
