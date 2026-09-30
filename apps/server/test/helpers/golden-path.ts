import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isHumanOnlyLabel,
  labelDefinition,
  labelSetters,
  roleBundle,
  routes,
  stageOwners,
  type Actor,
  type BoardView,
  type ConfigView,
  type InboxItem,
  type InboxView,
  type ProjectConfig,
  type Stage,
  type Task,
  type TaskDetail,
  type TimelineEvent,
} from '@projectman/shared';
import { templates } from '@projectman/templates';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../src/contracts';
import { waitFor } from '../../src/runner/test-helpers';
import { createAppHarness, setupOwner } from './app-harness';

/**
 * Golden paths: a task goes through a factory template's whole pipeline in the real server,
 * with the real runner driving the fake CLIs, real worktrees, context packs, memory and MCP.
 * Every step is checked against the task detail, the timeline, the inbox and the board.
 * One test file per template, so vitest runs them in parallel.
 */

const projectKey = 'GP';
const owner: Actor = { kind: 'human', handle: 'owner' };
const ai = (handle: string): Actor => ({ kind: 'ai', handle });

/** Templates whose pipeline has a code review stage a QA member can take over. */
const REVIEW_TEMPLATES = new Set(['web-client-project', 'internal-tool', 'small-team']);

/** The factory templates the golden-path files cover, one file each. */
export const GOLDEN_PATH_TEMPLATES = ['web-client-project', 'internal-tool', 'small-team', 'daily-routine'];

