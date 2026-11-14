import { describe, expect, it } from 'vitest';
import {
  PERMISSION_KEYS,
  ProjectManagerConfigPatch,
  ProjectManagerMemberChanges,
  TEAM_SETTING_POLICY,
} from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { getTemplate, roleViews } from '@projectman/templates';
import { CAPABILITY_AREAS } from '../contracts';
import type { CapabilitySources } from '../contracts';
import { connectedToolCatalog, TEAM_TOOL_NAMES, teamToolCatalog } from '../mcp';
import { MEMBER_SETTING_NOTES, PROJECT_SETTING_NOTES, TEAM_LIMIT_NOTES } from './capability-notes';
import {
  buildCapabilityCatalog,
  CAPABILITY_INDEX_LIMIT,
  capabilityDetail,
  capabilityIndex,
} from './capability-catalog';

const OWNER_EMAIL = 'anna@example.com';

function project(): ProjectConfig {
  const config = getTemplate('web-client-project')!.build({
    key: 'AR',
    name: 'Acme Web',
    workspacePath: '/work/acme',
    language: 'en',
    owner: { handle: 'owner', displayName: 'Anna Example', email: OWNER_EMAIL },
  });
  config.team.roles.push({
    id: 'accountant',
    name: 'Accountant',
    summary: 'Keeps the books.',
    notTheirJob: 'Writes code.',
    holders: 'both',
    instructions: '',
  });
  return config;
}

const sources = (hostEmail: string | null): CapabilitySources => ({
  teamTools: teamToolCatalog(),
  connectedTools: connectedToolCatalog(),
  hostEmail,
});

const limitIds = Object.keys(ProjectManagerConfigPatch.shape.limits.unwrap().shape).map(
  (key) => `limits.${key}`,
);
const settingKeys = (shape: object) => Object.keys(shape);

describe('the capability catalog (PM-1468)', () => {
  const config = project();
  const catalog = buildCapabilityCatalog(config, sources('host@example.test'));
  const ids = (area: (typeof CAPABILITY_AREAS)[number]) => catalog[area].map((item) => item.id);

  it('covers every area with items', () => {
    for (const area of CAPABILITY_AREAS) expect(catalog[area].length, area).toBeGreaterThan(0);
  });

  it('lists the built-in and the custom roles of the project, as roleViews has them', () => {
    expect(ids('roles')).toEqual(roleViews(config).map((role) => role.id));
    expect(ids('roles')).toContain('accountant');
    expect(capabilityDetail(catalog, 'roles', 'accountant')).toContain('Keeps the books.');
  });

  it('lists every field the project manager edits a member or the project with, and every limit', () => {
    expect(ids('member_settings')).toEqual(settingKeys(ProjectManagerMemberChanges.shape));
    expect(ids('project_settings')).toEqual([
      ...settingKeys(ProjectManagerConfigPatch.shape).filter((key) => key !== 'limits'),
      ...limitIds,
    ]);
  });

  it('has a note for exactly the fields of the schemas, in plain short words', () => {
    expect(settingKeys(MEMBER_SETTING_NOTES).sort()).toEqual(
      settingKeys(ProjectManagerMemberChanges.shape).sort(),
    );
    expect(settingKeys(PROJECT_SETTING_NOTES).sort()).toEqual(
      settingKeys(ProjectManagerConfigPatch.shape)
        .filter((key) => key !== 'limits')
        .sort(),
    );
    expect(limitIds.map((id) => id.slice('limits.'.length)).sort()).toEqual(
      settingKeys(TEAM_LIMIT_NOTES).sort(),
    );
    for (const note of [
      ...Object.values(MEMBER_SETTING_NOTES),
      ...Object.values(PROJECT_SETTING_NOTES),
      ...Object.values(TEAM_LIMIT_NOTES),
    ]) {
      expect(note.trim()).not.toBe('');
      expect(note.length).toBeLessThanOrEqual(200);
    }
  });

  it('names no card and no decision in the notes or the index', () => {
    const general = [
      ...Object.values(MEMBER_SETTING_NOTES),
      ...Object.values(PROJECT_SETTING_NOTES),
      ...Object.values(TEAM_LIMIT_NOTES),
      capabilityIndex(catalog),
    ].join('\n');
    expect(general).not.toMatch(/\b[A-Z][A-Z0-9]*-\d+\b/);
    expect(general).not.toMatch(/decisions? \d+/i);
  });

  it('marks as owner-only the permission keys of a member and the owner-only team settings', () => {
    const marked = (area: 'member_settings' | 'project_settings') =>
      catalog[area].filter((item) => item.ownerOnly).map((item) => item.id);
    expect(marked('member_settings')).toEqual(
      ids('member_settings').filter((id) => (PERMISSION_KEYS as readonly string[]).includes(id)),
    );
    const policy = TEAM_SETTING_POLICY as Record<string, { ownerOnly: string | null }>;
    expect(marked('project_settings')).toEqual(
      ids('project_settings').filter((id) => policy[id] !== undefined && policy[id].ownerOnly !== null),
    );
    expect(marked('project_settings')).toContain('releaseFourEyes');
    expect(capabilityDetail(catalog, 'project_settings', 'releaseFourEyes')).toContain('Owner-only');
    expect(capabilityDetail(catalog, 'project_settings', 'merger')).not.toContain('Owner-only');
  });

  it('gives the schema of a setting, with its values', () => {
    expect(capabilityDetail(catalog, 'member_settings', 'provider')).toMatch(/Schema: .*"enum"/);
    expect(capabilityDetail(catalog, 'project_settings', 'limits.maxConcurrentAi')).toContain('Schema:');
  });

  it('lists the team tools by the names of the register, with who sees each', () => {
    expect(ids('team_tools').sort()).toEqual([...TEAM_TOOL_NAMES].sort());
    expect(capabilityDetail(catalog, 'team_tools', 'get_capability')).toContain('project_manager');
    expect(capabilityDetail(catalog, 'team_tools', 'get_task')).toContain('Visible to every member');
  });

  it.each([
    ['not an owner', 'host@example.test', false, false],
    ['an owner', OWNER_EMAIL, true, true],
  ])(
    'with a host who is %s: the host-only connected tools are offered %s, the request to the host is unavailable %s',
    (_label, host, hostOnlyOffered, unavailable) => {
      const built = buildCapabilityCatalog(config, sources(host));
      const all = connectedToolCatalog();
      expect(built.connected_ai.length).toBe(all.filter((tool) => hostOnlyOffered || !tool.hostOnly).length);
      expect(built.host_requests.map((item) => item.id)).toEqual(['ask_host']);
      expect(built.host_requests[0]!.summary.startsWith('not available')).toBe(unavailable);
    },
  );
});

