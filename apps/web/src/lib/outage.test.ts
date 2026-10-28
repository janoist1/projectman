import type { InboxItem, MemberView, Task, WorkOutage } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { members as fixtureMembers, tasks } from '../mocks/fixtures';
import { mockIndexes } from '../test/render';
import { memberStatusView } from './members';
import { outageEndedToast, outageHeading, outageReason, outageStuckLabel, outageStuckTitle } from './outage';
import { deriveTaskState, groupOpenInboxByTask, matchesFilter, phaseOrder } from './taskState';
import type { TaskStateContext } from './taskState';

const since = '2026-10-08T08:00:00.000Z';
const ENGINE = { id: 'eng_abcdefghijkl', name: 'Mac mini' };

const claude: WorkOutage = {
  kind: 'provider',
  id: 'out_claude',
  provider: 'claude',
  problem: 'not_logged_in',
  engine: null,
  since,
};
const claudeRemote: WorkOutage = { ...claude, engine: ENGINE };
const nanogpt: WorkOutage = { ...claude, id: 'out_nano', provider: 'nanogpt', problem: 'no_key' };
const engine: WorkOutage = { kind: 'engine', id: 'out_engine', engine: ENGINE, since };

const member = (handle: string): MemberView => fixtureMembers.find((entry) => entry.handle === handle)!;
const claudeText = t('providers.claude');

describe('the words of an outage (PM-468)', () => {
  it('heads a Claude, a NanoGPT and an engine outage, and names the engine of a remote one', () => {
    expect(outageHeading(claude)).toBe(
      t('inbox.alerts.work_outage.headings.not_logged_in', { provider: claudeText }),
    );
    expect(outageHeading(nanogpt)).toBe(t('inbox.alerts.work_outage.headings.no_key'));
    expect(outageHeading(engine)).toBe(
      t('inbox.alerts.work_outage.headings.engine', { engine: ENGINE.name }),
    );
    expect(outageHeading(claudeRemote)).toContain(ENGINE.name);
  });

  it('gives the reason of a member or a card in a few words, with the engine when it is remote', () => {
    expect(outageReason(claude)).toBe(
      t('inbox.alerts.work_outage.reasons.not_logged_in', { provider: claudeText }),
    );
    expect(outageReason(claudeRemote)).toContain(ENGINE.name);
    expect(outageReason(engine)).toBe(t('inbox.alerts.work_outage.reasons.engine', { engine: ENGINE.name }));
  });

  it('tells a card what stands and, as its tooltip, what to do', () => {
    expect(outageStuckLabel(claude)).toBe(t('taskStatus.stuck', { reason: outageReason(claude) }));
    expect(outageStuckTitle(claude)).toContain(t('providerSettings.loginCommands.claude'));
    expect(outageStuckTitle(claudeRemote)).toContain(ENGINE.name);
    expect(outageStuckTitle(nanogpt)).toBe(t('taskStatus.stuckTodo.settings'));
    expect(outageStuckTitle(engine)).toBe(t('taskStatus.stuckTodo.engine'));
  });
});

