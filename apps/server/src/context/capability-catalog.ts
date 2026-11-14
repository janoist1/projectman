import {
  coordinationMemberOf,
  hostOutsideOwners,
  hostRequestRefusal,
  PERMISSION_KEYS,
  ProjectManagerConfigPatch,
  ProjectManagerMemberChanges,
  TEAM_SETTING_POLICY,
} from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { roleViews } from '@projectman/templates';
import { z } from 'zod';
import { CAPABILITY_AREAS } from '../contracts';
import type {
  CapabilityArea,
  CapabilityCatalog,
  CapabilityItem,
  CapabilitySources,
  ToolAudience,
} from '../contracts';
import { MEMBER_SETTING_NOTES, PROJECT_SETTING_NOTES, TEAM_LIMIT_NOTES } from './capability-notes';

/** The prompt section's size limit, in characters (about 1000 tokens). */
export const CAPABILITY_INDEX_LIMIT = 4000;

/** The longest schema `get_capability` prints; the full form of an operation's fields is in `get_guide operations`. */
const SCHEMA_LIMIT = 6000;

/** The area's name in the prompt and the tool answers. */
const AREA_TITLES: Record<CapabilityArea, string> = {
  roles: 'roles',
  member_settings: 'member settings',
  team_tools: 'team tools',
  connected_ai: 'connected AI',
  host_requests: 'request to the host owner',
  project_settings: 'project settings',
};

/** Noise the model does not need: the dialect URL and the "no other keys" flag of every object. */
const NOISE = new Set(['$schema', 'additionalProperties']);

function schemaText(schema: z.ZodType): string {
  let json: string;
  try {
    json = JSON.stringify(
      z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
      (name, value: unknown) => (NOISE.has(name) ? undefined : value),
    );
  } catch {
    return 'Schema: not representable as JSON Schema.';
  }
  return json.length > SCHEMA_LIMIT
    ? `Schema (cut): ${json.slice(0, SCHEMA_LIMIT)} … the full form of the fields is in get_guide with topic "operations".`
    : `Schema: ${json}`;
}

/**
 * An item whose `detail` is built on first read and then kept: the prompt uses only the index, so the schema
 * texts (`z.toJSONSchema`) are not computed for every context build.
 */
function lazyItem(base: Omit<CapabilityItem, 'detail'>, build: () => string): CapabilityItem {
  let cached: string | undefined;
  return Object.defineProperty({ ...base }, 'detail', {
    enumerable: true,
    get: () => (cached ??= build()),
  }) as CapabilityItem;
}

function audienceText(audience: ToolAudience): string {
  const parts = [
    ...(audience.roles ?? []).map((role) => `role ${role}`),
    ...(audience.duties ?? []).map((duty) => `duty ${duty}`),
    ...(audience.channels ?? []).map((channel) => `channel ${channel}`),
    ...(audience.capabilities ?? []).map((capability) => `capability ${capability}`),
  ];
  return parts.length ? `Visible to members with: ${parts.join(', ')}.` : 'Visible to every member.';
}

const OWNER_ONLY_LINE = 'Owner-only: a change needs an owner’s own decision.';

function rolesItems(config: ProjectConfig): CapabilityItem[] {
  return roleViews(config).map((role) => ({
    id: role.id,
    name: role.name,
    summary: role.summary,
    detail: [
      `${role.name} (${role.id}), ${role.builtIn ? 'built-in' : 'custom'} role held by ${role.holders}.`,
      `Summary: ${role.summary}`,
      `Not their job: ${role.notTheirJob}`,
      ...(role.whenToAsk ? [`When to ask: ${role.whenToAsk}`] : []),
      `Duties: ${role.duties?.length ? role.duties.join(', ') : 'none'}.`,
    ].join('\n'),
  }));
}

function memberSettingItems(): CapabilityItem[] {
  const shape = ProjectManagerMemberChanges.shape as Record<string, z.ZodType>;
  return Object.keys(shape).map((id) => {
    const note = MEMBER_SETTING_NOTES[id as keyof typeof MEMBER_SETTING_NOTES];
    const ownerOnly = (PERMISSION_KEYS as readonly string[]).includes(id);
    return lazyItem({ id, summary: note, ...(ownerOnly ? { ownerOnly: true as const } : {}) }, () =>
      [note, ...(ownerOnly ? [OWNER_ONLY_LINE] : []), schemaText(shape[id]!)].join('\n'),
    );
  });
}

function projectSettingItems(): CapabilityItem[] {
  const shape = ProjectManagerConfigPatch.shape as Record<string, z.ZodType>;
  const limits = ProjectManagerConfigPatch.shape.limits.unwrap().shape as Record<string, z.ZodType>;
  const policy = TEAM_SETTING_POLICY as Record<string, { ownerOnly: string | null; default?: unknown }>;
  const items = Object.keys(shape)
    .filter((id) => id !== 'limits')
    .map((id): CapabilityItem => {
      const note = PROJECT_SETTING_NOTES[id as keyof typeof PROJECT_SETTING_NOTES];
      const setting = policy[id];
      const ownerOnly = setting !== undefined && setting.ownerOnly !== null;
      return lazyItem({ id, summary: note, ...(ownerOnly ? { ownerOnly: true as const } : {}) }, () =>
        [
          note,
          ...(ownerOnly ? [OWNER_ONLY_LINE] : []),
          ...(setting?.default !== undefined ? [`Default: ${JSON.stringify(setting.default)}`] : []),
          schemaText(shape[id]!),
        ].join('\n'),
      );
    });
  const limitItems = Object.keys(limits).map((field): CapabilityItem =>
    lazyItem(
      { id: `limits.${field}`, summary: TEAM_LIMIT_NOTES[field as keyof typeof TEAM_LIMIT_NOTES] },
      () => [TEAM_LIMIT_NOTES[field as keyof typeof TEAM_LIMIT_NOTES], schemaText(limits[field]!)].join('\n'),
    ),
  );
  return [...items, ...limitItems];
}

