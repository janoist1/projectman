import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import type { ProjectConfig, Task, TaskDetail } from '@projectman/shared';
import { createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER, OWNER_ACTOR } from './helpers/domain-harness';

/**
 * PM-236 over HTTP: the Start button on a `ui` card without `design-ok` starts the designer and
 * answers with the card, which shows what its developer waits for.
 */
describe('POST start of a card that waits for a label an AI member sets', () => {
  let h: AppHarness;
  let cookie: string;

  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: OWNER_ACTOR, author: OWNER },
      (draft: ProjectConfig) => {
        draft.team.members.push({
          kind: 'ai',
          handle: 'des',
          displayName: 'Designer',
          role: 'designer',
          sponsor: 'owner',
        } as ProjectConfig['team']['members'][number]);
        draft.pipeline.labels.push(
          { id: 'ui', name: 'UI', setBy: 'anyone' },
          { id: 'design-ok', name: 'Design ok', setBy: { duties: ['ux_design'] } },
        );
        draft.pipeline.stages.find((stage) => stage.id === 'development')!.gate = {
          conditions: [{ type: 'has_label', label: 'design-ok', when: 'ui' }],
        };
        return 'Designer plan before development';
      },
    );
  });
  afterEach(() => h.close());

  it('starts the designer, assigns nobody and says what the card waits for', async () => {
    const created = (
      await inject(h.app, 'POST', routes.tasks('AR'), cookie, { title: 'Screen', labels: ['ui'] })
    ).json<Task>();

    const started = await inject(h.app, 'POST', routes.startTask('AR', created.key), cookie, {});

    expect(started.statusCode, started.body).toBe(200);
    expect(started.json<TaskDetail>().task).toMatchObject({
      stageId: 'backlog',
      assignee: null,
      startWaiting: { reason: 'label_missing', labels: ['design-ok'], member: 'des' },
    });
    expect(h.runner.started).toHaveLength(1);
    expect(
      h.app.projectman.domain.sessions.list('AR', { taskKey: created.key }).map((s) => s.member),
    ).toEqual(['des']);
  });
});
