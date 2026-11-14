import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memberOf, SETUP_SOURCE_NONE_OPTION } from '@projectman/shared';
import type { AiMemberConfig, InboxItem, ProjectConfig } from '@projectman/shared';
import { getLocale, getTemplate } from '@projectman/templates';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { seedProjectManagerRequest } from './helpers/operator-session';

let h: DomainHarness;
let ctx: ToolContext;
afterEach(async () => {
  await h?.cleanup();
});

// The test template's project manager is on leave; the tool surface is its alone.
const pmActive = (config: ProjectConfig) => {
  (memberOf(config, 'pm') as AiMemberConfig).onLeave = false;
};

async function setup(others: { key: string; owner: { name: string; email: string } }[] = []) {
  h = await createDomainHarness({ adjust: pmActive });
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

  it('answers setup_source_none when the owner has no other project', async () => {
    await setup([FOREIGN]);
    await expect(h.domain.teamTools.askSetupSource(ctx)).rejects.toThrow('setup_source_none');
  });
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

  it("refuses another owner's project even with an allowed answer naming it", async () => {
    await setup([MINE, FOREIGN]);
    const asked = await h.domain.teamTools.askSetupSource(ctx);
    close(asked.inbox_item_id, { optionId: 'CX' });
    await expect(h.domain.teamTools.readSetupSource(ctx, { projectKey: 'CX' })).rejects.toThrow(
      'setup_source_not_allowed',
    );
  });
});
