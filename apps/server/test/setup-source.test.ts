import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isProjectManager, memberOf, SETUP_SOURCE_NONE_OPTION } from '@projectman/shared';
import type { AiMemberConfig, InboxItem, ProjectConfig } from '@projectman/shared';
import { getLocale, getTemplate } from '@projectman/templates';
import type { EngineDirectory, EngineHost, ToolContext } from '../src/contracts';
import { canSeeInboxItem, canSeeProjectEvent } from '../src/core/projects';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { seedProjectManagerRequest } from './helpers/operator-session';

let h: DomainHarness;
let ctx: ToolContext;
afterEach(async () => {
  await h?.cleanup();
});

/** A second owner of this project, who owns the other project too (PM-1487). */
const CO_OWNER = {
  kind: 'human',
  handle: 'co-owner',
  displayName: 'Co-owner',
  email: 'co-owner@example.test',
  access: 'owner',
  roles: [],
} as const;

// The test template's project manager is on leave; the tool surface is its alone. A developer and a guest of
// the project manager are there for the refusals.
const adjust = (config: ProjectConfig) => {
  (memberOf(config, 'pm') as AiMemberConfig).onLeave = false;
  config.team.members.push(
    { ...CO_OWNER, roles: [] },
    {
      kind: 'human',
      handle: 'dana',
      displayName: 'Dana',
      email: 'dana@example.test',
      access: 'developer',
      roles: [],
    },
    { kind: 'human', handle: 'guest', displayName: 'Guest', access: 'client', roles: [] },
  );
};

async function setup(
  others: { key: string; owner: { name: string; email: string } }[] = [],
  engines?: EngineDirectory,
) {
  h = await createDomainHarness({ adjust, ...(engines ? { engines } : {}) });
  for (const other of others) {
    const workspace = join(h.dir, other.key.toLowerCase());
    mkdirSync(workspace);
    await h.domain.projects.create(
      { key: other.key, name: `Project ${other.key}`, workspacePath: workspace, templateId: 'test' },
      other.owner,
    );
  }
  const { session } = seedProjectManagerRequest(h, 'AR', { member: 'pm', text: 'Set the project up.' });
  ctx = { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null };
}

const MINE = { key: 'BX', owner: OWNER };
const FOREIGN = { key: 'CX', owner: { name: 'Someone else', email: 'someone@example.com' } };

/** The answer as the store keeps it; `at` and the fields that say who really answered vary per case. */
const close = (item: string, resolution: Partial<NonNullable<InboxItem['resolution']>>) => {
  const at = new Date().toISOString();
  h.repos.inbox.close(item, 'resolved', { optionId: 'BX', by: 'owner', at, note: null, ...resolution }, at);
};

describe('preview_template (PM-1463)', () => {
  it("builds the template from this project's language and names no person or folder", async () => {
    await setup();
    const config = h.domain.projects.cachedConfig('AR')!;
    const list = await h.domain.teamTools.previewTemplate(ctx, {});
    expect('templates' in list && list.templates.map((t) => t.id)).toContain('small-team');

    const preview = await h.domain.teamTools.previewTemplate(ctx, { templateId: 'small-team' });
    const built = getTemplate('small-team')!.build({
      key: 'AR',
      name: config.project.name,
      workspacePath: config.project.workspacePath,
      language: config.project.language,
      owner: { handle: 'owner', displayName: OWNER.name, email: OWNER.email },
    });
    const titles = getLocale(config.project.language).checklist.items;
    expect(preview).toMatchObject({
      templateId: 'small-team',
      stages: built.pipeline.stages.map((stage) =>
        expect.objectContaining({ id: stage.id, name: stage.name }),
      ),
      checklist: getTemplate('small-team')!.checklist.map((item) => titles[item.id].title),
    });
    const text = JSON.stringify(preview);
    for (const secret of [OWNER.email, config.project.workspacePath, '"handle"', '"displayName"', '"email"'])
      expect(text).not.toContain(secret);
  });
});

