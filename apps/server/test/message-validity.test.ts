import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { TEAM_TOOLS } from '../src/mcp';

describe('versioned message wake-up', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  it('requires an explicit message kind at the MCP boundary', () => {
    const schema = TEAM_TOOLS.find((tool) => tool.name === 'send_message')!.inputSchema;
    expect(schema.safeParse({ to: ['cr'], text: 'Review' }).success).toBe(false);
    expect(schema.safeParse({ to: ['cr'], text: 'Review', kind: 'action' }).success).toBe(true);
    expect(schema.safeParse({ to: ['cr'], text: 'Done', kind: 'info' }).success).toBe(true);
  });

  it('batches three AI messages only after a busy session reaches idle', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const reviewer = (await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' }))
      .session;
    h.runner.setState(reviewer.id, 'working');
    for (const text of ['First', 'Second', 'Third'])
      await h.domain.messaging.send('AR', 'dev-1', { to: ['cr'], text, taskKey: 'AR-1' });
    await flush();
    expect(h.runner.messages).toHaveLength(0);
    h.runner.setState(reviewer.id, 'idle');
    await vi.waitFor(() => expect(h.runner.messages).toHaveLength(1));
    const text = h.runner.messages[0]!.text;
    expect(text).toContain('[team messages about AR-1]');
    expect(text).toContain('3 messages waited for you. 2 are out of date');
    expect(text.indexOf('First')).toBeLessThan(text.indexOf('Second'));
    expect(text.indexOf('Second')).toBeLessThan(text.indexOf('Third'));
    expect(h.repos.messages.pending('AR', 'cr')).toHaveLength(0);
  });

  it('keeps messages arriving during typing for the next input without duplicate delivery', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const reviewer = (await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' }))
      .session;
    h.runner.setState(reviewer.id, 'working');
    await h.domain.messaging.send(
      'AR',
      'dev-1',
      {
        to: ['cr'],
        text: 'First snapshot',
        taskKey: 'AR-1',
      },
      { kind: 'info' },
    );
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = h.runner.sendUserMessage.bind(h.runner);
    const typing = vi.spyOn(h.runner, 'sendUserMessage').mockImplementationOnce(async (id, text) => {
      await barrier;
      await original(id, text);
    });
    h.runner.setState(reviewer.id, 'idle');
    await vi.waitFor(() => expect(typing).toHaveBeenCalledTimes(1));
    await h.domain.messaging.send(
      'AR',
      'dev-2',
      {
        to: ['cr'],
        text: 'Arrived during typing',
        taskKey: 'AR-1',
      },
      { kind: 'info' },
    );
    await flush();
    expect(typing).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(h.repos.messages.pending('AR', 'cr')).toHaveLength(1));
    expect(h.runner.messages[0]!.text).not.toContain('Arrived during typing');
    h.runner.setState(reviewer.id, 'working');
    h.runner.setState(reviewer.id, 'idle');
    await vi.waitFor(() => expect(h.repos.messages.pending('AR', 'cr')).toHaveLength(0));
    expect(typing).toHaveBeenCalledTimes(2);
    expect(h.runner.messages[1]!.text).toContain('Arrived during typing');
    expect(h.runner.messages[1]!.text).not.toContain('First snapshot');
  });

  it('retains receipts after failed typing and retries the batch once at the next idle', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const reviewer = (await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' }))
      .session;
    h.runner.setState(reviewer.id, 'working');
    await h.domain.messaging.send('AR', 'dev-1', { to: ['cr'], text: 'Keep this request', taskKey: 'AR-1' });
    const typing = vi.spyOn(h.runner, 'sendUserMessage').mockRejectedValueOnce(new Error('Typing failed'));
    h.runner.setState(reviewer.id, 'idle');
    await vi.waitFor(() => expect(typing).toHaveBeenCalledTimes(1));
    await flush();
    expect(h.repos.messages.pending('AR', 'cr')).toHaveLength(1);
    h.runner.setState(reviewer.id, 'working');
    h.runner.setState(reviewer.id, 'idle');
    await vi.waitFor(() => expect(h.repos.messages.pending('AR', 'cr')).toHaveLength(0));
    expect(typing).toHaveBeenCalledTimes(2);
    expect(h.runner.messages).toHaveLength(1);
    expect(h.runner.messages[0]!.text).toContain('Keep this request');
  });

  it('splits oversized waiting inputs at message boundaries without losing the remainder', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const reviewer = (await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' }))
      .session;
    h.runner.setState(reviewer.id, 'working');
    for (const [from, text] of [
      ['dev-1', 'a'.repeat(13000)],
      ['dev-2', 'b'.repeat(13000)],
    ])
      await h.domain.messaging.send(
        'AR',
        from!,
        { to: ['cr'], text: text!, taskKey: 'AR-1' },
        { kind: 'info' },
      );
    h.runner.setState(reviewer.id, 'idle');
    await vi.waitFor(() => expect(h.runner.messages).toHaveLength(1));
    expect(h.runner.messages[0]!.text.length).toBeLessThanOrEqual(24000);
    expect(h.runner.messages[0]!.text).toContain('a'.repeat(13000));
    expect(h.repos.messages.pending('AR', 'cr')).toHaveLength(1);
    h.runner.setState(reviewer.id, 'working');
    h.runner.setState(reviewer.id, 'idle');
    await vi.waitFor(() => expect(h.repos.messages.pending('AR', 'cr')).toHaveLength(0));
    expect(h.runner.messages[1]!.text).toContain('b'.repeat(13000));
  });

  it('marks the PM-411 late correction request obsolete after its sender approved the card', async () => {
    let time = new Date('2026-10-08T05:39:00.000Z');
    h = await createDomainHarness({ now: () => time });
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const developer = (await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER }))
      .session!;
    let commit = 'old-commit';
    vi.spyOn(h.domain.sessions, 'sourceHead').mockImplementation(async () => ({
      commit,
      branch: 'task/AR-1',
      dirty: false,
      changes: 0,
      path: h.workspace,
      committedAt: time.toISOString(),
    }));
    h.runner.setState(developer.id, 'working');
    await flush();
    await h.domain.messaging.send('AR', 'cr', {
      to: ['dev-1'],
      text: 'Revert and fix the old commit.',
      taskKey: 'AR-1',
    });
    time = new Date(time.getTime() + 1000);
    commit = 'new-commit';
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    await flush();
    const reviewer = h.domain.sessions.list('AR', { member: 'cr', taskKey: 'AR-1' })[0]!;
    await h.domain.teamTools.updateTask(
      { projectKey: 'AR', taskKey: 'AR-1', member: 'cr', sessionId: reviewer.id },
      { taskKey: 'AR-1', addLabels: ['code-review-ok'] },
    );
    const rounds = vi.spyOn(h.domain.sessions, 'requestReviewRound');
    const starts = h.runner.started.length;
    await flush();
    const deliveredBefore = h.runner.messages.filter((m) => m.sessionId === developer.id).length;
    h.runner.setState(developer.id, 'idle');
    await vi.waitFor(() =>
      expect(h.runner.messages.filter((m) => m.sessionId === developer.id)).toHaveLength(deliveredBefore + 1),
    );
    expect(h.runner.messages.filter((m) => m.sessionId === developer.id).at(-1)!.text).toContain(
      'OUT OF DATE: cr has since recorded code-review-ok on the card',
    );
    expect(h.runner.started).toHaveLength(starts);
    expect(rounds).not.toHaveBeenCalled();
  });

  it('does not treat a changes label or approval for another recipient as a sender result', async () => {
    let time = new Date('2026-10-08T05:39:00.000Z');
    h = await createDomainHarness({ now: () => time });
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    const request = await h.domain.messaging.send('AR', 'cr', {
      to: ['dev-1', 'dev-2'],
      text: 'Fix this.',
      taskKey: 'AR-1',
    });
    time = new Date(time.getTime() + 1000);
    await h.domain.tasks.changeLabels(
      'AR',
      'AR-1',
      { add: ['code-review-changes'] },
      { kind: 'ai', handle: 'cr' },
      { comment: 'Fix the request.' },
    );
    const config = await h.domain.projects.config('AR');
    // The original action is superseded by the label's own correction notice, which stays actionable.
    const latest = h.repos.messages.pending('AR', 'dev-1').at(-1)!;
    expect(h.domain.messages.wakes(config, latest, 'dev-1')).toBe(true);
    expect(h.domain.messages.wakes(config, request, 'dev-2')).toBe(true);
    await h.domain.tasks.changeLabels(
      'AR',
      'AR-1',
      { add: ['code-review-ok'] },
      { kind: 'ai', handle: 'cr' },
    );
    expect(h.domain.messages.wakes(config, request, 'dev-2')).toBe(true);
  });

  it('delivers A and B requests as obsolete after C is reviewed, without another wake or round', async () => {
    let time = new Date('2026-10-05T21:30:00.000Z');
    h = await createDomainHarness({ now: () => time });
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    let commit = 'A';
    vi.spyOn(h.domain.sessions, 'sourceHead').mockImplementation(async () => ({
      commit,
      branch: 'task/AR-1',
      dirty: false,
      changes: 0,
      path: h.workspace,
      committedAt: time.toISOString(),
    }));
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    await flush();
    const reviewer = h.domain.sessions.list('AR', { member: 'cr', taskKey: 'AR-1' })[0]!;
    h.runner.setState(reviewer.id, 'waiting_permission');
    const sender = { projectKey: 'AR', taskKey: 'AR-1', member: 'dev-1', sessionId: started.session!.id };
    for (const next of ['A', 'B', 'C']) {
      commit = next;
      time = new Date(time.getTime() + 1000);
      await h.domain.teamTools.sendMessage(sender, { to: ['cr'], text: `Review ${next}`, kind: 'action' });
    }
    time = new Date(time.getTime() + 1000);
    h.repos.sessions.setReviewedCommit(reviewer.id, 'C');
    await h.domain.teamTools.updateTask(
      { ...sender, member: 'cr', sessionId: reviewer.id },
      { taskKey: 'AR-1', addLabels: ['code-review-ok'] },
    );
    const event = h.domain.timeline
      .list('AR', { taskKey: 'AR-1' })
      .find((e) => e.type === 'task_labels_changed' && e.data.resultCommit === 'C');
    expect(event).toBeDefined();
    const rounds = vi.spyOn(h.domain.sessions, 'requestReviewRound');
    const starts = h.runner.started.length;
    const messages = h.runner.messages.length;
    h.runner.setState(reviewer.id, 'idle');
    await vi.waitFor(() => expect(h.runner.messages.length).toBe(messages + 1));
    expect(h.runner.messages.at(-1)!.text).toContain('3 messages waited for you. 3 are out of date');
    expect(h.runner.messages.at(-1)!.text).toContain('you already recorded your result for this commit');
    expect(h.runner.started).toHaveLength(starts);
    expect(rounds).not.toHaveBeenCalled();
    await h.domain.sessions.stop('AR', reviewer.id);
    const info = await h.domain.teamTools.sendMessage(sender, {
      to: ['cr'],
      text: 'Finished.',
      kind: 'info',
    });
    await flush();
    expect(info.recipients[0]!.delivery).toBe('next_input');
    expect(h.runner.started).toHaveLength(starts);
    expect(rounds).not.toHaveBeenCalled();
  });

  it('an info from the assignee records its version but starts no review work', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    const round = vi.spyOn(h.domain.sessions, 'requestReviewRound');
    const repin = vi.spyOn(h.domain.tasks, 'repinReview');
    const result = await h.domain.teamTools.sendMessage(
      {
        projectKey: 'AR',
        taskKey: 'AR-1',
        member: 'dev-1',
        sessionId: started.session!.id,
      },
      { to: ['cr'], text: 'Finished; no action needed.', kind: 'info' },
    );
    await flush();
    expect(round).not.toHaveBeenCalled();
    expect(repin).not.toHaveBeenCalled();
    expect(result.recipients).toEqual([{ handle: 'cr', delivery: 'next_input' }]);
    expect(h.domain.sessions.list('AR', { member: 'cr' })).toEqual([]);
    expect(h.repos.messages.get(result.messageId)).toMatchObject({
      kind: 'info',
      version: { stageId: 'development', reviewCommit: null },
    });
    await h.domain.messaging.send('AR', 'owner', { to: ['cr'], text: 'Please check now.', taskKey: 'AR-1' });
    await flush();
    const reviewer = h.domain.sessions.list('AR', { member: 'cr', taskKey: 'AR-1' })[0]!;
    expect(h.runner.started.find((spec) => spec.sessionId === reviewer.id)?.initialMessage).toContain(
      'Finished; no action needed.',
    );
    expect(h.repos.messages.pending('AR', 'cr')).toHaveLength(0);
  });

  it('a superseded request does not survive deferred admission, while the newest does', async () => {
    h = await createDomainHarness({ planUsagePercent: 95 });
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const older = await h.domain.messaging.send('AR', 'dev-1', {
      to: ['cr'],
      text: 'Review A',
      taskKey: 'AR-1',
    });
    const newer = await h.domain.messaging.send('AR', 'dev-1', {
      to: ['cr'],
      text: 'Review B',
      taskKey: 'AR-1',
    });
    const config = await h.domain.projects.config('AR');
    expect(h.domain.messages.wakes(config, older, 'cr')).toBe(false);
    expect(h.domain.messages.wakes(config, newer, 'cr')).toBe(true);
    expect(h.repos.messages.pending('AR', 'cr').map((m) => m.id)).toEqual([older.id, newer.id]);
  });
});
