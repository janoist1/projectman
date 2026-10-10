import { TEMPLATE_COLUMN_COLORS } from './templates/draft';
import { describe, expect, it } from 'vitest';
import {
  isHumanOnlyLabel,
  isReleaseApprovalLabel,
  labelDefinition,
  labelHolders,
  MemberHandle,
  ProjectConfig,
  projectManagersOf,
  releaseGateAccepts,
  resolvedStages,
  stageOwners,
  validateProjectConfig,
  type Stage,
} from '@projectman/shared';
import {
  aiMemberDefaults,
  DAILY_WORKER_SCHEDULE,
  en,
  getLocale,
  getTemplate,
  hu,
  projectManagerMember,
  summarizeTemplate,
  templates,
  type BuildTemplateInput,
} from './index';

/** Accented letters of Hungarian text (prompt text must be English). Code points keep this file ASCII. */
const HUNGARIAN_LETTERS = new RegExp(
  `[${[0xe1, 0xe9, 0xed, 0xf3, 0xf6, 0x151, 0xfa, 0xfc, 0x171].map((c) => String.fromCodePoint(c)).join('')}]`,
  'i',
);

function input(language: string, ownerHandle = 'owner'): BuildTemplateInput {
  return {
    key: 'AR',
    name: 'Sample project',
    workspacePath: '/work/sample',
    language,
    owner: { handle: ownerHandle, displayName: 'Anna Example', email: 'anna@example.com' },
  };
}

function build(id: string, language = 'hu', ownerHandle = 'owner') {
  const template = getTemplate(id);
  if (!template) throw new Error(`missing template ${id}`);
  return template.build(input(language, ownerHandle));
}

describe.each([{ kind: 'worker' }, { kind: 'project_manager' }, { kind: 'human', handle: 'owner' }] as const)(
  'every template with the card mover %o',
  (cardMover) => {
    it.each(templates.map((t) => [t.id, t] as const))(
      '%s works: no error, no mover warning',
      (_id, template) => {
        const config = template.build({ ...input('hu'), cardMover });
        expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([]);
        expect(validateProjectConfig(config).filter((i) => i.code.startsWith('mover_'))).toEqual([]);
      },
    );
  },
);

it('all templates default to worker and preserve an explicitly selected mover', () => {
  for (const template of templates) {
    expect(template.build(input('en')).team.cardMover).toEqual({ kind: 'worker' });
    expect(
      template.build({ ...input('en'), cardMover: { kind: 'human', handle: 'owner' } }).team.cardMover,
    ).toEqual({ kind: 'human', handle: 'owner' });
  }
});

/** [id, kind, owners, gate conditions, column] per stage. */
function shape(stages: Stage[]) {
  return stages.map((s) => [s.id, s.kind, s.owners, s.gate?.conditions ?? [], s.columnId]);
}

