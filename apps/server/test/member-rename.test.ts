import { routes } from '@projectman/shared';
import type { MemberView } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '../src/runner/test-helpers';
import { StartHolds } from '../src/runtime/sessions';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { withoutOnboarding } from './helpers/onboarding';

/** Renaming an AI member's handle (PM-1025): the references follow, the history and the storage keys stay. */

const by = () => ({ actor: OWNER_ACTOR, author: OWNER });
const at = () => new Date().toISOString();

async function setAiEnabled(h: DomainHarness, aiEnabled: boolean) {
  await h.domain.projects.update('AR', by(), (config) => {
    config.team.limits.aiEnabled = aiEnabled;
    return 'Set AI admission';
  });
}

const timelineRows = (h: DomainHarness) =>
  h.repos.db
    .prepare('SELECT id, actor_handle, type, data FROM timeline_events WHERE project_key = ? ORDER BY seq')
    .all('AR');

describe('member rename', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const rename = (handle: string, to: string) => h.domain.members.rename('AR', handle, to, by());
  const members = async () => (await h.domain.projects.config('AR')).team.members;

  it('rewrites the references, keeps the timeline and records one rename event', async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create('AR', { title: 'Fictional feature' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', task.key, { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    await h.domain.sessions.stopMember('AR', 'dev-1');
    await setAiEnabled(h, false);
    const message = await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Fictional note' });
    h.repos.memberQueue.insert({
      id: 'queued-1',
      projectKey: 'AR',
      member: 'dev-1',
      kind: 'todo',
      source: { type: 'inbox', id: 'queued-1' },
      place: { type: 'general' },
      taskKey: null,
      wake: false,
      title: 'Fictional todo',
      from: null,
      queuedAt: at(),
    });
    const before = timelineRows(h);

    const view = await rename('dev-1', 'builder');

    expect(view).toMatchObject({ handle: 'builder', formerHandles: ['dev-1'] });
    expect(h.domain.tasks.get('AR', task.key).assignee).toBe('builder');
    expect(h.repos.messages.get(message.id)?.to).toEqual(['builder']);
    expect(h.repos.memberQueue.get('queued-1')?.member).toBe('builder');
    expect(h.repos.sessions.list('AR').map((s) => s.member)).toEqual(['builder']);
    expect(timelineRows(h).slice(0, before.length)).toEqual(before);
    const events = h.repos.timeline.ofProjectType('AR', 'member_renamed', 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ from: 'dev-1', to: 'builder' });
    expect(h.repos.timeline.ofProjectType('AR', 'member_retired', 10)).toEqual([]);
    expect(h.repos.timeline.ofProjectType('AR', 'member_hired', 10)).toEqual([]);
    expect((await members()).map((m) => m.handle)).not.toContain('dev-1');
  });

  it('keeps the work of a renamed member where it was, on the same conversation', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    h.runner.emit({
      type: 'transcript_path',
      sessionId: session.id,
      path: '/tmp/fictional-transcript.jsonl',
    });
    await h.domain.sessions.stop('AR', session.id);
    const first = h.runner.lastStarted();

    await rename('dev-1', 'builder');
    await h.domain.sessions.ensureSession('AR', 'builder', { type: 'general' });

    const second = h.runner.lastStarted();
    expect(second).toMatchObject({ sessionId: session.id, resume: true, member: 'builder' });
    expect(second.cwd).toBe(first.cwd);
    expect(h.contextBuilder.inputs.at(-1)?.previousConversation).toBeUndefined();
  });

  it('delivers a message addressed to the old handle to the renamed member', async () => {
    h = await createDomainHarness();
    await setAiEnabled(h, false);
    await rename('dev-1', 'builder');
    const message = await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Fictional note' });
    expect(message.to).toEqual(['builder']);
  });

  it.each([
    ['a human', 'owner', 'builder', 'not_ai_member'],
    ['a handle in use', 'dev-1', 'dev-2', 'handle_taken'],
    ['the same handle', 'dev-1', 'dev-1', 'handle_taken'],
    ['a malformed handle', 'dev-1', 'Not A Handle', 'invalid_request'],
  ])('refuses %s', async (_name, handle, to, code) => {
    h = await createDomainHarness();
    await expect(rename(handle, to)).rejects.toMatchObject({ code });
    expect((await members()).some((m) => m.handle === handle)).toBe(true);
  });

  it('refuses a new handle that is the address of a member of another project', async () => {
    h = await createDomainHarness();
    await withoutOnboarding(h.domain, () =>
      h.domain.projects.create(
        { key: 'BR', name: 'Fictional second project', workspacePath: h.workspace, templateId: 'test' },
        OWNER,
      ),
    );
    await h.domain.members.rename('BR', 'dev-2', 'builder', by());
    await h.domain.members.update('AR', 'dev-1', { email: { enabled: true } }, by());
    await expect(rename('dev-1', 'builder')).rejects.toMatchObject({ code: 'email_mailbox_taken' });
  });

  it('keeps the old handle reserved for the renamed member, so another project’s member cannot switch it on', async () => {
    h = await createDomainHarness();
    await withoutOnboarding(h.domain, () =>
      h.domain.projects.create(
        { key: 'BR', name: 'Fictional second project', workspacePath: h.workspace, templateId: 'test' },
        OWNER,
      ),
    );
    await rename('dev-1', 'builder');
    await expect(
      h.domain.members.update('BR', 'dev-1', { email: { enabled: true } }, by()),
    ).rejects.toMatchObject({ code: 'email_mailbox_taken' });
  });

  it('moves the e-mail address with the handle', async () => {
    h = await createDomainHarness();
    await h.domain.members.update('AR', 'dev-1', { email: { enabled: true } }, by());
    await rename('dev-1', 'builder');
    const member = (await members()).find((m) => m.handle === 'builder');
    expect(member).toMatchObject({ email: { enabled: true }, formerHandles: ['dev-1'] });
  });

  it('never reissues a handle once used, not even to the member itself', async () => {
    h = await createDomainHarness();
    await rename('dev-1', 'builder');
    await expect(rename('dev-2', 'dev-1')).rejects.toMatchObject({ code: 'handle_taken' });
    await expect(rename('builder', 'dev-1')).rejects.toMatchObject({ code: 'handle_taken' });
    await expect(
      h.domain.members.hire(
        'AR',
        { handle: 'dev-1', displayName: 'Fictional', role: 'developer' },
        { ...by(), sponsor: 'owner' },
      ),
    ).rejects.toMatchObject({ code: 'handle_taken' });
  });

  describe('while the member works', () => {
    const live = async () => {
      await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    };
    const processing = async () => {
      h.repos.memberQueue.insert({
        id: 'probe-1',
        projectKey: 'AR',
        member: 'dev-1',
        kind: 'todo',
        source: { type: 'inbox', id: 'probe-1' },
        place: { type: 'general' },
        taskKey: null,
        wake: false,
        title: 'Fictional todo',
        from: null,
        queuedAt: at(),
      });
      expect(h.repos.memberQueue.claim('probe-1', 'ses-a', at())).toBe(true);
    };
    const workspace = async () => {
      const task = await h.domain.tasks.create('AR', { title: 'Held workspace', repo: 'web' }, OWNER_ACTOR);
      const now = at();
      h.repos.sessions.insert({
        id: 'ses_held',
        projectKey: 'AR',
        member: 'dev-1',
        workItem: { type: 'task', taskKey: task.key },
        claudeSessionId: 'claude-ses_held',
        cwd: '/tmp/work',
        branch: null,
        transcriptPath: null,
        state: 'exited',
        activity: null,
        startedAt: now,
        lastActivityAt: now,
        endedAt: now,
      });
      h.repos.memberWorkspaces.insert({
        id: 'mws_held',
        projectKey: 'AR',
        member: 'dev-1',
        repo: 'web',
        path: '/tmp/work',
        generation: 1,
        createdAt: now,
      });
      h.repos.memberWorkspaces.hold('mws_held', {
        sessionId: 'ses_held',
        taskKey: task.key,
        pid: 4242,
        since: now,
        scopeId: 'scp_0123456789abcdef',
        cleanupFailed: false,
      });
    };

    it.each([
      ['session', live],
      ['queue', processing],
      ['workspace', workspace],
    ])('refuses with member_session_live for a %s', async (reason, setup) => {
      h = await createDomainHarness();
      await setup();
      await expect(rename('dev-1', 'builder')).rejects.toMatchObject({
        code: 'member_session_live',
        status: 409,
        details: { reason },
      });
      expect((await members()).some((m) => m.handle === 'dev-1')).toBe(true);
    });

    it('refuses with member_session_live for a deferred start naming the member', async () => {
      h = await createDomainHarness();
      await setAiEnabled(h, false);
      const task = await h.domain.tasks.create('AR', { title: 'Fictional review' }, OWNER_ACTOR);
      await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
      await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
      await expect(rename('cr', 'reviewer')).rejects.toMatchObject({
        code: 'member_session_live',
        details: { reason: 'deferred_start' },
      });
    });
  });

  it('completes a rename whose database step did not run, once, at startup', async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create('AR', { title: 'Fictional feature' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', task.key, { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    await h.domain.sessions.stopMember('AR', 'dev-1');
    await rename('dev-1', 'builder');
    // As if the process ended between the configuration save and the database step.
    h.repos.db.prepare('UPDATE tasks SET assignee = ? WHERE project_key = ?').run('dev-1', 'AR');
    h.repos.db.prepare("DELETE FROM timeline_events WHERE type = 'member_renamed'").run();

    h.domain.members.recoverRenames();
    h.domain.members.recoverRenames();

    expect(h.domain.tasks.get('AR', task.key).assignee).toBe('builder');
    expect(h.repos.timeline.ofProjectType('AR', 'member_renamed', 10)).toHaveLength(1);
  });
});