async function setup(templateId: string) {
  const harness = await createAppHarness({
    runner: 'fake-cli',
    trustAll: true,
    real: { context: true, memory: true, worktrees: true, mcp: true, templates: true },
    // Cleanup is exercised explicitly so event assertions do not race a timer.
    app: { doneCleanupDelayMs: 60_000 },
  });
  const { workspace } = harness;
  // Seed only the disposable repository. No git config or source checkout is changed.
  execFileSync('git', ['init', '--initial-branch=main', workspace]);
  execFileSync('git', ['-C', workspace, 'fast-import', '--quiet'], {
    input:
      'blob\nmark :1\ndata 19\nFictional workshop\n\n' +
      'commit refs/heads/main\ncommitter Fixture <fixture@example.com> 1700000000 +0000\n' +
      'data 12\nSeed fixture\nM 100644 :1 README.md\n\ndone\n',
  });
  execFileSync('git', ['-C', workspace, 'reset', '--hard', 'main']);
  const server = harness.app;
  const cookie = await setupOwner(server);
  const headers = { cookie };
  const created = await server.inject({
    method: 'POST',
    url: routes.projects(),
    headers,
    payload: {
      key: projectKey,
      name: 'Fictional workshop',
      workspacePath: workspace,
      templateId,
      repos: [{ name: 'app', path: '.', defaultBranch: 'main' }],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const domain = server.projectman.domain;
  const configView = async (): Promise<ConfigView> =>
    (await server.inject({ method: 'GET', url: routes.config(projectKey), headers })).json();
  const board = async (): Promise<BoardView> =>
    (await server.inject({ method: 'GET', url: routes.board(projectKey), headers })).json();
  const patchConfig = async (change: object) => {
    const current = await configView();
    const response = await server.inject({
      method: 'PATCH',
      url: routes.patchConfig(projectKey),
      headers,
      payload: { baseVersion: current.version, ...change },
    });
    expect(response.statusCode, response.body).toBe(200);
    const next = response.json<ConfigView>();
    expect(next.version).not.toBe(current.version);
    expect(domain.timeline.list(projectKey).at(-1)).toMatchObject({
      type: 'config_changed',
      actor: owner,
      data: { version: next.version },
    });
    return next.config;
  };
  return { server, domain, cookie, headers, workspace, configView, board, patchConfig, close: harness.close };
}

type Harness = Awaited<ReturnType<typeof setup>>;
type ExpectedEvent = Pick<TimelineEvent, 'type' | 'actor'> & {
  data: Record<string, unknown>;
  sessionId?: string;
};

async function waitForBrief(h: Harness, sessionId: string) {
  // SessionStart is briefly idle before the runner types the kickoff. Wait for
  // the fake CLI's completed response before acting as the member or stopping it.
  await waitFor(
    () => {
      const session = h.domain.sessions.get(projectKey, sessionId);
      return (
        session.state === 'idle' &&
        session.transcriptPath &&
        existsSync(session.transcriptPath) &&
        readFileSync(session.transcriptPath, 'utf8').includes('"type":"assistant"')
      );
    },
    { what: 'fake CLI kickoff completed' },
  );
}

async function startTask(h: Harness) {
  const title = 'Build a fictional workshop page';
  const created = await h.server.inject({
    method: 'POST',
    url: routes.tasks(projectKey),
    headers: h.headers,
    payload: { title, repo: 'app' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const task = created.json<Task>();
  const events: ExpectedEvent[] = [{ type: 'task_created', actor: owner, data: { title } }];
  const decisions: InboxItem[] = [];
  const sessions = new Map<string, string>();
  const labels: string[] = [];
  let assignee: string | null = null;

  async function assertState(stageId: string, status = 'active') {
    const response = await h.server.inject({
      method: 'GET',
      url: routes.task(projectKey, task.key),
      headers: h.headers,
    });
    expect(response.statusCode).toBe(200);
    const detail = response.json<TaskDetail>();
    expect(detail.task).toMatchObject({ stageId, status, assignee });
    expect(detail.task.labels).toEqual(labels);
    if (status === 'done') expect(detail.task.closedAt).toEqual(expect.any(String));
    const businessEvents = detail.timeline.filter((event) => !event.type.startsWith('session_'));
    expect(businessEvents).toHaveLength(events.length);
    events.forEach((event, i) => expect(businessEvents[i]).toMatchObject(event));
    expect(detail.timeline.filter((event) => event.type === 'session_started')).toHaveLength(sessions.size);
    for (const [member, sessionId] of sessions)
      expect(detail.timeline).toContainEqual(
        expect.objectContaining({
          type: 'session_started',
          actor: ai(member),
          sessionId,
          data: { member, resumed: false },
        }),
      );
    const inboxResponse = await h.server.inject({
      method: 'GET',
      url: `${routes.inbox(projectKey)}?state=all`,
      headers: h.headers,
    });
    expect(inboxResponse.statusCode).toBe(200);
    const inbox = inboxResponse.json<InboxView>().items;
    expect(inbox).toHaveLength(decisions.length);
    for (const decision of decisions) expect(inbox).toContainEqual(decision);
    const open = decisions.filter((item) => item.state === 'open');
    const visibleInbox = await h.server.inject({
      method: 'GET',
      url: routes.inbox(projectKey),
      headers: h.headers,
    });
    expect(
      visibleInbox
        .json<InboxView>()
        .items.map((item) => item.id)
        .sort(),
    ).toEqual(open.map((item) => item.id).sort());
    expect((await h.board()).openInboxCount).toBe(
      open.filter((item) => item.assignees.includes('owner')).length,
    );
    return detail;
  }

  await assertState('ready');
  const config = (await h.configView()).config;
  const work = config.pipeline.stages.find((stage) => stage.kind === 'work')!;
  expect(work.duty).toBe(config.project.templateId === 'daily-routine' ? 'maintenance' : 'implementation');
  expect(work.owners).toBeUndefined();
  const started = await h.server.inject({
    method: 'POST',
    url: routes.startTask(projectKey, task.key),
    headers: h.headers,
    payload: {},
  });
  expect(started.statusCode, started.body).toBe(200);
  const detail = started.json<TaskDetail>();
  const developer = detail.task.assignee!;
  assignee = developer;
  expect(stageOwners(config, work)).toContain(developer);
  expect(detail.sessions).toHaveLength(1);
  const session = detail.sessions[0]!;
  expect(session.cwd).toBe(join(h.server.projectman.home, 'worktrees', projectKey, `${task.key}-app`));
  expect(execFileSync('git', ['-C', session.cwd, 'branch', '--show-current'], { encoding: 'utf8' })).toMatch(
    new RegExp(`^${task.key}-`),
  );
  sessions.set(developer, session.id);
  events.push(
    { type: 'task_assigned', actor: owner, data: { assignee: developer, previous: null } },
    { type: 'task_stage_changed', actor: owner, data: { from: 'ready', to: work.id } },
    {
      type: 'task_link_added',
      actor: { kind: 'system', handle: null },
      data: { kind: 'branch', ref: session.branch },
    },
  );
  await waitForBrief(h, session.id);
  expect(h.server.projectman.runnerModule.runner.isRunning(session.id)).toBe(true);
  await assertState(work.id);

  async function context(member: string): Promise<ToolContext> {
    const { session } = await h.domain.sessions.ensureSession(projectKey, member, {
      type: 'task',
      taskKey: task.key,
    });
    sessions.set(member, session.id);
    await waitForBrief(h, session.id);
    return { projectKey, taskKey: task.key, member, sessionId: session.id };
  }
  return { task, developer, events, decisions, sessions, labels, assertState, context };
}

type Journey = Awaited<ReturnType<typeof startTask>>;

function holder(config: ProjectConfig, stage: Stage): string {
  const member = config.team.members.find(
    (member) => member.kind === 'ai' && stageOwners(config, stage).includes(member.handle),
  );
  expect(member, `AI holder of ${stage.duty}`).toBeDefined();
  return member!.handle;
}

/** A member records a result as a label; a label of a group replaces the group's other label. */
async function recordLabel(h: Harness, j: Journey, member: string, label: string) {
  const ctx = await j.context(member);
  const config = (await h.configView()).config;
  const group = labelDefinition(config, label)?.group;
  const removed = group
    ? j.labels.filter((l) => l !== label && labelDefinition(config, l)?.group === group)
    : [];
  const result = await h.domain.teamTools.updateTask(ctx, { taskKey: j.task.key, addLabels: [label] });
  expect(result.task.labels).toContain(label);
  j.labels.splice(0, j.labels.length, ...j.labels.filter((l) => !removed.includes(l)), label);
  j.events.push({
    type: 'task_labels_changed',
    actor: ai(member),
    sessionId: ctx.sessionId,
    data: { added: [label], removed },
  });
  await j.assertState(result.task.stageId);
}

async function removeLabel(h: Harness, j: Journey, member: string, label: string) {
  const ctx = await j.context(member);
  const result = await h.domain.teamTools.updateTask(ctx, { taskKey: j.task.key, removeLabels: [label] });
  expect(result.task.labels).not.toContain(label);
  j.labels.splice(j.labels.indexOf(label), 1);
  j.events.push({
    type: 'task_labels_changed',
    actor: ai(member),
    sessionId: ctx.sessionId,
    data: { added: [], removed: [label] },
  });
  await j.assertState(result.task.stageId);
}

async function move(h: Harness, j: Journey, member: string, target: string) {
  const from = h.domain.tasks.get(projectKey, j.task.key).stageId;
  await h.domain.teamTools.updateTask(await j.context(member), { taskKey: j.task.key, stageId: target });
  j.events.push({ type: 'task_stage_changed', actor: ai(member), data: { from, to: target } });
  await j.assertState(target, target === 'done' ? 'done' : 'active');
}

async function approve(h: Harness, j: Journey, member: string, target: string, cookie = h.cookie) {
  const from = h.domain.tasks.get(projectKey, j.task.key).stageId;
  await expect(
    h.domain.teamTools.updateTask(await j.context(member), { taskKey: j.task.key, stageId: target }),
  ).rejects.toMatchObject({ code: 'gate_blocked' });
  const pending = h.domain.inbox.list(projectKey, { state: 'open', taskKey: j.task.key });
  expect(pending).toHaveLength(1);
  const item = pending[0]!;
  const gate = item.payload.gate as { stageId: string; toStageId: string };
  const config = (await h.configView()).config;
  const gatedStage = config.pipeline.stages.find((stage) => stage.id === gate.stageId)!;
  const approval = gatedStage
    .gate!.conditions.map((condition) => labelDefinition(config, condition.label))
    .find((label) => label !== undefined && isHumanOnlyLabel(label))!;
  expect(approval.setBy).toMatchObject({
    duties: [gatedStage.kind === 'release' ? 'release_approval' : 'final_decision'],
    humansOnly: true,
  });
  expect(item).toMatchObject({
    kind: 'decision',
    state: 'open',
    source: member,
    taskKey: j.task.key,
    payload: { gate: { fromStageId: from, toStageId: target } },
  });
  expect(item.assignees).toEqual(labelSetters(config, approval, h.domain.tasks.get(projectKey, j.task.key)));
  j.decisions.push(item);
  j.events.push({
    type: 'task_updated',
    actor: ai(member),
    data: { fields: ['status'], gateRequest: { from, to: target, inboxItemIds: [item.id] } },
  });
  await j.assertState(from, 'waiting');
  await expect(
    h.domain.inbox.resolve(projectKey, item.id, { optionId: 'approve' }, { handle: member, access: 'owner' }),
  ).rejects.toMatchObject({ code: 'ai_approval_forbidden' });
  await j.assertState(from, 'waiting');
  // Repeated requests must reuse the open decision and preserve the audit trail.
  await expect(
    h.domain.teamTools.updateTask(await j.context(member), { taskKey: j.task.key, stageId: target }),
  ).rejects.toMatchObject({ code: 'gate_blocked' });
  await j.assertState(from, 'waiting');
  const response = await h.server.inject({
    method: 'POST',
    url: routes.resolveInbox(projectKey, item.id),
    headers: { cookie },
    payload: { optionId: 'approve' },
  });
  expect(response.statusCode, response.body).toBe(200);
  const resolved = response.json<InboxItem>();
  expect(resolved).toMatchObject({ state: 'resolved', resolution: { optionId: 'approve', by: 'owner' } });
  j.decisions[j.decisions.length - 1] = resolved;
  // Approving puts the approval label on the task in the approver's name, then moves it.
  j.labels.push(approval.id);
  j.events.push({
    type: 'task_labels_changed',
    actor: owner,
    data: { added: [approval.id], removed: [], reason: 'approval' },
  });
  j.events.push({
    type: 'task_stage_changed',
    actor: owner,
    data: { from, to: target, approvedBy: ['owner'], inboxItemIds: [item.id] },
  });
  await j.assertState(target, target === 'done' ? 'done' : 'active');
}

async function rebundle(h: Harness, j: Journey) {
  let config = (await h.configView()).config;
  if (!config.team.members.some((member) => member.kind === 'ai' && member.role === 'qa')) {
    const hired = await h.server.inject({
      method: 'POST',
      url: routes.members(projectKey),
      headers: h.headers,
      payload: { role: 'qa' },
    });
    expect(hired.statusCode, hired.body).toBe(201);
    config = (await h.configView()).config;
  }
  const review = config.pipeline.stages.find((stage) => stage.id === 'code_review')!;
  const original = holder(config, review);
  const qa = config.team.members.find((member) => member.kind === 'ai' && member.role === 'qa')!;
  config = await h.patchConfig({
    roleOverrides: {
      ...config.team.roleOverrides,
      code_review: { duties: [], instructions: '' },
      qa: { duties: [...roleBundle(config, 'qa').duties, 'code_review'], instructions: '' },
    },
  });
  expect(review.duty).toBe('code_review');
  expect(config.pipeline.stages.find((stage) => stage.id === 'code_review')).toEqual(review);
  expect((await h.board()).stages.find((stage) => stage.id === 'code_review')!.owners).toEqual([qa.handle]);
  expect(stageOwners(config, review)).not.toContain(original);
  await j.assertState('code_review');
  await refuseOrphan(h, j, qa.handle, 'code_review', 'pipeline.stages[2].duty');
  // The QA member now holds code review: it may take the review label off and put it back.
  await removeLabel(h, j, qa.handle, 'code-review-ok');
  await recordLabel(h, j, qa.handle, 'code-review-ok');
}

async function refuseOrphan(h: Harness, j: Journey, member: string, duty: string, path: string) {
  const before = await h.configView();
  const timeline = h.domain.timeline.list(projectKey);
  const task = h.domain.tasks.get(projectKey, j.task.key);
  const failed = await h.server.inject({
    method: 'DELETE',
    url: routes.member(projectKey, member),
    headers: h.headers,
    payload: {},
  });
  expect(failed.statusCode).toBe(422);
  expect(failed.json().error).toMatchObject({
    code: 'invalid_config',
    details: {
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_duty_holder',
          detail: duty,
          path,
        }),
      ]),
    },
  });
  expect(await h.configView()).toEqual(before);
  expect(h.domain.timeline.list(projectKey)).toEqual(timeline);
  expect(h.domain.tasks.get(projectKey, j.task.key)).toEqual(task);
  for (const sessionId of j.sessions.values())
    expect(h.server.projectman.runnerModule.runner.isRunning(sessionId)).toBe(true);
  await j.assertState(task.stageId);
}

async function throughQuality(h: Harness, j: Journey, rebundled = false) {
  let config = (await h.configView()).config;
  const review = config.pipeline.stages.find((stage) => stage.id === 'code_review')!;
  expect(review).toMatchObject({ kind: 'step', duty: 'code_review' });
  expect(review.owners).toBeUndefined();
  await move(h, j, j.developer, review.id);
  const developerContext = await j.context(j.developer);
  // Only defined labels have rules; in a pipeline without QA, "qa-ok" would be a plain tag.
  for (const label of ['code-review-ok', 'qa-ok'].filter((l) => labelDefinition(config, l))) {
    await expect(
      h.domain.tasks.changeLabels(projectKey, j.task.key, { add: [label] }, ai(j.developer)),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(self_review_forbidden|label_not_allowed)$/) });
    // The team-tool contract maps domain 403 errors to its public "forbidden" category.
    await expect(
      h.domain.teamTools.updateTask(developerContext, { taskKey: j.task.key, addLabels: [label] }),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('cannot') });
    await j.assertState(review.id);
  }
  const next = config.pipeline.stages[3]!;
  await expect(
    h.domain.teamTools.updateTask(developerContext, { taskKey: j.task.key, stageId: next.id }),
  ).rejects.toMatchObject({ code: 'gate_blocked' });
  await j.assertState(review.id);
  await recordLabel(h, j, holder(config, review), 'code-review-ok');
  if (rebundled) {
    await rebundle(h, j);
    config = (await h.configView()).config;
  }
  if (config.pipeline.stages.some((stage) => stage.id === 'integration')) {
    const integration = config.pipeline.stages.find((stage) => stage.id === 'integration')!;
    expect(integration).toMatchObject({ kind: 'step', duty: 'deployment' });
    const devops = holder(config, integration);
    await move(h, j, devops, integration.id);
    const ctx = await j.context(devops);
    await h.domain.teamTools.updateTask(ctx, {
      taskKey: j.task.key,
      note: 'Fictional integration deployment verified.',
    });
    j.events.push({
      type: 'task_note',
      actor: ai(devops),
      sessionId: ctx.sessionId,
      data: { text: 'Fictional integration deployment verified.' },
    });
    await j.assertState(integration.id);
  }
  const qa = config.pipeline.stages.find((stage) => stage.id === 'qa');
  if (qa) {
    expect(qa).toMatchObject({ kind: 'step', duty: 'testing_acceptance' });
    await move(h, j, holder(config, qa), qa.id);
    const clientTest = config.pipeline.stages.find((stage) => stage.id === 'client_test');
    if (clientTest) {
      await expect(
        h.domain.teamTools.updateTask(await j.context(holder(config, qa)), {
          taskKey: j.task.key,
          stageId: clientTest.id,
        }),
      ).rejects.toMatchObject({ code: 'gate_blocked' });
      await j.assertState(qa.id);
    }
    await recordLabel(h, j, holder(config, qa), 'qa-ok');
    if (clientTest) {
      expect(clientTest.duty).toBe('client_communication');
      const communication = holder(config, clientTest);
      await move(h, j, communication, clientTest.id);
      await expect(
        h.domain.teamTools.updateTask(await j.context(communication), {
          taskKey: j.task.key,
          stageId: 'merge',
        }),
      ).rejects.toMatchObject({ code: 'gate_blocked' });
      await j.assertState(clientTest.id);
      await recordLabel(h, j, communication, 'client-accepted');
    }
  }
}

