import { z } from 'zod';
import type { ConfigHistoryEntry, ConfigVersionEntry } from '../api/dto';
import type { BoardColumn, Stage } from '../domain/pipeline';
import type { LabelDefinition } from '../domain/label';
import { canonical } from './canonical';
import type { ProjectConfig } from './schema';
import { effectiveTeamSettings } from './team-settings';

const Named = { id: z.string(), name: z.string() };

/** One change between two saved versions of a project's configuration, in terms a person reads. */
export const ConfigDiffItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('created') }),
  z.object({ kind: z.literal('stage_added'), ...Named }),
  /** `name`: as it was. */
  z.object({ kind: z.literal('stage_removed'), ...Named }),
  z.object({ kind: z.literal('stage_moved'), ...Named }),
  z.object({ kind: z.literal('stage_renamed'), ...Named, from: z.string() }),
  z.object({
    kind: z.literal('stage_changed'),
    ...Named,
    fields: z.array(z.enum(['description', 'kind', 'column', 'duty', 'owners', 'gate'])).min(1),
  }),
  z.object({ kind: z.literal('column_added'), ...Named }),
  z.object({ kind: z.literal('column_removed'), ...Named }),
  z.object({ kind: z.literal('column_renamed'), ...Named, from: z.string() }),
  z.object({
    kind: z.literal('column_changed'),
    ...Named,
    fields: z.array(z.enum(['color', 'hint', 'order'])).min(1),
  }),
  z.object({ kind: z.literal('label_added'), ...Named }),
  z.object({ kind: z.literal('label_removed'), ...Named }),
  z.object({
    kind: z.literal('label_changed'),
    ...Named,
    fields: z.array(z.enum(['name', 'color', 'meaning', 'setBy', 'rules'])).min(1),
  }),
  z.object({
    kind: z.literal('section_changed'),
    section: z.enum(['project', 'repos', 'team', 'duties', 'limits']),
  }),
  z.object({ kind: z.literal('other') }),
]);
export type ConfigDiffItem = z.infer<typeof ConfigDiffItem>;

type Section = Extract<ConfigDiffItem, { kind: 'section_changed' }>['section'];
type StageField = Extract<ConfigDiffItem, { kind: 'stage_changed' }>['fields'][number];
type ColumnField = Extract<ConfigDiffItem, { kind: 'column_changed' }>['fields'][number];
type LabelField = Extract<ConfigDiffItem, { kind: 'label_changed' }>['fields'][number];

/**
 * Which section each setting belongs to. A new setting does not type-check until it is classified
 * here, so the history never silently skips it.
 */
const PROJECT_SECTION = {
  key: 'project',
  name: 'project',
  workspacePath: 'project',
  language: 'project',
  timezone: 'project',
  templateId: 'project',
  email: 'project',
  feedback: 'project',
  repos: 'repos',
} as const satisfies { [K in keyof ProjectConfig['project']]-?: Section };

const TEAM_SECTION = {
  members: 'team',
  contacts: 'team',
  cardMover: 'team',
  merger: 'team',
  mergeAfterReview: 'team',
  taskCreateAccess: 'team',
  projectManagerMoves: 'team',
  projectManagerLifecycle: 'team',
  prerequisiteOverride: 'team',
  projectManagerAuthority: 'team',
  prioritySetters: 'team',
  complexitySetters: 'team',
  assigneeFit: 'team',
  viewerRecipients: 'team',
  ownerDecisionTopics: 'team',
  operatorWatch: 'team',
  ruleReasons: 'team',
  roles: 'duties',
  roleOverrides: 'duties',
  releaseFourEyes: 'duties',
  boundary: 'duties',
  limits: 'limits',
} as const satisfies { [K in keyof ProjectConfig['team']]-?: 'team' | 'duties' | 'limits' };

const STAGE_KEYS = {
  id: null,
  name: null,
  description: 'description',
  kind: 'kind',
  columnId: 'column',
  duty: 'duty',
  owners: 'owners',
  gate: 'gate',
} as const satisfies { [K in keyof Stage]-?: StageField | null };

const COLUMN_KEYS = { id: null, name: null, color: 'color', hint: 'hint' } as const satisfies {
  [K in keyof BoardColumn]-?: ColumnField | null;
};

const LABEL_KEYS = {
  id: null,
  name: 'name',
  color: 'color',
  meaning: 'meaning',
  setBy: 'setBy',
  group: 'rules',
  notByAuthor: 'rules',
  requiresComment: 'rules',
  notifyAssignee: 'rules',
  clearedWhen: 'rules',
  blocks: 'rules',
} as const satisfies { [K in keyof LabelDefinition]-?: LabelField | null };

const SECTION_ORDER: readonly Section[] = ['project', 'repos', 'team', 'duties', 'limits'];

