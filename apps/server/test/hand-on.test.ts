import { afterEach, describe, expect, it } from 'vitest';
import { handOnRequestOf } from '@projectman/shared';
import type { CardMover, ProjectConfig } from '@projectman/shared';
import { migrateProjectConfig } from '../src/config/migrations';
import { aiActor, SYSTEM_ACTOR } from '../src/domain';
import { TEAM_TOOLS } from '../src/mcp';
import { createDomainHarness, restartDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { settle } from './helpers/fakes';

let h: DomainHarness;
afterEach(() => h?.cleanup());
const owner = { handle: 'owner', access: 'owner' as const };
const by = { actor: OWNER_ACTOR, author: OWNER };
const human: CardMover = { kind: 'human', handle: 'owner' };

async function setup(mover: CardMover = human, adjust?: (c: ProjectConfig) => void) {
  h = await createDomainHarness({
    adjust: (c) => {
      c.team.cardMover = mover;
      adjust?.(c);
    },
  });
  const task = await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  await h.domain.taskStarts.start('AR', task.key, { assignee: 'dev-1', ...by });
  const path = h.worktrees.existing.get(`AR/${task.key}/web`)!.path;
  h.worktrees.heads.set(path, {
    commit: 'c1',
    branch: 'task/AR-1',
    dirty: false,
    changes: 0,
    path,
    committedAt: null,
  });
  return { key: task.key, path };
}
const requests = (key: string) => h.domain.inbox.list('AR', { kind: 'hand_on', taskKey: key });
const ask = (key: string, to = 'code_review') => h.domain.tasks.moveToStage('AR', key, to, aiActor('dev-1'));
async function mover(value: CardMover) {
  const loaded = await h.domain.projects.load('AR');
  await h.domain.projects.patch('AR', { baseVersion: loaded.version, cardMover: value }, by);
  await settle();
}

describe('hand-on requests', () => {
  it('keeps the card with the worker, requests once and pins only when the human moves it', async () => {
    const { key, path } = await setup();
    const updated = await h.domain.tasks.update(
      'AR',
      key,
      { stageId: 'code_review', note: 'Implementation complete' },
      aiActor('dev-1'),
    );
    expect(updated.handOn).toMatchObject({ mover: 'owner', requestedBy: 'dev-1' });
    const result = await ask(key);
    expect(result).toMatchObject({ moved: false, handOn: { mover: 'owner', requestedBy: 'dev-1' } });
    expect(result.task.stageId).toBe('development');
    expect(result.task.reviewPin).toBeUndefined();
    const [item] = requests(key);
    expect(item).toMatchObject({
      state: 'open',
      assignees: ['owner'],
      source: 'dev-1',
      options: [{ id: 'move', label: 'move', style: 'primary' }],
    });
    expect(handOnRequestOf(item!)).toMatchObject({
      taskKey: key,
      fromStageId: 'development',
      toStageId: 'code_review',
    });
    await ask(key);
    await h.domain.tasks.moveToStage('AR', key, 'code_review', SYSTEM_ACTOR);
    expect(requests(key)).toHaveLength(1);
    expect(
      h.domain.timeline.list('AR', { taskKey: key }).filter((e) => e.type === 'task_hand_on_requested'),
    ).toHaveLength(1);
    h.worktrees.heads.set(path, { ...h.worktrees.heads.get(path)!, commit: 'c2' });
    const resolved = await h.domain.inbox.resolve('AR', item!.id, { optionId: 'move' }, owner);
    expect(resolved).toMatchObject({ state: 'resolved', resolution: { optionId: 'move', by: 'owner' } });
    expect(h.domain.tasks.get('AR', key)).toMatchObject({
      stageId: 'code_review',
      reviewPin: { commit: 'c2' },
    });
    expect(h.domain.tasks.get('AR', key).handOn).toBeUndefined();
    expect(h.repos.taskHandOns.get('AR', key)).toBeNull();
  });

  it('leaves the item open when the gate changes or the workspace becomes dirty', async () => {
    const { key, path } = await setup();
    await ask(key);
    const item = requests(key)[0]!;
    await expect(h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, owner)).rejects.toMatchObject(
      { code: 'unknown_option' },
    );
    h.worktrees.heads.set(path, { ...h.worktrees.heads.get(path)!, dirty: true, changes: 1 });
    await expect(h.domain.inbox.resolve('AR', item.id, { optionId: 'move' }, owner)).rejects.toMatchObject({
      code: 'handover_uncommitted',
    });
    expect(h.domain.inbox.get('AR', item.id).state).toBe('open');
    h.worktrees.heads.set(path, { ...h.worktrees.heads.get(path)!, dirty: false, changes: 0 });
    const loaded = await h.domain.projects.load('AR');
    loaded.config.pipeline.stages.find((s) => s.id === 'code_review')!.gate = {
      conditions: [{ type: 'has_label', label: 'code-review-ok' }],
    };
    await h.domain.projects.save('AR', loaded.config, by);
    await expect(h.domain.inbox.resolve('AR', item.id, { optionId: 'move' }, owner)).rejects.toMatchObject({
      code: 'gate_blocked',
    });
    expect(h.domain.inbox.get('AR', item.id).state).toBe('open');
    expect(h.domain.tasks.get('AR', key).stageId).toBe('development');
  });

  it('refuses uncommitted work before creating any request', async () => {
    const { key, path } = await setup();
    h.worktrees.heads.set(path, { ...h.worktrees.heads.get(path)!, dirty: true, changes: 1 });
    await expect(ask(key)).rejects.toMatchObject({ code: 'handover_uncommitted' });
    expect(requests(key)).toEqual([]);
    expect(h.domain.tasks.get('AR', key).handOn).toBeUndefined();
  });

  it('returns the hand-on completion message from the MCP update_task tool', async () => {
    const { key } = await setup();
    const session = h.repos.sessions.list('AR', { taskKey: key, member: 'dev-1' })[0]!;
    const update = TEAM_TOOLS.find((tool) => tool.name === 'update_task')!;
    const text = await update.run({
      ctx: { sessionId: session.id, projectKey: 'AR', member: 'dev-1', taskKey: key },
      args: { task_key: key, stage_id: 'code_review' },
      handler: h.domain.teamTools,
    });
    expect(text).toContain('The move to code_review goes to Owner (owner)');
    expect(text).toContain('Your work on this stage is done.');
    expect(text).not.toContain('moved to code_review');
  });

  it('stores one system action for the project manager, whose update moves the card', async () => {
    const { key } = await setup({ kind: 'project_manager' });
    await ask(key);
    await ask(key);
    const messages = h.repos.messages
      .list('AR', { taskKey: key })
      .filter((m) => m.body.includes('In this project you move cards on'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ from: 'system', kind: 'action', taskKey: key, to: ['pm'] });
    expect(messages[0]!.body).toContain('stage_id code_review');
    expect(messages[0]!.receipts?.find((receipt) => receipt.handle === 'pm')?.route).toEqual({
      type: 'general',
    });
    expect(requests(key)).toEqual([]);
    const moved = await h.domain.tasks.update('AR', key, { stageId: 'code_review' }, aiActor('pm'));
    expect(moved.stageId).toBe('code_review');
    expect(moved.handOn).toBeUndefined();
  });

  it('retains worker moves', async () => {
    const { key } = await setup({ kind: 'worker' });
    const result = await ask(key);
    expect(result.moved).toBe(true);
    expect(result.task.stageId).toBe('code_review');
    expect(requests(key)).toEqual([]);
  });

  it('replaces another target once and resolves a direct human move', async () => {
    const { key } = await setup(human, (c) => {
      c.pipeline.stages.find((s) => s.id === 'merge')!.gate = {
        conditions: [{ type: 'lacks_label', label: 'code-review-ok' }],
      };
    });
    await ask(key);
    const first = requests(key)[0]!;
    await ask(key, 'merge');
    expect(h.domain.inbox.get('AR', first.id).state).toBe('cancelled');
    const replacement = requests(key).find((i) => i.state === 'open')!;
    await ask(key, 'merge');
    expect(requests(key)).toHaveLength(2);
    await h.domain.tasks.moveToStage('AR', key, 'merge', OWNER_ACTOR);
    expect(h.domain.inbox.get('AR', replacement.id)).toMatchObject({
      state: 'resolved',
      resolution: { by: 'owner', optionId: 'move' },
    });
  });

  it('clears the old request when switching to worker cannot pass the gate', async () => {
    const { key } = await setup();
    await ask(key);
    const item = requests(key)[0]!;
    const loaded = await h.domain.projects.load('AR');
    loaded.config.team.cardMover = { kind: 'worker' };
    loaded.config.pipeline.stages.find((s) => s.id === 'code_review')!.gate = {
      conditions: [{ type: 'has_label', label: 'code-review-ok' }],
    };
    await h.domain.projects.save('AR', loaded.config, by);
    expect(h.domain.tasks.get('AR', key).stageId).toBe('development');
    expect(h.domain.tasks.get('AR', key).handOn).toBeUndefined();
    expect(h.domain.inbox.get('AR', item.id).state).toBe('cancelled');
  });

  it('requires developer access even when a viewer is the designated human mover', async () => {
    const { key } = await setup({ kind: 'human', handle: 'observer' }, (c) => {
      c.team.members.push({
        kind: 'human',
        handle: 'observer',
        displayName: 'Observer',
        access: 'viewer',
        roles: [],
      });
    });
    await ask(key);
    const item = requests(key)[0]!;
    await expect(
      h.domain.inbox.resolve('AR', item.id, { optionId: 'move' }, { handle: 'observer', access: 'viewer' }),
    ).rejects.toMatchObject({ code: 'insufficient_access' });
    expect(h.domain.inbox.get('AR', item.id).state).toBe('open');
  });

  it('restores the persisted request after a server restart', async () => {
    h = await createDomainHarness({
      persistent: true,
      adjust: (c) => {
        c.team.cardMover = human;
      },
    });
    const task = await h.domain.tasks.create('AR', { title: 'Restart' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'development', OWNER_ACTOR);
    await ask(task.key);
    const request = h.domain.tasks.get('AR', task.key).handOn;
    h = await restartDomainHarness(h);
    expect(h.domain.tasks.get('AR', task.key).handOn).toEqual(request);
    expect(requests(task.key).filter((i) => i.state === 'open')).toHaveLength(1);
  });

  it('AutoAdvance requests a human once across repeated checks', async () => {
    h = await createDomainHarness({
      adjust: (c) => {
        c.team.cardMover = human;
        c.pipeline.stages.find((s) => s.id === 'merge')!.gate = {
          conditions: [{ type: 'has_label', label: 'code-review-ok' }],
        };
      },
    });
    const task = await h.domain.tasks.create('AR', { title: 'Review complete' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    await h.domain.tasks.changeLabels('AR', task.key, { add: ['code-review-ok'] }, aiActor('cr'));
    await settle();
    for (let i = 0; i < 3; i++) await h.domain.autoAdvance.check(h.domain.tasks.get('AR', task.key));
    expect(requests(task.key)).toHaveLength(1);
    expect(h.domain.tasks.get('AR', task.key)).toMatchObject({
      stageId: 'code_review',
      handOn: { requestedBy: 'system' },
    });
  });

  it('cancels on backward movement and task cancellation', async () => {
    const { key } = await setup();
    await ask(key);
    const item = requests(key)[0]!;
    await h.domain.tasks.moveToStage('AR', key, 'backlog', aiActor('dev-1'));
    expect(h.domain.inbox.get('AR', item.id).state).toBe('cancelled');
    expect(h.repos.taskHandOns.get('AR', key)).toBeNull();
    await h.domain.tasks.moveToStage('AR', key, 'development', aiActor('dev-1'));
    await ask(key);
    const open = requests(key).find((i) => i.state === 'open')!;
    await h.domain.tasks.cancel('AR', key, {}, OWNER_ACTOR);
    expect(h.domain.inbox.get('AR', open.id).state).toBe('cancelled');
    expect(h.repos.taskHandOns.get('AR', key)).toBeNull();
  });

  it('redirects between human and PM preserving the requester, then worker executes the move', async () => {
    const { key } = await setup();
    await ask(key);
    const item = requests(key)[0]!;
    await mover({ kind: 'project_manager' });
    expect(h.domain.inbox.get('AR', item.id).state).toBe('cancelled');
    expect(h.domain.tasks.get('AR', key).handOn).toMatchObject({
      mover: 'pm',
      requestedBy: 'dev-1',
      inboxItemId: null,
    });
    await mover(human);
    expect(requests(key).filter((i) => i.state === 'open')).toHaveLength(1);
    expect(h.domain.tasks.get('AR', key).handOn).toMatchObject({ mover: 'owner', requestedBy: 'dev-1' });
    await mover({ kind: 'worker' });
    expect(h.domain.tasks.get('AR', key).stageId).toBe('code_review');
    expect(h.domain.tasks.get('AR', key).handOn).toBeUndefined();
    expect(requests(key).filter((i) => i.state === 'open')).toEqual([]);
  });

  it('prioritizes human approvals in every mover mode', async () => {
    for (const value of [human, { kind: 'worker' }, { kind: 'project_manager' }] as CardMover[]) {
      if (h) await h.cleanup();
      h = await createDomainHarness({
        adjust: (c) => {
          c.team.cardMover = value;
        },
      });
      const task = await h.domain.tasks.create('AR', { title: 'Approval' }, OWNER_ACTOR);
      await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
      await h.domain.tasks.changeLabels('AR', task.key, { add: ['code-review-ok'] }, aiActor('cr'));
      const result = await h.domain.tasks.moveToStage('AR', task.key, 'merge', aiActor('dev-1'));
      expect(result.pendingApproval).toHaveLength(1);
      expect(requests(task.key)).toEqual([]);
      await h.domain.inbox.resolve('AR', result.pendingApproval[0]!.id, { optionId: 'approve' }, owner);
      expect(h.domain.tasks.get('AR', task.key).stageId).toBe('merge');
    }
  });

  it('migrates missing movers to worker and keeps explicit values', () => {
    const logger = { warn: () => {} };
    const old = { team: { members: [] } };
    expect(migrateProjectConfig(old, { projectKey: 'AR', logger })).toMatchObject({
      team: { cardMover: { kind: 'worker' } },
    });
    const configured = { team: { members: [], cardMover: human } };
    expect(migrateProjectConfig(configured, { projectKey: 'AR', logger })).toMatchObject({
      team: { cardMover: human },
    });
  });
});
