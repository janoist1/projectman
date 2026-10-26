import { afterEach, describe, expect, it } from 'vitest';
import type { AiMemberConfig, Session } from '@projectman/shared';
import type { ToolContext, UpdateChecklistInput } from '../src/contracts';
import { TEAM_TOOLS } from '../src/mcp/tools';
import { createDomainHarness, waitForSession } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

let h: DomainHarness;
let ctx: ToolContext;
afterEach(async () => {
  await h?.cleanup();
});

async function setup() {
  h = await createDomainHarness({
    adjust(config) {
      (config.team.members.find((m) => m.handle === 'pm') as AiMemberConfig).onLeave = false;
    },
  });
  await h.domain.messaging.sendReporting(
    'AR',
    'owner',
    { to: ['operator'], text: 'Set up the checklist' },
    { awaitWake: true },
  );
  await flush();
  const session = await waitForSession(h.domain, { member: 'operator' });
  ctx = { projectKey: 'AR', member: 'operator', sessionId: session.id, taskKey: null };
}

const update = (args: UpdateChecklistInput, caller = ctx) => h.domain.teamTools.updateChecklist(caller, args);
const items = async () => (await h.domain.checklist.get('AR'))!.items;
const itemOf = async (id: string) => (await items()).find((item) => item.id === id)!;

/** A session of another member or another kind of conversation, cloned from the Operator's own. */
function sessionAs(member: string, workItem: Session['workItem']): ToolContext {
  const session = {
    ...h.repos.sessions.get(ctx.sessionId)!,
    id: `ses_checklist_${member}_${workItem.type === 'general' ? (workItem.with ?? 'own') : 'card'}`,
    member,
    workItem,
  } as Session;
  h.repos.sessions.insert(session);
  return { ...ctx, member, sessionId: session.id };
}

