import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProvider, PlanUsage, ProjectConfig } from '@projectman/shared';
import type { ProviderStatus, RunnerModule } from '../src/contracts';
import { DomainError } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/** Members run on Claude Code or Codex: the domain passes the member's provider through. */

const CODEX_ID = '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b';
const general = { type: 'general' } as const;

function codexDev2(config: ProjectConfig): void {
  const dev2 = config.team.members.find((m) => m.handle === 'dev-2');
  if (dev2?.kind === 'ai') dev2.provider = 'codex';
}

function status(provider: AgentProvider, loggedIn: boolean | null): ProviderStatus {
  return {
    provider,
    loggedIn,
    method: loggedIn ? 'chatgpt' : 'none',
    checkedAt: '2026-01-01T00:00:00.000Z',
    ...(loggedIn ? {} : { detail: `${provider} is not logged in` }),
  };
}

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  return err as DomainError;
}

/** The fake runner module the domain was built with (the same object on every call). */
function moduleOf(h: DomainHarness): RunnerModule {
  return h.runnerModule.createWithBroker(h.runnerModule.broker());
}

describe('agent providers', () => {
  let h: DomainHarness;
  afterEach(() => h.cleanup());

  it('hires a Codex member and shows every AI member with its provider', async () => {
    h = await createDomainHarness();
    const hired = await h.domain.members.hire(
      'AR',
      { role: 'qa', provider: 'codex', effort: 'high' },
      { actor: OWNER_ACTOR, author: OWNER, sponsor: 'owner' },
    );
    expect(hired).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    const config = await h.domain.projects.config('AR');
    expect(config.team.members.find((m) => m.handle === hired.handle)).toMatchObject({ provider: 'codex' });

    const roster = await h.domain.members.roster('AR');
    expect(roster.find((m) => m.handle === hired.handle)?.provider).toBe('codex');
    expect(roster.find((m) => m.handle === 'dev-1')?.provider).toBe('claude');
    expect(roster.find((m) => m.kind === 'human')).not.toHaveProperty('provider');
  });

  it('switches providers, resets incompatible models and forwards effort to the runner', async () => {
    h = await createDomainHarness();
    const update = (body: import('@projectman/shared').UpdateMemberRequest) =>
      h.domain.members.update('AR', 'dev-2', body, { actor: OWNER_ACTOR, author: OWNER });
    expect(await update({ provider: 'codex', effort: 'xhigh' })).toMatchObject({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
    });
    await h.domain.sessions.ensureSession('AR', 'dev-2', general);
    expect(h.runner.lastStarted()).toMatchObject({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
    });
    expect(await update({ model: 'fictional-codex-model' })).toMatchObject({
      model: 'fictional-codex-model',
    });
    expect(await update({ specialty: 'backend' })).toMatchObject({
      provider: 'codex',
      effort: 'xhigh',
      model: 'fictional-codex-model',
    });
    expect(await update({ provider: 'claude' })).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(await update({ provider: 'codex', model: 'gpt-6-luna' })).toMatchObject({ model: 'gpt-6-luna' });
    expect(await update({ provider: 'claude', model: 'sonnet' })).toMatchObject({ model: 'sonnet' });
  });

  it('retains compatible custom ids and rejects AI settings on humans', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        const member = config.team.members.find((m) => m.handle === 'dev-2');
        if (member?.kind === 'ai') member.model = 'fictional-codex-model';
      },
    });
    expect(
      await h.domain.members.update(
        'AR',
        'dev-2',
        { provider: 'codex' },
        { actor: OWNER_ACTOR, author: OWNER },
      ),
    ).toMatchObject({ provider: 'codex', model: 'fictional-codex-model' });
    for (const body of [{ provider: 'codex' }, { effort: 'high' }] as const) {
      expect(
        await failure(h.domain.members.update('AR', 'owner', body, { actor: OWNER_ACTOR, author: OWNER })),
      ).toMatchObject({ code: 'not_ai_member' });
    }
  });

  it('starts each member on its own provider', async () => {
    h = await createDomainHarness({ adjust: codexDev2 });
    await h.domain.sessions.ensureSession('AR', 'dev-2', general);
    expect(h.runner.lastStarted()).toMatchObject({ provider: 'codex', resume: false });
    await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    expect(h.runner.lastStarted()).toMatchObject({ provider: 'claude' });
  });

  it('refuses to start a session while the provider is not logged in', async () => {
    h = await createDomainHarness({ adjust: codexDev2 });
    Object.assign(h.runner, {
      providerStatus: async (provider: AgentProvider) => status(provider, provider !== 'codex'),
    });
    const err = await failure(h.domain.sessions.ensureSession('AR', 'dev-2', general));
    expect(err).toMatchObject({
      code: 'provider_not_logged_in',
      status: 409,
      details: { provider: 'codex', method: 'none' },
    });
    expect(h.runner.started).toEqual([]);
    expect(h.domain.sessions.list('AR', { member: 'dev-2' })).toEqual([]);
    // The Claude member is not affected.
    await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    expect(h.runner.started).toHaveLength(1);
  });

  it('maps a refusal by the runner itself to the same error', async () => {
    h = await createDomainHarness({ adjust: codexDev2 });
    h.runner.failNextStart = Object.assign(new Error('Codex is not logged in with a subscription'), {
      code: 'provider_not_logged_in',
    });
    const err = await failure(h.domain.sessions.ensureSession('AR', 'dev-2', general));
    expect(err).toMatchObject({ code: 'provider_not_logged_in', details: { provider: 'codex' } });
  });

  it('keeps the conversation id Codex reports and resumes it', async () => {
    h = await createDomainHarness({ adjust: codexDev2 });
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-2', general);
    const transcript = `/home/anna/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${CODEX_ID}.jsonl`;
    h.runner.emit({ type: 'provider_session_id', sessionId: session.id, providerSessionId: CODEX_ID });
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: transcript });
    expect(h.domain.sessions.get('AR', session.id)).toMatchObject({
      claudeSessionId: CODEX_ID,
      transcriptPath: transcript,
    });

    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
    await h.domain.sessions.ensureSession('AR', 'dev-2', general);
    expect(h.runner.lastStarted()).toMatchObject({
      provider: 'codex',
      resume: true,
      claudeSessionId: CODEX_ID,
    });
  });

  it('does not resume a conversation of another provider', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-2', general);
    h.runner.emit({
      type: 'transcript_path',
      sessionId: session.id,
      path: `/home/anna/.claude/projects/-w/${session.claudeSessionId}.jsonl`,
    });
    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      codexDev2(draft);
      return 'Run dev-2 on Codex';
    });
    await h.domain.sessions.ensureSession('AR', 'dev-2', general);
    expect(h.runner.lastStarted()).toMatchObject({ provider: 'codex', resume: false });
  });

  it('keeps the reason of a session that lost its login', async () => {
    h = await createDomainHarness({ adjust: codexDev2 });
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-2', general);
    h.runner.emit({
      type: 'auth_error',
      sessionId: session.id,
      provider: 'codex',
      message: 'Please sign in again.',
    });
    h.runner.setState(session.id, 'failed', 'Please sign in again.');
    expect(h.domain.sessions.get('AR', session.id)).toMatchObject({
      state: 'failed',
      activity: 'Please sign in again.',
    });
    const ended = h.domain.timeline.list('AR', { limit: 50 }).find((e) => e.type === 'session_ended');
    expect(ended?.data).toMatchObject({ member: 'dev-2', exitCode: 1, reason: 'Please sign in again.' });
    expect(h.log.warnings.some((w) => /lost its login/.test(JSON.stringify(w)))).toBe(true);
  });

  it("pauses new work on the plan usage of the member's own provider", async () => {
    h = await createDomainHarness({ adjust: codexDev2 });
    const codexUsage: PlanUsage = {
      fiveHourPercent: null,
      weeklyPercent: 95,
      fiveHourResetsAt: null,
      weeklyResetsAt: '2026-01-07T00:00:00.000Z',
      fetchedAt: '2026-01-01T00:00:00.000Z',
    };
    moduleOf(h).planUsageFor = (provider) => ({
      get: async () => (provider === 'codex' ? codexUsage : null),
    });
    const first = await h.domain.tasks.create('AR', { title: 'Codex task' }, OWNER_ACTOR);
    const start = (key: string, assignee: string) =>
      h.domain.scheduler.startTask('AR', key, {
        assignee,
        actor: OWNER_ACTOR,
        author: OWNER,
        sponsor: 'owner',
      });
    const err = await failure(start(first.key, 'dev-2'));
    expect(err).toMatchObject({ code: 'plan_usage_paused', details: { percent: 95, provider: 'codex' } });

    // Claude's plan is unknown here, so a Claude member may start.
    const second = await h.domain.tasks.create('AR', { title: 'Claude task' }, OWNER_ACTOR);
    expect((await start(second.key, 'dev-1')).session).not.toBeNull();
    expect(await h.domain.planUsage.get('codex')).toEqual(codexUsage);
    expect(await h.domain.planUsage.get()).toBeNull();
  });
});