describe('the capability index', () => {
  // The host is an owner: every connected tool is offered, the longest list.
  const catalog = buildCapabilityCatalog(project(), sources(OWNER_EMAIL));

  it('fits the limit with the real registers and names every area', () => {
    const index = capabilityIndex(catalog);
    expect(index.length).toBeLessThanOrEqual(CAPABILITY_INDEX_LIMIT);
    expect(index).toContain('get_capability');
    for (const area of CAPABILITY_AREAS) {
      const sample = catalog[area][0]!;
      expect(index, area).toMatch(new RegExp(`(${sample.id}|get_capability \\{ area: "${area}")`));
    }
    expect(index).toContain('owner-only: ');
  });

  it('gives way to counts in a fixed order when the list is too long', () => {
    const full = capabilityIndex(catalog, 100_000);
    const withoutConnected = capabilityIndex(catalog, full.length - 1);
    expect(withoutConnected).toContain('connected AI (');
    expect(withoutConnected).toContain('list them with get_capability { area: "connected_ai" }');
    expect(withoutConnected).not.toContain('list them with get_capability { area: "team_tools" }');
    const bothCollapsed = capabilityIndex(catalog, withoutConnected.length - 1);
    expect(bothCollapsed).toContain('list them with get_capability { area: "team_tools" }');
    expect(capabilityIndex(catalog, 300).length).toBeLessThanOrEqual(300);
  });
});

describe('capabilityDetail', () => {
  const catalog = buildCapabilityCatalog(project(), sources('host@example.test'));

  it('lists an area without an id, one line per item', () => {
    const list = capabilityDetail(catalog, 'member_settings')!;
    expect(list.split('\n').length).toBe(catalog.member_settings.length + 1);
    expect(list).toContain('- permissionMode [owner-only]: ');
  });

  it('tells one item with an id and gives null for an unknown one', () => {
    expect(capabilityDetail(catalog, 'host_requests', 'ask_host')).toContain('State:');
    expect(capabilityDetail(catalog, 'roles', 'no-such-role')).toBeNull();
  });
});