function hostRequestItems(config: ProjectConfig, sources: CapabilitySources): CapabilityItem[] {
  const handle = coordinationMemberOf(config)?.handle;
  const refusal = handle ? hostRequestRefusal(config, handle, sources.hostEmail) : 'project_manager_only';
  const state =
    refusal === null
      ? 'available: the instance’s host is not an owner of this project, so you can open a request to them'
      : refusal === 'host_request_not_needed'
        ? 'not available: the instance’s host is an owner of this project (or none is set up), so the owners reach the host directly'
        : 'not available: only the selected project manager may open a request to the host';
  const tool = sources.teamTools.find((entry) => entry.name === 'ask_host');
  return [
    {
      id: 'ask_host',
      summary: state,
      detail: [`State: ${state}.`, ...(tool ? [`Tool ask_host: ${tool.description}`] : [])].join('\n'),
    },
  ];
}

/**
 * The capability catalog of a project (PM-1468): the items of every area, built from the code's own registers
 * and schemas, so a new role, tool or setting shows up without a manual step. Pure.
 */
export function buildCapabilityCatalog(config: ProjectConfig, sources: CapabilitySources): CapabilityCatalog {
  const host = !hostOutsideOwners(config, sources.hostEmail);
  return {
    roles: rolesItems(config),
    member_settings: memberSettingItems(),
    team_tools: sources.teamTools.map((tool) => ({
      id: tool.name,
      summary: tool.title,
      detail: [`${tool.title}.`, tool.description, audienceText(tool.audience)].join('\n'),
    })),
    connected_ai: sources.connectedTools
      .filter((tool) => host || !tool.hostOnly)
      .map((tool) => ({
        id: tool.name,
        summary: tool.title,
        detail: [
          `${tool.title}.`,
          tool.description,
          `Access: ${tool.access === 'read' ? 'reads' : 'writes'}.${tool.hostOnly ? ' Only the host owner’s own access offers it.' : ''}`,
        ].join('\n'),
      })),
    host_requests: hostRequestItems(config, sources),
    project_settings: projectSettingItems(),
  };
}

/** The areas whose id lists give way, in this order, when the index is too long. */
const COLLAPSE_ORDER: readonly CapabilityArea[] = [
  'connected_ai',
  'team_tools',
  'project_settings',
  'member_settings',
  'roles',
];

function indexLine(area: CapabilityArea, items: readonly CapabilityItem[], collapsed: boolean): string {
  const title = AREA_TITLES[area];
  if (area === 'host_requests')
    return `- ${title} (${items.map((item) => item.id).join(', ')}): ${items[0]?.summary ?? 'none'}`;
  if (collapsed) return `- ${title} (${items.length}): list them with get_capability { area: "${area}" }`;
  const label = (item: CapabilityItem) => (item.name ? `${item.id} (${item.name})` : item.id);
  const plain = items.filter((item) => !item.ownerOnly).map(label);
  const ownerOnly = items.filter((item) => item.ownerOnly).map(label);
  return `- ${title} (${items.length}): ${plain.join(', ')}${ownerOnly.length ? `; owner-only: ${ownerOnly.join(', ')}` : ''}`;
}

/**
 * The prompt section: what the project can do, one line per area. Over `limit` characters the id lists of the
 * areas in `COLLAPSE_ORDER` give way to their count, one at a time, until it fits.
 */
export function capabilityIndex(catalog: CapabilityCatalog, limit = CAPABILITY_INDEX_LIMIT): string {
  const head = [
    '# Capabilities',
    'Generated from the code, so it is current. Look here before you propose a solution or say there is no way to do something; get_capability { area, id } gives the details of an area or an item.',
  ];
  const collapsed = new Set<CapabilityArea>();
  const render = () =>
    [...head, ...CAPABILITY_AREAS.map((area) => indexLine(area, catalog[area], collapsed.has(area)))].join(
      '\n',
    );
  let text = render();
  for (const area of COLLAPSE_ORDER) {
    if (text.length <= limit) break;
    collapsed.add(area);
    text = render();
  }
  return text.length <= limit ? text : cutAtLines(text, limit);
}

const CUT_MARK = '… get_capability';

/** The last resort: whole lines up to `limit` characters, the cut shown by a closing `… get_capability` line. */
function cutAtLines(text: string, limit: number): string {
  const kept: string[] = [];
  let size = CUT_MARK.length;
  for (const line of text.split('\n')) {
    size += line.length + 1;
    if (size > limit) break;
    kept.push(line);
  }
  return [...kept, CUT_MARK].join('\n');
}

/**
 * What `get_capability` answers: the items of an area (one line each) or the details of one item; null for an
 * item the area does not have.
 */
export function capabilityDetail(
  catalog: CapabilityCatalog,
  area: CapabilityArea,
  id?: string,
): string | null {
  const items = catalog[area];
  if (id === undefined)
    return [
      `# ${AREA_TITLES[area]} (${items.length})`,
      ...items.map(
        (item) =>
          `- ${item.id}${item.name ? ` (${item.name})` : ''}${item.ownerOnly ? ' [owner-only]' : ''}: ${item.summary}`,
      ),
    ].join('\n');
  const item = items.find((candidate) => candidate.id === id);
  return item ? `# ${item.id}\n${item.detail}` : null;
}