async function finish(h: Harness, j: Journey) {
  const config = (await h.configView()).config;
  const merge = config.pipeline.stages.find((stage) => stage.id === 'merge');
  if (merge) {
    await approve(h, j, j.developer, merge.id);
    const release = config.pipeline.stages.find((stage) => stage.kind === 'release');
    if (release) {
      expect(release.duty).toBe('deployment');
      const devops = holder(config, release);
      await approve(h, j, devops, release.id);
      const ctx = await j.context(devops);
      const text = 'Fictional release deployment verified.';
      await h.domain.teamTools.updateTask(ctx, { taskKey: j.task.key, note: text });
      j.events.push({ type: 'task_note', actor: ai(devops), sessionId: ctx.sessionId, data: { text } });
      await j.assertState(release.id);
    }
    const from = h.domain.tasks.get(projectKey, j.task.key).stageId;
    const response = await h.server.inject({
      method: 'PATCH',
      url: routes.task(projectKey, j.task.key),
      headers: h.headers,
      payload: { stageId: 'done' },
    });
    expect(response.statusCode, response.body).toBe(200);
    j.events.push({ type: 'task_stage_changed', actor: owner, data: { from, to: 'done' } });
  } else {
    await approve(h, j, j.developer, 'done');
  }
  await cleanupTask(h, j);
}

