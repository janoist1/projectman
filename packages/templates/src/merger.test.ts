import { describe, expect, it } from 'vitest';
import {
  cardMerger,
  defaultMerger,
  mergeReadiness,
  mergeTargetOf,
  moveMerge,
  stageOwners,
  validateProjectConfig,
  type Merger,
  type ProjectConfig,
} from '@projectman/shared';
import { getTemplate, templates, type BuildTemplateInput } from './index';

function input(extra: Partial<BuildTemplateInput> = {}): BuildTemplateInput {
  return {
    key: 'AR',
    name: 'Sample project',
    workspacePath: '/work/sample',
    language: 'en',
    owner: { handle: 'owner', displayName: 'Anna Example', email: 'anna@example.com' },
    ...extra,
  };
}

/** The template's configuration with one repository, so that the merge applies. */
function build(id: string, extra: Partial<BuildTemplateInput> = {}): ProjectConfig {
  const config = getTemplate(id)!.build(input(extra));
  config.project.repos = [{ name: 'web', path: '.', defaultBranch: 'main' }];
  return config;
}

const target: Record<string, string> = {
  'web-client-project': 'release',
  'small-team': 'done',
  'internal-tool': 'done',
  'daily-routine': 'done',
};
const defaults: Record<string, Merger> = {
  'web-client-project': { kind: 'code_reviewer' },
  'small-team': { kind: 'code_reviewer' },
  'internal-tool': { kind: 'code_reviewer' },
  'daily-routine': { kind: 'developer' },
};

describe('the merger of the templates', () => {
  it('has four templates, each with its merge target and default merger', () => {
    expect(templates.map((t) => t.id).sort()).toEqual(Object.keys(defaults).sort());
    for (const { id } of templates) {
      const config = build(id);
      expect(mergeTargetOf(config)?.id, id).toBe(target[id]);
      expect(defaultMerger(config), id).toEqual(defaults[id]);
      expect(config.team.merger, id).toEqual(defaults[id]);
    }
  });

  it('builds a flawless configuration with each kind of merger', () => {
    for (const { id } of templates) {
      for (const merger of [
        { kind: 'code_reviewer' },
        { kind: 'developer' },
        { kind: 'member', handle: 'owner' },
      ] as Merger[]) {
        const config = getTemplate(id)!.build(input({ merger }));
        expect(config.team.merger, id).toEqual(merger);
        expect(
          validateProjectConfig(config).filter((i) => i.severity !== 'warning'),
          id,
        ).toEqual([]);
        // With a repository that requires a merge, the setting still resolves, except a code reviewer
        // in a template that has no code review stage.
        config.project.repos = [{ name: 'web', path: '.', defaultBranch: 'main' }];
        const issues = validateProjectConfig(config).filter((i) => i.code === 'merger_unresolved');
        expect(issues, `${id} ${merger.kind}`).toEqual(
          merger.kind === 'code_reviewer' && id === 'daily-routine'
            ? [{ code: 'merger_unresolved', path: 'team.merger', detail: 'code_reviewer' }]
            : [],
        );
      }
    }
  });

  it('names the owner as a member merger who can merge', () => {
    const config = build('small-team', { merger: { kind: 'member', handle: 'owner' } });
    expect(cardMerger(config, { assignee: null }, null)).toBe('owner');
  });

  it('resolves the default merger to the code review stage owner or the assignee', () => {
    const small = build('small-team');
    const reviewers = stageOwners(
      small,
      small.pipeline.stages.find((s) => s.id === 'code_review')!,
    );
    expect(reviewers).toHaveLength(1);
    expect(cardMerger(small, { assignee: null }, null)).toBe(reviewers[0]);
    expect(cardMerger(small, { assignee: 'dev' }, reviewers[0]!)).toBe(reviewers[0]);
    const daily = build('daily-routine');
    expect(cardMerger(daily, { assignee: 'daily' }, null)).toBe('daily');
    expect(cardMerger(daily, { assignee: null }, null)).toBeNull();
  });
});

