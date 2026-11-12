import type { GateCondition, LabelView, Stage } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { isDoneCard, summarizeLabels } from './labelSummary';

/** A pipeline with its own label ids: nothing here is the PM project's. */
const stage = (id: string, kind: Stage['kind'], conditions: GateCondition[] = []): Stage => ({
  id,
  name: id,
  kind,
  columnId: 'c',
  ...(conditions.length > 0 ? { gate: { conditions } } : {}),
});
const stages: Stage[] = [
  stage('inbox', 'queue'),
  stage('build', 'work', [
    { type: 'has_label', label: 'spec-ready', when: 'spec-wanted' },
    { type: 'has_label', label: 'art-ready', when: 'art-wanted' },
    { type: 'lacks_label', label: 'halted' },
  ]),
  stage('check', 'step', [
    { type: 'has_label', label: 'checked' },
    { type: 'has_label', label: 'self', when: 'self' },
    { type: 'lacks_label', label: 'old-result', when: 'old-need' },
  ]),
  stage('shipped', 'done'),
];
const def = (id: string, extra: Partial<LabelView> = {}): LabelView => ({
  id,
  name: id,
  setBy: 'anyone',
  holders: [],
  ...extra,
});
const definitions = [
  def('spec-wanted'),
  def('spec-ready', { group: 'spec' }),
  def('spec-rejected', { group: 'spec' }),
  def('art-wanted'),
  def('art-ready'),
  def('halted', { blocks: true }),
  def('checked'),
  def('self'),
  def('old-need'),
  def('old-result'),
  def('stale', { clearedWhen: ['moved_back'] }),
  def('area-web'),
  def('area-api', { color: 'blue' }),
];
const summarize = (labels: string[], done = false) => summarizeLabels({ labels, definitions, stages, done });

describe('summarizeLabels', () => {
  it('leaves out a condition label whose result from the gates is on the card', () => {
    const summary = summarize(['area-web', 'spec-wanted', 'spec-ready']);
    expect(summary.shown).toEqual(['area-web', 'spec-ready']);
    expect(summary.dropped).toEqual(['spec-wanted']);
  });

  it('keeps the condition label while its result is missing', () => {
    expect(summarize(['spec-wanted', 'art-ready']).shown).toEqual(['spec-wanted', 'art-ready']);
  });

  it.each([
    ['a lacks_label gate', ['old-need', 'old-result']],
    ['a condition that points at itself', ['self']],
  ])('finds no pair in %s', (_name, labels) => {
    expect(summarize(labels).dropped).toEqual([]);
  });

  it('drops each condition only once its own result is present', () => {
    const summary = summarize(['spec-wanted', 'art-wanted', 'art-ready']);
    expect(summary.shown).toEqual(['spec-wanted', 'art-ready']);
  });

  it('folds the process labels of a done card and keeps the area labels, after the pairs', () => {
    const summary = summarize(
      ['area-web', 'spec-wanted', 'spec-ready', 'checked', 'area-api', 'stale'],
      true,
    );
    expect(summary.shown).toEqual(['area-web', 'area-api']);
    expect(summary.folded).toEqual(['spec-ready', 'checked', 'stale']);
  });

  it('counts a label of a gate group, a blocking one and an event-cleared one as process labels', () => {
    expect(summarize(['spec-rejected', 'halted', 'stale'], true).folded).toEqual([
      'spec-rejected',
      'halted',
      'stale',
    ]);
  });

  it('keeps an unknown tag out of the fold and never folds a card still in progress', () => {
    expect(summarize(['imported-tag', 'checked'], true).shown).toEqual(['imported-tag']);
    expect(summarize(['imported-tag', 'checked']).folded).toEqual([]);
  });

  it('folds nothing when every label is an area label', () => {
    expect(summarize(['area-web', 'area-api'], true).folded).toEqual([]);
  });

  it('hides nothing while the label definitions are missing', () => {
    const summary = summarizeLabels({
      labels: ['spec-wanted', 'spec-ready'],
      definitions: [],
      stages,
      done: true,
    });
    expect(summary).toEqual({ shown: ['spec-wanted', 'spec-ready'], folded: [], dropped: [] });
  });
});

describe('isDoneCard', () => {
  it.each([
    [{ status: 'done', stageId: 'build' }, true],
    [{ status: 'active', stageId: 'shipped' }, true],
    [{ status: 'active', stageId: 'build' }, false],
    [{ status: 'cancelled', stageId: 'shipped' }, false],
  ] as const)('reads %j as done: %s', (task, expected) => {
    expect(isDoneCard(task, stages)).toBe(expected);
  });
});
