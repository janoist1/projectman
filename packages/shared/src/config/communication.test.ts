import { describe, expect, it } from 'vitest';
import {
  accessOfHandle,
  canCommentOnTask,
  contactHandles,
  hasRecipientLimit,
  isContact,
  isContactRestricted,
  teamMessageRecipientRefusal,
  viewerRecipientsOf,
  writableRecipientHandles,
} from './communication';
import { applyConfigPatch, PatchConfigRequest } from './edit';
import { validateProjectConfig } from './invariants';
import { ProjectConfig, type ProjectConfigInput } from './schema';
import { TEAM_SETTING_POLICY } from './team-settings';

function configInput(): ProjectConfigInput {
  return {
    schemaVersion: 1,
    project: {
      key: 'AC',
      name: 'Acme',
      workspacePath: '/work/acme',
      repos: [{ name: 'web', path: '.', github: 'acme/web', requireMerge: false }],
    },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        { kind: 'human', handle: 'cleo', displayName: 'Cleo', access: 'client' },
        { kind: 'human', handle: 'vic', displayName: 'Vic', access: 'viewer' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'pm', displayName: 'PM', role: 'project_manager', sponsor: 'owner' },
        { kind: 'ai', handle: 'op', displayName: 'Ops', role: 'developer', sponsor: 'owner' },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'todo', name: 'To do' }],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', owners: [], columnId: 'todo' },
        { id: 'done', name: 'Done', kind: 'done', owners: [], columnId: 'todo' },
      ],
    },
  };
}

function build(change: (input: ProjectConfigInput) => void = () => {}): ProjectConfig {
  const input = configInput();
  change(input);
  return ProjectConfig.parse(input);
}

const withContacts = (...contacts: string[]) =>
  build((input) => {
    (input.team as { contacts?: string[] }).contacts = contacts;
  });

describe('who may comment and who is held to the contacts', () => {
  it.each([
    ['owner', true],
    ['admin', true],
    ['developer', true],
    ['client', true],
    ['ai', true],
    ['viewer', false],
    [undefined, false],
  ] as const)('%s comments: %s', (access, allowed) => {
    expect(canCommentOnTask(access)).toBe(allowed);
  });

  it('holds only the client to the contacts', () => {
    expect(isContactRestricted('client')).toBe(true);
    for (const access of ['owner', 'admin', 'developer', 'viewer', 'ai', undefined] as const)
      expect(isContactRestricted(access)).toBe(false);
  });
});

describe('the project contacts', () => {
  it('is empty by default, so an older configuration loads without a migration', () => {
    expect(build().team.contacts).toEqual([]);
    expect(contactHandles(build())).toEqual([]);
  });

  it('lists the members once, and drops a handle that is no member', () => {
    const config = withContacts('pm', 'op');
    expect(contactHandles(config)).toEqual(['pm', 'op']);
    expect(isContact(config, 'pm')).toBe(true);
    expect(isContact(config, 'dev-1')).toBe(false);
    expect(isContact(config, null)).toBe(false);
    const stale = { ...config, team: { ...config.team, contacts: ['gone', 'pm'] } };
    expect(contactHandles(stale)).toEqual(['pm']);
  });

  it('rejects a duplicate handle as a schema error', () => {
    expect(() => withContacts('pm', 'pm')).toThrow();
  });

  it('reports a contact who is no member', () => {
    const issues = validateProjectConfig({
      ...withContacts('pm'),
      team: { ...withContacts('pm').team, contacts: ['pm', 'gone'] },
    }).filter((issue) => issue.code === 'unknown_member');
    expect(issues).toEqual([{ code: 'unknown_member', path: 'team.contacts[1]', detail: 'gone' }]);
  });

  it('offers a client the contacts, and a developer no extra limit', () => {
    const config = withContacts('op');
    expect(writableRecipientHandles(config, 'client')).toEqual(['op']);
    expect(writableRecipientHandles(config, 'developer')).toBeNull();
  });

  it('offers a viewer the project manager, or no one without one', () => {
    expect(writableRecipientHandles(withContacts('op'), 'viewer')).toEqual(['pm']);
    const noManager = build((input) => {
      input.team.members = input.team.members.filter((member) => member.handle !== 'pm');
    });
    expect(writableRecipientHandles(noManager, 'viewer')).toEqual([]);
  });

  it('offers a viewer the contacts by the setting, and the manager only when a contact', () => {
    const config = build((input) => {
      Object.assign(input.team, { contacts: ['op'], viewerRecipients: 'contacts' });
    });
    expect(viewerRecipientsOf(config)).toBe('contacts');
    expect(writableRecipientHandles(config, 'viewer')).toEqual(['op']);
    expect(viewerRecipientsOf(withContacts())).toBe(TEAM_SETTING_POLICY.viewerRecipients.default);
  });

  it('limits only the client and the viewer, without the configuration', () => {
    expect(hasRecipientLimit('client')).toBe(true);
    expect(hasRecipientLimit('viewer')).toBe(true);
    for (const access of ['owner', 'admin', 'developer', 'ai', undefined] as const)
      expect(hasRecipientLimit(access)).toBe(false);
  });
});

