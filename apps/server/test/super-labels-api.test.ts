import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreatedIntegratorAccessKey, routes } from '@projectman/shared';
import type { Actor, Task } from '@projectman/shared';
import type { ProjectTemplate } from '@projectman/templates';
import { createAppHarness, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { testTemplate } from './helpers/test-template';

/**
 * The test template with a label only the owner holds, as `refine` is in a real project. `refine` itself is
 * not used: the refinement flow takes it off at once when nobody works the card out.
 */
const ownerLabelTemplate: ProjectTemplate = {
  ...testTemplate,
  id: 'owner-label',
  build: (input) => {
    const config = testTemplate.build(input);
    config.pipeline.labels.push({
      id: 'owner-tag',
      name: 'Owner tag',
      setBy: { members: [input.owner.handle] },
    });
    return config;
  },
};

describe('labels in super mode on the key owner’s authority (PM-831)', () => {
  let app: AppHarness;
  let cookie: string;
  let secret: string;
  let taskKey: string;
  let keyPrefix: string;
  beforeEach(async () => {
    app = await createAppHarness({ extraTemplates: [ownerLabelTemplate] });
    cookie = await setupOwner(app.app);
    const created = await app.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: {
        key: 'AR',
        name: 'acme',
        workspacePath: app.workspace,
        templateId: 'owner-label',
        repos: [{ name: 'web', path: '.', github: 'acme/web' }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    secret = await keySecret('super');
    taskKey = (await inject(app.app, 'POST', routes.tasks('AR'), cookie, { title: 'A card' })).json<Task>()
      .key;
  });
  afterEach(async () => app?.close());

  async function keySecret(mode: 'super' | 'read'): Promise<string> {
    const response = await app.app.inject({
      method: 'POST',
      url: routes.integratorKeys(),
      headers: { cookie },
      payload: { mode },
    });
    const key = CreatedIntegratorAccessKey.parse(response.json());
    if (mode === 'super') keyPrefix = key.key.prefix;
    return key.secret;
  }

  const bearer = (token = secret) => ({ authorization: `Bearer ${token}` });
  const labelsOf = () => app.app.projectman.domain.tasks.get('AR', taskKey).labels;
  const change = (
    payload: { add?: string[]; remove?: string[] },
    headers: Record<string, string> = bearer(),
  ) => app.app.inject({ method: 'POST', url: routes.taskLabels('AR', taskKey), headers, payload });
  const labelEvents = () =>
    app.app.projectman.domain.timeline
      .list('AR', { taskKey })
      .filter((event) => event.type === 'task_labels_changed');

  it('adds and removes a label the owner holds; the actor is the Operator with the key’s origin', async () => {
    const added = await change({ add: ['owner-tag'] });
    expect(added.statusCode, added.body).toBe(200);
    expect(labelsOf()).toContain('owner-tag');
    const removed = await change({ remove: ['owner-tag'] });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(labelsOf()).not.toContain('owner-tag');

    const events = labelEvents();
    expect(events).toHaveLength(2);
    for (const event of events)
      expect(event.actor).toMatchObject({
        kind: 'ai',
        handle: 'operator',
        via: 'integrator',
        operatorMode: 'super',
        credential: { prefix: keyPrefix },
      });
  });

  it('keeps the owner-reserved labels refused: approvals, four-eyes labels and human-only labels', async () => {
    for (const label of ['merge-ok', 'code-review-ok', 'release-ok']) {
      const response = await change({ add: [label] });
      expect(response.statusCode, label).toBe(403);
      expect(response.json().error.code, label).toBe('owner_approval_required');
    }
    expect(labelsOf()).toEqual([]);

    // The owner gives the approval with their own login; the key cannot take it off, it is human-only.
    expect((await change({ add: ['merge-ok'] }, { cookie })).statusCode).toBe(200);
    const removal = await change({ remove: ['merge-ok'] });
    expect(removal.statusCode).toBe(403);
    expect(removal.json().error).toMatchObject({
      code: 'label_not_allowed',
      details: { reason: 'humans_only' },
    });
    expect(labelsOf()).toEqual(['merge-ok']);
  });

  it('does not lend the owner’s holding to a label the owner does not hold', async () => {
    expect((await change({ add: ['code-review-ok'] })).statusCode).toBe(403);
    // The owner holds neither the label nor the code review duty.
    expect(labelsOf()).not.toContain('code-review-ok');
  });

  it('records the owner’s own login as the owner, with no super origin', async () => {
    expect((await change({ add: ['owner-tag'] }, { cookie })).statusCode).toBe(200);
    expect(labelEvents().at(-1)!.actor).toEqual({ kind: 'human', handle: 'owner' } satisfies Actor);
  });

  it('refuses a read key, and the base Operator stays without the owner’s labels', async () => {
    const read = await change({ add: ['owner-tag'] }, bearer(await keySecret('read')));
    expect(read.statusCode).toBe(403);
    expect(labelsOf()).toEqual([]);

    // The base Operator (MCP) has no key owner behind it: the same label stays `not_holder` (AC4).
    await expect(
      app.app.projectman.domain.tasks.changeLabels(
        'AR',
        taskKey,
        { add: ['owner-tag'] },
        {
          kind: 'ai',
          handle: 'operator',
        },
      ),
    ).rejects.toMatchObject({ code: 'label_not_allowed', details: { reason: 'not_holder' } });
  });
});