describe('every template', () => {
  it('lists the four factory templates', () => {
    expect(templates.map((t) => t.id)).toEqual([
      'web-client-project',
      'small-team',
      'internal-tool',
      'daily-routine',
    ]);
  });

  describe.each(templates.map((t) => [t.id, t] as const))('%s', (id, template) => {
    it.each(['hu', 'en', 'hu-HU', 'de'])('builds a valid configuration (language %s)', (language) => {
      const config = template.build(input(language));
      expect(ProjectConfig.parse(config)).toEqual(config);
      expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([]);
      expect(config.project).toMatchObject({ key: 'AR', templateId: id, language, repos: [] });
    });

    it.each(['hu', 'en'])('has exactly one project manager, handle pm (language %s)', (language) => {
      const config = template.build(input(language));
      const managers = projectManagersOf(config);
      expect(managers).toHaveLength(1);
      expect(managers[0]).toMatchObject({
        handle: 'pm',
        role: 'project_manager',
        displayName: getLocale(language).roles.project_manager.name,
        sponsor: 'owner',
        temp: false,
      });
      expect(managers[0]!.onLeave).toBeUndefined();
    });

    it('makes the owner the operator and the product owner', () => {
      for (const language of ['hu', 'en']) {
        const owner = template.build(input(language)).team.members[0];
        expect(owner).toEqual({
          kind: 'human',
          handle: 'owner',
          displayName: 'Anna Example',
          access: 'owner',
          roles: ['operator', 'product_owner'],
          email: 'anna@example.com',
        });
      }
    });

    it('sets the time zone from the project language', () => {
      expect(template.build(input('hu')).project.timezone).toBe('Europe/Budapest');
      expect(template.build(input('hu-HU')).project.timezone).toBe('Europe/Budapest');
      expect(template.build(input('en')).project.timezone).toBe('UTC');
      expect(template.build(input('de')).project.timezone).toBe('UTC');
      expect(template.build(input('en')).team.roles).toEqual([]);
    });

    it('sponsors every AI member by the owner and uses the role defaults', () => {
      const config = template.build(input('en'));
      const owner = config.team.members[0];
      expect(owner).toMatchObject({ kind: 'human', handle: 'owner', access: 'owner' });
      for (const member of config.team.members) {
        if (member.kind !== 'ai') continue;
        const defaults = aiMemberDefaults(member.role, config.team.roles);
        if (!defaults) throw new Error(`no AI defaults for ${member.role}`);
        expect(member).toMatchObject({
          sponsor: 'owner',
          temp: false,
          model: defaults.model,
          permissionMode: defaults.permissionMode,
          capacity: defaults.capacity,
          instructions: defaults.instructions,
        });
      }
    });

    it('uses unique, readable handles', () => {
      const handles = template.build(input('en')).team.members.map((m) => m.handle);
      expect(new Set(handles).size).toBe(handles.length);
      for (const handle of handles) {
        expect(MemberHandle.safeParse(handle).success).toBe(true);
        expect(handle).toMatch(/^[a-z]+(-[a-z0-9]+)*$/);
      }
    });

    it('stays valid when the owner handle collides with an AI handle', () => {
      const aiHandles = template
        .build(input('en'))
        .team.members.filter((m) => m.kind === 'ai')
        .map((m) => m.handle);
      for (const taken of aiHandles) {
        const config = template.build(input('en', taken));
        expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([]);
        expect(config.team.members.filter((m) => m.handle === taken)).toHaveLength(1);
      }
    });

    it('shows every column and gives every working stage an owner', () => {
      const config = template.build(input('en'));
      const used = new Set(config.pipeline.stages.map((s) => s.columnId));
      expect(config.pipeline.columns.map((c) => c.id).filter((c) => !used.has(c))).toEqual([]);
      for (const stage of config.pipeline.stages) {
        if (stage.kind === 'queue' || stage.kind === 'done') continue;
        expect(stageOwners(config, stage).length, stage.id).toBeGreaterThan(0);
      }
    });

    it('starts with the standard limits and no cap on concurrent AI sessions (decision 23)', () => {
      expect(template.build(input('en')).team.limits).toEqual({
        aiEnabled: true,
        pauseAbovePlanUsagePercent: 80,
        tempWorkers: { enabled: false, max: 1, role: 'developer' },
        minFreeDiskGb: 10,
      });
    });

    it('releases behind the approval of the release approval duty, which the owner holds (decision 19)', () => {
      for (const language of ['hu', 'en', 'de']) {
        const config = template.build(input(language));
        for (const stage of config.pipeline.stages.filter((s) => s.kind === 'release')) {
          const required = (stage.gate?.conditions ?? [])
            .filter((c) => c.type === 'has_label')
            .map((c) => labelDefinition(config, c.label)!);
          const approvals = required.filter(isHumanOnlyLabel);
          expect(approvals.length, stage.id).toBeGreaterThan(0);
          for (const label of required) expect(releaseGateAccepts(label), label.id).toBe(true);
          for (const label of approvals) {
            expect(isReleaseApprovalLabel(label), label.id).toBe(true);
            expect(labelHolders(config, label), label.id).toEqual(['owner']);
          }
        }
      }
    });

    it('is summarized with i18n keys and counts', () => {
      const config = template.build(input('en'));
      expect(summarizeTemplate(template)).toEqual({
        id,
        nameKey: `templates.${id}.name`,
        descriptionKey: `templates.${id}.description`,
        memberCount: {
          human: config.team.members.filter((m) => m.kind === 'human').length,
          ai: config.team.members.filter((m) => m.kind === 'ai').length,
        },
        stageCount: config.pipeline.stages.length,
      });
    });
  });
});