type Fields = Readonly<Record<string, unknown>>;

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** Deep equality independent of key order. */
export function sameConfig(a: ProjectConfig, b: ProjectConfig): boolean {
  return same(a, b);
}

/** The server's revert commit message, and its reverse. */
export function revertMessage(projectKey: string, commitId: string): string {
  return `Revert ${projectKey} configuration to ${commitId.slice(0, 12)}`;
}

/** The 12-character commit id a revert message names, or null for any other message. */
export function revertTarget(message: string): string | null {
  return /^Revert [A-Z][A-Z0-9]{0,9} configuration to ([0-9a-f]{12})$/.exec(message.trim())?.[1] ?? null;
}

/** The ids of `next` that are in neither longest common subsequence of the two orders: those moved. */
function movedIds(previous: readonly string[], next: readonly string[]): Set<string> {
  const length: number[][] = Array.from({ length: previous.length + 1 }, () =>
    new Array<number>(next.length + 1).fill(0),
  );
  for (let i = previous.length - 1; i >= 0; i--)
    for (let j = next.length - 1; j >= 0; j--)
      length[i]![j] =
        previous[i] === next[j]
          ? length[i + 1]![j + 1]! + 1
          : Math.max(length[i + 1]![j]!, length[i]![j + 1]!);
  const kept = new Set<string>();
  for (let i = 0, j = 0; i < previous.length && j < next.length;) {
    if (previous[i] === next[j]) {
      kept.add(next[j]!);
      i++;
      j++;
    } else if (length[i + 1]![j]! >= length[i]![j + 1]!) i++;
    else j++;
  }
  return new Set(next.filter((id) => !kept.has(id)));
}

function changedFields<F extends string>(
  previous: Fields,
  next: Fields,
  keys: Readonly<Record<string, F | null>>,
): F[] {
  const fields = new Set<F>();
  for (const [key, field] of Object.entries(keys))
    if (field !== null && !same(previous[key], next[key])) fields.add(field);
  return [...fields];
}

function byId<T extends { id: string }>(list: readonly T[]): Map<string, T> {
  return new Map(list.map((entry) => [entry.id, entry]));
}

/** The entries of a list that the other list also holds, in their order. */
function commonIds<T extends { id: string }>(a: readonly T[], b: readonly T[]): string[] {
  const other = byId(b);
  return a.filter((entry) => other.has(entry.id)).map((entry) => entry.id);
}

function listItems<T extends { id: string; name: string }, F extends string>(
  previous: readonly T[],
  next: readonly T[],
  keys: Readonly<Record<string, F | null>>,
  kinds: {
    added: ConfigDiffItem['kind'];
    removed: ConfigDiffItem['kind'];
    renamed?: ConfigDiffItem['kind'];
    changed: ConfigDiffItem['kind'];
  },
  ordered: boolean,
  orderField: F | null,
): ConfigDiffItem[] {
  const before = byId(previous);
  const after = byId(next);
  const moved = ordered ? movedIds(commonIds(previous, next), commonIds(next, previous)) : new Set<string>();
  const items: unknown[] = [];
  for (const entry of next) {
    const old = before.get(entry.id);
    if (!old) {
      items.push({ kind: kinds.added, id: entry.id, name: entry.name });
      continue;
    }
    if (kinds.renamed && old.name !== entry.name)
      items.push({ kind: kinds.renamed, id: entry.id, name: entry.name, from: old.name });
    const fields: F[] = changedFields(old, entry, keys);
    if (orderField && moved.has(entry.id)) fields.push(orderField);
    if (fields.length > 0) items.push({ kind: kinds.changed, id: entry.id, name: entry.name, fields });
  }
  return items.concat(
    previous
      .filter((entry) => !after.has(entry.id))
      .map((entry) => ({ kind: kinds.removed, id: entry.id, name: entry.name })),
  ) as ConfigDiffItem[];
}

function stageItems(previous: ProjectConfig, next: ProjectConfig): ConfigDiffItem[] {
  const items = listItems(
    previous.pipeline.stages,
    next.pipeline.stages,
    STAGE_KEYS,
    { added: 'stage_added', removed: 'stage_removed', renamed: 'stage_renamed', changed: 'stage_changed' },
    false,
    null,
  );
  const moved = movedIds(
    commonIds(previous.pipeline.stages, next.pipeline.stages),
    commonIds(next.pipeline.stages, previous.pipeline.stages),
  );
  const stages = byId(next.pipeline.stages);
  const movedItems = [...moved].map((id): ConfigDiffItem => ({
    kind: 'stage_moved',
    id,
    name: stages.get(id)!.name,
  }));
  // Changes and renames first, then the moves, then what was removed.
  const removedFrom = items.findIndex((item) => item.kind === 'stage_removed');
  return removedFrom < 0
    ? [...items, ...movedItems]
    : [...items.slice(0, removedFrom), ...movedItems, ...items.slice(removedFrom)];
}

