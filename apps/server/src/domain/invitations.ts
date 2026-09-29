import { roleBundle } from '@projectman/shared';
import { createHash, randomBytes } from 'node:crypto';
import { AcceptInviteRequest, InvitationView } from '@projectman/shared';
import type { Actor, CreateInviteRequest, CreatedInvitation, PublicInviteView } from '@projectman/shared';
import type { AuthService, AuthUser } from '../auth/auth-service';
import type { InvitationRecord } from '../db/invitations';
import type { Domain } from './index';
import { findHumanByEmail } from './access';
import { conflict, DomainError, forbidden, notFound } from './errors';
import { assertRoleFor } from './members';
import { roleViews } from './roles';
import { KeyedMutex, newId } from './util';

const DAY_MS = 24 * 60 * 60 * 1000;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class InvitationService {
  private readonly domain: Domain;
  private readonly auth: AuthService;
  // Serializes account creation across projects, acceptance and revocation.
  private readonly lock = new KeyedMutex();

  constructor(domain: Domain, auth: AuthService) {
    this.domain = domain;
    this.auth = auth;
  }

  async create(projectKey: string, input: CreateInviteRequest, user: AuthUser): Promise<CreatedInvitation> {
    const config = await this.domain.projects.config(projectKey);
    const inviter = findHumanByEmail(config, user.email);
    if (!inviter || !['owner', 'admin'].includes(inviter.access))
      throw forbidden('insufficient_access', 'owner or admin required');
    if (input.access === 'admin' && inviter.access !== 'owner')
      throw forbidden('owner_only', 'only an owner may invite an admin');
    if (findHumanByEmail(config, input.email))
      throw conflict('already_member', 'this email is already a human member');
    for (const role of input.roles) {
      assertRoleFor(config, role, 'human');
      if (inviter.access !== 'owner' && roleBundle(config, role).duties.includes('release_approval'))
        throw forbidden('owner_only', 'only an owner may grant release approval');
    }
    const token = randomBytes(32).toString('base64url');
    const now = this.domain.ctx.now();
    const invite: InvitationRecord = {
      id: newId('inv'),
      projectKey,
      email: input.email,
      displayName: input.displayName ?? null,
      access: input.access,
      roles: [...new Set(input.roles)],
      invitedBy: user.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 7 * DAY_MS).toISOString(),
      acceptedAt: null,
      revokedAt: null,
      tokenHash: tokenHash(token),
    };
    this.domain.ctx.repos.invitations.insert(invite);
    return { ...InvitationView.parse(invite), path: `/invite/${token}` };
  }

  list(projectKey: string): InvitationView[] {
    const now = this.domain.ctx.now();
    return this.domain.ctx.repos.invitations
      .list(projectKey, now.toISOString(), new Date(now.getTime() - 30 * DAY_MS).toISOString())
      .map((invite) => InvitationView.parse(invite));
  }

  revoke(projectKey: string, id: string): Promise<void> {
    return this.lock.run('invitations', async () => {
      const invite = this.domain.ctx.repos.invitations.get(id);
      if (!invite || invite.projectKey !== projectKey) throw notFound('invitation', id);
      if (invite.acceptedAt) throw conflict('invite_used', 'the invitation has already been accepted');
      if (!invite.revokedAt)
        this.domain.ctx.repos.invitations.revoke(id, this.domain.ctx.now().toISOString());
    });
  }

  private valid(token: string): InvitationRecord {
    const invite = this.domain.ctx.repos.invitations.byTokenHash(tokenHash(token));
    if (
      !invite ||
      invite.acceptedAt ||
      invite.revokedAt ||
      invite.expiresAt <= this.domain.ctx.now().toISOString()
    )
      throw new DomainError('invite_invalid', 'the invitation is invalid or no longer available', {
        status: 404,
      });
    return invite;
  }

  async inspect(token: string): Promise<PublicInviteView> {
    const invite = this.valid(token);
    const config = await this.domain.projects.config(invite.projectKey);
    const inviter = this.domain.ctx.repos.users.get(invite.invitedBy)!;
    const catalogue = roleViews(config);
    return {
      projectKey: invite.projectKey,
      projectName: config.project.name,
      inviterName: findHumanByEmail(config, inviter.email)?.displayName ?? inviter.name,
      displayName: invite.displayName,
      access: invite.access,
      roles: invite.roles,
      roleNames: invite.roles.map((id) => catalogue.find((role) => role.id === id)?.name ?? id),
      expiresAt: invite.expiresAt,
      requiresLogin: this.domain.ctx.repos.users.findByEmail(invite.email) !== null,
    };
  }

  accept(token: string, body: unknown, caller: AuthUser | null): Promise<AuthUser> {
    return this.lock.run('invitations', async () => {
      const invite = this.valid(token);
      const existing = this.domain.ctx.repos.users.findByEmail(invite.email);
      if (existing && caller?.id !== existing.id)
        throw conflict('login_required', 'log in as the account for the invited email');
      if (existing && !AcceptInviteRequest.safeParse(body ?? {}).success)
        throw new DomainError('invalid_request', 'invalid invitation acceptance body', { status: 400 });
      let user = existing;
      if (!user) {
        const input = AcceptInviteRequest.required().safeParse(body ?? {});
        if (!input.success)
          throw new DomainError(
            'invalid_request',
            'name and a password of at least eight characters are required',
            { status: 400 },
          );
        user = await this.auth.prepareUser({ ...input.data, email: invite.email });
      }
      const account = user;
      const inviterUser = this.domain.ctx.repos.users.get(invite.invitedBy);
      const inviter = inviterUser
        ? findHumanByEmail(await this.domain.projects.config(invite.projectKey), inviterUser.email)
        : undefined;
      if (!inviter || !['owner', 'admin'].includes(inviter.access))
        throw forbidden('insufficient_access', 'inviter no longer manages this team');
      const actor: Actor = { kind: 'human', handle: inviter.handle };
      await this.domain.projects.update(
        invite.projectKey,
        { actor, author: { name: account.name, email: account.email } },
        (draft) => {
          this.valid(token);
          const currentInviter = inviterUser ? findHumanByEmail(draft, inviterUser.email) : undefined;
          if (!currentInviter || !['owner', 'admin'].includes(currentInviter.access))
            throw forbidden('insufficient_access', 'inviter no longer manages this team');
          if (invite.access === 'admin' && currentInviter.access !== 'owner')
            throw forbidden('owner_only', 'only an owner may invite an admin');
          if (findHumanByEmail(draft, invite.email))
            throw conflict('already_member', 'this email is already a human member');
          for (const role of invite.roles) assertRoleFor(draft, role, 'human');
          const base =
            account.name
              .normalize('NFKD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 24) || 'member';
          const taken = this.domain.members.takenHandles(invite.projectKey, draft);
          let handle = base;
          for (let suffix = 2; taken.has(handle); suffix++) handle = `${base}-${suffix}`;

          draft.team.members.push({
            kind: 'human',
            handle,
            displayName: account.name,
            email: account.email,
            access: invite.access,
            roles: invite.roles,
          });
          return `Invite accepted: ${account.name}`;
        },
      );
      this.domain.ctx.repos.transaction(() => {
        if (!existing) this.domain.ctx.repos.users.insert(account);
        this.domain.ctx.repos.invitations.accept(invite.id, this.domain.ctx.now().toISOString());
      });
      return account;
    });
  }
}
