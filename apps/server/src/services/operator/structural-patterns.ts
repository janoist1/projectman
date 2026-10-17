import { createHash } from 'node:crypto';
import { countFixRounds, isTheme, PatternFacts, stageOf } from '@projectman/shared';
import type { ProjectConfig, Task, TimelineEvent } from '@projectman/shared';
import type { DomainContext } from '../../core/base';

export const STRUCTURAL_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const structuralKind = (kind: string) => kind === 'structural_pattern' || kind === 'milestone_closed';
export const patternSubject = (fingerprint: string) =>
  createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);

/** Reject absolute paths and escapes; equivalent repository-relative spellings share one fingerprint. */
export function normalizedEvidencePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) return null;
  const path = value.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/** Reads only structured timeline data. The same fixed window reconstructs a signal after restart. */
export class StructuralPatterns {
  private readonly ctx: DomainContext;
  constructor(ctx: DomainContext) {
    this.ctx = ctx;
  }

  /**
   * Reads the window's events, and of the cards only those the events name (PM-771): never the project's
   * whole card history. A card that is gone is no card, as before.
   */
  report(config: ProjectConfig, until = this.ctx.now().toISOString()) {
    const since = new Date(Date.parse(until) - STRUCTURAL_WINDOW_MS).toISOString();
    const events = this.ctx.repos.timeline.structuralEvidence(config.project.key, since, until);
    const keys = [...new Set(events.flatMap((event) => (event.taskKey ? [event.taskKey] : [])))];
    const cards =
      keys.length === 0
        ? []
        : this.ctx.repos.tasks.readScheduling(config.project.key, { kind: 'keys', keys });
    const byKey = new Map(cards.map((card) => [card.key, card]));
    return {
      patterns: this.patterns(config, events, cards, since, until),
      milestones: [
        ...this.parentMilestones(config, events, byKey, since),
        ...events.flatMap((event) => {
          const task = event.taskKey ? byKey.get(event.taskKey) : undefined;
          if (!task) return [];
          const themeClosed =
            isTheme(task) &&
            event.type === 'task_updated' &&
            event.data.action === 'closed' &&
            ['active', 'waiting', 'blocked'].includes(String(event.data.previousStatus));
          const stageClosed =
            event.type === 'task_stage_changed' &&
            event.data.from !== event.data.to &&
            stageOf(config, String(event.data.from))?.kind !== 'done' &&
            stageOf(config, String(event.data.to))?.kind === 'done';
          return themeClosed || (stageClosed && isTheme(task))
            ? [{ taskKey: task.key, eventId: event.id }]
            : [];
        }),
      ],
    };
  }

  /**
   * Reconstruct each sibling's status at the closing event; today's completed siblings are not proof. The
   * starting state of a sibling is its last state event before the window (`latestTaskStatesBefore`; none:
   * unknown), on which the window's events are replayed in order. Only the parents of the cards that
   * closed in the window are looked at, with all their subtasks, closed ones too.
   */
  private parentMilestones(
    config: ProjectConfig,
    events: TimelineEvent[],
    named: ReadonlyMap<string, Task>,
    since: string,
  ) {
    const projectKey = config.project.key;
    const closedChild = (event: TimelineEvent) => {
      const child = event.taskKey ? named.get(event.taskKey) : undefined;
      return child?.parentKey &&
        event.type === 'task_stage_changed' &&
        event.data.from !== event.data.to &&
        stageOf(config, String(event.data.from))?.kind !== 'done' &&
        stageOf(config, String(event.data.to))?.kind === 'done'
        ? child
        : undefined;
    };
    const parentKeys = new Set<string>();
    for (const event of events) {
      const child = closedChild(event);
      if (child) parentKeys.add(child.parentKey!);
    }
    if (parentKeys.size === 0) return [];
    const parents = new Map(
      this.ctx.repos.tasks
        .readScheduling(projectKey, { kind: 'keys', keys: [...parentKeys] })
        .filter((card) => !isTheme(card))
        .map((card) => [card.key, card]),
    );
    if (parents.size === 0) return [];
    const siblings = new Map<string, string[]>();
    for (const child of this.ctx.repos.tasks.readScheduling(projectKey, {
      kind: 'children',
      parentKeys: [...parents.keys()],
      includeClosed: true,
    })) {
      const list = siblings.get(child.parentKey!) ?? [];
      list.push(child.key);
      siblings.set(child.parentKey!, list);
    }
    const status = new Map<string, string>();
    const update = (event: TimelineEvent) => {
      if (!event.taskKey) return;
      if (event.type === 'task_stage_changed')
        status.set(event.taskKey, stageOf(config, String(event.data.to))?.kind === 'done' ? 'done' : 'open');
      else if (event.type === 'task_updated') {
        if (event.data.action === 'cancelled') status.set(event.taskKey, 'cancelled');
        else if (event.data.action === 'reopened') status.set(event.taskKey, 'open');
      }
    };
    const tracked = new Set([...siblings.values()].flat());
    for (const event of this.ctx.repos.timeline.latestTaskStatesBefore(projectKey, [...tracked], since))
      update(event);
    const milestones: { taskKey: string; eventId: string }[] = [];
    for (const event of events) {
      if (event.taskKey && tracked.has(event.taskKey)) update(event);
      const child = closedChild(event);
      const parentKey = child?.parentKey;
      if (!child || !parentKey || !parents.has(parentKey)) continue;
      if (
        siblings.get(parentKey)!.every((key) => ['done', 'cancelled'].includes(status.get(key) ?? 'unknown'))
      )
        milestones.push({ taskKey: parentKey, eventId: event.id });
    }
    return milestones;
  }

