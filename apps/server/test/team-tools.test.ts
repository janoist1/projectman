import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { questionPayloadOf } from '@projectman/shared';
import type { TaskStatus } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import { TEAM_TOOLS } from '../src/mcp';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { flush, pullRequest } from './helpers/fakes';

const toolError = (promise: Promise<unknown>) => rejection(promise, TeamToolError);

describe('team tools', () => {
  let h: DomainHarness;
  let dev: ToolContext;
  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    dev = { sessionId: started.session!.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
  });
  afterEach(() => h.cleanup());

  it('send_message delivers to the recipient session for the task without waiting for it', async () => {
    const result = await h.domain.teamTools.sendMessage(dev, {
      to: ['cr', 'owner', 'dev-1'],
      text: 'Ready for review',
    });
    expect(result.deliveredTo).toEqual(['cr', 'owner']);
    await flush();

    const crSession = h.domain.sessions.list('AR', { member: 'cr', taskKey: 'AR-1' })[0]!;
    expect(crSession).toBeDefined();
    // The recipient's new session takes the whole message in its first input, behind its brief.
    expect(h.runner.started.find((spec) => spec.sessionId === crSession.id)?.initialMessage).toContain(
      '[team message from dev-1 about AR-1]\nReady for review',
    );
    expect(h.runner.messages.filter((m) => m.sessionId === crSession.id)).toEqual([]);
    const stored = h.repos.messages.get(result.messageId)!;
    expect(stored).toMatchObject({ from: 'dev-1', to: ['cr', 'owner'], taskKey: 'AR-1' });
    expect(stored.deliveredAt).not.toBeNull();

    expect((await toolError(h.domain.teamTools.sendMessage(dev, { to: ['nobody'], text: 'hi' }))).code).toBe(
      'not_found',
    );
    expect((await toolError(h.domain.teamTools.sendMessage(dev, { to: ['dev-1'], text: 'me' }))).code).toBe(
      'invalid',
    );
  });

  describe('what send_message says per recipient (PM-144)', () => {
    const task = { type: 'task', taskKey: 'AR-1' } as const;
    const send = (to: string[]) => h.domain.teamTools.sendMessage(dev, { to, text: 'Please take a look' });

    it('says typed_now for an idle session, after_turn for one in a turn, wake without a session, inbox for a person', async () => {
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-2', task);
      h.runner.setState(session.id, 'idle');
      expect((await send(['dev-2', 'owner', 'cr'])).recipients).toEqual([
        { handle: 'dev-2', delivery: 'typed_now' },
        { handle: 'owner', delivery: 'inbox' },
        { handle: 'cr', delivery: 'wake' },
      ]);
      await flush();
      for (const state of ['working', 'waiting_permission'] as const) {
        h.runner.setState(session.id, state);
        expect((await send(['dev-2'])).recipients).toEqual([{ handle: 'dev-2', delivery: 'after_turn' }]);
      }
    });

    it('says held/restart for a session that waits for its restart into a new permission mode', async () => {
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-2', task);
      h.runner.setState(session.id, 'working');
      h.repos.sessions.update(session.id, { permissionRestartPending: true });
      expect((await send(['dev-2'])).recipients).toEqual([
        { handle: 'dev-2', delivery: 'held', hold: 'restart' },
      ]);
    });

    it('says held/pause while the team is paused', async () => {
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-2', task);
      h.runner.setState(session.id, 'idle');
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
      expect((await send(['dev-2'])).recipients).toEqual([
        { handle: 'dev-2', delivery: 'held', hold: 'pause' },
      ]);
    });

    it("lists the caller's messages not typed in yet in get_task, until they are typed in", async () => {
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-2', task);
      // The fake runner types at once; a session that waits for its restart keeps the message.
      h.repos.sessions.update(session.id, { permissionRestartPending: true });
      const { messageId } = await send(['dev-2', 'owner']);
      expect((await h.domain.teamTools.getTask(dev, { taskKey: 'AR-1' })).pendingSentMessages).toEqual([
        { messageId, handles: ['dev-2'] },
      ]);

      h.domain.messages.markRecipientDelivered(messageId, 'dev-2');
      expect((await h.domain.teamTools.getTask(dev, { taskKey: 'AR-1' })).pendingSentMessages).toEqual([]);
    });
  });

  it('update_task adds labels before moving, so one call can pass the gate', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    const reviewer: ToolContext = { ...dev, member: 'cr', sessionId: 'ses_cr' };
    const err = await toolError(
      h.domain.teamTools.updateTask(reviewer, {
        taskKey: 'AR-1',
        addLabels: ['code-review-ok'],
        note: 'Looks good',
        stageId: 'merge',
      }),
    );
    // The review label is on; the merge gate still needs the owner's approval, which was requested.
    expect(err.code).toBe('gate_blocked');
    expect(err.message).toContain('needs a human approval');
    const task = h.domain.tasks.get('AR', 'AR-1');
    expect(task.labels).toContain('code-review-ok');
    expect(task.status).toBe('waiting');
    const timeline = h.domain.timeline.list('AR', { taskKey: 'AR-1' });
    expect(timeline.find((e) => e.type === 'task_note')).toMatchObject({
      actor: { kind: 'ai', handle: 'cr' },
      data: { text: 'Looks good' },
    });

    const unknownStage = await toolError(
      h.domain.teamTools.updateTask(reviewer, { taskKey: 'AR-1', stageId: 'shipped', note: 'not recorded' }),
    );
    expect(unknownStage.message).toBe(
      'Unknown stage "shipped". Stages in pipeline order: backlog, development, code_review, merge, release, done.',
    );
    const notes = h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((e) => e.type === 'task_note');
    expect(notes.map((e) => e.data.text)).toEqual(['Looks good']);

    const blocked = await toolError(
      h.domain.teamTools.updateTask(reviewer, { taskKey: 'AR-1', stageId: 'release' }),
    );
    expect(blocked.code).toBe('gate_blocked');
    expect(blocked.message).toContain('the label "pr-merged" is missing');
  });

  it('update_task names who may set the label a blocked move is missing', async () => {
    const blocked = await toolError(
      h.domain.teamTools.updateTask(dev, { taskKey: 'AR-1', stageId: 'merge' }),
    );
    expect(blocked.code).toBe('gate_blocked');
    expect(blocked.message).toContain(
      'the label "code-review-ok" is missing (required to enter stage "merge"; only cr may set it)',
    );
  });

  it('ask_human creates a question and delivers the answer back to the asking session', async () => {
    const { inboxItemId } = await h.domain.teamTools.askHuman(dev, {
      question: 'Which font should the login page use?',
      options: ['Inter', 'Roboto'],
    });
    const item = h.domain.inbox.get('AR', inboxItemId);
    expect(item).toMatchObject({ kind: 'question', assignees: ['owner'], source: 'dev-1', taskKey: 'AR-1' });
    expect(item.options.map((o) => o.id)).toEqual(['option_1', 'option_2', 'answer']);

    await h.domain.inbox.resolve(
      'AR',
      inboxItemId,
      { optionId: 'option_2', note: 'and bold titles' },
      {
        handle: 'owner',
        access: 'owner',
      },
    );
    await flush();
    const delivered = h.runner.messages.filter((m) => m.sessionId === dev.sessionId).pop()!;
    expect(delivered.text).toBe(
      '[team message from owner about AR-1]\nAnswer to your question "Which font should the login page use?":\n\nRoboto\n\nand bold titles',
    );
  });

  it('ask_human stores the consequences, the recommendation, its reason and the details', async () => {
    const details = 'The `session` cookie is `SameSite=Lax`; a toast needs a new provider.';
    const question = 'Should a wrong email show its error under the field or as a pop-up?';
    const { inboxItemId } = await h.domain.teamTools.askHuman(dev, {
      question: `  ${question} `,
      options: [
        { label: 'Under the field', consequence: 'The message stays until the address is fixed.' },
        { label: ' Pop-up ', consequence: ' It disappears after a few seconds, so it can be missed. ' },
        'Nowhere',
      ],
      recommended: 'Pop-up',
      recommendationReason: ' It is easier to read on a phone. ',
      details: `  ${details}\n`,
    });

    // Read back from the database, as the inbox API serves it.
    const item = h.domain.inbox.get('AR', inboxItemId);
    expect(item).toMatchObject({ kind: 'question', title: question, source: 'dev-1', taskKey: 'AR-1' });
    expect(item.options).toEqual([
      {
        id: 'option_1',
        label: 'Under the field',
        style: 'secondary',
        consequence: 'The message stays until the address is fixed.',
      },
      {
        id: 'option_2',
        label: 'Pop-up',
        style: 'primary',
        consequence: 'It disappears after a few seconds, so it can be missed.',
      },
      { id: 'option_3', label: 'Nowhere', style: 'secondary' },
      { id: 'answer', label: 'answer', style: 'secondary' },
    ]);
    expect(item.payload).toEqual({
      question,
      options: ['Under the field', 'Pop-up', 'Nowhere'],
      recommended: 'option_2',
      recommendationReason: 'It is easier to read on a phone.',
      details,
    });
    expect(questionPayloadOf(item)).toEqual(item.payload);

    // The timeline and the answer to the asking session work as for any question.
    expect(
      h.domain.timeline.list('AR', { taskKey: 'AR-1' }).find((e) => e.type === 'question_asked'),
    ).toMatchObject({ data: { inboxItemId, question } });
    await h.domain.inbox.resolve(
      'AR',
      inboxItemId,
      { optionId: 'option_2' },
      { handle: 'owner', access: 'owner' },
    );
    await flush();
    const delivered = h.runner.messages.filter((m) => m.sessionId === dev.sessionId).pop()!;
    expect(delivered.text).toBe(
      `[team message from owner about AR-1]\nAnswer to your question "${question}":\n\nPop-up`,
    );
  });

  it('ask_human without the plain-language fields stores the question as it always did', async () => {
    const { inboxItemId } = await h.domain.teamTools.askHuman(dev, {
      question: 'Which font should the login page use?',
      options: ['Inter', 'Roboto', ' Inter '],
    });

    const item = h.domain.inbox.get('AR', inboxItemId);
    expect(item.payload).toEqual({
      question: 'Which font should the login page use?',
      options: ['Inter', 'Roboto'],
    });
    // The first option is the primary button when nothing is recommended.
    expect(item.options).toEqual([
      { id: 'option_1', label: 'Inter', style: 'primary' },
      { id: 'option_2', label: 'Roboto', style: 'secondary' },
      { id: 'answer', label: 'answer', style: 'secondary' },
    ]);
    expect(questionPayloadOf(item)).toEqual({
      question: 'Which font should the login page use?',
      options: ['Inter', 'Roboto'],
    });
  });

  it('ask_human refuses a recommendation that is not one of the options and asks nothing', async () => {
    const question = 'Which font should the login page use?';
    const unknown = await toolError(
      h.domain.teamTools.askHuman(dev, { question, options: ['Inter', 'Roboto'], recommended: 'Arial' }),
    );
    const noOptions = await toolError(h.domain.teamTools.askHuman(dev, { question, recommended: 'Inter' }));
    const reasonOnly = await toolError(
      h.domain.teamTools.askHuman(dev, { question, recommendationReason: 'It is clearer.' }),
    );

    expect(unknown.code).toBe('invalid');
    expect(unknown.message).toBe('The recommended option "Arial" is not one of the options.');
    expect(noOptions.code).toBe('invalid');
    expect(reasonOnly.code).toBe('invalid');
    expect(reasonOnly.message).toBe('A recommendation reason needs a recommended option.');
    expect(h.domain.inbox.list('AR', { kind: 'question' })).toEqual([]);
  });

  it('link_pull_request links and watches the PR; save_memory appends to the member memory', async () => {
    h.github.prs.set('acme/web#7', pullRequest());
    const { task } = await h.domain.teamTools.linkPullRequest(dev, {
      taskKey: 'AR-1',
      repo: 'acme/web',
      number: 7,
    });
    expect(task.links).toEqual([
      // The developer's session started in the worktree of the project's only repo.
      { kind: 'branch', ref: 'task/AR-1', repo: 'acme/web' },
      {
        kind: 'pull_request',
        ref: '7',
        repo: 'acme/web',
        title: 'Add login page',
        state: 'open',
        author: 'dev-1',
      },
    ]);
    expect(h.github.isWatched('acme/web', 7)).toBe(true);

    await h.domain.teamTools.saveMemory(dev, { note: 'Run npm test before pushing' });
    expect(await h.memory.read('AR', 'dev-1')).toContain('Run npm test before pushing');
  });

  it('list_members and get_task answer with the roster and the task detail', async () => {
    const members = await h.domain.teamTools.listMembers(dev);
    expect(members.map((m) => m.handle)).toEqual(['owner', 'dev-1', 'dev-2', 'cr']);
    const detail = await h.domain.teamTools.getTask(dev, { taskKey: 'AR-1' });
    expect(detail.task.key).toBe('AR-1');
    expect(detail.sessions).toHaveLength(1);
    expect((await toolError(h.domain.teamTools.getTask(dev, { taskKey: 'AR-99' }))).code).toBe('not_found');
  });

  it('get_task shows a long note cut, and event_id returns the whole text (PM-191)', async () => {
    const reviewer: ToolContext = { ...dev, member: 'cr', sessionId: 'ses_cr' };
    const note = `Measured values:\n${'0123456789'.repeat(200)}`;
    await h.domain.teamTools.updateTask(reviewer, { taskKey: 'AR-1', note });

    const getTask = TEAM_TOOLS.find((t) => t.name === 'get_task')!;
    const read = (args: Record<string, unknown>) =>
      getTask.run({ ctx: dev, args: { task_key: 'AR-1', ...args }, handler: h.domain.teamTools });
    const line = (await read({})).split('\n').find((l) => l.includes('note: Measured'))!;
    const id = /event_id (\S+)\)/.exec(line)![1]!;
    expect(line).toContain('(cut, 2017 chars; read it whole: get_task task_key AR-1, event_id ');
    expect(line).not.toContain(note.slice(0, 400));

    const whole = await read({ event_id: id });
    expect(whole).toContain(`shown whole:\n${note}`);

    expect((await toolError(read({ event_id: 'evt_nope' }))).code).toBe('not_found');
  });

  it("get_task names the caller's messages that are not delivered yet, and only those", async () => {
    const sent = (id: string, to: string, deliveredAt: string | null) =>
      h.repos.messages.insert({
        id,
        projectKey: 'AR',
        from: 'owner',
        to: [to],
        taskKey: 'AR-1',
        body: 'Please look at this.',
        createdAt: '2026-09-30T10:00:00.000Z',
        deliveredAt,
      });
    sent('msg_waiting', 'dev-1', null);
    sent('msg_typed', 'dev-1', '2026-09-30T10:00:01.000Z');
    sent('msg_other', 'dev-2', null);
    const detail = await h.domain.teamTools.getTask(dev, { taskKey: 'AR-1' });
    expect(detail.undeliveredMessageIds).toEqual(['msg_waiting']);
  });

  it('list_tasks filters the board, sorts before limiting and uses get_task visibility', async () => {
    h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, { updatedAt: '2026-09-29T09:00:00.000Z' });
    const statuses: TaskStatus[] = ['active', 'waiting', 'blocked', 'done', 'cancelled'];
    for (const [index, status] of statuses.entries()) {
      const task = await h.domain.tasks.create(
        'AR',
        { title: `Board task ${index}`, visibility: index % 2 ? 'shared' : 'internal' },
        OWNER_ACTOR,
      );
      h.repos.tasks.update(task.id, {
        status,
        stageId: 'backlog',
        assignee: 'dev-2',
        labels: ['board'],
        updatedAt: `2026-09-29T10:0${index}:00.000Z`,
      });
    }
    const result = await h.domain.teamTools.listTasks(dev, {});
    expect(result.slice(0, 3).map((task) => task.status)).toEqual(['blocked', 'waiting', 'active']);
    expect(result).toHaveLength(4);
    expect(Object.keys(result[0]!).sort()).toEqual(
      ['key', 'title', 'stageId', 'status', 'assignee', 'labels', 'updatedAt'].sort(),
    );
    expect(await h.domain.teamTools.listTasks(dev, { assignee: 'me' })).toMatchObject([{ key: 'AR-1' }]);
    expect(
      await h.domain.teamTools.listTasks(dev, { stage: 'backlog', assignee: 'dev-2', limit: 1 }),
    ).toMatchObject([{ key: 'AR-4' }]);
    for (const status of statuses) {
      const matches = await h.domain.teamTools.listTasks(dev, { status, assignee: 'dev-2' });
      expect(matches).toHaveLength(1);
      expect(matches[0]!.status).toBe(status);
      expect((await h.domain.teamTools.getTask(dev, { taskKey: matches[0]!.key })).task.key).toBe(
        matches[0]!.key,
      );
    }
    expect(await h.domain.teamTools.listTasks(dev, { stage: 'missing' })).toEqual([]);
    expect((await toolError(h.domain.teamTools.listTasks({ ...dev, member: 'owner' }, {}))).code).toBe(
      'forbidden',
    );
    expect((await toolError(h.domain.teamTools.listTasks(dev, { limit: 201 }))).code).toBe('invalid');
  });

  it('list_tasks defaults to 50 results and permits up to 200', async () => {
    for (let index = 0; index < 201; index += 1) {
      await h.domain.tasks.create('AR', { title: `Board task ${index}` }, OWNER_ACTOR);
    }
    expect(await h.domain.teamTools.listTasks(dev, {})).toHaveLength(50);
    expect(await h.domain.teamTools.listTasks(dev, { limit: 200 })).toHaveLength(200);
  });

  it('list_tasks includes named priority only on cards where it was set', async () => {
    const other = await h.domain.tasks.create('AR', { title: 'No priority' }, OWNER_ACTOR);
    await h.domain.tasks.update('AR', 'AR-1', { priority: 'high' }, OWNER_ACTOR);
    const result = await h.domain.teamTools.listTasks(dev, {});
    expect(result.find((task) => task.key === 'AR-1')).toMatchObject({ priority: 'high' });
    expect(result.find((task) => task.key === other.key)).not.toHaveProperty('priority');
  });

  it('create_task puts an unassigned task into the first stage, attributed to the member', async () => {
    const { task } = await h.domain.teamTools.createTask(dev, {
      title: '  Signup form accepts an empty email ',
      description: 'Steps: open /signup, submit without an email.',
      labels: ['bug', ' bug', ''],
      visibility: 'shared',
    });
    expect(task).toMatchObject({
      key: 'AR-2',
      title: 'Signup form accepts an empty email',
      description: 'Steps: open /signup, submit without an email.',
      stageId: 'backlog',
      status: 'active',
      assignee: null,
      priority: null,
      labels: ['bug'],
      visibility: 'shared',
      createdBy: 'dev-1',
    });
    const created = h.domain.timeline.list('AR', { taskKey: 'AR-2' });
    expect(created).toMatchObject([
      {
        type: 'task_created',
        actor: { kind: 'ai', handle: 'dev-1' },
        sessionId: dev.sessionId,
        data: { title: 'Signup form accepts an empty email' },
      },
    ]);
    const blank = await toolError(h.domain.teamTools.createTask(dev, { title: '   ' }));
    expect(blank.code).toBe('invalid');
  });

  it('update_task rewrites the title and the description before the stage move', async () => {
    const reviewer: ToolContext = { ...dev, member: 'cr', sessionId: 'ses_cr' };
    const { task } = await h.domain.teamTools.updateTask(reviewer, {
      taskKey: 'AR-1',
      title: 'Login page with remember me',
      description: '## Acceptance criteria\n1. The session survives a browser restart.',
      note: 'Specified the acceptance criteria',
      stageId: 'code_review',
    });
    expect(task).toMatchObject({
      title: 'Login page with remember me',
      description: '## Acceptance criteria\n1. The session survives a browser restart.',
      stageId: 'code_review',
    });
    const events = h.domain.timeline
      .list('AR', { taskKey: 'AR-1' })
      .map((e) => [e.type, e.data, e.sessionId]);
    expect(events.slice(-3)).toEqual([
      ['task_updated', { fields: ['title', 'description'] }, 'ses_cr'],
      ['task_note', { text: 'Specified the acceptance criteria', mentions: [] }, 'ses_cr'],
      ['task_stage_changed', { from: 'development', to: 'code_review' }, null],
    ]);
    expect(
      (await toolError(h.domain.teamTools.updateTask(reviewer, { taskKey: 'AR-1', title: ' ' }))).code,
    ).toBe('invalid');
    expect(
      (await toolError(h.domain.teamTools.updateTask(reviewer, { taskKey: 'AR-1', description: '\n' }))).code,
    ).toBe('invalid');
  });

  it('refuses callers that are not AI members of the project', async () => {
    const human: ToolContext = { ...dev, member: 'owner' };
    expect((await toolError(h.domain.teamTools.listMembers(human))).code).toBe('forbidden');
  });
});
