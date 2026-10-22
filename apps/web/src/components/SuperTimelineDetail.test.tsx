import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { SuperHandoff, TimelineEvent } from '@projectman/shared';
import { setFetchImplementation } from '../api/client';
import { t } from '../i18n/t';
import { mockProject } from '../test/mockProject';
import { SuperTimelineDetail } from './SuperTimelineDetail';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

it('shows separate command output streams, failure and truncation in the operation detail', async () => {
  const project = mockProject();
  const at = new Date().toISOString();
  project.backend.superOperations = [
    {
      id: 'cmd',
      projectKey: 'AC',
      taskKey: null,
      handoffId: null,
      state: 'failed',
      requestId: '00000000-0000-4000-8000-000000000000',
      ownerQuestionId: null,
      errorCode: null,
      createdAt: at,
      updatedAt: at,
      command: {
        kind: 'administration',
        request: {
          kind: 'owner_command',
          target: { kind: 'hub' },
          command: 'git status',
          timeoutSeconds: 120,
          reason: 'Inspect state',
        },
      },
    },
  ];
  project.backend.superResults.set('cmd', {
    kind: 'owner_command',
    exitCode: 1,
    signal: 'SIGTERM',
    stdout: '<literal stdout>',
    stderr: 'diagnostic stderr',
    truncated: true,
    durationMs: 1250,
  });
  const event: TimelineEvent = {
    id: 'result',
    projectKey: 'AC',
    taskKey: null,
    sessionId: null,
    actor: { kind: 'ai', handle: 'operator' },
    type: 'super_operation_changed',
    data: { operationId: 'cmd', state: 'failed' },
    createdAt: at,
  };
  project.render(<SuperTimelineDetail event={event} events={[event]} fallback="Changed" />);
  expect(await screen.findByText(t('ownerCommand.truncated'))).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toBe('SIGTERM');
  fireEvent.click(screen.getByText(t('ownerCommand.stdout')));
  fireEvent.click(screen.getByText(t('ownerCommand.stderr')));
  expect(screen.getByText('<literal stdout>').tagName).toBe('PRE');
  expect(screen.getByText('diagnostic stderr').tagName).toBe('PRE');
});

it('links a successful operation back to its recorded handoff and preserves the historical event state', async () => {
  const project = mockProject();
  const at = new Date().toISOString();
  const actor = {
    kind: 'ai' as const,
    handle: 'actual-operator',
    via: 'integrator' as const,
    operatorMode: 'super' as const,
    credential: { id: 'key', prefix: 'pmi_test' },
  };
  const handoff: SuperHandoff = {
    id: 'h',
    projectKey: 'AC',
    taskKey: 'AC-21',
    requestedBy: { kind: 'ai', handle: actor.handle },
    reason: 'Queue maintenance',
    command: {
      kind: 'merge_order',
      repo: 'webshop',
      taskKeys: [],
      expectedRevision: 0,
      reason: 'Queue maintenance',
    },
    expectedConfigVersion: null,
    state: 'succeeded',
    operationId: 'op',
    createdAt: at,
    updatedAt: at,
  };
  project.backend.superHandoffs = [
    ...Array.from({ length: 51 }, (_, i) => ({ ...handoff, id: `recent_${i}`, reason: 'Recent handoff' })),
    handoff,
  ];
  project.backend.superOperations = [
    {
      id: 'op',
      projectKey: 'AC',
      taskKey: 'AC-21',
      handoffId: 'h',
      state: 'succeeded',
      requestId: '00000000-0000-4000-8000-000000000000',
      command: handoff.command,
      ownerQuestionId: null,
      errorCode: null,
      createdAt: at,
      updatedAt: at,
    },
  ];
  const start: TimelineEvent = {
    id: 'start',
    projectKey: 'AC',
    taskKey: 'AC-21',
    sessionId: null,
    actor: handoff.requestedBy,
    type: 'super_handoff_changed',
    data: { handoffId: 'h', state: 'pending' },
    createdAt: at,
  };
  const end: TimelineEvent = {
    ...start,
    id: 'end',
    actor,
    type: 'super_operation_changed',
    data: { operationId: 'op', state: 'succeeded', resultKind: null },
  };
  project.render(
    <>
      <SuperTimelineDetail event={start} events={[start, end]} fallback="Handoff changed" />
      <SuperTimelineDetail event={end} events={[start, end]} fallback="Operation changed" />
    </>,
  );
  expect(screen.getByText('Handoff changed')).toBeTruthy();
  expect(screen.getByText('Operation changed')).toBeTruthy();
  expect(await screen.findByText(/Queue maintenance/)).toBeTruthy();
  expect(screen.getByText(t('superMode.states.pending'))).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole('link', { name: t('superMode.handoff') }).getAttribute('href')).toBe(
      '/#timeline-start',
    ),
  );
  expect(
    screen.getByText(t('superMode.executed', { operation: t('superMode.commands.merge_order') })),
  ).toBeTruthy();
  expect(project.requests.every((request) => request.method === 'GET')).toBe(true);
});

it('preserves the timeline description for non-owners and on a failed detail read', async () => {
  const project = mockProject();
  project.context.isOwner = false;
  const event: TimelineEvent = {
    id: 'old',
    projectKey: 'AC',
    taskKey: 'AC-21',
    sessionId: null,
    actor: { kind: 'ai', handle: 'operator' },
    type: 'super_handoff_changed',
    data: { handoffId: 'missing', state: 'pending' },
    createdAt: new Date().toISOString(),
  };
  const fallback = t('timeline.events.super_handoff_changed', { state: t('superMode.states.pending') });
  const rendered = project.render(<SuperTimelineDetail event={event} events={[event]} fallback={fallback} />);
  expect(screen.getByText(fallback)).toBeTruthy();
  expect(project.requests).toHaveLength(0);
  rendered.unmount();
  project.context.isOwner = true;
  project.render(<SuperTimelineDetail event={event} events={[event]} fallback={fallback} />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText(fallback)).toBeTruthy();
});