/** What a configuration holds that the diff has no kind for (unknown fields, label order, the schema version). */
function residual(
  config: ProjectConfig,
  common: { stages: string[]; columns: string[]; labels: string[] },
): unknown {
  const omit = (value: Fields, known: Readonly<Record<string, unknown>>): Fields =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !(key in known)));
  // Stages and columns are compared by id (their order is a change of its own kind); labels in their order.
  const pick = <T extends { id: string }>(
    list: readonly T[],
    ids: readonly string[],
    known: Fields,
    keepOrder = false,
  ) => {
    const kept = list.filter((entry) => ids.includes(entry.id));
    if (!keepOrder) kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return kept.map((entry) => omit(entry, known));
  };
  const { project, team, pipeline, ...top } = config;
  const { stages, columns, labels, ...pipelineRest } = pipeline;
  return {
    top,
    project: omit(project, PROJECT_SECTION),
    team: omit(effectiveTeamSettings(config), TEAM_SECTION),
    pipeline: pipelineRest,
    stages: pick(stages, common.stages, STAGE_KEYS),
    columns: pick(columns, common.columns, COLUMN_KEYS),
    // The order of the labels is not a change of any kind of its own, so a reorder is left to `other`.
    labels: pick(labels, common.labels, LABEL_KEYS, true),
  };
}

function changedSections(previous: ProjectConfig, next: ProjectConfig): Set<Section> {
  const sections = new Set<Section>();
  for (const [key, section] of Object.entries(PROJECT_SECTION))
    if (
      !same(
        previous.project[key as keyof ProjectConfig['project']],
        next.project[key as keyof ProjectConfig['project']],
      )
    )
      sections.add(section);
  const before = effectiveTeamSettings(previous);
  const after = effectiveTeamSettings(next);
  for (const [key, section] of Object.entries(TEAM_SECTION))
    if (!same(before[key], after[key])) sections.add(section);
  return sections;
}

/** What changed from `previous` to `next`, in pipeline order (stages, columns, labels) then sections. */
export function configDiff(previous: ProjectConfig, next: ProjectConfig): ConfigDiffItem[] {
  if (sameConfig(previous, next)) return [];
  const columns = listItems(
    previous.pipeline.columns,
    next.pipeline.columns,
    COLUMN_KEYS,
    {
      added: 'column_added',
      removed: 'column_removed',
      renamed: 'column_renamed',
      changed: 'column_changed',
    },
    true,
    'order',
  );
  const labels = listItems(
    previous.pipeline.labels,
    next.pipeline.labels,
    LABEL_KEYS,
    { added: 'label_added', removed: 'label_removed', changed: 'label_changed' },
    false,
    null,
  );
  const sections = changedSections(previous, next);
  const items: ConfigDiffItem[] = [
    ...stageItems(previous, next),
    ...columns,
    ...labels,
    ...SECTION_ORDER.filter((section) => sections.has(section)).map((section): ConfigDiffItem => ({
      kind: 'section_changed',
      section,
    })),
  ];
  const common = {
    stages: commonIds(next.pipeline.stages, previous.pipeline.stages),
    columns: commonIds(next.pipeline.columns, previous.pipeline.columns),
    labels: commonIds(next.pipeline.labels, previous.pipeline.labels),
  };
  // A difference no kind describes is never left out, also next to known ones.
  if (!same(residual(previous, common), residual(next, common))) items.push({ kind: 'other' });
  return items;
}

/**
 * History rows, newest first. `rows` are the page's versions followed by at most two older ones;
 * fewer than pageSize + 2 rows means the list reached the first version.
 */
export function configHistoryEntries(
  rows: readonly { entry: ConfigVersionEntry; config: ProjectConfig | null }[],
  pageSize: number,
): ConfigHistoryEntry[] {
  const changesAt = (index: number): ConfigDiffItem[] | null => {
    const row = rows[index];
    if (!row) return null;
    const older = rows[index + 1];
    if (!older) return [{ kind: 'created' }];
    return row.config && older.config ? configDiff(older.config, row.config) : null;
  };
  return rows.slice(0, pageSize).map((row, index): ConfigHistoryEntry => {
    const target = revertTarget(row.entry.message);
    const before = rows[index + 1];
    const twoBack = rows[index + 2];
    const undone =
      !target && before && twoBack && row.config && twoBack.config && sameConfig(row.config, twoBack.config);
    return {
      ...row.entry,
      changes: changesAt(index),
      ...(target
        ? { restores: { kind: 'revert' as const, version: target, changes: null } }
        : undone
          ? {
              restores: {
                kind: 'undo' as const,
                version: before.entry.version,
                changes: changesAt(index + 1),
              },
            }
          : {}),
    };
  });
}
