import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPERATOR_PREFERENCE, MemberContextPreview, routes } from '@projectman/shared';
import type { Merger } from '@projectman/shared';
import type { ContextPackInput } from '../src/contracts';
import { createContextPackBuilder } from '../src/context';
import { humanActor } from '../src/kernel';
import { visibleTeamTools } from '../src/mcp';
import { memberAudience } from '../src/runtime/sessions';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('member context preview', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it.each(['general', 'task'] as const)('uses the launch input for a fresh %s conversation', async (kind) => {
    const task =
      kind === 'task' ? await h.domain.tasks.create('AR', { title: 'Preview work' }, OWNER_ACTOR) : null;
    const handle = task ? 'cr' : 'dev-1';
    h.memory.notes.set(`AR/${handle}`, 'Remember 🧭');
    await h.domain.sessions.previewContext('AR', handle, {
      viewer: 'owner',
      ...(task ? { taskKey: task.key } : {}),
    });
    const preview = h.contextBuilder.inputs.at(-1)!;
    await h.domain.sessions.ensureSession(
      'AR',
      handle,
      task ? { type: 'task', taskKey: task.key } : { type: 'general' },
      {
        cause: { kind: task ? 'start_button' : 'conversation', by: OWNER_ACTOR },
      },
    );
    const launch = h.contextBuilder.inputs.at(-1)!;
    const common = (input: ContextPackInput) => {
      const { placementDeferred, sessionPolicy, sandbox, lastReviewedCommit, previousConversation, ...rest } =
        input;
      void [placementDeferred, sessionPolicy, sandbox, lastReviewedCommit, previousConversation];
      return rest;
    };
    expect(common(preview)).toEqual(common(launch));
  });

  it('returns builder text, ordered guides, sections and code point counts', async () => {
    const builder = createContextPackBuilder();
    const build = vi.spyOn(h.contextBuilder, 'build').mockImplementation((input) => builder.build(input));
    h.memory.notes.set('AR/pm', 'Remember 🧭');
    const preview = MemberContextPreview.parse(
      await h.domain.sessions.previewContext('AR', 'pm', { viewer: 'owner' }),
    );
    const input = build.mock.calls[0]![0];
    const pack = builder.build(input);
    expect(preview.prompt.text).toBe(pack.appendSystemPrompt);
    expect(preview.prompt.sections).toEqual(
      pack.sections.map((section) => ({ ...section, chars: Array.from(section.text).length })),
    );
    expect(preview.prompt.chars).toBe(Array.from(pack.appendSystemPrompt).length);
    expect(preview.prompt.chars).toBeLessThan(preview.prompt.text.length);
    expect(preview.guides.map((guide) => guide.topic)).toEqual(['rules', 'role', 'operations']);
    for (const guide of preview.guides) {
      expect(guide.text).toBe(pack.guide[guide.topic as keyof typeof pack.guide]);
      expect(guide.chars).toBe(Array.from(guide.text).length);
      expect(guide.title).toBe(
        guide.text
          .split('\n')
          .find((line) => line.startsWith('# '))!
          .slice(2),
      );
    }
    expect(preview.initialMessage).toBeNull();
  });

  it('counts the task opening message and uses the current stage', async () => {
    const task = await h.domain.tasks.create('AR', { title: 'Work 🧭' }, OWNER_ACTOR);
    const preview = await h.domain.sessions.previewContext('AR', 'dev-1', {
      viewer: 'owner',
      taskKey: task.key,
    });
    expect(preview.situation).toEqual({ kind: 'task', taskKey: task.key, stageId: task.stageId });
    expect(preview.initialMessage).toEqual({
      text: `Brief for ${task.key}: ${task.title}`,
      chars: Array.from(`Brief for ${task.key}: ${task.title}`).length,
    });
  });

  it("keeps only the requesting owner's preference", async () => {
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      config.team.members.push({
        kind: 'human',
        handle: 'other',
        displayName: 'Other',
        roles: [],
        access: 'owner',
        email: 'other@example.test',
      });
      return 'Add another owner';
    });
    for (const [handle, length] of [
      ['owner', 'brief'],
      ['other', 'detailed'],
    ] as const) {
      await h.domain.operatorKnowledge.compareAndSwapPreference('AR', handle, 0, {
        schemaVersion: 1,
        revision: 1,
        data: { ...DEFAULT_OPERATOR_PREFERENCE, length },
        updatedAt: '2026-10-25T10:00:00.000Z',
      });
    }
    for (const [viewer, length] of [
      ['owner', 'brief'],
      ['other', 'detailed'],
    ] as const) {
      await h.domain.sessions.previewContext('AR', 'operator', { viewer });
      expect(h.contextBuilder.inputs.at(-1)!.operatorPreference).toEqual({
        ...DEFAULT_OPERATOR_PREFERENCE,
        length,
      });
    }
  });

  it('lists distinct tools for the Operator, project manager and developer from the MCP rule', async () => {
    const config = await h.domain.projects.config('AR');
    const lists = [];
    for (const handle of ['operator', 'pm', 'dev-1']) {
      const preview = await h.domain.sessions.previewContext('AR', handle, { viewer: 'owner' });
      expect(preview.tools).toEqual(visibleTeamTools(memberAudience(config, handle)));
      lists.push(preview.tools.map((tool) => tool.name));
    }
    expect(new Set(lists.map((list) => JSON.stringify(list))).size).toBe(3);
  });

  it.each<{ merger?: Merger; handle: string; visible: boolean }>([
    { handle: 'cr', visible: true },
    { handle: 'dev-1', visible: false },
    { merger: { kind: 'developer' }, handle: 'dev-1', visible: true },
    { merger: { kind: 'developer' }, handle: 'operator', visible: false },
    { merger: { kind: 'member', handle: 'cr' }, handle: 'cr', visible: true },
    { merger: { kind: 'member', handle: 'cr' }, handle: 'dev-1', visible: false },
  ])(
    'resolves merge tool visibility for $handle with policy $merger',
    async ({ merger, handle, visible }) => {
      const config = structuredClone(await h.domain.projects.config('AR'));
      config.team.merger = merger;
      const audience = memberAudience(config, handle);
      expect(audience.merger).toBe(visible);
      if (!audience.operator) {
        const names = visibleTeamTools(audience).map((tool) => tool.name);
        for (const tool of ['merge_task', 'prioritize_merge']) {
          expect(names.includes(tool)).toBe(visible);
        }
      }
    },
  );

  it.each([
    { channel: true, member: true, email: true },
    { channel: true, member: false, email: false },
    { channel: false, member: true, email: false },
  ])(
    'marks e-mail sending in the audience (channel $channel, member $member)',
    async ({ channel, member, email }) => {
      const config = structuredClone(await h.domain.projects.config('AR'));
      config.project.email = { enabled: channel };
      for (const candidate of config.team.members)
        if (candidate.kind === 'ai' && candidate.handle === 'dev-1')
          candidate.email = { enabled: member, sendWithoutApproval: false };
      expect(memberAudience(config, 'dev-1').email).toBe(email);
    },
  );

  it('previews leave and task contexts without sessions, timeline writes, branch links or placement', async () => {
    const task = await h.domain.tasks.create('AR', { title: 'Read only preview' }, OWNER_ACTOR);
    const timeline = h.domain.timeline.list('AR', { limit: 100 });
    const sessions = h.domain.sessions.list('AR');
    const link = vi.spyOn(h.domain.tasks, 'addLink');
    const directory = vi.spyOn(h.attachmentStorage, 'taskDirectory');
    const leave = await h.domain.sessions.previewContext('AR', 'pm', { viewer: 'owner' });
    await h.domain.sessions.previewContext('AR', 'dev-1', { viewer: 'owner', taskKey: task.key });
    expect(leave.member).toMatchObject({ onLeave: true, role: 'project_manager' });
    expect(leave.member.duties).toContain('scheduling');
    expect(h.domain.sessions.list('AR')).toEqual(sessions);
    expect(h.domain.timeline.list('AR', { limit: 100 })).toEqual(timeline);
    expect(h.runner.started).toEqual([]);
    expect(h.worktrees.calls).toEqual([]);
    expect(link).not.toHaveBeenCalled();
    expect(directory).not.toHaveBeenCalled();
    for (const input of h.contextBuilder.inputs) {
      expect(input.placementDeferred).toBe(true);
      expect(input.sessionPolicy).toBeUndefined();
      expect(input.sandbox).toBeUndefined();
    }
  });
});