describe('the toast of an outage that ended by itself (PM-468)', () => {
  const alert = (outage: WorkOutage, cards: string[]): InboxItem => ({
    id: 'inb_outage',
    projectKey: 'AC',
    kind: 'alert',
    assignees: ['owner'],
    source: 'system',
    sessionId: null,
    taskKey: null,
    title: 'An outage',
    body: null,
    payload: { alert: 'work_outage', outage, members: ['fe-1'], tasks: cards, checkedAt: since },
    options: [{ id: 'seen', label: 'Láttam', style: 'secondary' }],
    state: 'resolved',
    resolution: { optionId: 'seen', by: 'system', at: since, note: null, rule: 'outage_ended' },
    createdAt: since,
  });

  it('says the provider is usable again, and that the waiting work started only when cards waited', () => {
    expect(outageEndedToast(alert(claude, ['AC-24']), 'owner')).toBe(
      `${t('inbox.alerts.work_outage.providerBack', { provider: claudeText })} ${t('inbox.alerts.work_outage.workStarted')}`,
    );
    expect(outageEndedToast(alert(claude, []), 'owner')).toBe(
      t('inbox.alerts.work_outage.providerBack', { provider: claudeText }),
    );
  });

  it('says the engine connects again', () => {
    expect(outageEndedToast(alert(engine, []), 'owner')).toBe(
      t('inbox.alerts.work_outage.engineBack', { engine: ENGINE.name }),
    );
  });

  it('is for the assignee only, and for a closed outage only', () => {
    expect(outageEndedToast(alert(claude, []), 'bence')).toBeNull();
    expect(outageEndedToast(alert(claude, []), null)).toBeNull();
    expect(outageEndedToast({ ...alert(claude, []), state: 'open', resolution: null }, 'owner')).toBeNull();
    const seen = alert(claude, []);
    expect(
      outageEndedToast({ ...seen, resolution: { ...seen.resolution!, rule: undefined } }, 'owner'),
    ).toBeNull();
  });
});

describe('the status "Nem tud dolgozni" (PM-468)', () => {
  const worker = member('be-1');
  const stuck: MemberView = { ...worker, outage: claudeRemote };

  it('reads the outage with its reason for an AI member', () => {
    expect(memberStatusView(stuck, [], 'owner')).toEqual({
      status: 'cannot_work',
      label: t('memberStatus.cannotWork'),
      reason: outageReason(claudeRemote),
    });
  });

  it('keeps a pause above it and leave above it, and goes before "Rád vár" and the working state', () => {
    expect(memberStatusView(stuck, [], 'owner', []).status).toBe('paused');
    const away: MemberView = { ...stuck, status: 'offline', onLeave: true };
    expect(memberStatusView(away, [], 'owner', []).status).toBe('offline');
    const waiting: MemberView = { ...stuck, status: 'waiting_for_human' };
    const ask = { source: 'be-1', state: 'open', assignees: ['owner'] } as InboxItem;
    expect(memberStatusView(waiting, [ask], 'owner').status).toBe('cannot_work');
    expect(memberStatusView(worker, [], 'owner').status).toBe('working');
  });

  it('leaves a human member alone', () => {
    const human: MemberView = { ...member('owner'), outage: claude };
    expect(memberStatusView(human, [], 'owner').status).toBe(member('owner').status);
  });
});

describe('a card that stands on an outage (PM-468)', () => {
  const { pipeline, members } = mockIndexes();
  const ctx: TaskStateContext = {
    pipeline,
    members,
    openInboxByTask: groupOpenInboxByTask([]),
    tasksByKey: new Map(tasks.map((entry) => [entry.key, entry])),
    myHandle: 'owner',
  };
  const card = (patch: Partial<Task>): Task => ({ ...tasks[0]!, ...patch });

  it('is "stuck" with the reason as its line and what to do as its tooltip', () => {
    const state = deriveTaskState(card({ outage: claude }), ctx);
    expect(state.phase).toBe('stuck');
    expect(state.label).toBe(outageStuckLabel(claude));
    expect(state.title).toBe(outageStuckTitle(claude));
  });

  it('stands the same for a start that waits and for a continuation that has no waiting start', () => {
    const waiting = card({ outage: claude, startWaiting: { reason: 'provider_not_logged_in', since } });
    expect(deriveTaskState(waiting, ctx).phase).toBe('stuck');
    expect(deriveTaskState(card({ outage: engine, status: 'active' }), ctx).phase).toBe('stuck');
  });

  it('is not "needs you": the filter and the order leave it with the waiting cards', () => {
    expect(matchesFilter('stuck', 'needsYou')).toBe(false);
    expect(matchesFilter('stuck', 'waiting')).toBe(true);
    expect(phaseOrder.stuck).toBeGreaterThan(phaseOrder.needs_you);
  });
});
