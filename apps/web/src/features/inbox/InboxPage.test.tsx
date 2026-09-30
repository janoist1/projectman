import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
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