  private patterns(
    config: ProjectConfig,
    events: TimelineEvent[],
    cards: Task[],
    since: string,
    until: string,
  ) {
    const groups = new Map<string, { kind: PatternFacts['kind']; events: TimelineEvent[] }>();
    const add = (kind: PatternFacts['kind'], scope: string, file: string, event: TimelineEvent) => {
      const fingerprint = JSON.stringify([kind, scope, file]);
      if (fingerprint.length > 300) return;
      const group = groups.get(fingerprint) ?? { kind, events: [] };
      group.events.push(event);
      groups.set(fingerprint, group);
    };
    for (const event of events) {
      if (!event.taskKey) continue;
      let repo: unknown;
      let files: unknown;
      let kind: PatternFacts['kind'];
      if (event.type === 'task_merge_failed' && event.data.reason === 'conflict') {
        const merge =
          typeof event.data.mergeId === 'string' ? this.ctx.repos.taskMerges.get(event.data.mergeId) : null;
        const requested = this.ctx.repos.timeline
          .listOfTypes(config.project.key, event.taskKey, ['task_merge_requested'], 1000)
          .find((entry) => entry.data.mergeId === event.data.mergeId);
        repo = requested?.data.repo ?? (merge?.projectKey === config.project.key ? merge.repo : undefined);
        files = event.data.files;
        kind = 'conflict_file';
      } else if (event.type === 'task_full_test' && event.data.outcome === 'failed') {
        repo = event.data.repo;
        files = event.data.failedFiles;
        kind = 'failed_test_file';
      } else continue;
      if (typeof repo !== 'string' || !repo || !Array.isArray(files)) continue;
      for (const file of new Set(files.map(normalizedEvidencePath).filter((file) => file !== null)))
        add(kind, repo, file, event);
    }
    const eventsOf = new Map<string, TimelineEvent[]>();
    for (const event of events) {
      if (!event.taskKey) continue;
      const list = eventsOf.get(event.taskKey) ?? [];
      list.push(event);
      eventsOf.set(event.taskKey, list);
    }
    for (const card of cards) {
      const own = eventsOf.get(card.key) ?? [];
      if (countFixRounds(own, config, null).rounds < 3) continue;
      for (const event of own)
        if (countFixRounds([event], config, null).rounds > 0)
          add('fix_rounds', config.project.key, '', event);
    }
    return [...groups].flatMap(([fingerprint, group]) => {
      const keys = [...new Set(group.events.map((event) => event.taskKey!))]
        .sort()
        .slice(0, group.kind === 'fix_rounds' ? 13 : 20);
      if (keys.length < 2) return [];
      // Give each card evidence before spending the remaining evidence budget on retries.
      const selected = keys.flatMap((key) =>
        group.events.filter((event) => event.taskKey === key).slice(0, group.kind === 'fix_rounds' ? 3 : 1),
      );
      return [
        PatternFacts.parse({
          kind: group.kind,
          fingerprint,
          taskKeys: keys,
          eventIds: selected.map((event) => event.id).slice(0, 40),
          windowStartedAt: since,
          windowEndedAt: until,
        }),
      ];
    });
  }
}