describe('mergeReadiness in the templates', () => {
  const task = (stageId: string, labels: string[] = []) => ({
    stageId,
    labels,
    assignee: null,
    links: [],
    repo: null,
  });

  it('web client project: the merge step is ready without the release approval', () => {
    const config = build('web-client-project');
    const readiness = mergeReadiness(config, task('merge', ['client-accepted', 'merge-approved']));
    expect(readiness).toMatchObject({ ready: true, repo: { name: 'web' }, target: { id: 'release' } });
    // The release approval comes after the merge, so it is not asked for; a blocking label still holds.
    expect(
      mergeReadiness(config, task('merge', ['client-accepted', 'merge-approved', 'waiting-answer'])),
    ).toEqual({
      ready: false,
      reason: 'gate',
    });
    expect(mergeReadiness(config, task('qa'))).toEqual({ ready: false, reason: 'not_before_target' });
    expect(mergeReadiness(config, task('release'))).toEqual({ ready: false, reason: 'not_before_target' });
  });

  it('small team: the done stage asks for the merge approval', () => {
    const config = build('small-team');
    expect(mergeReadiness(config, task('code_review', ['code-review-ok']))).toEqual({
      ready: false,
      reason: 'gate',
    });
    expect(mergeReadiness(config, task('code_review', ['code-review-ok', 'merge-approved']))).toMatchObject({
      ready: true,
      target: { id: 'done' },
    });
    expect(
      mergeReadiness(config, task('code_review', ['code-review-ok', 'merge-approved', 'waiting-answer'])),
    ).toEqual({ ready: false, reason: 'gate' });
    expect(mergeReadiness(config, task('dev'))).toEqual({ ready: false, reason: 'not_before_target' });
  });

  it('internal tool and daily routine: nothing stands in the way of the done stage', () => {
    expect(mergeReadiness(build('internal-tool'), task('merge'))).toMatchObject({ ready: true });
    expect(mergeReadiness(build('daily-routine'), task('work'))).toMatchObject({ ready: true });
  });

  it('is not due where the repository needs no merge, or the card has none', () => {
    const config = build('daily-routine');
    config.project.repos = [{ name: 'web', path: '.', defaultBranch: 'main', fullTestAtMerge: true }];
    expect(mergeReadiness(config, task('work'))).toEqual({ ready: false, reason: 'no_merge' });
    config.project.repos = [];
    expect(mergeReadiness(config, task('work'))).toEqual({ ready: false, reason: 'no_merge' });
  });
});

describe('moveMerge in the templates', () => {
  const card = (labels: string[] = []) => ({ labels, assignee: null, links: [], repo: null });

  it('is none where no merge is due: no repository to merge, a move that stays before the target or goes back', () => {
    const small = build('small-team');
    expect(moveMerge(small, card(), 'dev', 'code_review')).toEqual({ kind: 'none' });
    expect(moveMerge(small, card(), 'done', 'code_review')).toEqual({ kind: 'none' });
    small.project.repos = [{ name: 'web', path: '.', defaultBranch: 'main', requireMerge: false }];
    expect(moveMerge(small, card(['code-review-ok']), 'code_review', 'done')).toEqual({ kind: 'none' });
  });

  it('is due when the gates of the move hold', () => {
    const small = build('small-team');
    expect(moveMerge(small, card(['code-review-ok', 'merge-approved']), 'code_review', 'done')).toMatchObject(
      {
        kind: 'due',
        repo: { name: 'web' },
      },
    );
  });

  it('is after the gates while an approval or a condition is missing', () => {
    const small = build('small-team');
    const approval = moveMerge(small, card(['code-review-ok']), 'code_review', 'done');
    expect(approval).toMatchObject({ kind: 'after_gates', repo: { name: 'web' }, unmet: [] });
    expect(approval.kind === 'after_gates' && approval.approvals.map((a) => a.label)).toEqual([
      'merge-approved',
    ]);
    const blocking = moveMerge(
      small,
      card(['code-review-ok', 'merge-approved', 'waiting-answer']),
      'code_review',
      'done',
    );
    expect(blocking.kind === 'after_gates' && blocking.unmet).not.toEqual([]);
  });

  it('leaves out the release approval of a release target, so the merge comes first', () => {
    const web = build('web-client-project');
    const merge = moveMerge(web, card(['client-accepted', 'merge-approved']), 'merge', 'release');
    expect(merge).toMatchObject({ kind: 'due', repo: { name: 'web' } });
    // A move from before the merge step still waits for the merge approval first; only the release approval is left out.
    const early = moveMerge(web, card(['client-accepted']), 'client_test', 'release');
    expect(early.kind === 'after_gates' && early.approvals.map((a) => a.label)).toEqual(['merge-approved']);
    expect(moveMerge(web, card(['client-accepted', 'merge-approved']), 'client_test', 'release').kind).toBe(
      'due',
    );
  });
});