describe('web-client-project', () => {
  const config = build('web-client-project');

  it('hires DevOps, code review, QA, communication and two developers', () => {
    expect(
      config.team.members.map((m) =>
        m.kind === 'ai' ? [m.handle, m.role, m.specialty ?? null] : [m.handle, m.access, null],
      ),
    ).toEqual([
      ['owner', 'owner', null],
      ['devops', 'devops', null],
      ['code-review', 'code_review', null],
      ['qa', 'qa', null],
      ['communication', 'communication', null],
      ['fe-1', 'developer', hu.specialties.frontend],
      ['be-1', 'developer', hu.specialties.backend],
      ['pm', 'project_manager', null],
    ]);
  });

  it('reviews code before the integration deploy and gates merge and release on the owner', () => {
    expect(shape(resolvedStages(config))).toEqual([
      ['ready', 'queue', ['owner'], [], 'ready'],
      ['dev', 'work', ['fe-1', 'be-1'], [], 'development'],
      ['code_review', 'step', ['code-review'], [], 'review'],
      ['integration', 'step', ['devops'], [{ type: 'has_label', label: 'code-review-ok' }], 'review'],
      ['qa', 'step', ['owner', 'qa'], [], 'review'],
      ['client_test', 'step', ['communication'], [{ type: 'has_label', label: 'qa-ok' }], 'client_test'],
      [
        'merge',
        'step',
        ['owner'],
        [
          { type: 'has_label', label: 'client-accepted' },
          { type: 'has_label', label: 'merge-approved' },
        ],
        'awaiting_release',
      ],
      [
        'release',
        'release',
        ['devops'],
        [{ type: 'has_label', label: 'release-approved' }],
        'awaiting_release',
      ],
      ['done', 'done', [], [], 'done'],
    ]);
  });

  it('is the template with a release stage, so the release approval checks above are not vacuous', () => {
    expect(templates.filter((t) => build(t.id).pipeline.stages.some((s) => s.kind === 'release'))).toEqual([
      getTemplate('web-client-project'),
    ]);
    expect(labelDefinition(config, 'release-approved')!.setBy).toEqual({
      duties: ['release_approval'],
      humansOnly: true,
    });
  });

  it('uses display names from the project language', () => {
    expect(config.pipeline.columns).toEqual(
      (['ready', 'development', 'review', 'client_test', 'awaiting_release', 'done'] as const).map((id) => ({
        id,
        ...hu.columns[id],
        color: TEMPLATE_COLUMN_COLORS[id],
      })),
    );
    expect(config.pipeline.stages.map((s) => s.name)).toEqual(
      (
        [
          'ready',
          'dev',
          'code_review',
          'integration',
          'qa',
          'client_test',
          'merge',
          'release',
          'done',
        ] as const
      ).map((id) => hu.stages[id]),
    );
    expect(config.team.members.map((m) => m.displayName)).toEqual([
      'Anna Example',
      hu.roles.devops.name,
      hu.roles.code_review.name,
      hu.roles.qa.name,
      hu.roles.communication.name,
      hu.specialist(hu.specialties.frontend, hu.roles.developer.name),
      hu.specialist(hu.specialties.backend, hu.roles.developer.name),
      hu.roles.project_manager.name,
    ]);

    const english = build('web-client-project', 'en');
    expect(english.pipeline.columns.map((c) => c.name)).toEqual([
      'Ready',
      'In development',
      'In review',
      'Client test',
      'Awaiting release',
      'Done',
    ]);
    expect(english.team.members.map((m) => m.displayName).slice(5)).toEqual([
      'Frontend developer',
      'Backend developer',
      'Project manager',
    ]);
  });
});

