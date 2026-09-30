import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import type { Task, TaskDetail } from '@projectman/shared';
import { humanActor } from '../src/domain';
import {
  addHumanAndLogin,
  createAppHarness,
  createProject,
  inject,
  OWNER_LOGIN,
  setupOwner,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';

/** PM-68 over REST: the repository of a task can be set later, and a developer needs one. */
describe('task repository API', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    // The project has two repositories, so a task has to name the one it works in.
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: humanActor('owner'), author: OWNER_LOGIN },
      (draft) => {
        draft.project.repos.push({ name: 'api', path: 'api', github: 'acme/api', defaultBranch: 'main' });
        return 'Add a second repository';
      },
    );
    await h.app.projectman.domain.tasks.create('AR', { title: 'Acme webshop checkout' }, OWNER_ACTOR);
  });
  afterEach(async () => h.close());

  const call = (
    method: 'POST' | 'PATCH' | 'GET',
    url: string,
    payload?: object,
    auth: string | null = cookie,
  ) => inject(h.app, method, url, auth, payload);
  const patch = (payload: object, auth?: string | null) =>
    call('PATCH', routes.task('AR', 'AR-1'), payload, auth);
  const detail = async () => (await call('GET', routes.task('AR', 'AR-1'))).json<TaskDetail>();

  it('sets the repository, clears it with null and keeps it when it is not sent', async () => {
    const set = await patch({ repo: 'api' });
    expect(set.statusCode).toBe(200);
    expect(set.json<Task>().repo).toBe('api');

    const renamed = await patch({ title: 'Acme checkout' });
    expect(renamed.json<Task>()).toMatchObject({ title: 'Acme checkout', repo: 'api' });

    const cleared = await patch({ repo: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<Task>().repo).toBeNull();
  });

  it('records each change on the timeline with the repositories it went from and to', async () => {
    await patch({ repo: 'web' });
    await patch({ repo: 'api' });
    await patch({ repo: null });

    const changes = (await detail()).timeline.filter((event) => event.type === 'task_updated');

    expect(changes.map((event) => event.data)).toEqual([
      { fields: ['repo'], repo: 'web', previousRepo: null },
      { fields: ['repo'], repo: 'api', previousRepo: 'web' },
      { fields: ['repo'], repo: null, previousRepo: 'api' },
    ]);
    expect(changes[0]).toMatchObject({ actor: { kind: 'human', handle: 'owner' } });
  });

  it('refuses a repository the project does not have, and changes nothing', async () => {
    const unknown = await patch({ repo: 'mobile', title: 'Changed' });
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([400, 'unknown_repo']);
    const wrongType = await patch({ repo: 7 });
    expect([wrongType.statusCode, wrongType.json().error.code]).toEqual([400, 'invalid_request']);

    expect(h.app.projectman.domain.tasks.get('AR', 'AR-1')).toMatchObject({
      title: 'Acme webshop checkout',
      repo: null,
    });
  });

  it('refuses the change while a session of the task is running, and allows it once it has stopped', async () => {
    await patch({ repo: 'web' });
    const started = await call('POST', routes.startTask('AR', 'AR-1'), { assignee: 'dev-1' });
    expect(started.statusCode).toBe(200);
    const session = started.json<TaskDetail>().sessions[0]!;

    const live = await patch({ repo: 'api' });
    expect([live.statusCode, live.json().error.code, live.json().error.details]).toEqual([
      409,
      'task_session_live',
      { sessionId: session.id },
    ]);
    expect((await detail()).task.repo).toBe('web');

    expect((await call('POST', routes.stopSession('AR', session.id))).statusCode).toBeLessThan(300);
    const stopped = await patch({ repo: 'api' });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json<Task>().repo).toBe('api');
  });

  it('is for members who may edit tasks: developers may, viewers and clients may not', async () => {
    const developer = await addHumanAndLogin(h.app, { handle: 'dev-human', access: 'developer' });
    const viewer = await addHumanAndLogin(h.app, { handle: 'viewer-human', access: 'viewer' });
    const client = await addHumanAndLogin(h.app, { handle: 'client-human', access: 'client' });

    for (const [name, auth] of [
      ['viewer', viewer],
      ['client', client],
    ] as const) {
      const refused = await patch({ repo: 'api' }, auth);
      expect([refused.statusCode, refused.json().error.code], name).toEqual([403, 'insufficient_access']);
    }
    expect((await patch({ repo: null }, null)).statusCode).toBe(401);
    expect(h.app.projectman.domain.tasks.get('AR', 'AR-1').repo).toBeNull();

    const allowed = await patch({ repo: 'api' }, developer);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<Task>().repo).toBe('api');
  });

  it('refuses to start a developer on a task without a repository, then starts it once one is set', async () => {
    const refused = await call('POST', routes.startTask('AR', 'AR-1'), { assignee: 'dev-1' });
    expect([refused.statusCode, refused.json().error.code, refused.json().error.details]).toEqual([
      409,
      'repo_required',
      { taskKey: 'AR-1' },
    ]);
    expect(h.app.projectman.domain.tasks.get('AR', 'AR-1')).toMatchObject({
      assignee: null,
      stageId: 'backlog',
    });
    expect(h.runner.started).toEqual([]);

    await patch({ repo: 'api' });
    const started = await call('POST', routes.startTask('AR', 'AR-1'), { assignee: 'dev-1' });
    expect(started.statusCode).toBe(200);
    expect(started.json<TaskDetail>().sessions[0]).toMatchObject({
      member: 'dev-1',
      cwd: expect.stringMatching(/AR-1-api$/),
    });
  });

  it('serves the task as the board shows it, with the waiting reason of a developer without a repository', async () => {
    const domain = h.app.projectman.domain;
    domain.tasks.assign('AR', 'AR-1', 'dev-1', OWNER_ACTOR);
    await domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);

    const waiting = (await detail()).task.startWaiting;
    expect(waiting).toMatchObject({ reason: 'repo_required', member: 'dev-1' });
    const board = (await call('GET', routes.board('AR'))).json<{ tasks: Task[] }>();
    expect(board.tasks.find((task) => task.key === 'AR-1')?.startWaiting?.reason).toBe('repo_required');

    await patch({ repo: 'web' });
    expect((await detail()).task.startWaiting).toBeUndefined();
  });
});