describe('ask_setup_source (PM-1463)', () => {
  it("offers only the asking owner's own other projects, to that owner alone", async () => {
    await setup([MINE, FOREIGN]);
    const asked = await h.domain.teamTools.askSetupSource(ctx);
    expect(asked.candidates).toEqual(['BX']);
    const item = h.repos.inbox.get(asked.inbox_item_id)!;
    expect(item.assignees).toEqual(['owner']);
    expect(item.options.map((option) => option.id)).toEqual(
      expect.arrayContaining(['BX', SETUP_SOURCE_NONE_OPTION]),
    );
    expect(item.options.map((option) => option.id)).not.toContain('CX');
    expect(item.payload).toMatchObject({ setupSource: { owner: 'owner', candidates: ['BX'] } });
  });

  it("keeps the owner's other projects, asked and answered, from everyone but an owner or admin on their own login", async () => {
    await setup([MINE]);
    const asked = await h.domain.teamTools.askSetupSource(ctx);
    await h.domain.inbox.resolve(
      'AR',
      asked.inbox_item_id,
      { optionId: 'BX' },
      { handle: 'owner', access: 'owner' },
    );
    const item = h.repos.inbox.get(asked.inbox_item_id)!;
    const [answered] = h.repos.timeline.ofProjectType('AR', 'question_answered', 1);
    expect(answered!.data).toMatchObject({ inboxItemId: item.id, ownerOnly: true });
    for (const access of ['owner', 'admin', 'developer', 'viewer', 'client'] as const)
      for (const via of [undefined, 'integrator'] as const) {
        const viewer = { handle: 'reader', access, via };
        const sees = via === undefined && ['owner', 'admin'].includes(access);
        expect(canSeeInboxItem(viewer, item)).toBe(sees);
        expect(canSeeProjectEvent(viewer, { type: 'inbox_upserted', projectKey: 'AR', item })).toBe(sees);
        expect(
          canSeeProjectEvent(viewer, { type: 'timeline_appended', projectKey: 'AR', event: answered! }),
        ).toBe(sees);
      }
  });

  it('answers setup_source_none when the owner has no other project', async () => {
    await setup([FOREIGN]);
    await expect(h.domain.teamTools.askSetupSource(ctx)).rejects.toThrow('setup_source_none');
  });

  it('opens no second question while one is unanswered, and asks again after the answer (PM-1487)', async () => {
    await setup([MINE]);
    const asked = await h.domain.teamTools.askSetupSource(ctx);
    await expect(h.domain.teamTools.askSetupSource(ctx)).rejects.toThrow('setup_source_open');
    const questions = () =>
      h.repos.inbox.list('AR', { kind: 'question' }).filter((item) => 'setupSource' in item.payload);
    expect(questions()).toHaveLength(1);
    close(asked.inbox_item_id, { optionId: SETUP_SOURCE_NONE_OPTION });
    await h.domain.teamTools.askSetupSource(ctx);
    expect(questions()).toHaveLength(2);
  });
});

describe('the setup idea tools refuse (PM-1487)', () => {
  const calls: [string, (at: ToolContext) => Promise<unknown>][] = [
    ['preview_template', (at) => h.domain.teamTools.previewTemplate(at, {})],
    ['ask_setup_source', (at) => h.domain.teamTools.askSetupSource(at)],
    ['read_setup_source', (at) => h.domain.teamTools.readSetupSource(at, { projectKey: 'BX' })],
  ];
  it.each(calls)(
    "%s on a request of someone who is not an owner, and in a guest's conversation",
    async (_tool, call) => {
      await setup([MINE]);
      // The owner's own permission is there: only the request or the conversation is wrong.
      const asked = await h.domain.teamTools.askSetupSource(ctx);
      close(asked.inbox_item_id, {});
      // A developer's request in the owners' conversation, in place of the owner's.
      const at = new Date().toISOString();
      for (const request of h.repos.projectManagerRequests.openOfSession(ctx.sessionId))
        h.repos.projectManagerRequests.close(request.id, at);
      h.repos.projectManagerRequests.insert({
        id: 'opr_dana',
        projectKey: 'AR',
        sessionId: ctx.sessionId,
        source: 'message',
        messageId: null,
        inboxItemId: null,
        fromHandle: 'dana',
        quote: 'Show me another project.',
        openedAt: at,
      });
      const guest = seedProjectManagerRequest(h, 'AR', { member: 'pm', from: 'guest', with: 'guest' });
      for (const sessionId of [ctx.sessionId, guest.session.id])
        await expect(call({ ...ctx, sessionId })).rejects.toMatchObject({
          code: 'forbidden',
          message: expect.stringContaining('operator_owner_only'),
        });
    },
  );
});