describe('small-team', () => {
  const config = build('small-team', 'en');

  it('has the owner, one developer and a code reviewer', () => {
    expect(config.team.members.map((m) => [m.handle, m.kind === 'ai' ? m.role : m.access])).toEqual([
      ['owner', 'owner'],
      ['dev-1', 'developer'],
      ['code-review', 'code_review'],
      ['pm', 'project_manager'],
    ]);
  });

  it('closes reviewed work on the owner decision', () => {
    expect(shape(resolvedStages(config))).toEqual([
      ['ready', 'queue', ['owner'], [], 'ready'],
      ['dev', 'work', ['dev-1'], [], 'development'],
      ['code_review', 'step', ['code-review'], [], 'review'],
      [
        'done',
        'done',
        [],
        [
          { type: 'has_label', label: 'code-review-ok' },
          { type: 'has_label', label: 'merge-approved' },
        ],
        'done',
      ],
    ]);
  });
});

describe('internal-tool', () => {
  const config = build('internal-tool', 'en');

  it('has the owner, two developers, code review and QA', () => {
    expect(
      config.team.members.map((m) => [m.handle, m.kind === 'ai' ? m.role : m.access, m.displayName]),
    ).toEqual([
      ['owner', 'owner', 'Anna Example'],
      ['dev-1', 'developer', 'Developer'],
      ['dev-2', 'developer', 'Developer 2'],
      ['code-review', 'code_review', 'Code reviewer'],
      ['qa', 'qa', 'QA'],
      ['pm', 'project_manager', 'Project manager'],
    ]);
  });

  it('tests after the review and merges on the owner decision, without a client test', () => {
    expect(shape(resolvedStages(config))).toEqual([
      ['ready', 'queue', ['owner'], [], 'ready'],
      ['dev', 'work', ['dev-1', 'dev-2'], [], 'development'],
      ['code_review', 'step', ['code-review'], [], 'review'],
      ['qa', 'step', ['owner', 'qa'], [{ type: 'has_label', label: 'code-review-ok' }], 'review'],
      [
        'merge',
        'step',
        ['owner'],
        [
          { type: 'has_label', label: 'qa-ok' },
          { type: 'has_label', label: 'merge-approved' },
        ],
        'awaiting_merge',
      ],
      ['done', 'done', [], [], 'done'],
    ]);
  });
});

describe('daily-routine', () => {
  const config = build('daily-routine', 'en');

  it('has the owner and a daily worker working through ready, work and done', () => {
    expect(config.team.members.map((m) => [m.handle, m.kind === 'ai' ? m.role : m.access])).toEqual([
      ['owner', 'owner'],
      ['daily', 'maintainer'],
      ['pm', 'project_manager'],
    ]);
    expect(shape(resolvedStages(config))).toEqual([
      ['ready', 'queue', ['owner'], [], 'ready'],
      ['work', 'work', ['daily'], [], 'in_progress'],
      ['done', 'done', [], [], 'done'],
    ]);
    expect(config.pipeline.columns.map((c) => c.name)).toEqual([
      en.columns.ready.name,
      en.columns.in_progress.name,
      en.columns.done.name,
    ]);
  });

  it('names the maintainer the daily worker and runs it every weekday morning', () => {
    const worker = config.team.members[1];
    expect(worker).toMatchObject({ displayName: en.members.daily_worker, schedule: DAILY_WORKER_SCHEDULE });
    expect(build('daily-routine', 'hu').team.members[1]).toMatchObject({
      displayName: hu.members.daily_worker,
      schedule: DAILY_WORKER_SCHEDULE,
    });
    // Minute 0, hour 8, Monday to Friday, in the project's time zone.
    expect(DAILY_WORKER_SCHEDULE.cron).toBe('0 8 * * 1-5');
    expect(DAILY_WORKER_SCHEDULE.prompt).not.toMatch(HUNGARIAN_LETTERS);
    expect(DAILY_WORKER_SCHEDULE.prompt).toContain('create_task');
    expect(DAILY_WORKER_SCHEDULE.prompt).toContain('send_message');
  });
});
