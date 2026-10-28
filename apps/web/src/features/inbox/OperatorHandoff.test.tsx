import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { OperatorHandoff, SuperOperation } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { api } from '../../api/endpoints';
import { t } from '../../i18n/t';
import { plainLanguageQuestion } from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { InboxCard } from './InboxCard';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

it.each<OperatorHandoff['reason']>(['owner_reserved', 'no_typed_operation', 'no_grant', 'processing_failed'])(
  'shows the handoff action and fixed reason for %s',
  async (reason) => {
    const project = mockProject();
    const entry = plainLanguageQuestion({
      source: 'system',
      title: 'Old title',
      payload: {
        question: 'Old title',
        operatorHandoff: {
          queueItemId: 'queue',
          reason,
          action: 'Complete the remaining work',
          detail: 'Already checked the state',
          operationId: null,
        },
      },
      options: [
        { id: 'todo_done', label: 'Done', style: 'primary' },
        { id: 'todo_cannot', label: 'Cannot', style: 'secondary' },
      ],
    });
    const onResolve = vi.fn();
    project.render(
      <InboxCard
        item={entry}
        members={new Map()}
        myHandle="owner"
        onResolve={onResolve}
        cardHref="/p/AC/tasks/AC-21"
        detailsHref="/p/AC/tasks/AC-21"
      />,
    );
    expect(screen.getByRole('heading', { name: 'Complete the remaining work' })).toBeTruthy();
    expect(screen.getByText(t('superMode.name'))).toBeTruthy();
    expect(screen.getByText(t(`inbox.handedOff.reasons.${reason}`))).toBeTruthy();
    expect(screen.getByText('Already checked the state').closest('details')?.open).toBe(false);
    fireEvent.click(screen.getByText(t('inbox.handedOff.detail')));
    expect(screen.getByText('Already checked the state')).toBeTruthy();
    if (reason === 'no_grant')
      expect(
        (await screen.findByRole('link', { name: t('inbox.handedOff.grant') })).getAttribute('href'),
      ).toBe('/p/AC/settings/integrator#operator-grant');
    if (reason === 'processing_failed')
      expect(
        screen.getAllByRole('link').filter((link) => link.getAttribute('href') === '/p/AC/tasks/AC-21'),
      ).toHaveLength(1);
  },
);

it('replaces the grant action with a note when access has since been granted', async () => {
  const project = mockProject();
  project.backend.operatorGrant.active = true;
  const entry = plainLanguageQuestion({
    payload: {
      question: 'Work',
      operatorHandoff: {
        queueItemId: 'q',
        reason: 'no_grant',
        action: 'Work',
        detail: null,
        operationId: null,
      },
    },
  });
  project.render(<InboxCard item={entry} members={new Map()} myHandle="owner" onResolve={vi.fn()} />);
  expect(await screen.findByText(t('inbox.handedOff.nowGranted'))).toBeTruthy();
  expect(screen.queryByRole('link', { name: t('inbox.handedOff.grant') })).toBeNull();
});

function commandFixture() {
  const project = mockProject();
  const at = new Date().toISOString();
  const operation: SuperOperation = {
    id: 'command',
    projectKey: 'AC',
    taskKey: null,
    handoffId: null,
    state: 'waiting_owner',
    requestId: '00000000-0000-4000-8000-000000000000',
    ownerQuestionId: 'question',
    errorCode: null,
    createdAt: at,
    updatedAt: at,
    command: {
      kind: 'administration',
      request: {
        kind: 'owner_command',
        target: { kind: 'hub' },
        command: 'printf "%s" * `pwd` \\path\nnext\u2028last',
        reason: 'Inspect the current state',
        cwd: '/work/project',
        timeoutSeconds: 120,
      },
    },
  };
  project.backend.superOperations = [operation];
  const entry = plainLanguageQuestion({
    id: 'question',
    payload: {
      question: 'Run the command?',
      superOperation: {
        operationId: operation.id,
        commandHash: 'hash',
        expectedConfigVersion: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    options: [
      { id: 'yes', label: 'Yes', style: 'primary' },
      { id: 'no', label: 'No', style: 'danger' },
    ],
  });
  const onResolve = vi.fn();
  return {
    project,
    entry,
    operation,
    onResolve,
    show: () =>
      project.render(<InboxCard item={entry} members={new Map()} myHandle="owner" onResolve={onResolve} />),
  };
}

it('cannot approve unseen command details and preserves literal shell syntax after loading', async () => {
  const f = commandFixture();
  let release!: (value: Awaited<ReturnType<typeof api.superOperation>>) => void;
  vi.spyOn(api, 'superOperation').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  f.show();
  expect(screen.getByRole('button', { name: 'Yes' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
  expect(f.onResolve).not.toHaveBeenCalled();
  release({ operation: f.operation, result: null });
  const yes = await screen.findByRole('button', { name: t('ownerCommand.yes') });
  expect(yes.hasAttribute('disabled')).toBe(false);
  expect(screen.getByLabelText(t('ownerCommand.command')).textContent).toBe(
    'printf "%s" * `pwd` \\path\nnext\\u2028last',
  );
  expect(screen.getByLabelText(t('ownerCommand.command')).tagName).toBe('PRE');
  expect(screen.getByText('/work/project')).toBeTruthy();
  fireEvent.click(yes);
  expect(f.onResolve).toHaveBeenCalledWith(f.entry, { optionId: 'yes' });
});

it('keeps rejection available when command loading fails and retries the read', async () => {
  const f = commandFixture();
  vi.spyOn(api, 'superOperation')
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValue({ operation: f.operation, result: null });
  f.show();
  expect(await screen.findByText(t('ownerCommand.error'))).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Yes' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'No' }));
  expect(f.onResolve).toHaveBeenCalledWith(f.entry, { optionId: 'no' });
  fireEvent.click(screen.getByRole('button', { name: t('app.retry') }));
  await screen.findByRole('button', { name: t('ownerCommand.yes') });
});

it('hides decision controls for a credential login', async () => {
  const f = commandFixture();
  f.project.context.me.via = 'integrator';
  f.show();
  expect(await screen.findByText(t('errors.codes.owner_approval_required'))).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('button', { name: t('ownerCommand.yes') })).toBeNull());
});