describe('read_setup_source (PM-1463)', () => {
  it("reads the allowed project's process without cards, messages, documents or people", async () => {
    await setup([MINE]);
    await h.domain.tasks.create('BX', { title: 'A private card title' }, OWNER_ACTOR);
    const asked = await h.domain.teamTools.askSetupSource(ctx);
    await h.domain.inbox.resolve(
      'AR',
      asked.inbox_item_id,
      { optionId: 'BX' },
      { handle: 'owner', access: 'owner' },
    );

    const read = await h.domain.teamTools.readSetupSource(ctx, { projectKey: 'BX' });
    const source = h.domain.projects.cachedConfig('BX')!;
    expect(read).toMatchObject({ key: 'BX', name: 'Project BX', lessons: null });
    expect(read.stages.map((stage) => stage.id)).toEqual(source.pipeline.stages.map((stage) => stage.id));
    expect(read.aiMembers).toHaveLength(source.team.members.filter((member) => member.kind === 'ai').length);
    const text = JSON.stringify(read);
    for (const hidden of [
      'A private card title',
      'BX-1',
      OWNER.email,
      '"handle"',
      '"displayName"',
      '"members"',
    ])
      expect(text).not.toContain(hidden);
    for (const member of source.team.members) expect(text).not.toContain(`"${member.handle}"`);
  });

  it.each<{ name: string; answer: (item: string) => void | Promise<void> }>([
    { name: 'without an answer', answer: () => {} },
    {
      name: 'when the owner allowed none',
      answer: (item) => close(item, { optionId: SETUP_SOURCE_NONE_OPTION }),
    },
    {
      name: 'after the permission expired',
      answer: (item) => close(item, { at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }),
    },
    {
      name: 'on an answer given through the integrator',
      answer: (item) => close(item, { via: 'integrator' }),
    },
    {
      // Another owner of this project who owns that project too: only the owner asked may allow it (PM-1487).
      name: 'when another owner answered the question',
      answer: async (item) => {
        await h.domain.projects.update('BX', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
          draft.team.members.push({ ...CO_OWNER, roles: [] });
          return 'Add a co-owner';
        });
        close(item, { by: CO_OWNER.handle });
      },
    },
    {
      name: 'when the owner no longer owns that project',
      answer: async (item) => {
        close(item, {});
        // The same stored answer allows the read while the owner still owns it.
        await expect(h.domain.teamTools.readSetupSource(ctx, { projectKey: 'BX' })).resolves.toMatchObject({
          key: 'BX',
        });
        await h.domain.projects.update('BX', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
          const owner = draft.team.members.find(
            (member) => member.kind === 'human' && member.access === 'owner',
          );
          if (owner?.kind === 'human') owner.email = 'new-owner@example.com';
          return 'Hand the project over';
        });
      },
    },
  ])('refuses $name', async ({ answer }) => {
    await setup([MINE]);
    const asked = await h.domain.teamTools.askSetupSource(ctx);
    await answer(asked.inbox_item_id);
    await expect(h.domain.teamTools.readSetupSource(ctx, { projectKey: 'BX' })).rejects.toThrow(
      'setup_source_not_allowed',
    );
  });

  it('reads the lessons of a project without a project manager on its own engine (PM-1487)', async () => {
    const LESSONS = 'docs/LESSONS.md';
    const readFile = vi.fn(async (_ref: unknown, input: { path: string }) => ({
      commit: 'c'.repeat(40),
      text: input.path === LESSONS ? '# Lessons\n- Keep the cards small.' : null,
    }));
    // The project's own engine is connected; the engine a member's setting would name is not.
    const engines = {
      get: (id: string) =>
        id === 'project'
          ? ({ merger: { readFile }, workspaceState: async () => 'directory' } as unknown as EngineHost)
          : null,
      ids: () => ['project'],
      engineFor: () => 'member',
      projectEngine: () => 'project',
      hostEngine: () => 'project',
      onChange: () => () => {},
    } as unknown as EngineDirectory;
    await setup([MINE], engines);
    await h.domain.projects.update('BX', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.project.repos[0]!.docs = { lessons: LESSONS };
      return 'Keep lessons';
    });
    // The invariants keep a project manager in a stored configuration; the read must not rely on one.
    const config = h.domain.projects.config.bind(h.domain.projects);
    vi.spyOn(h.domain.projects, 'config').mockImplementation(async (key) => {
      const read = await config(key);
      if (key !== 'BX') return read;
      const members = read.team.members.filter((member) => !isProjectManager(member));
      return { ...read, team: { ...read.team, members } };
    });
    const asked = await h.domain.teamTools.askSetupSource(ctx);
    close(asked.inbox_item_id, {});

    const read = await h.domain.teamTools.readSetupSource(ctx, { projectKey: 'BX' });
    expect(read.lessons).toBe('# Lessons\n- Keep the cards small.');
    expect(read).not.toHaveProperty('lessonsUnavailable');
    expect(readFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectKey: 'BX' }),
      expect.objectContaining({ path: LESSONS }),
    );
  });

  it("refuses another owner's project even with an allowed answer naming it", async () => {
    await setup([MINE, FOREIGN]);
    const asked = await h.domain.teamTools.askSetupSource(ctx);
    close(asked.inbox_item_id, { optionId: 'CX' });
    await expect(h.domain.teamTools.readSetupSource(ctx, { projectKey: 'CX' })).rejects.toThrow(
      'setup_source_not_allowed',
    );
  });
});
