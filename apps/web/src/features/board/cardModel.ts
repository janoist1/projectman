import type { CheckState, Task, TaskLink } from '@projectman/shared';
import { t } from '../../i18n/t';
import { checkForStage, stagesInColumn } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import { checkLine } from '../../lib/timeline';

export interface CheckRow {
  label: string;
  tone: 'ok' | 'warn' | 'wait';
}

function checkTone(state: CheckState): CheckRow['tone'] {
  if (state === 'passed') return 'ok';
  if (state === 'pending') return 'wait';
  return 'warn';
}

/**
 * Check rows on a card: recorded checks up to the task's column, plus progress through
 * the stages of a grouped column (e.g. Code review → Integration → QA).
 */
export function cardChecks(task: Task, pipeline: PipelineIndex): CheckRow[] {
  const stage = pipeline.stageById.get(task.stageId);
  if (
    !stage ||
    stage.kind === 'queue' ||
    stage.kind === 'work' ||
    stage.kind === 'done' ||
    task.status === 'done'
  ) {
    return [];
  }
  const column = pipeline.columnOfStage.get(task.stageId);
  const current = pipeline.stageIndex.get(task.stageId) ?? 0;
  const inColumn = new Set(
    column ? stagesInColumn(pipeline, column).map((entry) => entry.id) : [task.stageId],
  );
  const grouped = inColumn.size > 1;
  const rows: CheckRow[] = [];
  pipeline.stages.forEach((entry, index) => {
    if (index > current && !inColumn.has(entry.id)) return;
    const check = checkForStage(entry);
    const state = check ? task.checks[check] : undefined;
    if (check && state) {
      if (index > current && state === 'pending') return;
      rows.push({ label: checkLine(check, state), tone: checkTone(state) });
      return;
    }
    if (!grouped || !inColumn.has(entry.id) || index > current) return;
    rows.push(
      index < current
        ? { label: t('checks.line', { name: entry.name, state: t('checks.stageDone') }), tone: 'ok' }
        : { label: t('checks.line', { name: entry.name, state: t('checks.stageActive') }), tone: 'wait' },
    );
  });
  return rows;
}

export interface PrChip {
  label: string;
  merged: boolean;
  href: string | null;
}

export function pullRequestLink(task: Task): TaskLink | undefined {
  const prs = task.links.filter((link) => link.kind === 'pull_request');
  return prs.find((link) => link.state !== 'merged' && link.state !== 'closed') ?? prs[prs.length - 1];
}

export function githubUrl(link: TaskLink): string | null {
  if (!link.repo || !/^[\w.-]+\/[\w.-]+$/.test(link.repo)) return null;
  if (link.kind === 'pull_request') return `https://github.com/${link.repo}/pull/${link.ref}`;
  if (link.kind === 'issue') return `https://github.com/${link.repo}/issues/${link.ref}`;
  if (link.kind === 'branch') return `https://github.com/${link.repo}/tree/${link.ref}`;
  return null;
}

export function prChip(task: Task): PrChip | null {
  const link = pullRequestLink(task);
  if (!link) return null;
  const repo = link.repo?.split('/').pop();
  return {
    label: repo
      ? t('taskCard.prWithRepo', { number: link.ref, repo })
      : t('taskCard.pr', { number: link.ref }),
    merged: link.state === 'merged',
    href: githubUrl(link),
  };
}

/** Accent-insensitive search over key, title, labels and PR numbers. */
export function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function matchesSearch(task: Task, query: string): boolean {
  const needle = normalizeSearch(query);
  if (!needle) return true;
  const haystack = [
    task.key,
    task.title,
    ...task.labels,
    ...task.links.filter((link) => link.kind === 'pull_request').map((link) => `#${link.ref} pr ${link.ref}`),
    task.repo ?? '',
  ]
    .join(' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  return haystack.includes(needle);
}