async function cleanupTask(h: Harness, j: Journey) {
  await j.assertState('done', 'done');
  await h.domain.sessions.cleanupDoneTask(projectKey, j.task.key);
  const ended = await j.assertState('done', 'done');
  expect(ended.sessions.every((session) => session.state === 'exited')).toBe(true);
  expect(ended.timeline.filter((event) => event.type === 'session_ended')).toHaveLength(j.sessions.size);
  for (const [member, sessionId] of j.sessions)
    expect(ended.timeline).toContainEqual(
      expect.objectContaining({
        type: 'session_ended',
        actor: ai(member),
        sessionId,
        data: { member, exitCode: null },
      }),
    );
  expect(h.server.projectman.runnerModule.runner.list()).toEqual([]);
}

/**
 * The golden-path tests of one factory template: the whole pipeline, and for templates with a
 * code review stage, the same after moving code review to QA (orphaning it is refused).
 */
export function describeGoldenPath(templateId: string): void {
  describe(`factory pipeline golden path: ${templateId}`, () => {
    let current: Harness | undefined;
    const start = async () => {
      current = await setup(templateId);
      return current;
    };
    afterEach(async () => {
      await current?.close();
      current = undefined;
    });

    it('completes the pipeline with attributed tools and human decisions', { timeout: 60_000 }, async () => {
      const h = await start();
      const j = await startTask(h);
      if (templateId === 'daily-routine') {
        await refuseOrphan(h, j, j.developer, 'maintenance', 'pipeline.stages[1].duty');
        await move(h, j, j.developer, 'done');
        await cleanupTask(h, j);
      } else {
        await throughQuality(h, j);
        await finish(h, j);
      }
    });

    if (REVIEW_TEMPLATES.has(templateId)) {
      it(
        'completes after moving code review to QA and rejects orphaning it',
        { timeout: 60_000 },
        async () => {
          const h = await start();
          const j = await startTask(h);
          await throughQuality(h, j, true);
          await finish(h, j);
        },
      );
    }
  });
}

/** Guards the split into one file per template: a new factory template needs its own file. */
export function describeTemplateCoverage(): void {
  it('has a golden-path file for every factory template', () => {
    expect(templates.map((template) => template.id).sort()).toEqual([...GOLDEN_PATH_TEMPLATES].sort());
  });
}
