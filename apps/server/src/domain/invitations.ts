import { roleBundle } from '@projectman/shared';
import { createHash, randomBytes } from 'node:crypto';
import { AcceptInviteRequest, InvitationView } from '@projectman/shared';
import type {
  Actor,
  CreateInviteRequest,
  CreatedInvitation,
  PublicInviteView,
  ProjectConfig,
  HumanMemberConfig,
} from '@projectman/shared';
import type { AuthService, AuthUser } from '../auth/auth-service';
import type { InvitationRecord } from '../db/invitations';
import { findHumanByEmail } from './access';
import type { DomainContext } from './context';
import { conflict, DomainError, forbidden, invalid, notFound } from './errors';
import { assertRoleFor } from './members';
import type { MemberService } from './members';
import type { ProjectService } from './projects';
import { roleViews } from './roles';
import { KeyedMutex, newId } from './util';
import { humanMemberHandle } from './naming';

const DAY_MS = 24 * 60 * 60 * 1000;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Colleague invitations: an owner or admin invites an email (optionally to an unclaimed seat);
 * accepting creates the account (unless it exists) and adds or binds the member in one
 * configuration commit.
 */
export class InvitationService {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly members: MemberService;
  /** Hashes the password of a new account (the account is stored after the commit). */
  private readonly accounts: Pick<AuthService, 'prepareUser'>;
  // Serializes account creation across projects, acceptance and revocation.
  private readonly lock = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    members: MemberService;
    accounts: Pick<AuthService, 'prepareUser'>;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.members = deps.members;
    this.accounts = deps.accounts;
  }

  async create(projectKey: string, input: CreateInviteRequest, user: AuthUser): Promise<CreatedInvitation> {
    return this.lock.run('invitations', async () => {
      const config = await this.projects.config(projectKey);
      const inviter = findHumanByEmail(config, user.email);
      if (!inviter || !['owner', 'admin'].includes(inviter.access))
        throw forbidden('insufficient_access', 'owner or admin required');
      if (input.access === 'admin' && inviter.access !== 'owner')
        throw forbidden('owner_only', 'only an owner may invite an admin');
      const member = input.memberHandle ? this.unclaimedMember(config, input.memberHandle) : undefined;
      if (findHumanByEmail(config, input.email))
        throw conflict('already_member', 'this email is already a human member');
      for (const role of input.roles) {
        assertRoleFor(config, role, 'human');
        if (
          !member &&
          inviter.access !== 'owner' &&
          roleBundle(config, role).duties.includes('release_approval')
        )
          throw forbidden('owner_only', 'only an owner may grant release approval');
      }
      if (
        member &&
        this.list(projectKey).some(
          (invite) =>
            invite.memberHandle === member.handle &&
            !invite.acceptedAt &&
            !invite.revokedAt &&
            invite.expiresAt > this.ctx.now().toISOString(),
        )
      )
        throw conflict('member_invite_pending', 'this member already has an open invitation');
      const token = randomBytes(32).toString('base64url');
      const now = this.ctx.now();
      const invite: InvitationRecord = {
        id: newId('inv'),
        projectKey,
        email: input.email,
        displayName: member?.displayName ?? input.displayName ?? null,
        ...(member ? { memberHandle: member.handle } : {}),
        access: input.access,
        roles: [...new Set(member?.roles ?? input.roles)],
        invitedBy: user.id,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 7 * DAY_MS).toISOString(),
        acceptedAt: null,
        revokedAt: null,
        tokenHash: tokenHash(token),
      };
      this.ctx.repos.invitations.insert(invite);
      return { ...InvitationView.parse(invite), path: `/invite/${token}` };
    });
  }

  private unclaimedMember(config: ProjectConfig, handle: string): HumanMemberConfig {
    const member = config.team.members.find((member) => member.handle === handle);
    if (!member)
      throw new DomainError('invite_member_not_found', 'invited member does not exist', { status: 404 });
    if (member.kind !== 'human') throw invalid('invite_member_not_human', 'invited member must be human');
    if (member.email) throw conflict('member_has_account', 'this member already has an email');
    return member;
  }

  list(projectKey: string): InvitationView[] {
    const now = this.ctx.now();
    return this.ctx.repos.invitations
      .list(projectKey, now.toISOString(), new Date(now.getTime() - 30 * DAY_MS).toISOString())
      .map((invite) => InvitationView.parse(invite));
  }

  revoke(projectKey: string, id: string): Promise<void> {
    return this.lock.run('invitations', async () => {
      const invite = this.ctx.repos.invitations.get(id);
      if (!invite || invite.projectKey !== projectKey) throw notFound('invitation', id);
      if (invite.acceptedAt) throw conflict('invite_used', 'the invitation has already been accepted');
      if (!invite.revokedAt) this.ctx.repos.invitations.revoke(id, this.ctx.now().toISOString());
    });
  }

  private valid(token: string): InvitationRecord {
    const invite = this.ctx.repos.invitations.byTokenHash(tokenHash(token));
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= this.ctx.now().toISOString())
      throw new DomainError('invite_invalid', 'the invitation is invalid or no longer available', {
        status: 404,
      });
    return invite;
  }

  async inspect(token: string): Promise<PublicInviteView> {
    const invite = this.valid(token);
    const config = await this.projects.config(invite.projectKey);
    const inviter = this.ctx.repos.users.get(invite.invitedBy)!;
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
      requiresLogin: this.ctx.repos.users.findByEmail(invite.email) !== null,
    };
  }

  accept(token: string, body: unknown, caller: AuthUser | null): Promise<AuthUser> {
    return this.lock.run('invitations', async () => {
      const invite = this.valid(token);
      const existing = this.ctx.repos.users.findByEmail(invite.email);
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
        user = await this.accounts.prepareUser({ ...input.data, email: invite.email });
      }
      const account = user;
      const inviterUser = this.ctx.repos.users.get(invite.invitedBy);
      const inviter = inviterUser
        ? findHumanByEmail(await this.projects.config(invite.projectKey), inviterUser.email)
        : undefined;
      if (!inviter || !['owner', 'admin'].includes(inviter.access))
        throw forbidden('insufficient_access', 'inviter no longer manages this team');
      const actor: Actor = { kind: 'human', handle: inviter.handle };
      await this.projects.update(
        invite.projectKey,
        {
          actor,
          author: { name: account.name, email: account.email },
          ...(invite.memberHandle
            ? { invitationBinding: { handle: invite.memberHandle, email: account.email } }
            : {}),
        },
        (draft) => {
          this.valid(token);
          const currentInviter = inviterUser ? findHumanByEmail(draft, inviterUser.email) : undefined;
          if (!currentInviter || !['owner', 'admin'].includes(currentInviter.access))
            throw forbidden('insufficient_access', 'inviter no longer manages this team');
          if (invite.access === 'admin' && currentInviter.access !== 'owner')
            throw forbidden('owner_only', 'only an owner may invite an admin');
          const member = invite.memberHandle ? this.unclaimedMember(draft, invite.memberHandle) : undefined;
          if (findHumanByEmail(draft, invite.email))
            throw conflict('already_member', 'this email is already a human member');
          if (member) {
            for (const role of member.roles) assertRoleFor(draft, role, 'human');
            member.email = account.email;
            member.access = invite.access;
          } else {
            for (const role of invite.roles) {
              assertRoleFor(draft, role, 'human');
              if (
                currentInviter.access !== 'owner' &&
                roleBundle(draft, role).duties.includes('release_approval')
              )
                throw forbidden('owner_only', 'only an owner may grant release approval');
            }
            const handle = humanMemberHandle(
              account.name,
              this.members.takenHandles(invite.projectKey, draft),
            );
            draft.team.members.push({
              kind: 'human',
              handle,
              displayName: account.name,
              email: account.email,
              access: invite.access,
              roles: invite.roles,
            });
          }
          return `Invite accepted: ${account.name}`;
        },
      );
      this.ctx.repos.transaction(() => {
        if (!existing) this.ctx.repos.users.insert(account);
        this.ctx.repos.invitations.accept(invite.id, this.ctx.now().toISOString());
      });
      return account;
    });
  }
}
