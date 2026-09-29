import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush, pullRequest } from './helpers/fakes';

async function toolError(promise: Promise<unknown>): Promise<TeamToolError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TeamToolError);
  return err as TeamToolError;
}

describe('team tools', () => {
  let h: DomainHarness;
  let dev: ToolContext;
  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const started = await h.domain.scheduler.startTask('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
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
    expect(h.runner.messages).toContainEqual({
      sessionId: crSession.id,
      text: '[team message from dev-1 about AR-1]\nReady for review',
    });
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

  it('update_task records the check before moving, so one call can pass the gate', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    const reviewer: ToolContext = { ...dev, member: 'cr', sessionId: 'ses_cr' };
    const err = await toolError(
      h.domain.teamTools.updateTask(reviewer, {
        taskKey: 'AR-1',
        check: { name: 'code_review', state: 'passed' },
        note: 'Looks good',
        stageId: 'merge',
      }),
    );
    // The check passed; the merge gate still needs the owner's approval, which was requested.
    expect(err.code).toBe('gate_blocked');
    expect(err.message).toContain('needs a human approval');
    const task = h.domain.tasks.get('AR', 'AR-1');
    expect(task.checks.code_review).toBe('passed');
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
    expect(blocked.message).toContain('pull request is not merged');
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

  it('link_pull_request links and watches the PR; save_memory appends to the member memory', async () => {
    h.github.prs.set('acme/web#7', pullRequest());
    const { task } = await h.domain.teamTools.linkPullRequest(dev, {
      taskKey: 'AR-1',
      repo: 'acme/web',
      number: 7,
    });
    expect(task.links).toEqual([
      { kind: 'pull_request', ref: '7', repo: 'acme/web', title: 'Add login page', state: 'open' },
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

  it('refuses callers that are not AI members of the project', async () => {
    const human: ToolContext = { ...dev, member: 'owner' };
    expect((await toolError(h.domain.teamTools.listMembers(human))).code).toBe('forbidden');
  });
});
