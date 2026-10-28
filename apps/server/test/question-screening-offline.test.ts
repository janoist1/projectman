import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_ENGINE_ID, QUESTION_SCREENING_MS, questionPayloadOf } from '@projectman/shared';
import type { EngineId, MemberHandle, ProjectConfig } from '@projectman/shared';
import type { EngineDirectory, EngineHost, ToolContext } from '../src/contracts';
import { createLocalEngine } from '../src/engine-host';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { capturingLogger, FakeWorktreeManager, settle } from './helpers/fakes';
import { aiActor } from '../src/kernel';

const START = new Date('2026-10-13T10:00:00.000Z');
const REMOTE: EngineId = 'eng_abcdefghijkl';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Engines that come and go; a member is placed on one of them (the PM lives on the Mac). */
class TestEngines implements EngineDirectory {
  readonly hosts = new Map<EngineId, EngineHost>();
  readonly online = new Set<EngineId>();
  readonly placement = new Map<MemberHandle, EngineId | null>();
  private readonly listeners = new Set<(id: EngineId, online: boolean) => void>();

  add(host: EngineHost): void {
    this.hosts.set(host.id, host);
    this.online.add(host.id);
  }
  setOnline(id: EngineId, online: boolean): void {
    if (online) this.online.add(id);
    else this.online.delete(id);
    for (const listener of this.listeners) listener(id, online);
  }
  get(id: EngineId): EngineHost | null {
    return this.online.has(id) ? (this.hosts.get(id) ?? null) : null;
  }
  ids(): EngineId[] {
    return [...this.hosts.keys()];
  }
  engineFor(_projectKey: string, member: MemberHandle): EngineId | null {
    return this.placement.has(member) ? this.placement.get(member)! : LOCAL_ENGINE_ID;
  }
  projectEngine(_projectKey: string): EngineId | null {
    return LOCAL_ENGINE_ID;
  }
  hostEngine(): EngineId | null {
    return LOCAL_ENGINE_ID;
  }
  onChange(listener: (id: EngineId, online: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function withPm(config: ProjectConfig): void {
  const pm = config.team.members.find((m) => m.handle === 'pm')!;
  if (pm.kind === 'ai') pm.onLeave = false;
  config.team.limits.loopWatch = { enabled: true, count: 3, minutes: 240 };
}

/**
 * PM-708: the PM runs on a Mac that is often off. A screened question waits for it, with its time held,
 * and nobody is asked because of that; the ten minutes run only after the PM got the question.
 */
describe('question screening while the PM’s machine is offline', () => {
  let h: DomainHarness;
  let now: Date;
  let root: string;
  let engines: TestEngines;
  let dev: ToolContext;

  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const host = (id: EngineId, workspace: string): EngineHost => {
    const engine = createLocalEngine(
      {
        worktrees: new FakeWorktreeManager(join(root, id, 'worktrees')),
        workspacePath: () => workspace,
        freeDiskBytes: async () => null,
        worktreesRootDir: join(root, id, 'worktrees'),
        claudeTmpRoots: [],
      },
      capturingLogger().logger,
    );
    return { ...engine, id };
  };

  beforeEach(async () => {
    now = new Date(START);
    root = mkdtempSync(join(tmpdir(), 'pm-screening-offline-'));
    engines = new TestEngines();
    for (const id of [LOCAL_ENGINE_ID, REMOTE]) {
      const workspace = join(root, `${id}-workspace`);
      mkdirSync(workspace);
      engines.add(host(id, workspace));
    }
    engines.placement.set('pm', REMOTE);
    h = await createDomainHarness({ screenQuestions: true, now: () => now, adjust: withPm, engines });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    dev = { sessionId: started.session!.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
    await settle();
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  const item = (id: string) => h.domain.inbox.get('AR', id);
  const screeningOf = (id: string) => questionPayloadOf(item(id))?.screening;
  const pmSessions = () => h.domain.sessions.list('AR', { member: 'pm' });
  const humanQueue = () => h.domain.inbox.list('AR', { state: 'open', kind: 'question' });
  const skipped = () =>
    h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((e) => e.type === 'question_screening_skipped');
  const sweep = async () => {
    await h.domain.questionScreening.sweep();
    await settle();
  };
  const setOnline = async (online: boolean) => {
    engines.setOnline(REMOTE, online);
    await settle();
    await sweep();
  };
  async function ask(question = 'Which font?') {
    const result = await h.domain.teamTools.askHuman(dev, { question, options: ['Yes', 'No'] });
    await settle();
    return result.inboxItemId;
  }
  /** The engine row the registry keeps, with the last moment the server saw the Mac. */
  function seenAt(at: Date): void {
    const repos = h.repos;
    if (!repos.users.get('usr_t'))
      repos.users.insert({
        id: 'usr_t',
        name: 't',
        email: 't@example.test',
        passwordHash: '',
        createdAt: START.toISOString(),
      });
    if (!repos.engines.get(REMOTE))
      repos.engines.create({
        id: REMOTE,
        name: 'Mac',
        hash: 'hash',
        prefix: 'pme_',
        userId: 'usr_t',
        at: START.toISOString(),
      });
    repos.engines.seen(REMOTE, at.toISOString(), '127.0.0.1');
  }

  it('holds a new question for a machine that is away: no PM, no person, no skip, any number of hours', async () => {
    await setOnline(false);
    const id = await ask();

    expect(item(id).state).toBe('screening');
    expect(screeningOf(id)?.queue).toEqual({
      reason: 'engine_offline',
      since: START.toISOString(),
      remainingMs: QUESTION_SCREENING_MS,
    });
    expect(pmSessions()).toHaveLength(0);

    advance(5 * HOUR);
    await sweep();

    expect(item(id).state).toBe('screening');
    expect(screeningOf(id)?.queue?.remainingMs).toBe(QUESTION_SCREENING_MS);
    expect(humanQueue()).toEqual([]);
    expect(skipped()).toEqual([]);
    expect(pmSessions()).toHaveLength(0);
  });

  it('delivers the held question once when the machine is back, and starts the ten minutes from the receipt', async () => {
    await setOnline(false);
    const id = await ask();
    advance(3 * HOUR);
    await sweep();

    await setOnline(true);
    await setOnline(true);

    expect(pmSessions()).toHaveLength(1);
    expect(h.runner.started.filter((s) => s.member === 'pm')).toHaveLength(1);
    const screening = screeningOf(id)!;
    expect(screening.queue).toBeUndefined();
    expect(screening.deliveredAt).toBe(now.toISOString());
    expect(screening.until).toBe(new Date(now.getTime() + QUESTION_SCREENING_MS).toISOString());
    expect(item(id).state).toBe('screening');

    advance(9 * MINUTE);
    await sweep();
    expect(item(id).state).toBe('screening');
    advance(2 * MINUTE);
    await sweep();
    expect(item(id).state).toBe('open');
    expect(screeningOf(id)).toMatchObject({ fallback: 'timeout' });
  });

  it('freezes what is left of a delivered question when the machine goes away, and unfreezes it on return', async () => {
    const id = await ask();
    expect(screeningOf(id)?.deliveredAt).toBe(START.toISOString());

    advance(4 * MINUTE);
    seenAt(now);
    await setOnline(false);
    expect(screeningOf(id)?.queue).toMatchObject({ reason: 'engine_offline', remainingMs: 6 * MINUTE });

    advance(8 * HOUR);
    await sweep();
    expect(item(id).state).toBe('screening');

    await setOnline(true);
    expect(screeningOf(id)?.queue).toBeUndefined();
    expect(screeningOf(id)?.until).toBe(new Date(now.getTime() + 6 * MINUTE).toISOString());
    // Not a new delivery, and not a new ten minutes.
    expect(h.runner.started.filter((s) => s.member === 'pm')).toHaveLength(1);

    advance(5 * MINUTE);
    await sweep();
    expect(item(id).state).toBe('screening');
    advance(2 * MINUTE);
    await sweep();
    expect(item(id).state).toBe('open');
  });

  it('keeps a delivered question with no online evidence at zero, and sends it to the people on return', async () => {
    const id = await ask();
    // No engine record at all: nothing says when the machine was last online.
    await setOnline(false);
    expect(screeningOf(id)?.queue).toMatchObject({ remainingMs: 0 });
    advance(HOUR);
    await sweep();
    expect(item(id).state).toBe('screening');

    await setOnline(true);

    expect(item(id).state).toBe('open');
    expect(screeningOf(id)).toMatchObject({ fallback: 'timeout' });
  });

  it('holds an old screening row that has no queue: undelivered keeps ten minutes, delivered counts from the last online moment', async () => {
    await setOnline(false);
    const old = (title: string, screening: Record<string, unknown>) =>
      h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        assignees: ['owner'],
        source: 'dev-1',
        sessionId: null,
        taskKey: null,
        title,
        state: 'screening',
        payload: { question: title, screening },
        options: [],
      });
    const until = new Date(START.getTime() + 10 * MINUTE).toISOString();
    const fresh = old('Undelivered', { until: new Date(START.getTime() - HOUR).toISOString() });
    const delivered = old('Delivered', { until, deliveredAt: START.toISOString() });
    seenAt(new Date(START.getTime() + 7 * MINUTE));

    await sweep();

    expect(screeningOf(fresh.id)?.queue?.remainingMs).toBe(QUESTION_SCREENING_MS);
    expect(screeningOf(delivered.id)?.queue?.remainingMs).toBe(3 * MINUTE);
    expect(humanQueue()).toEqual([]);
  });

  it('does not overwrite a valid queue at startup or on a later sweep', async () => {
    await setOnline(false);
    const held = h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      assignees: ['owner'],
      source: 'dev-1',
      sessionId: null,
      taskKey: null,
      title: 'Held',
      state: 'screening',
      payload: {
        question: 'Held',
        screening: {
          until: START.toISOString(),
          deliveredAt: START.toISOString(),
          queue: { reason: 'engine_offline', since: START.toISOString(), remainingMs: 1234 },
        },
      },
      options: [],
    });
    seenAt(new Date(START.getTime() + 9 * MINUTE));

    await sweep();
    await sweep();

    expect(screeningOf(held.id)?.queue).toEqual({
      reason: 'engine_offline',
      since: START.toISOString(),
      remainingMs: 1234,
    });
  });

  it('treats a machine nobody chose like an offline one', async () => {
    engines.placement.set('pm', null);
    const id = await ask();

    expect(screeningOf(id)?.queue?.remainingMs).toBe(QUESTION_SCREENING_MS);
    advance(2 * HOUR);
    await sweep();
    expect(item(id).state).toBe('screening');
    expect(skipped()).toEqual([]);
  });

  it('still gives the question to the people at once when the PM cannot take it for another reason', async () => {
    await setOnline(false);
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.team.limits.aiEnabled = false;
      return 'Switch AI work off';
    });
    const id = await ask();

    expect(item(id).state).toBe('open');
    expect(screeningOf(id)).toMatchObject({ fallback: 'unavailable' });
    expect(skipped()).toHaveLength(1);
  });

  it('holds the question, and does not release it, when the first input fails because the machine dropped', async () => {
    h.runner.holdFirstInput = true;
    const id = await ask();
    await vi.waitFor(() => expect(pmSessions()).toHaveLength(1));
    expect(screeningOf(id)?.deliveredAt).toBeUndefined();

    engines.online.delete(REMOTE);
    await h.domain.sessions.stop('AR', pmSessions()[0]!.id);
    await settle();

    expect(item(id).state).toBe('screening');
    expect(screeningOf(id)?.deliveredAt).toBeUndefined();
    expect(screeningOf(id)?.queue).toMatchObject({ remainingMs: QUESTION_SCREENING_MS });
    expect(skipped()).toEqual([]);
  });

  it('does not deliver a held question that was withdrawn meanwhile', async () => {
    await setOnline(false);
    const id = await ask();
    await h.domain.teamTools.withdrawQuestion(dev, { itemId: id, reason: 'No longer needed' });

    await setOnline(true);

    expect(item(id).state).toBe('cancelled');
    expect(pmSessions()).toHaveLength(0);
  });

  describe('loop triage queue and deadline (PM-712)', () => {
    const loop = () => h.repos.taskLoops.open('AR-1');
    const signals = () => h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'loop_suspected');
    const decisions = () => h.domain.inbox.list('AR', { kind: 'decision', taskKey: 'AR-1' });
    async function candidate() {
      for (const from of ['dev-1', 'cr', 'dev-1']) {
        advance(1000);
        h.domain.timeline.append({
          projectKey: 'AR',
          taskKey: 'AR-1',
          actor: aiActor(from),
          type: 'team_message',
          data: {
            messageId: `msg-${now.getTime()}`,
            from,
            to: [from === 'cr' ? 'dev-1' : 'cr'],
            excerpt: 'RAW_LOOP_SENTINEL',
          },
        });
        await settle();
      }
      await h.domain.loopWatch.sweep();
    }
    it('holds a queued candidate offline for hours, then delivers it once on reconnect', async () => {
      await setOnline(false);
      await candidate();
      expect(loop()!.triage!.deadline).toBeUndefined();
      expect(signals()).toHaveLength(1);
      expect(signals()[0]!.deliveredAt).toBeNull();
      advance(2 * HOUR);
      await h.domain.loopWatch.sweep();
      expect(decisions()).toEqual([]);
      expect(pmSessions()).toEqual([]);
      await setOnline(true);
      await h.domain.loopWatch.sweep();
      await setOnline(true);
      await h.domain.loopWatch.sweep();
      expect(signals()).toHaveLength(1);
      expect(signals()[0]!.deliveredAt).not.toBeNull();
      expect(loop()!.triage!.deadline!.remainingMs).toBe(10 * MINUTE);
      expect(pmSessions()).toHaveLength(1);
      expect(decisions()).toEqual([]);
      const text = h.runner.started
        .filter((s) => s.member === 'pm')
        .map((s) => s.initialMessage)
        .join('');
      expect(text).toContain('triage_loop');
      expect(text).not.toContain('RAW_LOOP_SENTINEL');
      expect(text).not.toContain('outputTail');
      expect(text).not.toContain('transcript');
    });

    it('holds the signal when the engine drops before first input succeeds', async () => {
      h.runner.holdFirstInput = true;
      const pending = candidate();
      await vi.waitFor(() => expect(pmSessions()).toHaveLength(1));
      expect(signals()[0]!.deliveredAt).toBeNull();
      engines.online.delete(REMOTE);
      await h.domain.sessions.stop('AR', pmSessions()[0]!.id);
      await pending;
      expect(loop()!.phase).toBe('notified');
      expect(signals()[0]!.deliveredAt).toBeNull();
      expect(loop()!.triage!.deadline).toBeUndefined();
      expect(decisions()).toEqual([]);
    });

    it('freezes the delivered deadline using durable last-seen time and resumes the remaining budget', async () => {
      await candidate();
      advance(4 * MINUTE);
      seenAt(now);
      await setOnline(false);
      expect(loop()!.triage!.deadline).toEqual({ remainingMs: 6 * MINUTE, resumedAt: null });
      advance(2 * HOUR);
      await h.domain.loopWatch.sweep();
      expect(decisions()).toEqual([]);
      expect(loop()!.triage!.deadline).toEqual({ remainingMs: 6 * MINUTE, resumedAt: null });
      await setOnline(true);
      advance(5 * MINUTE);
      await h.domain.loopWatch.sweep();
      expect(decisions()).toEqual([]);
      advance(MINUTE);
      await h.domain.loopWatch.sweep();
      await h.domain.loopWatch.sweep();
      expect(decisions()).toHaveLength(1);
      expect(loop()!.phase).toBe('owner');
    });

    it('resolves a progressed queued candidate before reconnect can wake the PM', async () => {
      await setOnline(false);
      await candidate();
      await h.domain.tasks.addNote('AR', 'AR-1', 'The review fix is ready.', aiActor('dev-1'));
      await settle();
      await setOnline(true);
      expect(loop()).toBeNull();
      expect(signals()[0]!.state).toBe('resolved');
      expect(pmSessions()).toEqual([]);
      expect(decisions()).toEqual([]);
    });
  });