describe('start holds', () => {
  it('refuses a second hold and a start of the held member only until the hold is lifted', () => {
    const holds = new StartHolds();
    const release = holds.hold('AR', 'dev-1');
    expect(() => holds.hold('AR', 'dev-1')).toThrowError(
      expect.objectContaining({ code: 'member_renaming' }),
    );
    expect(() => holds.assertFree('AR', 'dev-1')).toThrowError(
      expect.objectContaining({ code: 'member_renaming' }),
    );
    expect(() => holds.assertFree('AR', 'dev-2')).not.toThrow();
    release();
    expect(() => holds.assertFree('AR', 'dev-1')).not.toThrow();
  });
});

describe('member rename route', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => h.close());

  it('lets an owner rename and returns the new member view', async () => {
    const res = await inject(h.app, 'POST', routes.memberRename('AR', 'dev-1'), cookie, {
      handle: 'builder',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<MemberView>()).toMatchObject({ handle: 'builder', formerHandles: ['dev-1'] });
  });

  it('refuses anyone below an owner, and an unknown field', async () => {
    const developer = await addHumanAndLogin(h.app, { handle: 'dev', name: 'Dev', access: 'developer' });
    const refused = await inject(h.app, 'POST', routes.memberRename('AR', 'dev-1'), developer, {
      handle: 'builder',
    });
    expect(refused.statusCode).toBe(403);
    const strict = await inject(h.app, 'POST', routes.memberRename('AR', 'dev-1'), cookie, {
      handle: 'builder',
      displayName: 'x',
    });
    expect(strict.statusCode).toBe(400);
  });
});