describe('the owner-account flag of the project manager context (PM-1069)', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness({ pmOnDuty: true });
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      const owner = config.team.members.find((m) => m.kind === 'human' && m.access === 'owner')!;
      if (owner.kind === 'human') owner.email = OWNER.email;
      return 'Set the owner e-mail';
    });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it.each([
    ['pm', 'host@example.test', true],
    ['pm', OWNER.email, false],
    ['dev-1', 'host@example.test', false],
  ])('flags %s with the host %s: %s', async (handle, hostEmail, flagged) => {
    h.repos.users.insert({
      id: 'host-user',
      name: 'Host',
      email: hostEmail,
      passwordHash: 'unused-test-hash',
      createdAt: '2026-10-28T10:00:00.000Z',
    });
    await h.domain.sessions.previewContext('AR', handle, { viewer: 'owner' });
    expect(h.contextBuilder.inputs.at(-1)!.hostOutsideOwners).toBe(flagged ? true : undefined);
  });
});

describe('member context endpoint', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => {
    await h.close();
  });
  const url = (handle = 'dev-1', task?: string) =>
    routes.memberContext('AR', handle) + (task ? `?task=${encodeURIComponent(task)}` : '');

  it("allows the owner's login", async () => {
    const response = await inject(h.app, 'GET', url(), cookie);
    expect(response.statusCode, response.body).toBe(200);
    expect(MemberContextPreview.parse(response.json()).member.handle).toBe('dev-1');
  });

  it.each(['admin', 'developer', 'viewer', 'client'] as const)('refuses %s access', async (access) => {
    const login = await addHumanAndLogin(h.app, { handle: access, access });
    const response = await inject(h.app, 'GET', url(), login);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_access');
    expect(h.contextBuilder.inputs).toHaveLength(0);
  });

  it('refuses integrator attribution without a bearer principal', async () => {
    const domain = h.app.projectman.domain;
    const access = await domain.accessFor('AR', OWNER.email);
    vi.spyOn(domain, 'accessFor').mockResolvedValue({ ...access!, via: 'integrator' });
    const response = await inject(h.app, 'GET', url(), cookie);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_access');
  });

  it.each(['super', 'read'] as const)('refuses a %s bearer principal', async (mode) => {
    const issued = await inject(h.app, 'POST', routes.integratorKeys(), cookie, { mode });
    expect(issued.statusCode, issued.body).toBe(201);
    const response = await h.app.inject({
      url: url(),
      headers: { authorization: `Bearer ${issued.json().secret}` },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.code).toBe('insufficient_access');
    expect(h.contextBuilder.inputs).toHaveLength(0);
  });

  it.each([
    { handle: 'missing', status: 404, code: 'not_found' },
    { handle: 'owner', status: 400, code: 'not_ai_member' },
    { handle: 'dev-1', task: 'AR-9999', status: 404, code: 'task_not_found' },
    { handle: 'dev-1', task: 'invalid', status: 400, code: 'invalid_request' },
  ])('returns $code for $handle / $task', async ({ handle, task, status, code }) => {
    const response = await inject(h.app, 'GET', url(handle, task), cookie);
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    if (code === 'not_found') expect(response.json().error.details.what).toBe('member');
  });

  it('refuses a task belonging to another project', async () => {
    const domain = h.app.projectman.domain;
    await domain.projects.create(
      { key: 'OTHER', name: 'Other', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    );
    const task = await domain.tasks.create('OTHER', { title: 'Other work' }, humanActor('owner'));
    const response = await inject(h.app, 'GET', url('dev-1', task.key), cookie);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('task_not_found');
  });

  it('refuses a theme', async () => {
    const theme = await h.app.projectman.domain.tasks.create(
      'AR',
      { title: 'Theme', kind: 'theme' },
      OWNER_ACTOR,
    );
    const response = await inject(h.app, 'GET', url('dev-1', theme.key), cookie);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('task_is_theme');
  });
});
