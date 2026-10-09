import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { aiActor } from '../src/domain';
import { TEAM_TOOL_NAMES } from '../src/mcp';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { flush } from './helpers/fakes';

/**
 * What the project manager may do on its own, and what the server refuses it (PM-433). The pipeline
 * is backlog (first queue) → ready (queue) → development (work, gated by the pm's own label) → code review.
 */
function configure(config: ProjectConfig) {
  const pm = config.team.members.find((m) => m.handle === 'pm')!;
  if (pm.kind === 'ai') pm.onLeave = false;
  config.pipeline.stages.splice(1, 0, {
    id: 'ready',
    name: 'Ready',
    kind: 'queue',
    owners: ['owner'],
    columnId: 'todo',
  });
  const development = config.pipeline.stages.find((s) => s.id === 'development')!;
  development.gate = { conditions: [{ type: 'has_label', label: 'ready-ok' }] };
  config.pipeline.labels.push({ id: 'ready-ok', name: 'Ready ok', setBy: { members: ['pm', 'owner'] } });
}

describe('the project manager’s rights on the server', () => {
  let h: DomainHarness;
  let pm: ToolContext;
  let dev: ToolContext;
  beforeEach(async () => {
    h = await createDomainHarness({ adjust: configure });
    await h.domain.tasks.create('AR', { title: 'First card' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    pm = { sessionId: session.id, projectKey: 'AR', member: 'pm', taskKey: null };
    const other = await h.domain.sessions.ensureSession('AR', 'dev-2', { type: 'general' });
    dev = { sessionId: other.session.id, projectKey: 'AR', member: 'dev-2', taskKey: null };
  });
  afterEach(() => h.cleanup());

  const card = () => h.domain.tasks.get('AR', 'AR-1');
  const timelineLength = () => h.domain.tasks.detail('AR', 'AR-1').timeline.length;
  const toolError = (promise: Promise<unknown>) => rejection(promise, TeamToolError);

  describe('priority', () => {
    it('is set and cleared by the project manager under its own name', async () => {
      await h.domain.teamTools.updateTask(pm, { taskKey: 'AR-1', priority: 'urgent' });
      expect(card().priority).toBe('urgent');
      await h.domain.teamTools.updateTask(pm, { taskKey: 'AR-1', priority: null });
      expect(card().priority).toBeNull();
      const changes = h.domain.tasks
        .detail('AR', 'AR-1')
        .timeline.filter((event) => event.type === 'task_updated');
      expect(changes.map((event) => [event.actor, event.data])).toEqual([
        [
          { kind: 'ai', handle: 'pm' },
          { fields: ['priority'], priority: 'urgent', previousPriority: null },
        ],
        [
          { kind: 'ai', handle: 'pm' },
          { fields: ['priority'], priority: null, previousPriority: 'urgent' },
        ],
      ]);
    });

    it('stays refused to any other AI member, atomically', async () => {
      const refused = await toolError(
        h.domain.teamTools.updateTask(dev, { taskKey: 'AR-1', priority: 'high', note: 'not recorded' }),
      );
      expect(refused.code).toBe('forbidden');
      await expect(
        h.domain.tasks.update('AR', 'AR-1', { priority: 'high', title: 'Changed' }, aiActor('dev-1')),
      ).rejects.toMatchObject({ status: 403, code: 'priority_humans_only' });
      expect(card()).toMatchObject({ title: 'First card', priority: null });
    });
  });

  describe('starting a card', () => {
    beforeEach(async () => {
      await h.domain.tasks.update('AR', 'AR-1', { stageId: 'ready' }, OWNER_ACTOR);
    });

    it('moves a card waiting in a queue stage after the first into its work stage, gate included', async () => {
      const blocked = await toolError(
        h.domain.teamTools.updateTask(pm, { taskKey: 'AR-1', stageId: 'development' }),
      );
      expect(blocked.code).toBe('gate_blocked');
      expect(card().stageId).toBe('ready');
      // The pm's own, non-approval label in the same call opens the gate; the system picks the member.
      await h.domain.teamTools.updateTask(pm, {
        taskKey: 'AR-1',
        addLabels: ['ready-ok'],
        stageId: 'development',
      });
      expect(card()).toMatchObject({ stageId: 'development', labels: ['ready-ok'] });
      const moved = h.domain.tasks
        .detail('AR', 'AR-1')
        .timeline.filter((event) => event.type === 'task_stage_changed')
        .at(-1);
      expect(moved?.actor).toEqual({ kind: 'ai', handle: 'pm' });
      await flush();
      expect(['dev-1', 'dev-2']).toContain(card().assignee);
    });

    it('refuses every other move and records nothing of the same call', async () => {
      // A step stage, back to the first stage, and back from the work stage afterwards.
      for (const stageId of ['code_review', 'merge', 'done', 'backlog']) {
        const before = timelineLength();
        const err = await toolError(
          h.domain.teamTools.updateTask(pm, {
            taskKey: 'AR-1',
            stageId,
            priority: 'high',
            addLabels: ['ready-ok'],
            note: 'must not be recorded',
          }),
        );
        expect(err.code, stageId).toBe('forbidden');
        expect(err.message).toContain('the project manager only starts cards');
        expect(card(), stageId).toMatchObject({ stageId: 'ready', priority: null, labels: [] });
        expect(timelineLength(), stageId).toBe(before);
      }
      await h.domain.tasks.update(
        'AR',
        'AR-1',
        { addLabels: ['ready-ok'], stageId: 'development' },
        OWNER_ACTOR,
      );
      for (const stageId of ['ready', 'backlog', 'code_review']) {
        await expect(
          h.domain.tasks.update('AR', 'AR-1', { stageId, priority: 'low' }, aiActor('pm')),
          stageId,
        ).rejects.toMatchObject({ status: 403, code: 'project_manager_move_refused' });
        expect(card(), stageId).toMatchObject({ stageId: 'development', priority: null });
      }
    });

    it('refuses the move from the first stage, whichever way it is requested', async () => {
      await h.domain.tasks.create('AR', { title: 'Second card' }, OWNER_ACTOR);
      for (const stageId of ['ready', 'development']) {
        await expect(
          h.domain.tasks.update('AR', 'AR-2', { stageId }, aiActor('pm')),
          stageId,
        ).rejects.toMatchObject({ status: 403, code: 'project_manager_move_refused' });
        // The guard of the move itself, below the update.
        await expect(
          h.domain.tasks.moveToStage('AR', 'AR-2', stageId, aiActor('pm')),
          stageId,
        ).rejects.toMatchObject({ status: 403, code: 'project_manager_move_refused' });
      }
      expect(h.domain.tasks.get('AR', 'AR-2').stageId).toBe('backlog');
    });

    it('leaves the moves of people and of other members as they were', async () => {
      await h.domain.tasks.update(
        'AR',
        'AR-1',
        { addLabels: ['ready-ok'], stageId: 'development' },
        OWNER_ACTOR,
      );
      await h.domain.tasks.update('AR', 'AR-1', { stageId: 'ready' }, OWNER_ACTOR);
      expect(card().stageId).toBe('ready');
    });
  });

  describe('labels and decisions', () => {
    it('refuses an approval label, which the label rules give to people only', async () => {
      for (const label of ['merge-ok', 'release-ok', 'code-review-ok']) {
        const before = timelineLength();
        const err = await toolError(
          h.domain.teamTools.updateTask(pm, { taskKey: 'AR-1', addLabels: [label] }),
        );
        expect(err.code, label).toBe('forbidden');
        expect(card().labels, label).toEqual([]);
        expect(timelineLength(), label).toBe(before);
      }
      // A label that is not an approval is its to set and to remove.
      await h.domain.teamTools.updateTask(pm, { taskKey: 'AR-1', addLabels: ['ready-ok'] });
      expect(card().labels).toEqual(['ready-ok']);
      await h.domain.teamTools.updateTask(pm, { taskKey: 'AR-1', removeLabels: ['ready-ok'] });
      expect(card().labels).toEqual([]);
    });

    it('has no tool for what only the owner does', () => {
      // Stopping, pausing, leave and recall, settings, members and invitations, answering a question,
      // releasing: none has a team tool at all, so the agent cannot ask for it.
      const names: readonly string[] = TEAM_TOOL_NAMES;
      for (const absent of [
        'stop_session',
        'pause_session',
        'resume_session',
        'pause',
        'resume',
        'set_leave',
        'recall_member',
        'update_settings',
        'update_config',
        'add_member',
        'update_member',
        'retire_member',
        'create_invitation',
        'answer_question',
        'resolve_inbox_item',
        'release',
        'publish_main',
      ])
        expect(names, absent).not.toContain(absent);
    });
  });
});
