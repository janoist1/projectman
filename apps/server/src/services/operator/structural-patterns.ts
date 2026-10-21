import { createHash } from 'node:crypto';
import { countFixRounds, isTheme, PatternFacts, stageOf } from '@projectman/shared';
import type { OperatorSignalKind, ProjectConfig, Task, TimelineEvent } from '@projectman/shared';
import type { DomainContext } from '../../core/base';

export const STRUCTURAL_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const STRUCTURAL_KINDS = ['structural_pattern', 'milestone_closed'] as const;
export const structuralKind = (kind: string) => STRUCTURAL_KINDS.some((candidate) => candidate === kind);
export const patternSubject = (fingerprint: string) =>
  createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);

export type StructuralSignalRef = {
  projectKey: string;
  kind: OperatorSignalKind;
  taskKey: string | null;
  subject: string | null;
  raisedAt: string;
};
export type StructuralFacts =
  { evidence: PatternFacts; milestoneKey: null } | { evidence: null; milestoneKey: string } | null;
export type StructuralReport = {
  patterns: PatternFacts[];
  milestones: { taskKey: string; eventId: string }[];
};
export interface StructuralEvaluation {
  report(): StructuralReport;
  facts(signal: StructuralSignalRef): StructuralFacts;
}

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
  report(config: ProjectConfig, until?: string): StructuralReport {
    return this.evaluate(config, until).report();
  }

  /** One synchronous phase only: never retain an evaluation across awaits or evidence/config writes. */
  evaluate(config: ProjectConfig, until = this.ctx.now().toISOString()): StructuralEvaluation {
    const projectKey = config.project.key;
    const armed = new Map(
      STRUCTURAL_KINDS.map((kind) => [kind, this.ctx.repos.operatorSignals.armedAt(projectKey, kind)]),
    );
    const windows = new Map<string, ReturnType<typeof load>>();
    const requests = new Map<string, Map<unknown, TimelineEvent>>();
    const merges = new Map<string, ReturnType<DomainContext['repos']['taskMerges']['get']>>();
    const conflictRepo = (event: TimelineEvent): unknown => {
      let byMerge = requests.get(event.taskKey!);
      if (!byMerge) {
        byMerge = new Map();
        for (const request of this.ctx.repos.timeline.listOfTypes(
          projectKey,
          event.taskKey!,
          ['task_merge_requested'],
          1000,
        )) {
          // Preserve listOfTypes' first match, including requests outside the evidence window.
          if (!byMerge.has(request.data.mergeId)) byMerge.set(request.data.mergeId, request);
        }
        requests.set(event.taskKey!, byMerge);
      }
      const mergeId = event.data.mergeId;
      if (typeof mergeId === 'string' && !merges.has(mergeId))
        merges.set(mergeId, this.ctx.repos.taskMerges.get(mergeId));
      const merge = typeof mergeId === 'string' ? merges.get(mergeId) : null;
      return byMerge.get(mergeId)?.data.repo ?? (merge?.projectKey === projectKey ? merge.repo : undefined);
    };
    const load = (end: string) => {
      const since = new Date(Date.parse(end) - STRUCTURAL_WINDOW_MS).toISOString();
      const from = (kind: (typeof STRUCTURAL_KINDS)[number]) => {
        const at = armed.get(kind);
        return at ? (at > since ? at : since) : null;
      };
      const patternFrom = from('structural_pattern');
      const milestoneFrom = from('milestone_closed');
      const starts = [patternFrom, milestoneFrom].filter((at): at is string => at !== null && at <= end);
      const events = starts.length
        ? this.ctx.repos.timeline.structuralEvidence(projectKey, starts.sort()[0]!, end)
        : [];
      const keys = [...new Set(events.flatMap((event) => (event.taskKey ? [event.taskKey] : [])))];
      const cards =
        keys.length === 0 ? [] : this.ctx.repos.tasks.readScheduling(projectKey, { kind: 'keys', keys });
      let patterns: PatternFacts[] | undefined;
      let subjects: Map<string, PatternFacts> | undefined;
      let milestones: StructuralReport['milestones'] | undefined;
      let milestoneKeys: Set<string> | undefined;
      return {
        patterns: () =>
          (patterns ??= patternFrom
            ? this.patterns(
                config,
                events.filter((event) => event.createdAt >= patternFrom),
                cards,
                patternFrom,
                end,
                conflictRepo,
              )
            : []),
        subjects() {
          if (!subjects) {
            subjects = new Map();
            for (const facts of this.patterns()) {
              const subject = patternSubject(facts.fingerprint);
              if (!subjects.has(subject)) subjects.set(subject, facts);
            }
          }
          return subjects;
        },
        milestones: () =>
          (milestones ??= milestoneFrom
            ? this.milestones(
                config,
                events.filter((event) => event.createdAt >= milestoneFrom),
                new Map(cards.map((card) => [card.key, card])),
                milestoneFrom,
              )
            : []),
        milestoneKeys() {
          return (milestoneKeys ??= new Set(
            this.milestones().map((entry) => JSON.stringify([entry.taskKey, entry.eventId])),
          ));
        },
      };
    };
    const window = (end: string) => {
      let value = windows.get(end);
      if (!value) windows.set(end, (value = load(end)));
      return value;
    };
    return {
      report: () => ({ patterns: window(until).patterns(), milestones: window(until).milestones() }),
      facts: (signal) => {
        if (
          signal.projectKey !== projectKey ||
          !structuralKind(signal.kind) ||
          Date.parse(until) - Date.parse(signal.raisedAt) >= STRUCTURAL_WINDOW_MS
        )
          return null;
        if (signal.kind === 'structural_pattern') {
          if (!signal.subject || !window(until).subjects().has(signal.subject)) return null;
          const evidence = window(signal.raisedAt).subjects().get(signal.subject);
          return evidence ? { evidence, milestoneKey: null } : null;
        }
        return signal.taskKey &&
          window(until)
            .milestoneKeys()
            .has(JSON.stringify([signal.taskKey, signal.subject]))
          ? { evidence: null, milestoneKey: signal.taskKey }
          : null;
      },
    };
  }

  private milestones(
    config: ProjectConfig,
    events: TimelineEvent[],
    byKey: ReadonlyMap<string, Task>,
    since: string,
  ) {
    return [
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
    ];
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
    conflictRepo: (event: TimelineEvent) => unknown,
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
        repo = conflictRepo(event);
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
