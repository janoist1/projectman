import type { Session, WorkItemRef } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-184 (PM-176 rules 2 and 4): a member learns of the work that runs in parallel to theirs. A
 * changed description reaches the sessions working the card, and stops a reviewer whose review
 * measures the old one; a session that starts names the member's other running sessions on related
 * cards.
 *
 * Cards: AR-1 is the parent of AR-2 and AR-3 (siblings); AR-4 stands alone.
 */
const task = (taskKey: string): WorkItemRef => ({ type: 'task', taskKey });
const NOTICE = (by: string, key = 'AR-1') =>
  `[team message from ${by} about ${key}]\nThe description of ${key} changed (by ${by}). Stop and read it with get_task before you continue.`;

describe('a changed description reaches the sessions working the card', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
    const parent = await h.domain.tasks.create('AR', { title: 'Parent' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Child', parentKey: parent.key }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Sibling', parentKey: parent.key }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Alone' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  const run = async (member: string, workItem: WorkItemRef): Promise<Session> =>
    (await h.domain.sessions.ensureSession('AR', member, workItem)).session;
  // The notice that a member joined the card (PM-249) is not what these tests look at.
  const typedInto = (session: Session) =>
    h.runner.messages.filter(
      (m) => m.sessionId === session.id && !m.text.includes('Coordinate by send_message'),
    );
  const rewrite = async (by = 'dev-2', description = 'A new plan.') => {
    await h.domain.tasks.update('AR', 'AR-1', { description }, aiActor(by));
    await flush();
  };

  it('tells the developer working the card, in development, not to go on before reading it', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await flush();
    const developer = await run('dev-1', task('AR-1'));

    await rewrite('dev-2');

    expect(typedInto(developer).map((m) => m.text)).toEqual([NOTICE('dev-2')]);
    // Told, not stopped: the session goes on running.
    expect(h.runner.stopped).not.toContain(developer.id);
  });

  it('tells a human editor apart: the notice names them', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await flush();
    const developer = await run('dev-1', task('AR-1'));

    await h.domain.tasks.update('AR', 'AR-1', { description: 'The owner changed it.' }, OWNER_ACTOR);
    await flush();

    expect(typedInto(developer).map((m) => m.text)).toEqual([NOTICE('owner')]);
  });

  it('does not tell the member who rewrote it', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await flush();
    const developer = await run('dev-1', task('AR-1'));
    const other = await run('dev-2', task('AR-1'));

    await rewrite('dev-1');

    expect(typedInto(developer)).toEqual([]);
    expect(typedInto(other).map((m) => m.text)).toEqual([NOTICE('dev-1')]);
  });

  it('says nothing for a change that leaves the description as it is', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await flush();
    const developer = await run('dev-1', task('AR-1'));
    await rewrite('dev-2', 'The plan.');
    await rewrite('dev-2', 'The plan.');
    await h.domain.tasks.update('AR', 'AR-1', { title: 'Parent, renamed' }, aiActor('dev-2'));
    await flush();

    expect(typedInto(developer)).toHaveLength(1);
  });

  it('tells nobody in a queue stage', async () => {
    const session = await run('dev-1', task('AR-1'));

    await rewrite('dev-2');

    expect(typedInto(session)).toEqual([]);
  });

  it('only tells the sessions on the card, not the ones on a related card', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await flush();
    const child = await run('dev-1', task('AR-2'));

    await rewrite('dev-2');

    expect(typedInto(child)).toEqual([]);
  });

  it('stops the reviewer and resumes it at once with the notice as its first input', async () => {
    await h.domain.tasks.update('AR', 'AR-1', { assignee: 'dev-1' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await flush();
    const reviewer = h.domain.sessions.list('AR', { member: 'cr', taskKey: 'AR-1' })[0]!;
    expect(h.domain.sessions.isRunning(reviewer.id)).toBe(true);
    const developer = await run('dev-1', task('AR-1'));
    const started = h.runner.started.length;

    await rewrite('dev-2');

    expect(h.runner.stopped).toContain(reviewer.id);
    expect(h.runner.started).toHaveLength(started + 1);
    const restart = h.runner.lastStarted();
    expect(restart.sessionId).toBe(reviewer.id);
    expect(restart.initialMessage).toContain(NOTICE('dev-2'));
    expect(h.domain.sessions.isRunning(reviewer.id)).toBe(true);
    // The reviewer is not told twice, and the developer, who is not reviewing, is only told.
    expect(typedInto(reviewer)).toEqual([]);
    expect(typedInto(developer).map((m) => m.text)).toEqual([NOTICE('dev-2')]);
    expect(h.runner.stopped).not.toContain(developer.id);
  });

  it('does not restart the reviewer for a change it made itself', async () => {
    await h.domain.tasks.update('AR', 'AR-1', { assignee: 'dev-1' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await flush();
    const started = h.runner.started.length;

    await rewrite('cr');

    expect(h.runner.started).toHaveLength(started);
    expect(h.runner.stopped).toEqual([]);
  });

  it('does not restart a reviewer whose card is no longer in a review stage', async () => {
    await h.domain.tasks.update('AR', 'AR-1', { assignee: 'dev-1' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await flush();
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await flush();
    const started = h.runner.started.length;
    const stopped = h.runner.stopped.length;

    await rewrite('dev-2');

    expect(h.runner.stopped).toHaveLength(stopped);
    expect(h.runner.started).toHaveLength(started);
  });
});

describe("a new session names the member's other running sessions on related cards", () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
    const parent = await h.domain.tasks.create('AR', { title: 'Parent' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Child', parentKey: parent.key }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Sibling', parentKey: parent.key }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Alone' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  const start = async (member: string, taskKey: string) => {
    await h.domain.sessions.ensureSession('AR', member, task(taskKey));
    return h.contextBuilder.inputs.at(-1)!.relatedSessions;
  };

  it('names the parent card from a subtask, and the subtask from the parent card', async () => {
    await start('dev-1', 'AR-1');
    expect(await start('dev-1', 'AR-2')).toEqual([
      { taskKey: 'AR-1', title: 'Parent', relation: 'parent', state: 'starting' },
    ]);

    await h.domain.sessions.stop('AR', h.domain.sessions.list('AR', { taskKey: 'AR-1' })[0]!.id);
    expect(await start('dev-1', 'AR-1')).toEqual([
      { taskKey: 'AR-2', title: 'Child', relation: 'subtask', state: 'starting' },
    ]);
  });

  it('names nothing for a sibling, another member, a card of its own, or a session that ended', async () => {
    await start('dev-1', 'AR-3');
    expect(await start('dev-1', 'AR-2')).toBeUndefined();
    expect(await start('dev-2', 'AR-1')).toBeUndefined();
    expect(await start('dev-1', 'AR-4')).toBeUndefined();

    const first = h.domain.sessions.list('AR', { member: 'dev-1', taskKey: 'AR-3' })[0]!;
    await h.domain.sessions.stop('AR', first.id);
    const second = h.domain.sessions.list('AR', { member: 'dev-1', taskKey: 'AR-2' })[0]!;
    await h.domain.sessions.stop('AR', second.id);
    expect(await start('dev-1', 'AR-1')).toBeUndefined();
  });

  it('follows the prerequisite links in both directions', async () => {
    h.domain.tasks.addLink('AR', 'AR-4', { kind: 'prerequisite', ref: 'AR-3' }, OWNER_ACTOR);
    await start('dev-1', 'AR-3');
    // AR-4 needs AR-3 first: from AR-4, AR-3 is a prerequisite.
    expect(await start('dev-1', 'AR-4')).toEqual([
      { taskKey: 'AR-3', title: 'Sibling', relation: 'prerequisite', state: 'starting' },
    ]);
    await h.domain.sessions.stop('AR', h.domain.sessions.list('AR', { taskKey: 'AR-3' })[0]!.id);
    // And from AR-3, AR-4 has it as its prerequisite.
    expect(await start('dev-1', 'AR-3')).toEqual([
      { taskKey: 'AR-4', title: 'Alone', relation: 'prerequisite_of', state: 'starting' },
    ]);
  });

  it('names a card once, by its family relation first', async () => {
    h.domain.tasks.addLink('AR', 'AR-2', { kind: 'prerequisite', ref: 'AR-1' }, OWNER_ACTOR);
    await start('dev-1', 'AR-1');
    expect(await start('dev-1', 'AR-2')).toEqual([
      { taskKey: 'AR-1', title: 'Parent', relation: 'parent', state: 'starting' },
    ]);
  });
});