  it('releases a question whose record cannot be read instead of holding it unseen', async () => {
    await setOnline(false);
    const broken = h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      assignees: ['owner'],
      source: 'dev-1',
      sessionId: null,
      taskKey: null,
      title: 'Broken',
      state: 'screening',
      payload: {
        question: 'Broken',
        screening: { until: START.toISOString(), queue: { reason: 'engine_offline', remainingMs: -5 } },
      },
      options: [],
    });

    await sweep();

    expect(item(broken.id).state).toBe('open');
    expect(humanQueue().map((q) => q.id)).toContain(broken.id);
  });

  it('holds a combined decision once while offline and resumes only its earliest remaining deadline', async () => {
    const first = await ask('First equivalent decision?');
    advance(2 * MINUTE);
    const second = await ask('Second equivalent decision?');
    const group = await h.domain.teamTools.combineQuestions(
      { projectKey: 'AR', member: 'pm', taskKey: null, sessionId: pmSessions()[0]!.id },
      { itemIds: [first, second], question: 'Shared decision?', note: 'Same scope' },
    );
    seenAt(now);
    await setOnline(false);
    expect(screeningOf(group.primaryItemId)?.queue?.remainingMs).toBe(8 * MINUTE);
    advance(4 * HOUR);
    await sweep();
    expect(humanQueue()).toHaveLength(0);
    await setOnline(true);
    expect(screeningOf(group.primaryItemId)?.until).toBe(new Date(now.getTime() + 8 * MINUTE).toISOString());
    advance(8 * MINUTE + 1);
    await sweep();
    expect(humanQueue().map((item) => item.id)).toEqual([group.primaryItemId]);
    expect(h.repos.inbox.get(group.linkedItemIds[0]!)!.state).toBe('screening');
  });

  it('preserves the minimum queued group budget until its first delivery receipt', async () => {
    await setOnline(false);
    const first = await ask('First equivalent decision?');
    advance(MINUTE);
    const second = await ask('Second equivalent decision?');
    for (const [id, remainingMs] of [
      [first, 5 * MINUTE],
      [second, MINUTE],
    ] as const) {
      const current = h.repos.inbox.get(id)!;
      h.repos.inbox.updatePayload(
        id,
        {
          ...current.payload,
          screening: {
            ...screeningOf(id),
            queue: { reason: 'engine_offline', since: now.toISOString(), remainingMs },
          },
        },
        now.toISOString(),
      );
    }
    const group = await h.domain.inbox.combineQuestions(
      'AR',
      { itemIds: [first, second], question: 'Shared decision?', note: 'Same scope' },
      'pm',
    );
    advance(4 * HOUR);
    await sweep();
    expect(humanQueue()).toHaveLength(0);
    await setOnline(true);
    expect(screeningOf(group.primaryItemId)?.until).toBe(new Date(now.getTime() + MINUTE).toISOString());
    expect(screeningOf(group.primaryItemId)?.queue).toBeUndefined();
    const notices = h.runner.started
      .filter((s) => s.sessionId === pmSessions()[0]!.id)
      .map((s) => s.initialMessage ?? '');
    expect(notices.join('\n')).toContain('Shared decision?');
    expect(notices.join('\n')).not.toContain(`"id":"${group.linkedItemIds[0]}"`);
  });
});