describe('patching the contacts', () => {
  const patch = (config: ProjectConfig, contacts: unknown) =>
    applyConfigPatch(config, PatchConfigRequest.parse({ baseVersion: 'v1', contacts }));

  it('keeps the list when the patch has no contacts', () => {
    const config = withContacts('pm');
    expect(applyConfigPatch(config, PatchConfigRequest.parse({ baseVersion: 'v1' })).team.contacts).toEqual([
      'pm',
    ]);
  });

  it('replaces the whole list, and an empty list clears it', () => {
    const config = withContacts('pm');
    expect(patch(config, ['op', 'owner']).team.contacts).toEqual(['op', 'owner']);
    expect(patch(config, []).team.contacts).toEqual([]);
  });

  it('sets the viewer recipients and keeps them when the patch has none (PM-1102)', () => {
    const set = applyConfigPatch(
      withContacts(),
      PatchConfigRequest.parse({ baseVersion: 'v1', viewerRecipients: 'contacts' }),
    );
    expect(set.team.viewerRecipients).toBe('contacts');
    expect(applyConfigPatch(set, PatchConfigRequest.parse({ baseVersion: 'v1' })).team.viewerRecipients).toBe(
      'contacts',
    );
  });

  it('refuses null and duplicates', () => {
    expect(PatchConfigRequest.safeParse({ baseVersion: 'v1', contacts: null }).success).toBe(false);
    expect(PatchConfigRequest.safeParse({ baseVersion: 'v1', contacts: ['pm', 'pm'] }).success).toBe(false);
  });
});

describe('teamMessageRecipientRefusal', () => {
  const config = withContacts('pm');

  it('lets a client write to the contacts', () => {
    expect(teamMessageRecipientRefusal(config, 'cleo', ['pm'])).toBeNull();
  });

  it('refuses the whole message when one recipient is no contact', () => {
    expect(teamMessageRecipientRefusal(config, 'cleo', ['pm', 'dev-1', 'dev-1'])).toEqual({
      code: 'recipient_not_contact',
      recipients: ['dev-1'],
    });
  });

  it('lets a viewer write to the project manager alone', () => {
    expect(teamMessageRecipientRefusal(config, 'vic', ['pm'])).toBeNull();
    expect(teamMessageRecipientRefusal(config, 'vic', ['pm', 'dev-1'])).toEqual({
      code: 'insufficient_access',
      recipients: ['dev-1'],
    });
  });

  it('lets a viewer write to the contacts, as a client does, when the project says so (PM-1102)', () => {
    const viewerContacts = build((input) => {
      Object.assign(input.team, { contacts: ['op'], viewerRecipients: 'contacts' });
    });
    expect(teamMessageRecipientRefusal(viewerContacts, 'vic', ['op'])).toBeNull();
    expect(teamMessageRecipientRefusal(viewerContacts, 'vic', ['pm', 'op'])).toEqual({
      code: 'recipient_not_contact',
      recipients: ['pm'],
    });
  });

  it('puts no limit on anyone else', () => {
    expect(teamMessageRecipientRefusal(config, 'owner', ['dev-1', 'cleo'])).toBeNull();
    expect(teamMessageRecipientRefusal(config, 'dev-1', ['cleo'])).toBeNull();
    expect(accessOfHandle(config, 'dev-1')).toBe('ai');
    expect(accessOfHandle(config, 'nobody')).toBeUndefined();
  });
});