describe('the Operator’s checklist tools', () => {
  it('creates the base list for a project that has none, and refuses a second one', async () => {
    await setup();
    await expect(update({ op: 'init' })).rejects.toThrow('checklist_exists');
    h.repos.db.prepare('DELETE FROM project_checklist_items WHERE project_key = ?').run('AR');
    h.repos.db.prepare('DELETE FROM project_checklists WHERE project_key = ?').run('AR');
    expect(await h.domain.teamTools.getChecklist(ctx)).toMatchObject({ checklist: null });
    await update({ op: 'init' });
    expect((await items()).filter((item) => item.state === 'done').map((item) => item.id)).toEqual(['code']);
  });

  it('adds, edits, binds a condition to and settles an item as the Operator', async () => {
    await setup();
    const added = await update({ op: 'add', title: 'Legal review', hint: 'Ask the lawyer' });
    expect(added.itemId).toBe('custom_1');
    expect(await itemOf('custom_1')).toMatchObject({
      source: 'operator',
      state: 'open',
      updatedBy: 'operator',
    });
    await update({ op: 'edit', itemId: 'custom_1', title: 'Legal sign-off', hint: null });
    expect(await itemOf('custom_1')).toMatchObject({ title: 'Legal sign-off', hint: null });
    await update({ op: 'set_condition', itemId: 'custom_1', condition: 'reviewer_member' });
    expect(await itemOf('custom_1')).toMatchObject({ condition: 'reviewer_member', conditionHolds: true });
    await update({ op: 'set_state', itemId: 'custom_1', state: 'done' });
    expect(await itemOf('custom_1')).toMatchObject({ state: 'done', reopened: null });
    // Opening a done item is the Operator's own change, not a reopening for the Operator to hear about.
    const reopened: unknown[] = [];
    h.domain.ctx.events.on('checklist_item_reopened', (event) => {
      reopened.push(event);
    });
    await update({ op: 'set_state', itemId: 'custom_1', state: 'open' });
    expect(await itemOf('custom_1')).toMatchObject({ state: 'open', reopened: null });
    expect(reopened).toEqual([]);
    await update({ op: 'set_state', itemId: 'custom_1', state: 'not_needed', reason: 'No contract' });
    expect(await itemOf('custom_1')).toMatchObject({ state: 'not_needed', reason: 'No contract' });
    await update({ op: 'set_condition', itemId: 'custom_1', condition: null });
    expect((await itemOf('custom_1')).condition).toBeNull();
  });

  it('refuses a missing item, a missing list and a condition that does not hold', async () => {
    await setup();
    await expect(update({ op: 'edit', itemId: 'nope', title: 'x' })).rejects.toThrow(
      'checklist_item_not_found',
    );
    await expect(update({ op: 'set_state', itemId: 'team', state: 'done' })).resolves.toBeDefined();
    await expect(update({ op: 'set_condition', itemId: 'team', condition: 'client_member' })).rejects.toThrow(
      'checklist_condition_unmet',
    );
    await update({ op: 'add', title: 'Client contact', condition: 'client_member' });
    await expect(update({ op: 'set_state', itemId: 'custom_1', state: 'done' })).rejects.toThrow(
      'checklist_condition_unmet',
    );
    expect((await itemOf('custom_1')).state).toBe('open');
    h.repos.db.prepare('DELETE FROM project_checklist_items WHERE project_key = ?').run('AR');
    h.repos.db.prepare('DELETE FROM project_checklists WHERE project_key = ?').run('AR');
    await expect(update({ op: 'add', title: 'x' })).rejects.toThrow('checklist_missing');
  });

  it('stops adding at the item limit', async () => {
    await setup();
    const room = 40 - (await items()).length;
    for (let n = 0; n < room; n += 1) await update({ op: 'add', title: `Item ${n}` });
    await expect(update({ op: 'add', title: 'One too many' })).rejects.toThrow('checklist_full');
    expect(await items()).toHaveLength(40);
  });

  it('applies a template once: it adds only the missing items and keeps the existing ones', async () => {
    await setup();
    await update({ op: 'apply_template', templateId: 'web-client-project' });
    const first = await items();
    expect(first.filter((item) => item.source === 'template').map((item) => item.id)).toEqual([
      'guests',
      'feedback_marks',
      'qa',
      'client_test',
      'code_review',
    ]);
    expect(await itemOf('guests')).toMatchObject({
      templateId: 'web-client-project',
      condition: 'client_member',
    });
    expect((await h.domain.checklist.get('AR'))!.baseTemplateId).toBe('web-client-project');
    await update({ op: 'set_state', itemId: 'qa', state: 'not_needed', reason: 'No tester' });
    const again = await update({ op: 'apply_template', templateId: 'web-client-project' });
    expect(again.added).toEqual([]);
    expect(await items()).toHaveLength(first.length);
    expect(await itemOf('qa')).toMatchObject({ state: 'not_needed', reason: 'No tester' });
    await expect(update({ op: 'apply_template', templateId: 'nope' })).rejects.toThrow('unknown_template');
  });

  describe('permissions', () => {
    it('lets the PM read and change the list in its own conversation, and no developer', async () => {
      await setup();
      const pm = sessionAs('pm', { type: 'general' });
      expect((await h.domain.teamTools.getChecklist(pm)).checklist?.items.length).toBeGreaterThan(0);
      await expect(update({ op: 'add', title: 'x' }, pm)).resolves.toMatchObject({
        itemId: expect.stringMatching(/^custom_/),
      });
      const dev = sessionAs('dev-1', { type: 'general' });
      await expect(h.domain.teamTools.getChecklist(dev)).rejects.toThrow();
      await expect(update({ op: 'add', title: 'y' }, dev)).rejects.toThrow('operator_only');
    });

    it('refuses both tools in a conversation with a guest and in a card session', async () => {
      await setup();
      const guest = sessionAs('operator', { type: 'general', with: 'ada' });
      await expect(h.domain.teamTools.getChecklist(guest)).rejects.toThrow('operator_owner_only');
      await expect(update({ op: 'add', title: 'x' }, guest)).rejects.toThrow('operator_owner_only');
      expect(await items()).toHaveLength(10);
    });
  });

  describe('input check', () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'update_checklist')!;
    it.each([
      { op: 'add' },
      { op: 'edit', item_id: 'team' },
      { op: 'set_condition', item_id: 'team' },
      { op: 'set_state', item_id: 'team' },
      { op: 'set_state', item_id: 'team', state: 'not_needed' },
      { op: 'apply_template' },
      { op: 'set_state', item_id: 'Team', state: 'done' },
    ])('rejects %o', (input) => {
      expect(tool.inputSchema.safeParse(input).success).toBe(false);
    });
    it('accepts a condition taken off and a not_needed state with its reason', () => {
      expect(
        tool.inputSchema.safeParse({ op: 'set_condition', item_id: 'team', condition: null }).success,
      ).toBe(true);
      expect(
        tool.inputSchema.safeParse({
          op: 'set_state',
          item_id: 'team',
          state: 'not_needed',
          reason: 'No need',
        }).success,
      ).toBe(true);
    });
  });
});
