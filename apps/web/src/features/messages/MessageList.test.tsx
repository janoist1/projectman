import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockProject } from '../../test/mockProject';
import { t } from '../../i18n/t';
import { MessageList } from './MessageList';

const long = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of a long message`).join('\n');

function list(compact: boolean) {
  const p = mockProject();
  const message = {
    id: 'm-long',
    projectKey: 'AC',
    from: 'fe-1',
    to: ['owner'],
    taskKey: null,
    body: long,
    createdAt: '2026-10-01T12:00:00.000Z',
    deliveredAt: null,
  };
  p.render(
    <MessageList
      messages={[message]}
      members={new Map()}
      myHandle="owner"
      projectKey="AC"
      taskTitles={new Map()}
      compact={compact}
    />,
  );
}

describe('MessageList', () => {
  it('distinguishes the integrator from the signed-in owner', async () => {
    const p = mockProject();
    p.render(
      <MessageList
        messages={[
          {
            id: 'm-integrator',
            projectKey: 'AC',
            from: 'owner',
            via: 'integrator',
            to: ['fe-1'],
            taskKey: null,
            body: 'Review this card.',
            createdAt: '2026-10-01T12:00:00.000Z',
            deliveredAt: null,
          },
        ]}
        members={new Map()}
        myHandle="owner"
        projectKey="AC"
        taskTitles={new Map()}
      />,
    );
    expect(await screen.findByText(t('involvement.integratorFull'), { exact: false })).toBeTruthy();
    expect(screen.getByRole('img', { name: t('involvement.integratorFull') })).toBeTruthy();
    expect(screen.queryByText(t('common.you'))).toBeNull();
  });
  it('marks the narrow list, whose CSS cuts a long text to a few lines, and keeps the text whole', async () => {
    list(true);
    const body = await screen.findByText(/Line 1 of/);
    expect(body.textContent).toBe(long);
    expect(body.closest('ol')?.className).toMatch(/compact/);
  });

  it('does not mark the full list, which shows the whole text', async () => {
    list(false);
    await screen.findByText(/Line 1 of/);
    expect(screen.getByRole('list').className).not.toMatch(/compact/);
  });
});
