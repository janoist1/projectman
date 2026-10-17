import { screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { SuperHandoff, TimelineEvent } from '@projectman/shared';
import { setFetchImplementation } from '../api/client';
import { t } from '../i18n/t';
import { mockProject } from '../test/mockProject';
import { SuperTimelineDetail } from './SuperTimelineDetail';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

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
      <SuperTimelineDetail event={start} events={[start, end]} />
      <SuperTimelineDetail event={end} events={[start, end]} />
    </>,
  );
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
